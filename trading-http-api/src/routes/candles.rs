use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::candle_store::{self, CandleQuery, StoredCandle};
use crate::{MultiBotTradingState, TradingApiState};

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/market-data/candles", post(record_candles))
        .route("/market-data/candles", get(get_candles))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/market-data/candles", post(record_candles_multi_bot))
        .route("/market-data/candles", get(get_candles_multi_bot))
}

#[derive(Deserialize)]
pub struct RecordCandlesRequest {
    pub candles: Vec<CandleInput>,
}

#[derive(Deserialize)]
pub struct CandleInput {
    pub timestamp: i64,
    pub token: String,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: String,
}

#[derive(Serialize)]
pub struct RecordCandlesResponse {
    pub recorded: usize,
}

async fn record_candles(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<RecordCandlesRequest>,
) -> Result<Json<RecordCandlesResponse>, (StatusCode, String)> {
    if req.candles.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "candles array is empty".into()));
    }
    if req.candles.len() > 10_000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "candles batch exceeds 10k limit".into(),
        ));
    }

    let stored: Vec<StoredCandle> = req
        .candles
        .into_iter()
        .map(|c| StoredCandle {
            timestamp: c.timestamp,
            token: c.token,
            bot_id: state.bot_id.clone(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
        })
        .collect();

    let recorded = candle_store::record_candles(&state.bot_id, &stored)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(RecordCandlesResponse { recorded }))
}

async fn record_candles_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<RecordCandlesRequest>,
) -> Result<Json<RecordCandlesResponse>, (StatusCode, String)> {
    if req.candles.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "candles array is empty".into()));
    }
    if req.candles.len() > 10_000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "candles batch exceeds 10k limit".into(),
        ));
    }

    let stored: Vec<StoredCandle> = req
        .candles
        .into_iter()
        .map(|c| StoredCandle {
            timestamp: c.timestamp,
            token: c.token,
            bot_id: bot.bot_id.clone(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
        })
        .collect();

    let recorded = candle_store::record_candles(&bot.bot_id, &stored)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(RecordCandlesResponse { recorded }))
}

#[derive(Deserialize)]
pub struct GetCandlesQuery {
    pub token: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Serialize)]
pub struct GetCandlesResponse {
    pub candles: Vec<StoredCandle>,
    pub total: usize,
}

async fn get_candles(
    State(state): State<Arc<TradingApiState>>,
    Query(query): Query<GetCandlesQuery>,
) -> Result<Json<GetCandlesResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(1000).min(10_000);

    let candles = candle_store::query_candles(&CandleQuery {
        bot_id: state.bot_id.clone(),
        token: query.token,
        from: query.from,
        to: query.to,
        limit,
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let total = candles.len();
    Ok(Json(GetCandlesResponse { candles, total }))
}

async fn get_candles_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Query(query): Query<GetCandlesQuery>,
) -> Result<Json<GetCandlesResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(1000).min(10_000);

    let candles = candle_store::query_candles(&CandleQuery {
        bot_id: bot.bot_id.clone(),
        token: query.token,
        from: query.from,
        to: query.to,
        limit,
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let total = candles.len();
    Ok(Json(GetCandlesResponse { candles, total }))
}
