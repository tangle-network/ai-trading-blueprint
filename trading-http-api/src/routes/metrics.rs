use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::metrics_store::{self, MetricSnapshot};
use crate::TradingApiState;

#[derive(Serialize)]
pub struct BotMetrics {
    pub bot_id: String,
    pub paper_trade: bool,
    pub trading_active: bool,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/metrics", get(get_metrics))
        .route("/metrics/history", get(get_metrics_history))
        .route("/metrics/snapshot", post(post_snapshot))
}

async fn get_metrics(State(state): State<Arc<TradingApiState>>) -> Json<BotMetrics> {
    Json(BotMetrics {
        bot_id: state.bot_id.clone(),
        paper_trade: state.paper_trade,
        trading_active: true,
    })
}

#[derive(Deserialize)]
pub struct MetricsHistoryQuery {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub limit: Option<usize>,
}

#[derive(Serialize)]
pub struct MetricsHistoryResponse {
    pub snapshots: Vec<MetricSnapshot>,
    pub total: usize,
}

async fn get_metrics_history(
    State(state): State<Arc<TradingApiState>>,
    Query(query): Query<MetricsHistoryQuery>,
) -> Result<Json<MetricsHistoryResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(100).min(1000);

    let result = metrics_store::snapshots_for_bot(&state.bot_id, query.from, query.to, limit)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(MetricsHistoryResponse {
        snapshots: result.snapshots,
        total: result.total,
    }))
}

#[derive(Deserialize)]
pub struct SnapshotRequest {
    pub account_value_usd: String,
    #[serde(default)]
    pub unrealized_pnl: String,
    #[serde(default)]
    pub realized_pnl: String,
    #[serde(default)]
    pub high_water_mark: String,
    #[serde(default)]
    pub drawdown_pct: String,
    #[serde(default)]
    pub positions_count: u32,
    #[serde(default)]
    pub trade_count: u32,
}

#[derive(Serialize)]
pub struct SnapshotResponse {
    pub recorded: bool,
    pub timestamp: DateTime<Utc>,
}

async fn post_snapshot(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<SnapshotRequest>,
) -> Result<Json<SnapshotResponse>, (StatusCode, String)> {
    let now = Utc::now();

    let snapshot = MetricSnapshot {
        timestamp: now,
        bot_id: state.bot_id.clone(),
        account_value_usd: req.account_value_usd,
        unrealized_pnl: req.unrealized_pnl,
        realized_pnl: req.realized_pnl,
        high_water_mark: req.high_water_mark,
        drawdown_pct: req.drawdown_pct,
        positions_count: req.positions_count,
        trade_count: req.trade_count,
    };

    metrics_store::record_snapshot(snapshot)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SnapshotResponse {
        recorded: true,
        timestamp: now,
    }))
}
