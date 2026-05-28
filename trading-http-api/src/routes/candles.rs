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
        .route("/market-data/candles/fetch", post(fetch_historical))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/market-data/candles", post(record_candles_multi_bot))
        .route("/market-data/candles", get(get_candles_multi_bot))
        .route(
            "/market-data/candles/fetch",
            post(fetch_historical_multi_bot),
        )
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

// ── Fetch historical candles from a configurable source ────────────────
//
// `source` (optional): one of "hyperliquid", "binance" (default), "coinbase".
// Aliases like "hl"/"cb" and "_perp"/"_spot" suffixes also resolve. Each
// source is implemented in `trading_runtime::candle_sources` and pages
// against its venue's published endpoint (no auth required for any of them).
// Strategies that execute on Hyperliquid should backfill from `hyperliquid`
// — their native fills are what the backtest needs to model.

#[derive(Deserialize)]
pub struct FetchHistoricalRequest {
    pub tokens: Vec<String>,
    #[serde(default = "default_interval")]
    pub interval: String,
    #[serde(default = "default_fetch_limit")]
    pub limit: u32,
    /// Optional venue id. Defaults to `binance` for backwards compatibility
    /// with the prior single-source endpoint. Pass `"hyperliquid"` to pull
    /// HL native candles, or `"coinbase"` for the US-regulated reference.
    #[serde(default)]
    pub source: Option<String>,
}

fn default_interval() -> String {
    "1h".into()
}

fn default_fetch_limit() -> u32 {
    500
}

#[derive(Serialize)]
pub struct FetchHistoricalResponse {
    pub fetched: std::collections::HashMap<String, usize>,
    pub total_stored: usize,
}

fn parse_interval(s: &str) -> Result<trading_runtime::backtest::Interval, (StatusCode, String)> {
    match s {
        "1m" => Ok(trading_runtime::backtest::Interval::Min1),
        "5m" => Ok(trading_runtime::backtest::Interval::Min5),
        "15m" => Ok(trading_runtime::backtest::Interval::Min15),
        "1h" => Ok(trading_runtime::backtest::Interval::Hour1),
        "4h" => Ok(trading_runtime::backtest::Interval::Hour4),
        "1d" => Ok(trading_runtime::backtest::Interval::Day1),
        _ => Err((
            StatusCode::BAD_REQUEST,
            format!("Invalid interval '{s}'. Use: 1m, 5m, 15m, 1h, 4h, 1d"),
        )),
    }
}

async fn fetch_historical(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<FetchHistoricalRequest>,
) -> Result<Json<FetchHistoricalResponse>, (StatusCode, String)> {
    fetch_historical_inner(&state.bot_id, req).await
}

async fn fetch_historical_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<FetchHistoricalRequest>,
) -> Result<Json<FetchHistoricalResponse>, (StatusCode, String)> {
    fetch_historical_inner(&bot.bot_id, req).await
}

async fn fetch_historical_inner(
    bot_id: &str,
    req: FetchHistoricalRequest,
) -> Result<Json<FetchHistoricalResponse>, (StatusCode, String)> {
    if req.tokens.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "tokens array is empty".into()));
    }
    if req.tokens.len() > 20 {
        return Err((StatusCode::BAD_REQUEST, "max 20 tokens per fetch".into()));
    }
    let limit = req.limit.min(5000);
    let interval = parse_interval(&req.interval)?;

    // Dispatch: explicit source overrides the historical Binance default.
    let source = match req.source.as_deref() {
        None | Some("") => trading_runtime::candle_sources::Source::Binance,
        Some(name) => trading_runtime::candle_sources::Source::parse(name)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?,
    };

    let mut fetched = std::collections::HashMap::new();
    let mut total_stored = 0;

    for token in &req.tokens {
        let candles =
            trading_runtime::candle_sources::fetch_from_source(source, token, interval, limit)
                .await
                .map_err(|e| {
                    (
                        StatusCode::BAD_GATEWAY,
                        format!("Fetch failed for {token} from {}: {e}", source.name()),
                    )
                })?;

        let stored: Vec<StoredCandle> = candles
            .iter()
            .map(|c| StoredCandle {
                timestamp: c.timestamp,
                token: c.token.clone(),
                bot_id: bot_id.to_string(),
                open: c.open.to_string(),
                high: c.high.to_string(),
                low: c.low.to_string(),
                close: c.close.to_string(),
                volume: c.volume.to_string(),
            })
            .collect();

        let count = candle_store::record_candles(bot_id, &stored)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

        fetched.insert(token.clone(), count);
        total_stored += count;
    }

    Ok(Json(FetchHistoricalResponse {
        fetched,
        total_stored,
    }))
}
