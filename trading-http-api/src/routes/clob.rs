//! Polymarket CLOB API routes for the trading HTTP API.
//!
//! These endpoints expose CLOB operations (order status, order book, midpoint,
//! approval) to the sidecar agent. All routes require CLOB to be configured.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing::get};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use trading_runtime::polymarket_clob::{ApprovalResult, OpenOrder, OrderBook};

use crate::TradingApiState;

fn clob_not_configured() -> (StatusCode, String) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Polymarket CLOB client not configured".into(),
    )
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/clob/order", get(get_order))
        .route("/clob/orders", get(get_orders))
        .route("/clob/book", get(get_book))
        .route("/clob/midpoint", get(get_midpoint))
        .route("/clob/approve", axum::routing::post(approve_collateral))
        .route("/clob/config", get(get_config))
}

// ── Query params ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OrderIdQuery {
    pub order_id: String,
}

#[derive(Deserialize)]
pub struct OrdersQuery {
    pub market: Option<String>,
    pub asset_id: Option<String>,
}

#[derive(Deserialize)]
pub struct TokenIdQuery {
    pub token_id: String,
}

#[derive(Deserialize)]
pub struct ApproveQuery {
    #[serde(default)]
    pub neg_risk: bool,
    pub rpc_url: Option<String>,
}

// ── Response types ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct MidpointResponse {
    pub token_id: String,
    pub midpoint: String,
}

#[derive(Serialize)]
pub struct ConfigResponse {
    pub address: String,
    pub exchange: String,
    pub collateral: String,
    pub conditional_tokens: String,
    pub neg_risk_exchange: Option<String>,
    pub neg_risk_adapter: Option<String>,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn get_order(
    State(state): State<Arc<TradingApiState>>,
    Query(q): Query<OrderIdQuery>,
) -> Result<Json<OpenOrder>, (StatusCode, String)> {
    let clob = state.clob_client.as_ref().ok_or_else(clob_not_configured)?;
    let order = clob
        .get_order(&q.order_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(order))
}

async fn get_orders(
    State(state): State<Arc<TradingApiState>>,
    Query(q): Query<OrdersQuery>,
) -> Result<Json<Vec<OpenOrder>>, (StatusCode, String)> {
    let clob = state.clob_client.as_ref().ok_or_else(clob_not_configured)?;
    let orders = clob
        .get_open_orders(q.market.as_deref(), q.asset_id.as_deref())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(orders))
}

async fn get_book(
    State(state): State<Arc<TradingApiState>>,
    Query(q): Query<TokenIdQuery>,
) -> Result<Json<OrderBook>, (StatusCode, String)> {
    let clob = state.clob_client.as_ref().ok_or_else(clob_not_configured)?;
    let book = clob
        .get_book(&q.token_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(book))
}

async fn get_midpoint(
    State(state): State<Arc<TradingApiState>>,
    Query(q): Query<TokenIdQuery>,
) -> Result<Json<MidpointResponse>, (StatusCode, String)> {
    let clob = state.clob_client.as_ref().ok_or_else(clob_not_configured)?;
    let midpoint = clob
        .get_midpoint(&q.token_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(MidpointResponse {
        token_id: q.token_id,
        midpoint: midpoint.to_string(),
    }))
}

async fn approve_collateral(
    State(state): State<Arc<TradingApiState>>,
    Query(q): Query<ApproveQuery>,
) -> Result<Json<Vec<ApprovalResult>>, (StatusCode, String)> {
    let clob = state.clob_client.as_ref().ok_or_else(clob_not_configured)?;

    let rpc_url = q.rpc_url.or_else(|| state.rpc_url.clone()).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "rpc_url required (query param or server config)".into(),
        )
    })?;

    let results = clob
        .approve_collateral(&rpc_url, q.neg_risk)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(results))
}

async fn get_config(
    State(state): State<Arc<TradingApiState>>,
) -> Result<Json<ConfigResponse>, (StatusCode, String)> {
    let clob = state.clob_client.as_ref().ok_or_else(clob_not_configured)?;

    let config = clob
        .contract_config(false)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let neg_config = clob.contract_config(true).ok();

    Ok(Json(ConfigResponse {
        address: format!("{}", clob.address()),
        exchange: format!("{}", config.exchange),
        collateral: format!("{}", config.collateral),
        conditional_tokens: format!("{}", config.conditional_tokens),
        neg_risk_exchange: neg_config.map(|c| format!("{}", c.exchange)),
        neg_risk_adapter: neg_config.and_then(|c| c.neg_risk_adapter.map(|a| format!("{a}"))),
    }))
}
