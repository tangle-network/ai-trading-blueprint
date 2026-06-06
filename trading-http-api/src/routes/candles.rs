use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::candle_store::{self, CandleQuery, StoredCandle};
use crate::{MultiBotTradingState, TradingApiState};

const DEFAULT_CANDLE_LIMIT: usize = 1_000;
const MAX_CANDLE_LIMIT: usize = 10_000;
static CANDLE_REFRESHES_IN_FLIGHT: Lazy<Mutex<HashSet<String>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

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
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
}

#[derive(Deserialize)]
pub struct CandleInput {
    pub timestamp: i64,
    pub token: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
    #[serde(default)]
    pub fetched_at_ms: Option<i64>,
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

    let stored = stored_candles_from_request(&state.bot_id, req);

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

    let stored = stored_candles_from_request(&bot.bot_id, req);

    let recorded = candle_store::record_candles(&bot.bot_id, &stored)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(RecordCandlesResponse { recorded }))
}

#[derive(Deserialize)]
pub struct GetCandlesQuery {
    pub token: Option<String>,
    pub source: Option<String>,
    pub interval: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<usize>,
    pub backfill: Option<bool>,
}

#[derive(Serialize)]
pub struct GetCandlesResponse {
    pub candles: Vec<StoredCandle>,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<String>,
    pub backfilled: bool,
    pub fetched: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backfill_error: Option<String>,
    pub coverage: CandleCoverage,
}

#[derive(Serialize)]
pub struct CandleCoverage {
    pub requested_from: Option<i64>,
    pub requested_to: Option<i64>,
    pub first: Option<i64>,
    pub last: Option<i64>,
    pub candles: usize,
}

async fn get_candles(
    State(state): State<Arc<TradingApiState>>,
    Query(query): Query<GetCandlesQuery>,
) -> Result<Json<GetCandlesResponse>, (StatusCode, String)> {
    get_candles_inner(&state.bot_id, query).await
}

async fn get_candles_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Query(query): Query<GetCandlesQuery>,
) -> Result<Json<GetCandlesResponse>, (StatusCode, String)> {
    get_candles_inner(&bot.bot_id, query).await
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

fn interval_seconds(interval: trading_runtime::backtest::Interval) -> i64 {
    match interval {
        trading_runtime::backtest::Interval::Min1 => 60,
        trading_runtime::backtest::Interval::Min5 => 5 * 60,
        trading_runtime::backtest::Interval::Min15 => 15 * 60,
        trading_runtime::backtest::Interval::Hour1 => 60 * 60,
        trading_runtime::backtest::Interval::Hour4 => 4 * 60 * 60,
        trading_runtime::backtest::Interval::Day1 => 24 * 60 * 60,
    }
}

fn expected_candle_count(
    query: &GetCandlesQuery,
    interval: trading_runtime::backtest::Interval,
) -> Option<usize> {
    let from = query.from?;
    let to = query.to.unwrap_or_else(|| Utc::now().timestamp());
    if to <= from {
        return None;
    }
    let interval_secs = interval_seconds(interval).max(1);
    Some(((to - from) / interval_secs + 1) as usize)
}

fn resolved_candle_limit(query: &GetCandlesQuery) -> usize {
    if let Some(limit) = query.limit {
        return limit.min(MAX_CANDLE_LIMIT);
    }

    let interval = query.interval.as_deref().unwrap_or("1h");
    expected_candle_count(
        query,
        parse_interval(interval)
            .ok()
            .unwrap_or(trading_runtime::backtest::Interval::Hour1),
    )
    .unwrap_or(DEFAULT_CANDLE_LIMIT)
    .clamp(DEFAULT_CANDLE_LIMIT, MAX_CANDLE_LIMIT)
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn stored_candles_from_request(bot_id: &str, req: RecordCandlesRequest) -> Vec<StoredCandle> {
    let request_source = normalize_optional(req.source);
    let request_interval = normalize_optional(req.interval);
    req.candles
        .into_iter()
        .map(|c| StoredCandle {
            timestamp: c.timestamp,
            token: c.token,
            bot_id: bot_id.to_string(),
            source: normalize_optional(c.source).or_else(|| request_source.clone()),
            interval: normalize_optional(c.interval).or_else(|| request_interval.clone()),
            fetched_at_ms: c.fetched_at_ms,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackfillDecision {
    None,
    Blocking,
    BackgroundRefresh,
}

fn backfill_decision(
    existing: &[StoredCandle],
    query: &GetCandlesQuery,
    limit: usize,
    interval: trading_runtime::backtest::Interval,
) -> BackfillDecision {
    if existing.is_empty() {
        return BackfillDecision::Blocking;
    }
    if existing.len() < limit.min(20) {
        return BackfillDecision::Blocking;
    }

    let interval_secs = interval_seconds(interval);
    let target_to = query.to.unwrap_or_else(|| Utc::now().timestamp());
    if let Some(expected_count) = expected_candle_count(query, interval) {
        let desired_count = expected_count.min(limit);
        let minimum_count = ((desired_count as f64) * 0.9).ceil() as usize;
        if existing.len() < minimum_count.max(20).min(desired_count) {
            return BackfillDecision::Blocking;
        }

        let required_from = if desired_count >= expected_count {
            query.from
        } else {
            Some(target_to.saturating_sub((desired_count.saturating_sub(1) as i64) * interval_secs))
        };
        if let Some(required_from) = required_from {
            let earliest = existing
                .iter()
                .map(|candle| candle.timestamp)
                .min()
                .unwrap_or_default();
            if earliest > required_from + interval_secs {
                return BackfillDecision::Blocking;
            }
        }
    }

    let stale_threshold_secs = (interval_secs * 2).max(5 * 60);
    let latest = existing
        .iter()
        .map(|candle| candle.timestamp)
        .max()
        .unwrap_or_default();
    if latest + stale_threshold_secs < target_to {
        return BackfillDecision::BackgroundRefresh;
    }

    BackfillDecision::None
}

#[cfg(test)]
fn should_backfill(
    existing: &[StoredCandle],
    query: &GetCandlesQuery,
    limit: usize,
    interval: trading_runtime::backtest::Interval,
) -> bool {
    backfill_decision(existing, query, limit, interval) != BackfillDecision::None
}

fn query_stored_candles(
    bot_id: &str,
    query: &GetCandlesQuery,
    source: Option<String>,
    interval: Option<String>,
    limit: usize,
) -> Result<Vec<StoredCandle>, (StatusCode, String)> {
    candle_store::query_candles(&CandleQuery {
        bot_id: bot_id.to_string(),
        token: normalize_optional(query.token.clone()),
        source,
        interval,
        from: query.from,
        to: query.to,
        limit,
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn fetch_and_store_candles(
    bot_id: &str,
    token: &str,
    source: trading_runtime::candle_sources::Source,
    interval: trading_runtime::backtest::Interval,
    interval_text: &str,
    limit: usize,
) -> Result<usize, String> {
    let candles = trading_runtime::candle_sources::fetch_from_source(
        source,
        token,
        interval,
        limit.min(5_000) as u32,
    )
    .await
    .map_err(|err| format!("Fetch failed for {token} from {}: {err}", source.name()))?;
    let fetched_at_ms = Utc::now().timestamp_millis();
    let stored: Vec<StoredCandle> = candles
        .iter()
        .map(|c| StoredCandle {
            timestamp: c.timestamp,
            token: c.token.clone(),
            bot_id: bot_id.to_string(),
            source: Some(source.name().to_string()),
            interval: Some(interval_text.to_string()),
            fetched_at_ms: Some(fetched_at_ms),
            open: c.open.to_string(),
            high: c.high.to_string(),
            low: c.low.to_string(),
            close: c.close.to_string(),
            volume: c.volume.to_string(),
        })
        .collect();

    candle_store::record_candles(bot_id, &stored).map_err(|e| e.to_string())
}

fn candle_refresh_key(bot_id: &str, token: &str, source: &str, interval: &str) -> String {
    format!(
        "{}:{}:{}:{}",
        bot_id,
        token.trim().to_ascii_lowercase(),
        source.trim().to_ascii_lowercase(),
        interval.trim().to_ascii_lowercase()
    )
}

fn spawn_stale_candle_refresh(
    bot_id: String,
    token: String,
    source: trading_runtime::candle_sources::Source,
    interval: trading_runtime::backtest::Interval,
    interval_text: String,
    limit: usize,
) {
    let key = candle_refresh_key(&bot_id, &token, source.name(), &interval_text);
    let should_spawn = CANDLE_REFRESHES_IN_FLIGHT
        .lock()
        .map(|mut in_flight| in_flight.insert(key.clone()))
        .unwrap_or(false);
    if !should_spawn {
        return;
    }

    tokio::spawn(async move {
        let result =
            fetch_and_store_candles(&bot_id, &token, source, interval, &interval_text, limit).await;
        if let Err(err) = result {
            tracing::warn!(
                bot_id = %bot_id,
                token = %token,
                source = source.name(),
                interval = %interval_text,
                error = %err,
                "background chart candle refresh failed"
            );
        }
        if let Ok(mut in_flight) = CANDLE_REFRESHES_IN_FLIGHT.lock() {
            in_flight.remove(&key);
        }
    });
}

async fn get_candles_inner(
    bot_id: &str,
    query: GetCandlesQuery,
) -> Result<Json<GetCandlesResponse>, (StatusCode, String)> {
    resolve_candles_for_bot(bot_id, query).await.map(Json)
}

pub async fn resolve_candles_for_bot(
    bot_id: &str,
    query: GetCandlesQuery,
) -> Result<GetCandlesResponse, (StatusCode, String)> {
    let limit = resolved_candle_limit(&query);
    let mut response_source = normalize_optional(query.source.clone());
    let mut response_interval = normalize_optional(query.interval.clone());
    let mut backfilled = false;
    let mut fetched = 0usize;
    let mut backfill_error = None;

    if query.backfill.unwrap_or(false)
        && let Some(token) = normalize_optional(query.token.clone())
    {
        let source = response_source
            .as_deref()
            .map(trading_runtime::candle_sources::Source::parse)
            .transpose()
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?
            .unwrap_or(trading_runtime::candle_sources::Source::Binance);
        let interval_text = response_interval.clone().unwrap_or_else(default_interval);
        let interval = parse_interval(&interval_text)?;
        response_source = Some(source.name().to_string());
        response_interval = Some(interval_text.clone());

        let existing = query_stored_candles(
            bot_id,
            &query,
            response_source.clone(),
            response_interval.clone(),
            limit,
        )?;

        match backfill_decision(&existing, &query, limit, interval) {
            BackfillDecision::Blocking => {
                match fetch_and_store_candles(
                    bot_id,
                    &token,
                    source,
                    interval,
                    &interval_text,
                    limit,
                )
                .await
                {
                    Ok(recorded) => {
                        fetched = recorded;
                        backfilled = fetched > 0;
                    }
                    Err(err) => {
                        backfill_error = Some(err.clone());
                        tracing::warn!(
                            bot_id = %bot_id,
                            token = %token,
                            source = source.name(),
                            interval = %interval_text,
                            error = %err,
                            "chart candle read-through backfill failed"
                        );
                    }
                }
            }
            BackfillDecision::BackgroundRefresh => {
                spawn_stale_candle_refresh(
                    bot_id.to_string(),
                    token,
                    source,
                    interval,
                    interval_text,
                    limit,
                );
            }
            BackfillDecision::None => {}
        }
    }

    let candles = query_stored_candles(
        bot_id,
        &query,
        response_source.clone(),
        response_interval.clone(),
        limit,
    )?;
    let total = candles.len();
    let coverage = CandleCoverage {
        requested_from: query.from,
        requested_to: query.to,
        first: candles.first().map(|candle| candle.timestamp),
        last: candles.last().map(|candle| candle.timestamp),
        candles: total,
    };

    Ok(GetCandlesResponse {
        candles,
        total,
        source: response_source,
        interval: response_interval,
        backfilled,
        fetched,
        backfill_error,
        coverage,
    })
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

        let fetched_at_ms = Utc::now().timestamp_millis();
        let stored: Vec<StoredCandle> = candles
            .iter()
            .map(|c| StoredCandle {
                timestamp: c.timestamp,
                token: c.token.clone(),
                bot_id: bot_id.to_string(),
                source: Some(source.name().to_string()),
                interval: Some(req.interval.clone()),
                fetched_at_ms: Some(fetched_at_ms),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn candle(timestamp: i64) -> StoredCandle {
        StoredCandle {
            timestamp,
            token: "ETH".to_string(),
            bot_id: "bot-1".to_string(),
            source: Some("hyperliquid".to_string()),
            interval: Some("15m".to_string()),
            fetched_at_ms: Some(timestamp * 1000),
            open: "3000".to_string(),
            high: "3010".to_string(),
            low: "2990".to_string(),
            close: "3005".to_string(),
            volume: "10".to_string(),
        }
    }

    #[test]
    fn resolved_limit_expands_to_requested_window() {
        let from = 1_700_000_000;
        let to = from + 30 * 24 * 60 * 60;
        let query = GetCandlesQuery {
            token: Some("ETH".to_string()),
            source: Some("hyperliquid".to_string()),
            interval: Some("15m".to_string()),
            from: Some(from),
            to: Some(to),
            limit: None,
            backfill: Some(true),
        };

        assert_eq!(resolved_candle_limit(&query), 2_881);
    }

    #[test]
    fn resolved_limit_honors_explicit_cap() {
        let query = GetCandlesQuery {
            token: Some("ETH".to_string()),
            source: Some("hyperliquid".to_string()),
            interval: Some("15m".to_string()),
            from: Some(1_700_000_000),
            to: Some(1_700_000_000 + 30 * 24 * 60 * 60),
            limit: Some(50_000),
            backfill: Some(true),
        };

        assert_eq!(resolved_candle_limit(&query), MAX_CANDLE_LIMIT);
    }

    #[test]
    fn backfills_fresh_but_shallow_cache_that_misses_requested_start() {
        let interval = trading_runtime::backtest::Interval::Min15;
        let to = 1_700_000_000;
        let from = to - 30 * 24 * 60 * 60;
        let query = GetCandlesQuery {
            token: Some("ETH".to_string()),
            source: Some("hyperliquid".to_string()),
            interval: Some("15m".to_string()),
            from: Some(from),
            to: Some(to),
            limit: Some(8_640),
            backfill: Some(true),
        };
        let existing: Vec<StoredCandle> = (0..80)
            .map(|index| candle(to - (79 - index) * 15 * 60))
            .collect();

        assert!(should_backfill(&existing, &query, 8_640, interval));
        assert_eq!(
            backfill_decision(&existing, &query, 8_640, interval),
            BackfillDecision::Blocking
        );
    }

    #[test]
    fn does_not_backfill_when_cache_covers_requested_window() {
        let interval = trading_runtime::backtest::Interval::Min15;
        let to = 1_700_000_000;
        let from = to - 30 * 24 * 60 * 60;
        let query = GetCandlesQuery {
            token: Some("ETH".to_string()),
            source: Some("hyperliquid".to_string()),
            interval: Some("15m".to_string()),
            from: Some(from),
            to: Some(to),
            limit: Some(8_640),
            backfill: Some(true),
        };
        let existing: Vec<StoredCandle> = (0..2_881)
            .map(|index| candle(from + index * 15 * 60))
            .collect();

        assert!(!should_backfill(&existing, &query, 8_640, interval));
        assert_eq!(
            backfill_decision(&existing, &query, 8_640, interval),
            BackfillDecision::None
        );
    }

    #[test]
    fn explicit_small_limit_checks_latest_window_not_full_from_to_span() {
        let interval = trading_runtime::backtest::Interval::Min15;
        let to = 1_700_000_000;
        let from = to - 30 * 24 * 60 * 60;
        let query = GetCandlesQuery {
            token: Some("ETH".to_string()),
            source: Some("hyperliquid".to_string()),
            interval: Some("15m".to_string()),
            from: Some(from),
            to: Some(to),
            limit: Some(120),
            backfill: Some(true),
        };
        let existing: Vec<StoredCandle> = (0..120)
            .map(|index| candle(to - (119 - index) * 15 * 60))
            .collect();

        assert!(!should_backfill(&existing, &query, 120, interval));
        assert_eq!(
            backfill_decision(&existing, &query, 120, interval),
            BackfillDecision::None
        );
    }

    #[test]
    fn stale_but_covered_cache_refreshes_in_background() {
        let interval = trading_runtime::backtest::Interval::Min15;
        let to = 1_700_000_000;
        let from = to - 30 * 24 * 60 * 60;
        let query = GetCandlesQuery {
            token: Some("ETH".to_string()),
            source: Some("hyperliquid".to_string()),
            interval: Some("15m".to_string()),
            from: Some(from),
            to: Some(to),
            limit: Some(8_640),
            backfill: Some(true),
        };
        let stale_to = to - 60 * 60;
        let existing: Vec<StoredCandle> = (0..2_881)
            .map(|index| candle(stale_to - (2_880 - index) * 15 * 60))
            .collect();

        assert!(should_backfill(&existing, &query, 8_640, interval));
        assert_eq!(
            backfill_decision(&existing, &query, 8_640, interval),
            BackfillDecision::BackgroundRefresh
        );
    }
}
