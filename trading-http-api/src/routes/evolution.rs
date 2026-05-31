use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

use trading_runtime::backtest::{BacktestConfig, BacktestEngine, ExitRule, WalkForwardResult};

use crate::candle_store::{self, CandleQuery};
use crate::{
    MultiBotTradingState, TradingApiState, evolution_store, risk_budget, sandbox_store, trade_store,
};

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/evolution/run", post(run_evolution))
        .route("/evolution/promotion-gate", post(promotion_gate))
        .route(
            "/evolution/risk-budget/decisions/{decision_id}",
            get(get_risk_budget_decision),
        )
        .route(
            "/evolution/risk-budget/reports/{report_id}",
            get(get_evidence_report),
        )
        .route("/evolution/self-improve", post(self_improve))
        .route(
            "/evolution/self-improve/runs",
            get(list_self_improvement_runs),
        )
        .route("/evolution/sandbox/snapshot", post(create_sandbox_snapshot))
        .route(
            "/evolution/sandbox/revisions",
            post(create_sandbox_revision),
        )
        .route(
            "/evolution/sandbox/revisions/{revision_id}/activate",
            post(activate_sandbox_revision),
        )
        .route("/evolution/sandbox/rollback", post(rollback_sandbox))
        .route("/evolution/sandbox/lineage", get(get_sandbox_lineage))
        .route("/evolution/revision-arena", get(get_revision_arena))
        .route("/evolution/status", get(get_status))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/evolution/run", post(run_evolution_multi_bot))
        .route("/evolution/promotion-gate", post(promotion_gate_multi_bot))
        .route(
            "/evolution/risk-budget/decisions/{decision_id}",
            get(get_risk_budget_decision_multi_bot),
        )
        .route(
            "/evolution/risk-budget/reports/{report_id}",
            get(get_evidence_report_multi_bot),
        )
        .route("/evolution/self-improve", post(self_improve_multi_bot))
        .route(
            "/evolution/self-improve/runs",
            get(list_self_improvement_runs_multi_bot),
        )
        .route(
            "/evolution/sandbox/snapshot",
            post(create_sandbox_snapshot_multi_bot),
        )
        .route(
            "/evolution/sandbox/revisions",
            post(create_sandbox_revision_multi_bot),
        )
        .route(
            "/evolution/sandbox/revisions/{revision_id}/activate",
            post(activate_sandbox_revision_multi_bot),
        )
        .route(
            "/evolution/sandbox/rollback",
            post(rollback_sandbox_multi_bot),
        )
        .route(
            "/evolution/sandbox/lineage",
            get(get_sandbox_lineage_multi_bot),
        )
        .route(
            "/evolution/revision-arena",
            get(get_revision_arena_multi_bot),
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
    /// Optional exact code/sandbox revision used to derive this paper evidence.
    #[serde(default)]
    pub revision_id: Option<String>,
}

#[derive(Deserialize)]
pub struct PromotionGateRequest {
    pub current: BacktestConfig,
    pub candidate: BacktestConfig,
    pub token: Option<String>,
    /// Exact sandbox/code revision whose persisted paper trades should be used
    /// as promotion evidence. Falls back to candidate_hash for older runs.
    #[serde(default)]
    pub revision_id: Option<String>,
    #[serde(default = "default_train_pct")]
    pub train_pct: f64,
    #[serde(default)]
    pub paper: Option<PaperEvidence>,
    #[serde(default = "default_min_paper_trades")]
    pub min_paper_trades: u64,
    #[serde(default = "default_max_paper_drawdown_pct")]
    pub max_paper_drawdown_pct: f64,
    #[serde(default)]
    pub risk_budget: risk_budget::RiskBudgetRequest,
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
    pub evidence_report: risk_budget::EvidenceReport,
    pub risk_decision: risk_budget::RiskBudgetDecision,
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
    #[serde(default)]
    pub risk_budget: risk_budget::RiskBudgetRequest,
    #[serde(default)]
    pub sandbox_mutation: Option<SandboxMutationRequest>,
}

#[derive(Serialize)]
pub struct SelfImproveResponse {
    pub run: evolution_store::SelfImprovementRun,
    pub promotion: PromotionGateResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RevisionRunMode {
    Live,
    Canary,
    Paper,
    Shadow,
    Backtest,
    Research,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevisionModeCapability {
    pub mode: RevisionRunMode,
    pub can_touch_funds: bool,
    pub description: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevisionArenaEntry {
    pub revision_id: String,
    pub display_name: String,
    pub source: String,
    pub status: String,
    pub run_mode: RevisionRunMode,
    pub can_execute_live: bool,
    #[serde(default)]
    pub parent_revision_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    pub user_intent: String,
    #[serde(default)]
    pub patch_sha256: Option<String>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    #[serde(default)]
    pub promotion_approved: Option<bool>,
    #[serde(default)]
    pub promotion_blockers: Vec<String>,
    #[serde(default)]
    pub paper_evidence: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevisionArenaResponse {
    pub bot_id: String,
    pub invariant: &'static str,
    pub active_revision_id: String,
    pub live_revision_id: Option<String>,
    pub revisions: Vec<RevisionArenaEntry>,
    pub modes: Vec<RevisionModeCapability>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SandboxMutationRequest {
    pub base_snapshot_id: String,
    #[serde(default)]
    pub parent_revision_id: Option<String>,
    pub patch: String,
    #[serde(default)]
    pub patch_sha256: Option<String>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSandboxSnapshotRequest {
    pub base_repo: String,
    pub base_ref: String,
    pub base_commit: String,
    pub base_image_digest: String,
    pub workspace_digest: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSandboxRevisionRequest {
    #[serde(flatten)]
    pub mutation: SandboxMutationRequest,
    pub user_intent: String,
    #[serde(default)]
    pub run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ActivateSandboxRevisionRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RollbackSandboxRequest {
    pub target_revision_id: String,
    #[serde(default)]
    pub reason: Option<String>,
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

async fn get_risk_budget_decision(
    State(state): State<Arc<TradingApiState>>,
    Path(decision_id): Path<String>,
) -> Result<Json<risk_budget::RiskBudgetDecision>, (StatusCode, String)> {
    get_risk_budget_decision_inner(&state.bot_id, &decision_id).await
}

async fn get_risk_budget_decision_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Path(decision_id): Path<String>,
) -> Result<Json<risk_budget::RiskBudgetDecision>, (StatusCode, String)> {
    get_risk_budget_decision_inner(&bot.bot_id, &decision_id).await
}

async fn get_risk_budget_decision_inner(
    bot_id: &str,
    decision_id: &str,
) -> Result<Json<risk_budget::RiskBudgetDecision>, (StatusCode, String)> {
    let decision = risk_budget::get_decision(decision_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "risk budget decision not found".to_string(),
            )
        })?;
    if decision.bot_id != bot_id {
        return Err((
            StatusCode::NOT_FOUND,
            "risk budget decision not found".to_string(),
        ));
    }
    Ok(Json(decision))
}

async fn get_evidence_report(
    State(state): State<Arc<TradingApiState>>,
    Path(report_id): Path<String>,
) -> Result<Json<risk_budget::EvidenceReport>, (StatusCode, String)> {
    get_evidence_report_inner(&state.bot_id, &report_id).await
}

async fn get_evidence_report_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Path(report_id): Path<String>,
) -> Result<Json<risk_budget::EvidenceReport>, (StatusCode, String)> {
    get_evidence_report_inner(&bot.bot_id, &report_id).await
}

async fn get_evidence_report_inner(
    bot_id: &str,
    report_id: &str,
) -> Result<Json<risk_budget::EvidenceReport>, (StatusCode, String)> {
    let report = risk_budget::get_report(report_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "evidence report not found".to_string(),
            )
        })?;
    if report.bot_id != bot_id {
        return Err((
            StatusCode::NOT_FOUND,
            "evidence report not found".to_string(),
        ));
    }
    Ok(Json(report))
}

/// Run the promotion gate for a candidate and return the plain response. This is the
/// entry the promotion conductor (trading-blueprint-lib) calls in-process once a paper
/// trial has accrued enough forward evidence — it reuses the exact same gate the HTTP
/// route uses, so there is one gate, not two.
pub async fn run_promotion_gate(
    bot_id: &str,
    req: PromotionGateRequest,
) -> Result<PromotionGateResponse, String> {
    promotion_gate_inner(bot_id, req)
        .await
        .map(|json| json.0)
        .map_err(|(_, msg)| msg)
}

async fn promotion_gate_inner(
    bot_id: &str,
    req: PromotionGateRequest,
) -> Result<Json<PromotionGateResponse>, (StatusCode, String)> {
    let candidate_json = serde_json::to_value(&req.candidate).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize candidate: {e}"),
        )
    })?;
    let candidate_hash = hash_json(&candidate_json)?;
    let (paper, mut evidence_blockers) =
        paper_evidence_from_store(bot_id, &candidate_hash, req.revision_id.as_deref())?;
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

    let mut hard_blockers = Vec::new();
    let mut paper_blockers = Vec::new();
    if !run.result.should_promote {
        hard_blockers.push("walk-forward backtest did not approve candidate".to_string());
    }
    if run.result.likely_overfit {
        hard_blockers.push("candidate is likely overfit out-of-sample".to_string());
    }
    paper_blockers.append(&mut evidence_blockers);

    match paper.as_ref() {
        Some(p) => {
            if p.trades < req.min_paper_trades {
                paper_blockers.push(format!(
                    "paper trading evidence has {} trades; need at least {}",
                    p.trades, req.min_paper_trades
                ));
            }
            if !p.total_return_pct.is_finite() || p.total_return_pct <= 0.0 {
                paper_blockers.push("paper trading return must be positive and finite".to_string());
            }
            if !p.max_drawdown_pct.is_finite() || p.max_drawdown_pct > req.max_paper_drawdown_pct {
                paper_blockers.push(format!(
                    "paper max drawdown {:.2}% exceeds {:.2}% limit",
                    p.max_drawdown_pct, req.max_paper_drawdown_pct
                ));
            }
        }
        None => paper_blockers
            .push("missing persisted paper trading evidence for candidate".to_string()),
    }
    let paper_passed = paper.is_some() && paper_blockers.is_empty();
    let mut blockers = hard_blockers.clone();
    blockers.extend(paper_blockers.clone());

    let paper_summary = paper.as_ref().map(|p| risk_budget::PaperEvidenceSummary {
        trades: p.trades,
        total_return_pct: p.total_return_pct,
        max_drawdown_pct: p.max_drawdown_pct,
    });
    let (evidence_report, risk_decision) =
        risk_budget::build_promotion_decision(risk_budget::DecisionBuildInput {
            bot_id,
            candidate_hash: &candidate_hash,
            revision_id: req.revision_id.clone(),
            request: &req.risk_budget,
            result: &run.result,
            candles_used: run.candles_used,
            paper: paper_summary,
            paper_passed,
            hard_blockers,
            paper_blockers,
        });
    let (evidence_report, risk_decision) =
        risk_budget::persist_decision_pair(evidence_report, risk_decision).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("persist risk budget decision: {e}"),
            )
        })?;

    Ok(Json(PromotionGateResponse {
        bot_id: bot_id.to_string(),
        approved: blockers.is_empty(),
        blockers,
        result: run.result,
        candles_used: run.candles_used,
        paper,
        evidence_report,
        risk_decision,
    }))
}

fn paper_evidence_from_store(
    bot_id: &str,
    candidate_hash: &str,
    revision_id: Option<&str>,
) -> Result<(Option<PaperEvidence>, Vec<String>), (StatusCode, String)> {
    let (trades, evidence_revision_id) = if let Some(revision_id) = revision_id {
        let revision_trades = trade_store::paper_trades_for_revision(bot_id, revision_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        if revision_trades.is_empty() {
            (
                trade_store::paper_trades_for_candidate(bot_id, candidate_hash)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
                None,
            )
        } else {
            (revision_trades, Some(revision_id))
        }
    } else {
        (
            trade_store::paper_trades_for_candidate(bot_id, candidate_hash)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
            None,
        )
    };
    if trades.is_empty() {
        return Ok((None, Vec::new()));
    }

    let mut blockers = Vec::new();
    let mut total_return_pct = 0.0f64;
    let mut high_watermark: Option<f64> = None;
    let mut max_drawdown_pct = 0.0f64;
    let mut missing_pnl = false;
    let mut missing_equity = false;

    for trade in &trades {
        match trade
            .paper_pnl_pct
            .as_deref()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
        {
            Some(value) => total_return_pct += value,
            None => missing_pnl = true,
        }

        match trade
            .paper_equity_after
            .as_deref()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0)
        {
            Some(equity) => {
                let hwm = high_watermark.map_or(equity, |current| current.max(equity));
                high_watermark = Some(hwm);
                max_drawdown_pct = max_drawdown_pct.max(((hwm - equity) / hwm) * 100.0);
            }
            None => missing_equity = true,
        }
    }

    if missing_pnl {
        blockers.push("persisted paper trades are missing pnl metrics for candidate".to_string());
    }
    if missing_equity {
        blockers
            .push("persisted paper trades are missing equity metrics for candidate".to_string());
    }

    Ok((
        Some(PaperEvidence {
            trades: trades.len() as u64,
            total_return_pct,
            max_drawdown_pct,
            candidate_hash: Some(candidate_hash.to_string()),
            revision_id: evidence_revision_id.map(str::to_string),
        }),
        blockers,
    ))
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
    let sandbox_mutation = req.sandbox_mutation;
    let run_id = format!("sir-{}", uuid::Uuid::new_v4());
    let sandbox_revision = match sandbox_mutation {
        Some(mutation) => {
            let revision =
                build_sandbox_revision(bot_id, user_intent, Some(run_id.clone()), mutation)?;
            sandbox_store::insert_revision(revision.clone())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Some(revision)
        }
        None => None,
    };

    let promotion = promotion_gate_inner(
        bot_id,
        PromotionGateRequest {
            current: req.current,
            candidate,
            token: req.token,
            revision_id: sandbox_revision
                .as_ref()
                .map(|revision| revision.revision_id.clone()),
            train_pct: req.train_pct,
            paper: req.paper,
            min_paper_trades: req.min_paper_trades,
            max_paper_drawdown_pct: req.max_paper_drawdown_pct,
            risk_budget: req.risk_budget,
        },
    )
    .await?
    .0;

    // Lifecycle decision (the unlock for "self-improvement going nowhere"):
    // a candidate that clears the walk-forward backtest but only lacks forward
    // paper evidence must NOT dead-end as "blocked" — it enrolls in a paper trial
    // so the promotion sweep can accrue real paper trades under its candidate_hash
    // and re-run the gate later. Only a candidate that fails the backtest itself
    // (not promotable / likely overfit) is genuinely blocked.
    let backtest_passed = promotion.result.should_promote && !promotion.result.likely_overfit;
    let (status, trial_deadline, trades_target) = if promotion.approved {
        ("staged_for_operator_approval".to_string(), None, None)
    } else if backtest_passed {
        // Cleared backtest, only lacks forward paper evidence: queue for the promotion
        // conductor (trading-blueprint-lib) to activate as a paper trial when the bot's
        // single trial slot is free. The conductor sets `trial_deadline` on activation;
        // we record the requested evidence target now so it survives the queue.
        (
            evolution_store::status::BACKTEST_PASS.to_string(),
            None,
            Some(req.min_paper_trades.max(1)),
        )
    } else {
        ("blocked".to_string(), None, None)
    };

    let run = evolution_store::SelfImprovementRun {
        run_id,
        bot_id: bot_id.to_string(),
        created_at: chrono::Utc::now().timestamp(),
        user_intent: user_intent.to_string(),
        candidate_hash,
        approved: promotion.approved,
        status,
        blockers: promotion.blockers.clone(),
        candles_used: promotion.candles_used,
        current_config: current_json,
        candidate_config: candidate_json,
        paper_evidence: promotion
            .paper
            .as_ref()
            .and_then(|paper| serde_json::to_value(paper).ok()),
        evidence_report_id: Some(promotion.evidence_report.report_id.clone()),
        risk_budget_decision_id: Some(promotion.risk_decision.decision_id.clone()),
        base_snapshot_id: sandbox_revision
            .as_ref()
            .map(|revision| revision.base_snapshot_id.clone()),
        sandbox_revision_id: sandbox_revision
            .as_ref()
            .map(|revision| revision.revision_id.clone()),
        trial_deadline,
        trades_target,
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

async fn create_sandbox_snapshot(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<CreateSandboxSnapshotRequest>,
) -> Result<Json<sandbox_store::SandboxSnapshot>, (StatusCode, String)> {
    create_sandbox_snapshot_inner(&state.bot_id, req).await
}

async fn create_sandbox_snapshot_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<CreateSandboxSnapshotRequest>,
) -> Result<Json<sandbox_store::SandboxSnapshot>, (StatusCode, String)> {
    create_sandbox_snapshot_inner(&bot.bot_id, req).await
}

async fn create_sandbox_snapshot_inner(
    bot_id: &str,
    req: CreateSandboxSnapshotRequest,
) -> Result<Json<sandbox_store::SandboxSnapshot>, (StatusCode, String)> {
    require_nonempty("base_repo", &req.base_repo)?;
    require_nonempty("base_ref", &req.base_ref)?;
    require_nonempty("base_commit", &req.base_commit)?;
    require_nonempty("base_image_digest", &req.base_image_digest)?;
    require_nonempty("workspace_digest", &req.workspace_digest)?;

    let snapshot = sandbox_store::SandboxSnapshot {
        snapshot_id: format!("ss-{}", uuid::Uuid::new_v4()),
        bot_id: bot_id.to_string(),
        created_at: chrono::Utc::now(),
        base_repo: req.base_repo.trim().to_string(),
        base_ref: req.base_ref.trim().to_string(),
        base_commit: req.base_commit.trim().to_string(),
        base_image_digest: req.base_image_digest.trim().to_string(),
        workspace_digest: req.workspace_digest.trim().to_string(),
        workspace_path: req
            .workspace_path
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty()),
        notes: req
            .notes
            .map(|notes| notes.trim().to_string())
            .filter(|notes| !notes.is_empty()),
    };
    sandbox_store::insert_snapshot(snapshot.clone())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(snapshot))
}

async fn create_sandbox_revision(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<CreateSandboxRevisionRequest>,
) -> Result<Json<sandbox_store::SandboxRevision>, (StatusCode, String)> {
    create_sandbox_revision_inner(&state.bot_id, req).await
}

async fn create_sandbox_revision_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<CreateSandboxRevisionRequest>,
) -> Result<Json<sandbox_store::SandboxRevision>, (StatusCode, String)> {
    create_sandbox_revision_inner(&bot.bot_id, req).await
}

async fn create_sandbox_revision_inner(
    bot_id: &str,
    req: CreateSandboxRevisionRequest,
) -> Result<Json<sandbox_store::SandboxRevision>, (StatusCode, String)> {
    let revision =
        build_sandbox_revision(bot_id, req.user_intent.trim(), req.run_id, req.mutation)?;
    sandbox_store::insert_revision(revision.clone())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(revision))
}

async fn activate_sandbox_revision(
    State(state): State<Arc<TradingApiState>>,
    Path(revision_id): Path<String>,
    Json(req): Json<ActivateSandboxRevisionRequest>,
) -> Result<Json<sandbox_store::ActiveSandboxRevision>, (StatusCode, String)> {
    activate_sandbox_revision_inner(&state.bot_id, &revision_id, req.reason, None).await
}

async fn activate_sandbox_revision_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Path(revision_id): Path<String>,
    Json(req): Json<ActivateSandboxRevisionRequest>,
) -> Result<Json<sandbox_store::ActiveSandboxRevision>, (StatusCode, String)> {
    activate_sandbox_revision_inner(&bot.bot_id, &revision_id, req.reason, None).await
}

async fn rollback_sandbox(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<RollbackSandboxRequest>,
) -> Result<Json<sandbox_store::ActiveSandboxRevision>, (StatusCode, String)> {
    rollback_sandbox_inner(&state.bot_id, req).await
}

async fn rollback_sandbox_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
    Json(req): Json<RollbackSandboxRequest>,
) -> Result<Json<sandbox_store::ActiveSandboxRevision>, (StatusCode, String)> {
    rollback_sandbox_inner(&bot.bot_id, req).await
}

async fn rollback_sandbox_inner(
    bot_id: &str,
    req: RollbackSandboxRequest,
) -> Result<Json<sandbox_store::ActiveSandboxRevision>, (StatusCode, String)> {
    let prior = sandbox_store::active_revision(bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map(|active| active.revision_id);
    activate_sandbox_revision_inner(
        bot_id,
        &req.target_revision_id,
        req.reason.or_else(|| Some("rollback".to_string())),
        prior,
    )
    .await
}

async fn activate_sandbox_revision_inner(
    bot_id: &str,
    revision_id: &str,
    reason: Option<String>,
    rollback_from: Option<String>,
) -> Result<Json<sandbox_store::ActiveSandboxRevision>, (StatusCode, String)> {
    let revision = sandbox_store::get_revision(bot_id, revision_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("unknown sandbox revision '{revision_id}' for bot"),
            )
        })?;
    let active = sandbox_store::ActiveSandboxRevision {
        bot_id: bot_id.to_string(),
        revision_id: revision.revision_id,
        activated_at: chrono::Utc::now(),
        reason: reason
            .map(|reason| reason.trim().to_string())
            .filter(|reason| !reason.is_empty())
            .unwrap_or_else(|| "activate".to_string()),
        rollback_from,
    };
    sandbox_store::set_active_revision(active.clone())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(active))
}

async fn get_sandbox_lineage(
    State(state): State<Arc<TradingApiState>>,
) -> Result<Json<sandbox_store::SandboxLineage>, (StatusCode, String)> {
    get_sandbox_lineage_inner(&state.bot_id).await
}

async fn get_sandbox_lineage_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
) -> Result<Json<sandbox_store::SandboxLineage>, (StatusCode, String)> {
    get_sandbox_lineage_inner(&bot.bot_id).await
}

async fn get_sandbox_lineage_inner(
    bot_id: &str,
) -> Result<Json<sandbox_store::SandboxLineage>, (StatusCode, String)> {
    let lineage =
        sandbox_store::lineage(bot_id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(lineage))
}

async fn get_revision_arena(
    State(state): State<Arc<TradingApiState>>,
) -> Result<Json<RevisionArenaResponse>, (StatusCode, String)> {
    get_revision_arena_inner(&state.bot_id, state.paper_trade).await
}

async fn get_revision_arena_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    axum::Extension(bot): axum::Extension<crate::BotContext>,
) -> Result<Json<RevisionArenaResponse>, (StatusCode, String)> {
    get_revision_arena_inner(&bot.bot_id, bot.paper_trade).await
}

async fn get_revision_arena_inner(
    bot_id: &str,
    paper_trade: bool,
) -> Result<Json<RevisionArenaResponse>, (StatusCode, String)> {
    let lineage =
        sandbox_store::lineage(bot_id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let runs = evolution_store::list_for_bot(bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(build_revision_arena(
        bot_id,
        paper_trade,
        lineage,
        runs,
    )))
}

fn build_revision_arena(
    bot_id: &str,
    paper_trade: bool,
    lineage: sandbox_store::SandboxLineage,
    runs: Vec<evolution_store::SelfImprovementRun>,
) -> RevisionArenaResponse {
    let active_revision_id = lineage
        .active_revision
        .as_ref()
        .map(|active| active.revision_id.clone())
        .unwrap_or_else(|| "rev-0".to_string());
    let live_revision_id = if paper_trade {
        None
    } else {
        Some(active_revision_id.clone())
    };
    let run_by_revision: HashMap<String, evolution_store::SelfImprovementRun> = runs
        .into_iter()
        .filter_map(|run| {
            run.sandbox_revision_id
                .clone()
                .map(|revision_id| (revision_id, run))
        })
        .collect();

    let mut revisions = Vec::with_capacity(lineage.revisions.len() + 1);
    revisions.push(RevisionArenaEntry {
        revision_id: "rev-0".to_string(),
        display_name: "Revision 0".to_string(),
        source: "initial_baseline".to_string(),
        status: if active_revision_id == "rev-0" {
            "active".to_string()
        } else {
            "superseded".to_string()
        },
        run_mode: if paper_trade {
            RevisionRunMode::Paper
        } else {
            RevisionRunMode::Live
        },
        can_execute_live: !paper_trade && active_revision_id == "rev-0",
        parent_revision_id: None,
        run_id: None,
        created_at: lineage
            .snapshots
            .first()
            .map(|snapshot| snapshot.created_at.to_rfc3339()),
        user_intent: "Initial activated bot code, config, prompt, and memory baseline.".to_string(),
        patch_sha256: None,
        files_changed: Vec::new(),
        tests: Vec::new(),
        promotion_approved: Some(true),
        promotion_blockers: Vec::new(),
        paper_evidence: None,
    });

    for (index, revision) in lineage.revisions.iter().enumerate() {
        let run = revision
            .run_id
            .as_ref()
            .and_then(|_| run_by_revision.get(&revision.revision_id));
        let is_active = active_revision_id == revision.revision_id;
        let promotion_approved = run.map(|run| run.approved);
        let promotion_blockers = run.map(|run| run.blockers.clone()).unwrap_or_default();
        let status = if is_active {
            "active".to_string()
        } else if let Some(run) = run {
            if run.approved {
                "staged".to_string()
            } else {
                "blocked".to_string()
            }
        } else {
            revision.status.clone()
        };
        let run_mode = if is_active {
            if paper_trade {
                RevisionRunMode::Paper
            } else {
                RevisionRunMode::Live
            }
        } else if promotion_approved == Some(true) {
            RevisionRunMode::Paper
        } else {
            RevisionRunMode::Research
        };

        revisions.push(RevisionArenaEntry {
            revision_id: revision.revision_id.clone(),
            display_name: format!("Revision {}", index + 1),
            source: "mcp_candidate".to_string(),
            status,
            run_mode,
            can_execute_live: !paper_trade && is_active,
            parent_revision_id: revision
                .parent_revision_id
                .clone()
                .or_else(|| Some("rev-0".to_string())),
            run_id: revision.run_id.clone(),
            created_at: Some(revision.created_at.to_rfc3339()),
            user_intent: revision.user_intent.clone(),
            patch_sha256: Some(revision.patch_sha256.clone()),
            files_changed: revision.files_changed.clone(),
            tests: revision.tests.clone(),
            promotion_approved,
            promotion_blockers,
            paper_evidence: run.and_then(|run| run.paper_evidence.clone()),
        });
    }

    RevisionArenaResponse {
        bot_id: bot_id.to_string(),
        invariant: "Only the active live/canary revision may touch execution keys or vault funds; candidate revisions are paper, shadow, backtest, or research only.",
        active_revision_id,
        live_revision_id,
        revisions,
        modes: vec![
            RevisionModeCapability {
                mode: RevisionRunMode::Live,
                can_touch_funds: true,
                description: "Active approved revision with normal execution authority.",
            },
            RevisionModeCapability {
                mode: RevisionRunMode::Canary,
                can_touch_funds: true,
                description: "Approved revision with capped live exposure and rollback triggers.",
            },
            RevisionModeCapability {
                mode: RevisionRunMode::Paper,
                can_touch_funds: false,
                description: "Paper ledger execution only; no live keys or vault movement.",
            },
            RevisionModeCapability {
                mode: RevisionRunMode::Shadow,
                can_touch_funds: false,
                description: "Consumes live feed and records intended trades without execution.",
            },
            RevisionModeCapability {
                mode: RevisionRunMode::Backtest,
                can_touch_funds: false,
                description: "Historical replay against fixed market data.",
            },
            RevisionModeCapability {
                mode: RevisionRunMode::Research,
                can_touch_funds: false,
                description: "Code, prompt, and strategy research before promotion evidence.",
            },
        ],
    }
}

fn build_sandbox_revision(
    bot_id: &str,
    user_intent: &str,
    run_id: Option<String>,
    mutation: SandboxMutationRequest,
) -> Result<sandbox_store::SandboxRevision, (StatusCode, String)> {
    if user_intent.len() < 12 {
        return Err((
            StatusCode::BAD_REQUEST,
            "sandbox revision user_intent must be at least 12 non-whitespace characters"
                .to_string(),
        ));
    }
    require_nonempty("base_snapshot_id", &mutation.base_snapshot_id)?;
    require_nonempty("patch", &mutation.patch)?;
    if sandbox_store::get_snapshot(bot_id, &mutation.base_snapshot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "base_snapshot_id '{}' does not exist for bot",
                mutation.base_snapshot_id
            ),
        ));
    }
    if let Some(parent_revision_id) = mutation.parent_revision_id.as_ref()
        && sandbox_store::get_revision(bot_id, parent_revision_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
            .is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("parent_revision_id '{parent_revision_id}' does not exist for bot"),
        ));
    }

    let patch_sha256 = mutation
        .patch_sha256
        .map(|hash| hash.trim().to_string())
        .filter(|hash| !hash.is_empty())
        .unwrap_or_else(|| hash_bytes(mutation.patch.as_bytes()));

    Ok(sandbox_store::SandboxRevision {
        revision_id: format!("sr-{}", uuid::Uuid::new_v4()),
        bot_id: bot_id.to_string(),
        created_at: chrono::Utc::now(),
        base_snapshot_id: mutation.base_snapshot_id,
        parent_revision_id: mutation.parent_revision_id,
        run_id,
        user_intent: user_intent.to_string(),
        patch_sha256,
        patch: mutation.patch,
        files_changed: mutation.files_changed,
        tests: mutation.tests,
        status: mutation
            .status
            .map(|status| status.trim().to_string())
            .filter(|status| !status.is_empty())
            .unwrap_or_else(|| "candidate".to_string()),
    })
}

fn require_nonempty(label: &str, value: &str) -> Result<(), (StatusCode, String)> {
    if value.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("{label} must not be empty"),
        ));
    }
    Ok(())
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

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
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
