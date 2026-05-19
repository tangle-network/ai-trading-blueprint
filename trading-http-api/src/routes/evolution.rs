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
        .route("/evolution/promotion-gate", post(promotion_gate))
        .route("/evolution/status", get(get_status))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/evolution/run", post(run_evolution_multi_bot))
        .route("/evolution/promotion-gate", post(promotion_gate_multi_bot))
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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PaperEvidence {
    /// Number of paper trades observed for this exact candidate strategy version.
    pub trades: u64,
    /// Realized paper return percentage over the paper evaluation window.
    pub total_return_pct: f64,
    /// Maximum drawdown percentage observed during paper evaluation.
    pub max_drawdown_pct: f64,
    /// Optional candidate strategy/config/content hash. Returned for auditability.
    #[serde(default)]
    pub candidate_hash: Option<String>,
}

#[derive(Deserialize)]
pub struct PromotionGateRequest {
    pub current: BacktestConfig,
    pub candidate: BacktestConfig,
    pub token: Option<String>,
    #[serde(default = "default_train_pct")]
    pub train_pct: f64,
    #[serde(default)]
    pub paper: Option<PaperEvidence>,
    #[serde(default = "default_min_paper_trades")]
    pub min_paper_trades: u64,
    #[serde(default = "default_max_paper_drawdown_pct")]
    pub max_paper_drawdown_pct: f64,
}

fn default_min_paper_trades() -> u64 {
    20
}

fn default_max_paper_drawdown_pct() -> f64 {
    10.0
}

#[derive(Serialize)]
pub struct PromotionGateResponse {
    pub bot_id: String,
    pub approved: bool,
    pub blockers: Vec<String>,
    pub result: WalkForwardResult,
    pub candles_used: usize,
    pub paper: Option<PaperEvidence>,
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

async fn promotion_gate(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<PromotionGateRequest>,
) -> Result<Json<PromotionGateResponse>, (StatusCode, String)> {
    promotion_gate_inner(&state.bot_id, req).await
}

async fn promotion_gate_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<PromotionGateRequest>,
) -> Result<Json<PromotionGateResponse>, (StatusCode, String)> {
    promotion_gate_inner(&bot.bot_id, req).await
}

async fn promotion_gate_inner(
    bot_id: &str,
    req: PromotionGateRequest,
) -> Result<Json<PromotionGateResponse>, (StatusCode, String)> {
    let paper = req.paper.clone();
    let run = run_evolution_inner(
        bot_id,
        RunEvolutionRequest {
            current: req.current,
            candidate: req.candidate,
            token: req.token,
            train_pct: req.train_pct,
        },
    )
    .await?
    .0;

    let mut blockers = Vec::new();
    if !run.result.should_promote {
        blockers.push("walk-forward backtest did not approve candidate".to_string());
    }
    if run.result.likely_overfit {
        blockers.push("candidate is likely overfit out-of-sample".to_string());
    }

    match paper.as_ref() {
        Some(p) => {
            if p.trades < req.min_paper_trades {
                blockers.push(format!(
                    "paper trading evidence has {} trades; need at least {}",
                    p.trades, req.min_paper_trades
                ));
            }
            if !p.total_return_pct.is_finite() || p.total_return_pct <= 0.0 {
                blockers.push("paper trading return must be positive and finite".to_string());
            }
            if !p.max_drawdown_pct.is_finite() || p.max_drawdown_pct > req.max_paper_drawdown_pct {
                blockers.push(format!(
                    "paper max drawdown {:.2}% exceeds {:.2}% limit",
                    p.max_drawdown_pct, req.max_paper_drawdown_pct
                ));
            }
        }
        None => blockers.push("missing paper trading evidence for candidate".to_string()),
    }

    Ok(Json(PromotionGateResponse {
        bot_id: bot_id.to_string(),
        approved: blockers.is_empty(),
        blockers,
        result: run.result,
        candles_used: run.candles_used,
        paper,
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
