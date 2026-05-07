//! HTTP endpoints for the strategy-bandit + slippage-learner.
//!
//! All routes are multi-bot — the calling bot is resolved by the auth
//! middleware and provided through `axum::Extension<BotContext>`. The on-disk
//! state lives in `crate::learning_store`.
//!
//! Endpoints:
//!   GET  /learning/slippage?token_in=&token_out=    -> recommended bps
//!   POST /learning/strategy-outcome  {variant_id, reward}
//!   GET  /learning/bandit-status     -> arms + current best

use std::sync::Arc;

use axum::extract::{Extension, Query};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::{BotContext, MultiBotTradingState, learning_store};
use trading_runtime::learning::BanditArm;

// ── Slippage ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SlippageQuery {
    pub token_in: String,
    pub token_out: String,
    /// Optional fallback bps used when no observations exist yet for the pair.
    /// Defaults to 100 bps (1%) — matches `RiskParams::default().max_slippage_bps`.
    #[serde(default)]
    pub fallback: Option<u32>,
}

#[derive(Serialize)]
pub struct SlippageResponse {
    pub bot_id: String,
    pub token_in: String,
    pub token_out: String,
    pub recommended_max_bps: u32,
    pub observation_count: usize,
    pub failure_count: u64,
}

const DEFAULT_FALLBACK_BPS: u32 = 100;

async fn get_slippage(
    Extension(bot): Extension<BotContext>,
    Query(query): Query<SlippageQuery>,
) -> Result<Json<SlippageResponse>, (StatusCode, String)> {
    let token_in = query
        .token_in
        .parse::<alloy::primitives::Address>()
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid token_in address: {e}"),
            )
        })?;
    let token_out = query
        .token_out
        .parse::<alloy::primitives::Address>()
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid token_out address: {e}"),
            )
        })?;
    let fallback = query.fallback.unwrap_or(DEFAULT_FALLBACK_BPS);

    let state = learning_store::load(&bot.bot_id);
    let recommended_max_bps = state
        .slippage
        .recommend_max_bps(token_in, token_out, fallback);
    let (observation_count, failure_count) = state
        .slippage
        .stats(token_in, token_out)
        .map(|s| (s.observed_bps.len(), s.failure_count))
        .unwrap_or((0, 0));

    Ok(Json(SlippageResponse {
        bot_id: bot.bot_id,
        token_in: query.token_in,
        token_out: query.token_out,
        recommended_max_bps,
        observation_count,
        failure_count,
    }))
}

// ── Strategy outcome ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct StrategyOutcomeRequest {
    pub variant_id: String,
    pub reward: f64,
}

/// Hard cap on `|reward|` accepted by `POST /learning/strategy-outcome`.
///
/// `BanditArm::record_outcome` updates a running mean. Without an upper
/// bound on `reward`, a malicious agent could submit `1e308` once and
/// pin the arm's mean reward at f64::MAX, dominating every UCB1 / Thompson
/// arm-selection decision thereafter. 1e6 (`$1M PnL`) is two orders of
/// magnitude above realistic per-trade outcomes; we reject the request
/// rather than silently clamp so the agent learns about the violation.
/// See `audits/http-api-concurrency-audit.md` finding #4.
pub const MAX_BANDIT_REWARD: f64 = 1.0e6;

/// Maximum length of the variant_id field. Longer than 256 chars almost
/// certainly indicates an agent error or attempted abuse — the canonical
/// strategy variants are short identifiers like `momentum-v2`.
pub const MAX_VARIANT_ID_LEN: usize = 256;

#[derive(Serialize)]
pub struct StrategyOutcomeResponse {
    pub bot_id: String,
    pub variant_id: String,
    pub total_pulls: u64,
    pub arm_pulls: u64,
    pub arm_mean_reward: f64,
}

async fn post_strategy_outcome(
    Extension(bot): Extension<BotContext>,
    Json(req): Json<StrategyOutcomeRequest>,
) -> Result<Json<StrategyOutcomeResponse>, (StatusCode, String)> {
    if req.variant_id.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "variant_id must not be empty".into(),
        ));
    }
    if req.variant_id.len() > MAX_VARIANT_ID_LEN {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("variant_id must be ≤ {MAX_VARIANT_ID_LEN} chars"),
        ));
    }
    if !req.reward.is_finite() {
        return Err((
            StatusCode::BAD_REQUEST,
            "reward must be a finite number".into(),
        ));
    }
    if req.reward.abs() > MAX_BANDIT_REWARD {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("reward magnitude must be ≤ {MAX_BANDIT_REWARD}"),
        ));
    }

    let state = learning_store::update(&bot.bot_id, |state| {
        state.bandit.record_outcome(&req.variant_id, req.reward);
    })
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;

    let arm = state
        .bandit
        .arms
        .iter()
        .find(|a| a.variant_id == req.variant_id);

    Ok(Json(StrategyOutcomeResponse {
        bot_id: bot.bot_id,
        variant_id: req.variant_id,
        total_pulls: state.bandit.total_pulls,
        arm_pulls: arm.map(|a| a.pulls).unwrap_or(0),
        arm_mean_reward: arm.map(BanditArm::mean_reward).unwrap_or(0.0),
    }))
}

// ── Bandit status ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct BanditStatusResponse {
    pub bot_id: String,
    pub total_pulls: u64,
    pub arms: Vec<BanditArm>,
    pub best_arm: Option<BanditArm>,
}

async fn get_bandit_status(Extension(bot): Extension<BotContext>) -> Json<BanditStatusResponse> {
    let state = learning_store::load(&bot.bot_id);
    let best_arm = state.bandit.best_arm().cloned();
    Json(BanditStatusResponse {
        bot_id: bot.bot_id,
        total_pulls: state.bandit.total_pulls,
        arms: state.bandit.arms.clone(),
        best_arm,
    })
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/learning/slippage", get(get_slippage))
        .route("/learning/strategy-outcome", post(post_strategy_outcome))
        .route("/learning/bandit-status", get(get_bandit_status))
}
