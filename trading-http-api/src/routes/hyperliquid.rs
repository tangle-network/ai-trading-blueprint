//! Hyperliquid native perps trading routes.
//!
//! These endpoints let the agent trade directly on Hyperliquid's L1 via the
//! native REST API (not the on-chain bridge). Supports market/limit/stop/TP
//! orders, leverage management, and position queries.

use axum::extract::State;
use axum::http::StatusCode;
use axum::{
    Json, Router,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use trading_runtime::hyperliquid::{
    AccountInfo, CancelOrderRequest, PlaceOrderRequest, SetLeverageRequest,
};

use crate::MultiBotTradingState;

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

use std::sync::RwLock;
use trading_runtime::trading_envelope::TradingEnvelope;

static ENVELOPE: std::sync::LazyLock<RwLock<TradingEnvelope>> = std::sync::LazyLock::new(|| {
    // Load from state dir if available, otherwise use default
    let state_dir = sandbox_runtime::store::state_dir();
    let path = state_dir.join("trading-envelope.json");
    let env = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        TradingEnvelope::default()
    };
    RwLock::new(env)
});

pub(crate) fn get_envelope(_state: &MultiBotTradingState) -> TradingEnvelope {
    ENVELOPE.read().unwrap().clone()
}

fn set_envelope(env: TradingEnvelope) {
    // Persist to disk
    let state_dir = sandbox_runtime::store::state_dir();
    let path = state_dir.join("trading-envelope.json");
    if let Ok(json) = serde_json::to_string_pretty(&env) {
        if let Err(e) = std::fs::write(&path, json) {
            tracing::error!(error = %e, "Failed to persist trading envelope");
        }
    }
    *ENVELOPE.write().unwrap() = env;
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
    Json(req): Json<PlaceOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
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
    Json(req): Json<BracketOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
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
    Json(req): Json<CancelOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
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
    Json(req): Json<SetLeverageRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
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
    State(state): State<Arc<MultiBotTradingState>>,
) -> Json<TradingEnvelope> {
    Json(get_envelope(&state))
}

async fn update_envelope_handler(
    State(_state): State<Arc<MultiBotTradingState>>,
    Json(env): Json<TradingEnvelope>,
) -> Result<Json<TradingEnvelope>, (StatusCode, String)> {
    // Validate envelope constraints
    if env.max_leverage == 0 {
        return Err((StatusCode::BAD_REQUEST, "max_leverage must be > 0".into()));
    }
    if env.max_position_usd <= 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "max_position_usd must be > 0".into(),
        ));
    }
    if env.allowed_assets.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "allowed_assets must be non-empty".into(),
        ));
    }
    if env.max_drawdown_pct <= 0.0 || env.max_drawdown_pct > 1.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "max_drawdown_pct must be in (0, 1]".into(),
        ));
    }

    set_envelope(env.clone());
    tracing::info!(
        assets = ?env.allowed_assets,
        max_pos = env.max_position_usd,
        max_lev = env.max_leverage,
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
}
