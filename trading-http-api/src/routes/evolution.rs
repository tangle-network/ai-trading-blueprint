use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use trading_runtime::backtest::{BacktestConfig, BacktestEngine, WalkForwardResult};

use crate::candle_store::{self, CandleQuery};
use crate::{MultiBotTradingState, TradingApiState};

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/evolution/run", post(run_evolution))
        .route("/evolution/status", get(get_status))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/evolution/run", post(run_evolution_multi_bot))
        .route("/evolution/status", get(get_status_multi_bot))
}

#[derive(Deserialize)]
pub struct RunEvolutionRequest {
    /// Current strategy config being used.
    pub current: BacktestConfig,
    /// Candidate strategy config to evaluate.
    pub candidate: BacktestConfig,
    /// Token to load candles for (optional — loads all if absent).
    pub token: Option<String>,
    /// Train/test split (0.3–0.9, default 0.7).
    #[serde(default = "default_train_pct")]
    pub train_pct: f64,
}

fn default_train_pct() -> f64 {
    0.7
}

#[derive(Serialize)]
pub struct RunEvolutionResponse {
    pub result: WalkForwardResult,
    pub candles_used: usize,
}

async fn run_evolution(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<RunEvolutionRequest>,
) -> Result<Json<RunEvolutionResponse>, (StatusCode, String)> {
    run_evolution_inner(&state.bot_id, req).await
}

async fn run_evolution_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<RunEvolutionRequest>,
) -> Result<Json<RunEvolutionResponse>, (StatusCode, String)> {
    run_evolution_inner(&bot.bot_id, req).await
}

async fn run_evolution_inner(
    bot_id: &str,
    req: RunEvolutionRequest,
) -> Result<Json<RunEvolutionResponse>, (StatusCode, String)> {
    // Validate candidate harness
    if let Err(errors) = req.candidate.harness.validate() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Invalid candidate harness: {}", errors.join("; ")),
        ));
    }

    // Load candles from store
    let stored = candle_store::query_candles(&CandleQuery {
        bot_id: bot_id.to_string(),
        token: req.token.clone(),
        from: None,
        to: None,
        limit: 100_000,
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if stored.len() < 20 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Not enough candle history for evolution (have {}, need >= 20)",
                stored.len()
            ),
        ));
    }

    let candles: Vec<_> = stored.iter().map(|s| s.to_backtest_candle()).collect();
    let candles_used = candles.len();

    let result = BacktestEngine::walk_forward_compare(
        &req.current,
        &req.candidate,
        &candles,
        &[],
        req.train_pct,
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RunEvolutionResponse {
        result,
        candles_used,
    }))
}

#[derive(Serialize)]
pub struct EvolutionStatusResponse {
    pub bot_id: String,
    pub candles_stored: usize,
    pub tokens: Vec<String>,
}

async fn get_status(
    State(state): State<Arc<TradingApiState>>,
) -> Result<Json<EvolutionStatusResponse>, (StatusCode, String)> {
    get_status_inner(&state.bot_id).await
}

async fn get_status_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
) -> Result<Json<EvolutionStatusResponse>, (StatusCode, String)> {
    get_status_inner(&bot.bot_id).await
}

async fn get_status_inner(
    bot_id: &str,
) -> Result<Json<EvolutionStatusResponse>, (StatusCode, String)> {
    let candles_stored = candle_store::candle_count_for_bot(bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Get unique tokens
    let all = candle_store::query_candles(&CandleQuery {
        bot_id: bot_id.to_string(),
        token: None,
        from: None,
        to: None,
        limit: 100_000,
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let mut tokens: Vec<String> = all.iter().map(|c| c.token.clone()).collect();
    tokens.sort();
    tokens.dedup();

    Ok(Json(EvolutionStatusResponse {
        bot_id: bot_id.to_string(),
        candles_stored,
        tokens,
    }))
}
