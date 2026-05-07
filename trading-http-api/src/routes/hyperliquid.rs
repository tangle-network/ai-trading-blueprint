//! Hyperliquid native perps trading routes.
//!
//! These endpoints let the agent trade directly on Hyperliquid's L1 via the
//! native REST API (not the on-chain bridge). Supports market/limit/stop/TP
//! orders, leverage management, and position queries.

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::{
    Json, Router,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use trading_runtime::envelope::{EnvelopeBinding, SignedEnvelope};
use trading_runtime::hyperliquid::{
    AccountInfo, CancelOrderRequest, PlaceOrderRequest, SetLeverageRequest,
};

use crate::{BotContext, MultiBotTradingState};

// ── Lazy-initialized client ─────────────────────────────────────────────────

use std::sync::OnceLock;
use trading_runtime::hyperliquid::HyperliquidClient;

static HL_CLIENT: OnceLock<HyperliquidClient> = OnceLock::new();

pub(crate) fn get_hl_client(
    state: &MultiBotTradingState,
) -> Result<&'static HyperliquidClient, (StatusCode, String)> {
    if let Some(client) = HL_CLIENT.get() {
        return Ok(client);
    }
    let key = &state.operator_private_key;
    if key.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "EXECUTOR_PRIVATE_KEY not set".into(),
        ));
    }
    let is_testnet = std::env::var("HYPERLIQUID_TESTNET").is_ok_and(|v| v == "1" || v == "true");
    let client = if is_testnet {
        HyperliquidClient::testnet(key)
    } else {
        HyperliquidClient::new(key)
    }
    .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, format!("HL init: {e}")))?;
    let _ = HL_CLIENT.set(client);
    HL_CLIENT
        .get()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "HL client race".into()))
}

// ── Trading envelope ────────────────────────────────────────────────────────

fn envelope_dir() -> PathBuf {
    sandbox_runtime::store::state_dir().join("trading-envelopes")
}

fn envelope_path(bot_id: &str) -> PathBuf {
    let safe_bot_id = bot_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    envelope_dir().join(format!("{safe_bot_id}.json"))
}

pub(crate) fn get_signed_envelope(bot_id: &str) -> Option<SignedEnvelope> {
    std::fs::read_to_string(envelope_path(bot_id))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
}

fn set_signed_envelope(bot_id: &str, env: &SignedEnvelope) -> Result<(), String> {
    std::fs::create_dir_all(envelope_dir())
        .map_err(|e| format!("Failed to create envelope directory: {e}"))?;
    let json = serde_json::to_string_pretty(env)
        .map_err(|e| format!("Failed to serialize trading envelope: {e}"))?;
    std::fs::write(envelope_path(bot_id), json)
        .map_err(|e| format!("Failed to persist trading envelope: {e}"))
}

fn reject_live_direct_hyperliquid(bot: &BotContext) -> Result<(), (StatusCode, String)> {
    if bot.paper_trade {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        "Live Hyperliquid direct routes are disabled; submit live trades through /execute so PerTrade or signed Envelope authorization can be verified".into(),
    ))
}

// ── Request/Response types ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BracketOrderRequest {
    pub entry: PlaceOrderRequest,
    #[serde(default)]
    pub stop_loss: Option<PlaceOrderRequest>,
    #[serde(default)]
    pub take_profit: Option<PlaceOrderRequest>,
}

#[derive(Serialize)]
pub struct OrderResponse {
    pub status: String,
    pub data: serde_json::Value,
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn place_order(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<PlaceOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let resp = client
        .place_order(&req)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn place_bracket(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<BracketOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let resp = client
        .place_bracket(&req.entry, req.stop_loss.as_ref(), req.take_profit.as_ref())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn cancel_order(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<CancelOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let resp = client
        .cancel_order(req.asset, req.order_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn set_leverage(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<SetLeverageRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let resp = client
        .set_leverage(req.asset, req.leverage, req.is_cross)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn get_account(
    State(state): State<Arc<MultiBotTradingState>>,
) -> Result<Json<AccountInfo>, (StatusCode, String)> {
    let client = get_hl_client(&state)?;
    let account = client
        .get_account()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(account))
}

async fn get_prices(
    State(state): State<Arc<MultiBotTradingState>>,
) -> Result<Json<std::collections::HashMap<String, String>>, (StatusCode, String)> {
    let client = get_hl_client(&state)?;
    let mids = client
        .get_mids()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(mids))
}

// ── Envelope endpoints ──────────────────────────────────────────────────────

async fn get_envelope_handler(
    Extension(bot): Extension<BotContext>,
) -> Json<Option<SignedEnvelope>> {
    Json(get_signed_envelope(&bot.bot_id))
}

async fn update_envelope_handler(
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
        max_trade_usd = %env.policy.max_trade_size_usd,
        max_total_exposure_usd = %env.policy.max_total_exposure_usd,
        perps_assets = ?env.policy.perps.as_ref().map(|p| &p.allowed_assets),
        max_lev = ?env.policy.perps.as_ref().map(|p| p.max_leverage),
        "Trading envelope updated"
    );
    Ok(Json(env))
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/hyperliquid/order", post(place_order))
        .route("/hyperliquid/bracket", post(place_bracket))
        .route("/hyperliquid/cancel", post(cancel_order))
        .route("/hyperliquid/leverage", post(set_leverage))
        .route("/hyperliquid/account", get(get_account))
        .route("/hyperliquid/prices", get(get_prices))
        .route(
            "/hyperliquid/envelope",
            get(get_envelope_handler).put(update_envelope_handler),
        )
        .route(
            "/envelope",
            get(get_envelope_handler).put(update_envelope_handler),
        )
}
