use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::trade_store;
use crate::TradingApiState;

#[derive(Deserialize)]
pub struct TradeListQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Serialize)]
pub struct TradeListResponse {
    pub trades: Vec<trade_store::TradeRecord>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/trades", get(list_trades))
        .route("/trades/{trade_id}", get(get_trade))
}

async fn list_trades(
    State(state): State<Arc<TradingApiState>>,
    Query(query): Query<TradeListQuery>,
) -> Result<Json<TradeListResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);

    let result = trade_store::trades_for_bot(&state.bot_id, limit, offset)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(TradeListResponse {
        trades: result.trades,
        total: result.total,
        limit,
        offset,
    }))
}

async fn get_trade(
    Path(trade_id): Path<String>,
) -> Result<Json<trade_store::TradeRecord>, (StatusCode, String)> {
    let record = trade_store::get_trade(&trade_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Trade {trade_id} not found")))?;

    Ok(Json(record))
}
