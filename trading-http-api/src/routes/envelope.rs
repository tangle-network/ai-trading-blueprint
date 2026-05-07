//! Universal envelope HTTP endpoints — protocol-agnostic.
//!
//! `PUT /envelope` stores the signed envelope for the authenticated bot;
//! `GET /envelope` returns it. Storage is keyed by `bot_id` only — there's
//! one active envelope per bot, regardless of protocol. The envelope itself
//! carries the `protocol` field which determines on-chain enforcement at
//! execute time.

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use std::path::PathBuf;
use std::sync::Arc;

use trading_runtime::{EnvelopeBinding, SignedEnvelope};

use crate::{BotContext, MultiBotTradingState};

// ── On-disk storage ─────────────────────────────────────────────────────────

fn envelope_dir() -> PathBuf {
    sandbox_runtime::store::state_dir().join("trading-envelopes")
}

fn envelope_path(bot_id: &str) -> PathBuf {
    let safe = bot_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    envelope_dir().join(format!("{safe}.json"))
}

pub fn get_signed_envelope(bot_id: &str) -> Option<SignedEnvelope> {
    std::fs::read_to_string(envelope_path(bot_id))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
}

pub fn set_signed_envelope(bot_id: &str, env: &SignedEnvelope) -> Result<(), String> {
    std::fs::create_dir_all(envelope_dir())
        .map_err(|e| format!("Failed to create envelope directory: {e}"))?;
    let json = serde_json::to_string_pretty(env)
        .map_err(|e| format!("Failed to serialize envelope: {e}"))?;
    std::fs::write(envelope_path(bot_id), json)
        .map_err(|e| format!("Failed to persist envelope: {e}"))
}

pub fn clear_signed_envelope(bot_id: &str) -> Result<(), String> {
    let p = envelope_path(bot_id);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("Failed to clear envelope: {e}"))?;
    }
    Ok(())
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn get_envelope_handler(
    Extension(bot): Extension<BotContext>,
) -> Json<Option<SignedEnvelope>> {
    Json(get_signed_envelope(&bot.bot_id))
}

async fn put_envelope_handler(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(env): Json<SignedEnvelope>,
) -> Result<Json<SignedEnvelope>, (StatusCode, String)> {
    let binding = EnvelopeBinding {
        bot_id: &bot.bot_id,
        vault_address: &bot.vault_address,
        chain_id: bot.chain_id,
        protocol: &env.protocol,
    };
    env.verify(&binding, &state.trusted_envelope_signers())
        .map_err(<(StatusCode, String)>::from)?;
    if let Some(current) = get_signed_envelope(&bot.bot_id) {
        if env.nonce <= current.nonce {
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "Envelope nonce {} must be greater than current nonce {}",
                    env.nonce, current.nonce
                ),
            ));
        }
    }
    set_signed_envelope(&bot.bot_id, &env).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    tracing::info!(
        bot_id = %bot.bot_id,
        protocol = %env.protocol,
        nonce = env.nonce,
        has_enforcement = env.enforcement.is_some(),
        max_trade_usd = %env.policy.max_trade_size_usd,
        "envelope stored"
    );
    Ok(Json(env))
}

async fn delete_envelope_handler(
    Extension(bot): Extension<BotContext>,
) -> Result<StatusCode, (StatusCode, String)> {
    clear_signed_envelope(&bot.bot_id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Status (consumed/expiry/sigs) ─────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct EnvelopeStatusResponse {
    pub is_active: bool,
    pub consumed_amount: String,
    pub max_total_amount: String,
    pub consumed_pct: f64,
    pub expires_at: u64,
    pub expires_in_seconds: i64,
    pub signature_count: usize,
    pub min_signatures: usize,
    pub protocol: String,
    pub nonce: u64,
}

async fn envelope_status_handler(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<Option<EnvelopeStatusResponse>>, (StatusCode, String)> {
    let Some(envelope) = get_signed_envelope(&bot.bot_id) else {
        return Ok(Json(None));
    };
    let now = chrono::Utc::now().timestamp();
    let expires_in = envelope.expires_at as i64 - now;
    let max_total = max_total_for_enforcement(&envelope.enforcement);
    let consumed = match envelope_consumed_amount(&state, &envelope, &bot).await {
        Ok(v) => v,
        Err(_) => alloy::primitives::U256::ZERO, // best-effort; chain unavailable → unknown, report 0
    };
    let consumed_pct = if max_total.is_zero() {
        0.0
    } else {
        let ratio_num = consumed.to_string().parse::<f64>().unwrap_or(0.0);
        let ratio_den = max_total.to_string().parse::<f64>().unwrap_or(1.0);
        (ratio_num / ratio_den) * 100.0
    };
    let is_active = expires_in > 0
        && envelope.signatures.len() >= envelope.min_signatures
        && consumed < max_total;
    Ok(Json(Some(EnvelopeStatusResponse {
        is_active,
        consumed_amount: consumed.to_string(),
        max_total_amount: max_total.to_string(),
        consumed_pct,
        expires_at: envelope.expires_at,
        expires_in_seconds: expires_in,
        signature_count: envelope.signatures.len(),
        min_signatures: envelope.min_signatures,
        protocol: envelope.protocol,
        nonce: envelope.nonce,
    })))
}

pub fn max_total_for_enforcement(
    enforcement: &Option<trading_runtime::EnvelopeEnforcement>,
) -> alloy::primitives::U256 {
    use trading_runtime::EnvelopeEnforcement::*;
    match enforcement {
        Some(UniswapV3Swap(e)) => e.max_total_amount_in,
        Some(UniswapV4Swap(e)) => e.max_total_amount_in,
        Some(PancakeswapV3Swap(e)) => e.max_total_amount_in,
        Some(AerodromeSwap(e)) => e.max_total_amount_in,
        Some(CurveStableSwap(e)) => e.max_total_amount_in,
        Some(AaveSupply(e)) => e.max_total_amount,
        Some(AaveWithdraw(e)) => e.max_total_amount,
        Some(AaveBorrow(e)) => e.max_total_amount,
        Some(AaveRepay(e)) => e.max_total_amount,
        Some(MorphoSupply(e)) => e.max_total_amount,
        Some(MorphoWithdraw(e)) => e.max_total_amount,
        Some(MorphoBorrow(e)) => e.max_total_amount,
        Some(MorphoRepay(e)) => e.max_total_amount,
        None => alloy::primitives::U256::ZERO,
    }
}

pub async fn envelope_consumed_amount(
    _state: &MultiBotTradingState,
    envelope: &SignedEnvelope,
    bot: &BotContext,
) -> Result<alloy::primitives::U256, String> {
    use alloy::providers::ProviderBuilder;
    use trading_runtime::contracts::ITradingVault;
    use trading_runtime::envelope::abi_bridge::to_sol_envelope;

    let provider = ProviderBuilder::new().connect_http(
        bot.rpc_url
            .parse()
            .map_err(|e| format!("invalid bot rpc_url '{}': {e}", bot.rpc_url))?,
    );
    let vault: alloy::primitives::Address = envelope
        .vault_address
        .parse()
        .map_err(|e: alloy::hex::FromHexError| e.to_string())?;
    let sol_env = to_sol_envelope(envelope).map_err(|e| e.to_string())?;
    let vault_iface = ITradingVault::new(vault, &provider);
    let validator_addr = vault_iface
        .tradeValidator()
        .call()
        .await
        .map_err(|e| e.to_string())?;
    let tv = trading_runtime::contracts::ITradeValidator::new(validator_addr, &provider);
    let envelope_hash = tv
        .hashEnvelope(sol_env)
        .call()
        .await
        .map_err(|e| e.to_string())?;
    let consumed = vault_iface
        .envelopeConsumedAmount(envelope_hash)
        .call()
        .await
        .map_err(|e| e.to_string())?;
    Ok(consumed)
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route(
            "/envelope",
            get(get_envelope_handler)
                .put(put_envelope_handler)
                .delete(delete_envelope_handler),
        )
        .route("/envelope/status", get(envelope_status_handler))
}
