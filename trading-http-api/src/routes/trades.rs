use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::trade_store;
use crate::{MultiBotTradingState, TradingApiState};

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
    pub evidence: trade_store::TradeCountEvidence,
}

#[derive(Deserialize)]
pub struct PlatformVolumeQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub bucket: Option<String>,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/trades", get(list_trades))
        .route("/trades/{trade_id}", get(get_trade))
        .route("/platform/trades", get(get_platform_trades))
        .route("/platform/volume", get(get_platform_volume))
}

/// Router for multi-bot mode (state = MultiBotTradingState, bot resolved from extensions).
pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/trades", get(list_trades_multi_bot))
        .route("/trades/{trade_id}", get(get_trade))
        .route("/platform/trades", get(get_platform_trades))
        .route("/platform/volume", get(get_platform_volume))
}

pub fn resolve_platform_trades(
    query: &TradeListQuery,
) -> Result<TradeListResponse, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);

    let result = trade_store::platform_trades(limit, offset)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(TradeListResponse {
        trades: result.trades,
        total: result.total,
        limit,
        offset,
        evidence: result.evidence,
    })
}

pub fn resolve_platform_volume(
    query: &PlatformVolumeQuery,
) -> Result<trade_store::PlatformVolumeResponse, (StatusCode, String)> {
    let to = parse_optional_rfc3339(query.to.as_deref(), "to")?.unwrap_or_else(Utc::now);
    let from = parse_optional_rfc3339(query.from.as_deref(), "from")?
        .unwrap_or_else(|| to - chrono::Duration::days(30));
    let bucket = trade_store::PlatformVolumeBucketSize::parse(query.bucket.as_deref())
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    trade_store::platform_volume(from, to, bucket).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

fn parse_optional_rfc3339(
    value: Option<&str>,
    field: &str,
) -> Result<Option<DateTime<Utc>>, (StatusCode, String)> {
    match value {
        Some(raw) => DateTime::parse_from_rfc3339(raw)
            .map(|parsed| Some(parsed.with_timezone(&Utc)))
            .map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    format!("{field} must be an RFC3339 timestamp: {e}"),
                )
            }),
        None => Ok(None),
    }
}

async fn get_platform_volume(
    Query(query): Query<PlatformVolumeQuery>,
) -> Result<Json<trade_store::PlatformVolumeResponse>, (StatusCode, String)> {
    resolve_platform_volume(&query).map(Json)
}

async fn get_platform_trades(
    Query(query): Query<TradeListQuery>,
) -> Result<Json<TradeListResponse>, (StatusCode, String)> {
    resolve_platform_trades(&query).map(Json)
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
        evidence: result.evidence,
    }))
}

async fn list_trades_multi_bot(
    Extension(bot): Extension<crate::BotContext>,
    Query(query): Query<TradeListQuery>,
) -> Result<Json<TradeListResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);

    let result = trade_store::trades_for_bot(&bot.bot_id, limit, offset)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(TradeListResponse {
        trades: result.trades,
        total: result.total,
        limit,
        offset,
        evidence: result.evidence,
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
