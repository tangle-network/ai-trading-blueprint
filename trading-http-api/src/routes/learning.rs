//! HTTP endpoints for the strategy-bandit + slippage-learner.
//!
//! All routes are multi-bot — the calling bot is resolved by the auth
//! middleware and provided through `axum::Extension<BotContext>`. The on-disk
//! state lives in `crate::learning_store`.
//!
//! Endpoints:
//!   GET  /learning/slippage?token_in=&token_out=    -> recommended bps
//!   POST /learning/strategy-outcome  {variant_id, reward, iteration_id?}
//!   GET  /learning/bandit-status     -> arms + current best
//!
//! ## Idempotency on `/learning/strategy-outcome`
//!
//! Network glitches and agent retry loops can re-deliver an outcome
//! payload. Without an idempotency key the bandit would double-count the
//! same arm pull. Callers can opt into deduplication by sending an
//! `iteration_id` (typically the agent's per-phase counter from
//! `phase.json`); the route will record the outcome at most once per
//! `(bot_id, variant_id, iteration_id)` tuple. Omitting the field
//! preserves the legacy always-record behaviour.

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
    /// Optional caller-supplied idempotency key. When present, the route
    /// deduplicates per `(bot_id, variant_id, iteration_id)` tuple via the
    /// per-bot learning store. When absent, the route falls back to the
    /// always-record behaviour (preserves existing callers).
    ///
    /// Length-bounded by [`MAX_VARIANT_ID_LEN`] for the same reason as
    /// `variant_id` — agent retries should ship a short phase counter
    /// (e.g. `phase-iter-42`), not a sprawling correlation blob.
    #[serde(default)]
    pub iteration_id: Option<String>,
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
/// strategy variants are short identifiers like `momentum-v2`. Reused as
/// the cap on `iteration_id` to avoid sprawling correlation blobs.
pub const MAX_VARIANT_ID_LEN: usize = 256;

#[derive(Serialize, Deserialize)]
pub struct StrategyOutcomeResponse {
    pub bot_id: String,
    pub variant_id: String,
    pub total_pulls: u64,
    pub arm_pulls: u64,
    pub arm_mean_reward: f64,
    /// `true` when the request was a duplicate of an earlier
    /// `(variant_id, iteration_id)` and the bandit was NOT pulled. Lets
    /// callers distinguish "your retry was idempotently absorbed" from
    /// "a fresh outcome was recorded".
    #[serde(default, skip_serializing_if = "is_false")]
    pub deduplicated: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
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

    if let Some(it) = req.iteration_id.as_deref() {
        if it.trim().is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "iteration_id, if present, must not be empty".into(),
            ));
        }
        if it.len() > MAX_VARIANT_ID_LEN {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("iteration_id must be ≤ {MAX_VARIANT_ID_LEN} chars"),
            ));
        }
    }

    // Audit fix (HIGH): dedup-by-iteration_id. The closure short-circuits
    // when `(variant_id, iteration_id)` was already recorded; we use
    // `deduplicated` to set the response flag so the agent can distinguish
    // "absorbed a retry" from "first-time record".
    let mut deduplicated = false;
    let state = learning_store::update(&bot.bot_id, |state| {
        if let Some(iter_id) = req.iteration_id.as_deref() {
            if state.has_recorded_iteration(&req.variant_id, iter_id) {
                deduplicated = true;
                return;
            }
            state.note_iteration(&req.variant_id, iter_id);
        }
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
        deduplicated,
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

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::header::CONTENT_TYPE;
    use http_body_util::BodyExt;
    use std::path::PathBuf;
    use tower::ServiceExt;

    fn unique_bot_id() -> String {
        format!("learning-it-{}", uuid::Uuid::new_v4())
    }

    fn install_test_dir() -> PathBuf {
        // Per-test temp dir routed through the learning_store override —
        // sibling tests in this crate also use the override so we don't
        // race on `BLUEPRINT_STATE_DIR`.
        let tmp = tempfile::TempDir::new().expect("create test learning dir");
        let path = tmp.path().to_path_buf();
        std::mem::forget(tmp);
        learning_store::set_test_dir(path.clone());
        path
    }

    /// Build a router for the strategy-outcome endpoint with a fixed
    /// BotContext extension layer (skips the auth middleware).
    fn router_for_bot(bot_id: &str) -> Router {
        let bot = BotContext {
            bot_id: bot_id.to_string(),
            vault_address: "0x0000000000000000000000000000000000000000".to_string(),
            paper_trade: false,
            chain_id: 31337,
            rpc_url: "http://127.0.0.1:0".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::default(),
        };
        Router::new()
            .route("/learning/strategy-outcome", post(post_strategy_outcome))
            .layer(axum::Extension(bot))
    }

    async fn post_outcome(
        router: &Router,
        body: serde_json::Value,
    ) -> (StatusCode, StrategyOutcomeResponse) {
        let req = Request::builder()
            .method("POST")
            .uri("/learning/strategy-outcome")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let parsed: StrategyOutcomeResponse =
            serde_json::from_slice(&bytes).expect("parse response");
        (status, parsed)
    }

    /// Audit fix: identical `(variant_id, iteration_id)` POSTed twice
    /// must increment the bandit's pulls only once. A different
    /// iteration_id (or absence of one) must NOT be deduplicated.
    #[tokio::test]
    async fn strategy_outcome_dedups_by_iteration_id() {
        let _dir = install_test_dir();
        let bot_id = unique_bot_id();
        let router = router_for_bot(&bot_id);

        let body =
            serde_json::json!({"variant_id":"v1","reward":1.0,"iteration_id":"phase-iter-42"});

        let (s1, r1) = post_outcome(&router, body.clone()).await;
        assert_eq!(s1, StatusCode::OK);
        assert!(!r1.deduplicated);
        assert_eq!(r1.arm_pulls, 1);
        assert_eq!(r1.total_pulls, 1);

        // Same iteration_id again → must dedup. Pulls do NOT advance.
        let (s2, r2) = post_outcome(&router, body.clone()).await;
        assert_eq!(s2, StatusCode::OK);
        assert!(r2.deduplicated, "second call must be flagged deduplicated");
        assert_eq!(
            r2.arm_pulls, 1,
            "duplicate must not advance the arm's pulls"
        );
        assert_eq!(r2.total_pulls, 1);

        // Distinct iteration_id is a fresh record.
        let (s3, r3) = post_outcome(
            &router,
            serde_json::json!({"variant_id":"v1","reward":2.0,"iteration_id":"phase-iter-43"}),
        )
        .await;
        assert_eq!(s3, StatusCode::OK);
        assert!(!r3.deduplicated);
        assert_eq!(r3.arm_pulls, 2);
        assert_eq!(r3.total_pulls, 2);

        // No iteration_id → falls back to always-record (legacy behaviour).
        let (s4, r4) =
            post_outcome(&router, serde_json::json!({"variant_id":"v1","reward":1.5})).await;
        assert_eq!(s4, StatusCode::OK);
        assert!(!r4.deduplicated);
        assert_eq!(r4.arm_pulls, 3);
    }

    /// Empty / oversized `iteration_id` is rejected.
    #[tokio::test]
    async fn strategy_outcome_rejects_bad_iteration_id() {
        let _dir = install_test_dir();
        let bot_id = unique_bot_id();
        let router = router_for_bot(&bot_id);

        let req_empty = Request::builder()
            .method("POST")
            .uri("/learning/strategy-outcome")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "variant_id":"v1","reward":1.0,"iteration_id":"   "
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = router.clone().oneshot(req_empty).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let big = "x".repeat(MAX_VARIANT_ID_LEN + 1);
        let req_big = Request::builder()
            .method("POST")
            .uri("/learning/strategy-outcome")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "variant_id":"v1","reward":1.0,"iteration_id":big
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = router.clone().oneshot(req_big).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
