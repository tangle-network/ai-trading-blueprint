use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use trading_runtime::backtest::{
    BacktestComparison, BacktestConfig, BacktestEngine, BacktestResult, Candle, FundingSnapshot,
    WalkForwardResult,
};

use crate::{MultiBotTradingState, TradingApiState};

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/backtest/run", post(run_backtest))
        .route("/backtest/compare", post(compare_backtest))
        .route("/backtest/walk-forward", post(walk_forward_backtest))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/backtest/run", post(run_backtest))
        .route("/backtest/compare", post(compare_backtest))
        .route("/backtest/walk-forward", post(walk_forward_backtest))
}

#[derive(Deserialize)]
pub struct RunRequest {
    pub config: BacktestConfig,
    pub candles: Vec<Candle>,
    #[serde(default)]
    pub funding: Vec<FundingSnapshot>,
}

#[derive(Serialize)]
pub struct RunResponse {
    pub result: BacktestResult,
}

async fn run_backtest(
    Json(req): Json<RunRequest>,
) -> Result<Json<RunResponse>, (StatusCode, String)> {
    validate_candles(&req.candles)?;

    let engine = BacktestEngine::new(req.config);
    let result = engine
        .run(&req.candles, &req.funding)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RunResponse { result }))
}

#[derive(Deserialize)]
pub struct CompareRequest {
    pub current: BacktestConfig,
    pub candidate: BacktestConfig,
    pub candles: Vec<Candle>,
    #[serde(default)]
    pub funding: Vec<FundingSnapshot>,
}

#[derive(Serialize)]
pub struct CompareResponse {
    pub comparison: BacktestComparison,
    pub should_promote: bool,
}

async fn compare_backtest(
    Json(req): Json<CompareRequest>,
) -> Result<Json<CompareResponse>, (StatusCode, String)> {
    validate_candles(&req.candles)?;

    let comparison =
        BacktestEngine::compare(&req.current, &req.candidate, &req.candles, &req.funding)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let should_promote = comparison.should_promote();
    Ok(Json(CompareResponse {
        comparison,
        should_promote,
    }))
}

#[derive(Deserialize)]
pub struct WalkForwardRequest {
    pub current: BacktestConfig,
    pub candidate: BacktestConfig,
    pub candles: Vec<Candle>,
    #[serde(default)]
    pub funding: Vec<FundingSnapshot>,
    /// Train/test split ratio (0.3–0.9). Defaults to 0.7.
    #[serde(default = "default_train_pct")]
    pub train_pct: f64,
}

fn default_train_pct() -> f64 {
    0.7
}

#[derive(Serialize)]
pub struct WalkForwardResponse {
    pub result: WalkForwardResult,
}

async fn walk_forward_backtest(
    Json(req): Json<WalkForwardRequest>,
) -> Result<Json<WalkForwardResponse>, (StatusCode, String)> {
    validate_candles(&req.candles)?;

    let result = BacktestEngine::walk_forward_compare(
        &req.current,
        &req.candidate,
        &req.candles,
        &req.funding,
        req.train_pct,
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(WalkForwardResponse { result }))
}

fn validate_candles(candles: &[Candle]) -> Result<(), (StatusCode, String)> {
    if candles.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "candles array is empty".into()));
    }
    if candles.len() > 100_000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "candles array exceeds 100k limit".into(),
        ));
    }
    Ok(())
}
