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

fn set_signed_envelope(bot_id: &str, env: &SignedEnvelope) -> Result<(), String> {
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

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route(
        "/envelope",
        get(get_envelope_handler)
            .put(put_envelope_handler)
            .delete(delete_envelope_handler),
    )
}
