use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use trading_runtime::backtest::{BacktestConfig, BacktestEngine, ExitRule, WalkForwardResult};

use crate::candle_store::{self, CandleQuery};
use crate::{MultiBotTradingState, TradingApiState, evolution_store};

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/evolution/run", post(run_evolution))
        .route("/evolution/promotion-gate", post(promotion_gate))
        .route("/evolution/self-improve", post(self_improve))
        .route(
            "/evolution/self-improve/runs",
            get(list_self_improvement_runs),
        )
        .route("/evolution/status", get(get_status))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/evolution/run", post(run_evolution_multi_bot))
        .route("/evolution/promotion-gate", post(promotion_gate_multi_bot))
        .route("/evolution/self-improve", post(self_improve_multi_bot))
        .route(
            "/evolution/self-improve/runs",
            get(list_self_improvement_runs_multi_bot),
        )
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

#[derive(Deserialize)]
pub struct SelfImproveRequest {
    pub user_intent: String,
    pub current: BacktestConfig,
    #[serde(default)]
    pub candidate: Option<BacktestConfig>,
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

#[derive(Serialize)]
pub struct SelfImproveResponse {
    pub run: evolution_store::SelfImprovementRun,
    pub promotion: PromotionGateResponse,
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

async fn self_improve(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<SelfImproveRequest>,
) -> Result<Json<SelfImproveResponse>, (StatusCode, String)> {
    self_improve_inner(&state.bot_id, req).await
}

async fn self_improve_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<SelfImproveRequest>,
) -> Result<Json<SelfImproveResponse>, (StatusCode, String)> {
    self_improve_inner(&bot.bot_id, req).await
}

async fn self_improve_inner(
    bot_id: &str,
    req: SelfImproveRequest,
) -> Result<Json<SelfImproveResponse>, (StatusCode, String)> {
    let user_intent = req.user_intent.trim();
    if user_intent.len() < 12 {
        return Err((
            StatusCode::BAD_REQUEST,
            "user_intent must be at least 12 non-whitespace characters".to_string(),
        ));
    }

    let candidate = match req.candidate {
        Some(candidate) => candidate,
        None => propose_candidate(&req.current, user_intent)?,
    };
    let candidate_json = serde_json::to_value(&candidate).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize candidate: {e}"),
        )
    })?;
    let current_json = serde_json::to_value(&req.current).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize current: {e}"),
        )
    })?;
    let candidate_hash = hash_json(&candidate_json)?;

    let promotion = promotion_gate_inner(
        bot_id,
        PromotionGateRequest {
            current: req.current,
            candidate,
            token: req.token,
            train_pct: req.train_pct,
            paper: req.paper,
            min_paper_trades: req.min_paper_trades,
            max_paper_drawdown_pct: req.max_paper_drawdown_pct,
        },
    )
    .await?
    .0;

    let run = evolution_store::SelfImprovementRun {
        run_id: format!("sir-{}", uuid::Uuid::new_v4()),
        bot_id: bot_id.to_string(),
        created_at: chrono::Utc::now().timestamp(),
        user_intent: user_intent.to_string(),
        candidate_hash,
        approved: promotion.approved,
        status: if promotion.approved {
            "staged_for_operator_approval".to_string()
        } else {
            "blocked".to_string()
        },
        blockers: promotion.blockers.clone(),
        candles_used: promotion.candles_used,
        current_config: current_json,
        candidate_config: candidate_json,
        paper_evidence: promotion
            .paper
            .as_ref()
            .and_then(|paper| serde_json::to_value(paper).ok()),
    };
    evolution_store::insert(run.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SelfImproveResponse { run, promotion }))
}

async fn list_self_improvement_runs(
    State(state): State<Arc<TradingApiState>>,
) -> Result<Json<Vec<evolution_store::SelfImprovementRun>>, (StatusCode, String)> {
    list_self_improvement_runs_inner(&state.bot_id).await
}

async fn list_self_improvement_runs_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
) -> Result<Json<Vec<evolution_store::SelfImprovementRun>>, (StatusCode, String)> {
    list_self_improvement_runs_inner(&bot.bot_id).await
}

async fn list_self_improvement_runs_inner(
    bot_id: &str,
) -> Result<Json<Vec<evolution_store::SelfImprovementRun>>, (StatusCode, String)> {
    let runs = evolution_store::list_for_bot(bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(runs))
}

fn propose_candidate(
    current: &BacktestConfig,
    user_intent: &str,
) -> Result<BacktestConfig, (StatusCode, String)> {
    let mut candidate = current.clone();
    candidate.harness.version = candidate.harness.version.saturating_add(1);

    let intent = user_intent.to_ascii_lowercase();
    let conservative = intent.contains("conservative")
        || intent.contains("safer")
        || intent.contains("reduce risk")
        || intent.contains("lower drawdown");
    let aggressive = intent.contains("aggressive")
        || intent.contains("higher return")
        || intent.contains("more risk");

    candidate.harness.entry_threshold = if conservative {
        (candidate.harness.entry_threshold + 0.05).min(0.95)
    } else if aggressive {
        (candidate.harness.entry_threshold - 0.05).max(0.05)
    } else {
        candidate.harness.entry_threshold
    };

    for rule in &mut candidate.harness.exit_rules {
        match rule {
            ExitRule::StopLoss { pct } if conservative => *pct = (*pct * 0.8).clamp(1.0, 50.0),
            ExitRule::StopLoss { pct } if aggressive => *pct = (*pct * 1.1).clamp(1.0, 50.0),
            ExitRule::TakeProfit { pct } if conservative => *pct = (*pct * 0.9).clamp(1.0, 100.0),
            ExitRule::TakeProfit { pct } if aggressive => *pct = (*pct * 1.15).clamp(1.0, 100.0),
            _ => {}
        }
    }

    candidate.harness.validate().map_err(|errors| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid generated candidate: {}", errors.join("; ")),
        )
    })?;
    Ok(candidate)
}

fn hash_json(value: &serde_json::Value) -> Result<String, (StatusCode, String)> {
    let bytes = serde_json::to_vec(value).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize candidate: {e}"),
        )
    })?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
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
