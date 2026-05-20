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
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use trading_runtime::{EnvelopeBinding, SignedEnvelope};

use crate::{BotContext, MultiBotTradingState};

// ── On-disk storage ─────────────────────────────────────────────────────────

/// Coarse process-wide write lock for envelope persistence. Guards
/// read-modify-write races between the renewal cron, the envelope watcher,
/// and `PUT /envelope`. Writes are infrequent (≤1 per bot per renewal window)
/// so a single mutex is sufficient and avoids the complexity of a per-bot
/// dashmap. See `audits/http-api-concurrency-audit.md` finding #1.
static ENVELOPE_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

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

/// Persist `env` for `bot_id` if its `nonce` is strictly greater than the
/// current on-disk envelope's nonce (or the slot is empty). Returns
/// `Err(NonceConflict { current })` when a higher-or-equal nonce is already
/// stored — both the operator (`PUT /envelope`) and the renewal cron call
/// this so a stale cron read cannot regress a freshly PUT envelope.
///
/// Writes are atomic: data is staged to `<path>.tmp.<pid>` and `rename`d
/// into place so a crash mid-write cannot leave a truncated JSON blob that
/// `get_signed_envelope` would silently treat as missing.
pub fn set_signed_envelope(bot_id: &str, env: &SignedEnvelope) -> Result<(), SetEnvelopeError> {
    let _guard = ENVELOPE_WRITE_LOCK
        .lock()
        .map_err(|_| SetEnvelopeError::Internal("envelope mutex poisoned".into()))?;

    if let Some(current) = get_signed_envelope(bot_id)
        && env.nonce <= current.nonce
    {
        return Err(SetEnvelopeError::NonceConflict {
            current: current.nonce,
            attempted: env.nonce,
        });
    }

    std::fs::create_dir_all(envelope_dir())
        .map_err(|e| SetEnvelopeError::Internal(format!("create envelope dir: {e}")))?;
    let json = serde_json::to_string_pretty(env)
        .map_err(|e| SetEnvelopeError::Internal(format!("serialize envelope: {e}")))?;
    let target = envelope_path(bot_id);
    atomic_write(&target, json.as_bytes())
        .map_err(|e| SetEnvelopeError::Internal(format!("persist envelope: {e}")))
}

/// Outcome of a `set_signed_envelope` call. Distinguishes monotonicity
/// violations from infrastructure errors so the operator path can return
/// `409 Conflict` while the cron downgrades to a warn-level log.
#[derive(Debug)]
pub enum SetEnvelopeError {
    NonceConflict { current: u64, attempted: u64 },
    Internal(String),
}

impl std::fmt::Display for SetEnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SetEnvelopeError::NonceConflict { current, attempted } => write!(
                f,
                "Envelope nonce {attempted} must be greater than current nonce {current}",
            ),
            SetEnvelopeError::Internal(msg) => f.write_str(msg),
        }
    }
}

/// Stage `bytes` to a sibling tempfile and `rename` over `target`. POSIX
/// guarantees rename is atomic on the same filesystem; on Windows we accept
/// the filesystem's best-effort semantics (no on-prem Windows deployments
/// today). Falls back to `std::fs::write` only if the tempfile path itself
/// is uncreateable, which would equally have failed on the real path.
fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = target.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, target) {
        // best-effort cleanup; rename failed is the load-bearing error.
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub fn clear_signed_envelope(bot_id: &str) -> Result<(), String> {
    let _guard = ENVELOPE_WRITE_LOCK
        .lock()
        .map_err(|_| "envelope mutex poisoned".to_string())?;
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
    // `set_signed_envelope` enforces nonce monotonicity under the same
    // lock as the renewal cron's writer, so the operator path and cron
    // path agree on the highest-nonce envelope at all times.
    match set_signed_envelope(&bot.bot_id, &env) {
        Ok(()) => {}
        Err(err @ SetEnvelopeError::NonceConflict { .. }) => {
            return Err((StatusCode::CONFLICT, err.to_string()));
        }
        Err(SetEnvelopeError::Internal(msg)) => {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, msg));
        }
    }
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
    // `consumed_pct` is human-facing only. The `to_string().parse::<f64>()`
    // round-trip is lossy for values > 2^53 (≈ 9e15), but that maps to the
    // mantissa precision of *both* numerator and denominator so the ratio
    // remains accurate to ~15 significant digits. See audit finding #9.
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

    // SECURITY: RPC URLs commonly embed an API key in the path or query.
    // Log the failure server-side and surface a generic, non-leaking error
    // string to the caller. See `audits/http-api-concurrency-audit.md` #6.
    let provider = ProviderBuilder::new().connect_http(bot.rpc_url.parse().map_err(|e| {
        tracing::warn!(
            bot_id = %bot.bot_id,
            error = %e,
            "envelope consumption check: bot rpc_url failed to parse"
        );
        "bot rpc_url is invalid; check operator configuration".to_string()
    })?);
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
