use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::live_portfolio::{LiveRiskInput, reconcile_live_portfolio, snapshot_to_metric};
use crate::metrics_store::{self, MetricSnapshot};
use crate::routes::portfolio::{PortfolioResponse, build_multi_bot_portfolio_response};
use crate::trade_store;
use crate::{MultiBotTradingState, TradingApiState};

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

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/metrics", get(get_metrics_multi_bot))
        .route("/metrics/history", get(get_metrics_history_multi_bot))
        .route("/metrics/snapshot", post(post_snapshot_multi_bot))
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
    record_snapshot_for_bot(&state.bot_id, req)
}

async fn get_metrics_multi_bot(
    axum::Extension(bot): axum::Extension<crate::BotContext>,
) -> Json<BotMetrics> {
    Json(BotMetrics {
        bot_id: bot.bot_id,
        paper_trade: bot.paper_trade,
        trading_active: true,
    })
}

async fn get_metrics_history_multi_bot(
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    State(state): State<Arc<MultiBotTradingState>>,
    Query(query): Query<MetricsHistoryQuery>,
) -> Result<Json<MetricsHistoryResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(100).min(1000);

    let mut result = metrics_store::snapshots_for_bot(&bot.bot_id, query.from, query.to, limit)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Some older successful executions recorded trades without persisting a
    // metrics snapshot. Backfill one from the current portfolio view so the
    // performance tab can recover without waiting for the next run.
    if result.total == 0
        && trade_store::trades_for_bot(&bot.bot_id, 1, 0)
            .ok()
            .map(|page| page.total > 0)
            .unwrap_or(false)
    {
        if let Err(error) =
            backfill_initial_snapshot_for_bot(&bot, &state.market_data_base_url).await
        {
            tracing::warn!(
                bot_id = %bot.bot_id,
                %error,
                "failed to backfill initial metrics snapshot"
            );
        } else {
            result = metrics_store::snapshots_for_bot(&bot.bot_id, query.from, query.to, limit)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
    }

    Ok(Json(MetricsHistoryResponse {
        snapshots: result.snapshots,
        total: result.total,
    }))
}

async fn post_snapshot_multi_bot(
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<SnapshotRequest>,
) -> Result<Json<SnapshotResponse>, (StatusCode, String)> {
    record_snapshot_for_bot(&bot.bot_id, req)
}

fn record_snapshot_for_bot(
    bot_id: &str,
    req: SnapshotRequest,
) -> Result<Json<SnapshotResponse>, (StatusCode, String)> {
    let now = Utc::now();

    let snapshot = MetricSnapshot {
        timestamp: now,
        bot_id: bot_id.to_string(),
        account_value_usd: req.account_value_usd,
        unrealized_pnl: req.unrealized_pnl,
        realized_pnl: req.realized_pnl,
        high_water_mark: req.high_water_mark,
        drawdown_pct: req.drawdown_pct,
        positions_count: req.positions_count,
        trade_count: req.trade_count,
    };

    metrics_store::record_snapshot(snapshot).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SnapshotResponse {
        recorded: true,
        timestamp: now,
    }))
}

pub(crate) async fn capture_metrics_snapshot_for_bot(
    bot: &crate::BotContext,
    market_data_base_url: &str,
) -> Result<MetricSnapshot, String> {
    if !bot.paper_trade {
        let input = LiveRiskInput::from_bot(bot, market_data_base_url);
        let live = reconcile_live_portfolio(&input)
            .await
            .map_err(|(_, message)| message)?;
        let trade_count = trade_store::trades_for_bot(&bot.bot_id, 1, 0)?.total as u32;
        let snapshot = snapshot_to_metric(&live, trade_count);
        metrics_store::record_snapshot(snapshot.clone())?;
        return Ok(snapshot);
    }

    let portfolio = build_multi_bot_portfolio_response(bot, market_data_base_url).await;
    let previous = metrics_store::latest_snapshot_for_bot(&bot.bot_id)?;
    let trade_count = trade_store::trades_for_bot(&bot.bot_id, 1, 0)?.total as u32;

    let snapshot = build_snapshot_from_portfolio(
        &bot.bot_id,
        &bot.strategy_config,
        &portfolio,
        trade_count,
        previous.as_ref(),
    );
    metrics_store::record_snapshot(snapshot.clone())?;
    Ok(snapshot)
}

async fn backfill_initial_snapshot_for_bot(
    bot: &crate::BotContext,
    market_data_base_url: &str,
) -> Result<Option<MetricSnapshot>, String> {
    if metrics_store::latest_snapshot_for_bot(&bot.bot_id)?.is_some() {
        return Ok(None);
    }

    capture_metrics_snapshot_for_bot(bot, market_data_base_url)
        .await
        .map(Some)
}

fn build_snapshot_from_portfolio(
    bot_id: &str,
    strategy_config: &serde_json::Value,
    portfolio: &PortfolioResponse,
    trade_count: u32,
    previous: Option<&MetricSnapshot>,
) -> MetricSnapshot {
    let now = Utc::now();
    let account_value = parse_decimal(&portfolio.total_value_usd).unwrap_or(Decimal::ZERO);
    let baseline = initial_capital_usd(strategy_config).unwrap_or(account_value);
    let total_pnl = account_value - baseline;
    let realized_pnl = previous
        .and_then(|snapshot| parse_decimal(&snapshot.realized_pnl))
        .unwrap_or(Decimal::ZERO);
    let unrealized_pnl = total_pnl - realized_pnl;

    let previous_hwm = previous
        .and_then(|snapshot| parse_decimal(&snapshot.high_water_mark))
        .unwrap_or(baseline.max(account_value));
    let high_water_mark = previous_hwm.max(account_value).max(baseline);
    let drawdown_pct = if high_water_mark > Decimal::ZERO {
        ((high_water_mark - account_value) / high_water_mark) * Decimal::new(100, 0)
    } else {
        Decimal::ZERO
    };

    MetricSnapshot {
        timestamp: now,
        bot_id: bot_id.to_string(),
        account_value_usd: account_value.to_string(),
        unrealized_pnl: unrealized_pnl.to_string(),
        realized_pnl: realized_pnl.to_string(),
        high_water_mark: high_water_mark.to_string(),
        drawdown_pct: drawdown_pct.to_string(),
        positions_count: portfolio.positions.len() as u32,
        trade_count,
    }
}

fn initial_capital_usd(strategy_config: &serde_json::Value) -> Option<Decimal> {
    strategy_config
        .as_object()
        .and_then(|strategy| {
            strategy
                .get("initial_capital_usd")
                .or_else(|| strategy.get("initial_capital"))
                .or_else(|| strategy.get("cash_balance"))
        })
        .and_then(|value| match value {
            serde_json::Value::String(value) => parse_decimal(value),
            serde_json::Value::Number(value) => parse_decimal(&value.to_string()),
            _ => None,
        })
}

fn parse_decimal(value: &str) -> Option<Decimal> {
    value.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_portfolio(total_value_usd: &str) -> PortfolioResponse {
        PortfolioResponse {
            positions: Vec::new(),
            total_value_usd: total_value_usd.to_string(),
            cash_balance: Some("10000".to_string()),
            unrealized_pnl: "0".to_string(),
            realized_pnl: "0".to_string(),
            warnings: Vec::new(),
            has_unpriced_positions: false,
            has_value_only_positions: false,
            source: Some("test".to_string()),
            observed_at: None,
            stale: false,
        }
    }

    #[test]
    fn initial_capital_uses_string_or_number_values() {
        let string_config = serde_json::json!({ "initial_capital_usd": "10000.5" });
        let number_config = serde_json::json!({ "initial_capital": 7500 });

        assert_eq!(
            initial_capital_usd(&string_config),
            Some(Decimal::new(100005, 1))
        );
        assert_eq!(
            initial_capital_usd(&number_config),
            Some(Decimal::new(7500, 0))
        );
    }

    #[test]
    fn build_snapshot_derives_pnl_from_initial_capital_and_hwm() {
        let strategy = serde_json::json!({ "initial_capital_usd": "10000" });
        let previous = MetricSnapshot {
            timestamp: Utc::now(),
            bot_id: "bot-1".to_string(),
            account_value_usd: "10050".to_string(),
            unrealized_pnl: "50".to_string(),
            realized_pnl: "0".to_string(),
            high_water_mark: "10050".to_string(),
            drawdown_pct: "0".to_string(),
            positions_count: 1,
            trade_count: 1,
        };

        let snapshot = build_snapshot_from_portfolio(
            "bot-1",
            &strategy,
            &sample_portfolio("10025"),
            2,
            Some(&previous),
        );

        assert_eq!(snapshot.account_value_usd, "10025");
        assert_eq!(snapshot.unrealized_pnl, "25");
        assert_eq!(snapshot.realized_pnl, "0");
        assert_eq!(snapshot.high_water_mark, "10050");
        assert!(
            snapshot
                .drawdown_pct
                .starts_with("0.248756218905472636815920")
        );
        assert_eq!(snapshot.trade_count, 2);
    }
}
