//! Promotion conductor — the box-side bridge that turns backtest-passing
//! self-improvement candidates into promoted (or tabled) strategies.
//!
//! Generation + evolutionary search live in the TS `@tangle-network/agent-eval`
//! harness; this conductor does NOT generate candidates. It manages the forward
//! paper-trial lifecycle that the promotion gate requires but that nothing previously
//! drove — the reason every historical self-improvement run dead-ended at
//! "missing persisted paper trading evidence".
//!
//! Lifecycle (stored on the existing `SelfImprovementRun.status`, no parallel store):
//!   backtest_pass ─activate→ paper_trial ─evidence+gate→ promoted
//!                                         └─expired|reject→ tabled
//!
//! One trial slot per bot. While a candidate is on trial the bot RUNS the candidate's
//! harness in paper mode (`bot.harness_json = candidate.harness`) and its paper trades
//! are tagged to the candidate (via `trial_marker`), so the gate's evidence is honest
//! forward performance, not the baseline's trades relabeled. Safety: only paper bots
//! are auto-trialed — real-money bots promote through the validator path, never here.

use crate::state::{TradingBotRecord, bot_key, bots};
use trading_http_api::evolution_store::{self, SelfImprovementRun, status};
use trading_http_api::routes::evolution::{PromotionGateRequest, run_promotion_gate};
use trading_http_api::trade_store;
use trading_http_api::trial_marker::{self, TrialMarker};
use trading_runtime::backtest::BacktestConfig;

/// How long a candidate accrues forward paper evidence before the conductor tables it
/// for insufficient data. 7 days at the ~60s tick cadence is ample room to reach the
/// evidence floor without letting a stalled candidate occupy a bot's trial slot forever.
const PAPER_TRIAL_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
const DEFAULT_TRADES_TARGET: u64 = 20;
const TRAIN_PCT: f64 = 0.7;
const MAX_PAPER_DRAWDOWN_PCT: f64 = 10.0;
/// At most one blocked-but-best candidate per bot per day may enter a shadow
/// paper trial. Without this escape hatch the gate dead-ends: a blocked
/// candidate can never gain paper evidence, and "missing persisted paper
/// trading evidence" blocks it forever (385 candidates / 0 trials in 17h live).
const SHADOW_TRIAL_RATE_LIMIT_SECS: i64 = 24 * 60 * 60;

/// Run one conductor pass over the fleet. Called once per workflow tick. Each bot
/// advances at most one lifecycle step per tick (evaluate an active trial, or activate
/// the next queued candidate) so a single slow gate run can't stall the whole fleet.
pub async fn run_promotion_conductor(all_bots: &[TradingBotRecord]) {
    for bot in all_bots {
        // Only auto-trial active paper bots. Real-money bots, stopped bots, and bots
        // winding down are never strategy-swapped by the conductor.
        if !bot.paper_trade || !bot.trading_active || bot.wind_down_started_at.is_some() {
            continue;
        }
        if let Err(e) = conduct_for_bot(bot).await {
            tracing::warn!(bot_id = %bot.id, "promotion conductor: {e}");
        }
    }
}

async fn conduct_for_bot(bot: &TradingBotRecord) -> Result<(), String> {
    match bot.active_trial_run_id.clone() {
        Some(run_id) => evaluate_active_trial(bot, &run_id).await,
        None => activate_next_candidate(bot).await,
    }
}

/// Evaluate the bot's in-flight trial: promote if evidence met + gate approves, table
/// if the gate rejects on real evidence or the trial window expires; otherwise keep
/// accruing (no-op this tick).
async fn evaluate_active_trial(bot: &TradingBotRecord, run_id: &str) -> Result<(), String> {
    let Some(run) = evolution_store::get(&bot.id, run_id)? else {
        // Run vanished (manual edit) — clear the dangling slot so the bot can recover.
        clear_trial_slot(bot, None)?;
        trial_marker::clear(&bot.id)?;
        return Err(format!("active trial run '{run_id}' missing; cleared slot"));
    };

    let trades = trial_trades(&bot.id, &run)?;
    let target = run.trades_target.unwrap_or(DEFAULT_TRADES_TARGET);
    let now = chrono::Utc::now().timestamp();
    let deadline = run.trial_deadline.unwrap_or(now);

    if trades.len() as u64 >= target {
        evolution_store::update(&bot.id, &run.run_id, |r| {
            r.status = status::EVIDENCE_MET.to_string();
        })?;
        let resp = run_promotion_gate(&bot.id, gate_request(&run)?).await?;
        if resp.approved {
            promote(bot, &run).await
        } else {
            // Real forward evidence exists but the gate rejected — the candidate is
            // genuinely not better. Table it (revert harness) and free the slot.
            table(bot, &run, resp.blockers)
        }
    } else if now >= deadline {
        table(
            bot,
            &run,
            vec![format!(
                "paper trial expired with {}/{} forward trades",
                trades.len(),
                target
            )],
        )
    } else {
        Ok(())
    }
}

fn trial_trades(
    bot_id: &str,
    run: &SelfImprovementRun,
) -> Result<Vec<trade_store::TradeRecord>, String> {
    if let Some(revision_id) = run.sandbox_revision_id.as_deref() {
        let trades = trade_store::paper_trades_for_revision(bot_id, revision_id)?;
        if !trades.is_empty() {
            return Ok(trades);
        }
    }
    trade_store::paper_trades_for_candidate(bot_id, &run.candidate_hash)
}

/// No active trial: pick the oldest queued `backtest_pass` candidate for this bot and
/// activate it — swap the bot to the candidate's harness in paper mode, tag its trades,
/// and advance the run to `paper_trial`. If nothing is queued, fall back to a shadow
/// trial of the day's best blocked candidate (rate-limited to one per bot per day).
async fn activate_next_candidate(bot: &TradingBotRecord) -> Result<(), String> {
    let mut runs = evolution_store::list_for_bot(&bot.id)?;
    runs.reverse(); // list_for_bot is newest-first; take the oldest queued candidate.
    if let Some(run) = runs.iter().find(|r| r.status == status::BACKTEST_PASS) {
        return activate_trial(bot, run.clone(), false).await;
    }
    let Some(run) = shadow_trial_candidate(&runs, chrono::Utc::now().timestamp()) else {
        return Ok(());
    };
    activate_trial(bot, run, true).await
}

/// Walk-forward composite for ranking blocked candidates: the persisted
/// evidence report's confidence score (built from should_promote / overfit /
/// sharpe decay), tie-broken by out-of-sample sharpe improvement. Runs without
/// a persisted report can't be ranked and are skipped.
fn walk_forward_composite(run: &SelfImprovementRun) -> Option<(f64, f64)> {
    let report = run
        .evidence_report_id
        .as_deref()
        .and_then(|id| trading_http_api::risk_budget::get_report(id).ok().flatten())?;
    Some((report.confidence_score, report.test_sharpe_delta))
}

/// The best blocked candidate of the last day, eligible for a shadow paper
/// trial. Returns `None` when a shadow trial already started within the
/// rate-limit window (tabled shadow runs keep their timestamp, so they count).
fn shadow_trial_candidate(runs: &[SelfImprovementRun], now: i64) -> Option<SelfImprovementRun> {
    let recently_shadow_trialed = runs.iter().any(|run| {
        run.shadow_trial_started_at
            .is_some_and(|started| now.saturating_sub(started) < SHADOW_TRIAL_RATE_LIMIT_SECS)
    });
    if recently_shadow_trialed {
        return None;
    }
    runs.iter()
        .filter(|run| run.status == "blocked")
        .filter(|run| run.shadow_trial_started_at.is_none())
        .filter(|run| now.saturating_sub(run.created_at) < SHADOW_TRIAL_RATE_LIMIT_SECS)
        .filter_map(|run| walk_forward_composite(run).map(|score| (score, run)))
        .max_by(|(a, _), (b, _)| a.0.total_cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)))
        .map(|(_, run)| run.clone())
}

/// Activate a candidate as the bot's paper trial. A normal trial swaps the
/// bot onto the candidate harness so the evidence is honest forward
/// performance. A shadow trial leaves the live config untouched — it only
/// occupies the trial slot and tags the bot's paper trades to the candidate
/// so the gate finally has persisted evidence to judge; promotion still
/// requires the full gate (which re-runs the walk-forward backtest).
async fn activate_trial(
    bot: &TradingBotRecord,
    run: SelfImprovementRun,
    shadow: bool,
) -> Result<(), String> {
    let candidate: BacktestConfig = serde_json::from_value(run.candidate_config.clone())
        .map_err(|e| format!("deserialize candidate_config for {}: {e}", run.run_id))?;
    let new_harness = serde_json::to_value(&candidate.harness)
        .map_err(|e| format!("serialize candidate harness: {e}"))?;
    let prev_harness = bot.harness_json.clone();
    let run_id = run.run_id.clone();
    let candidate_hash = run.candidate_hash.clone();

    bots()?
        .update(&bot_key(&bot.id), |b| {
            if !shadow {
                b.pre_trial_harness_json = Some(prev_harness.clone());
                b.harness_json = new_harness.clone();
            }
            b.active_trial_run_id = Some(run_id.clone());
            b.active_trial_candidate_hash = Some(candidate_hash.clone());
        })
        .map_err(|e| e.to_string())?;

    trial_marker::set(TrialMarker {
        bot_id: bot.id.clone(),
        candidate_hash: candidate_hash.clone(),
        revision_id: run.sandbox_revision_id.clone(),
        run_id: run_id.clone(),
    })?;

    let now = chrono::Utc::now().timestamp();
    let deadline = now + PAPER_TRIAL_WINDOW_SECS;
    evolution_store::update(&bot.id, &run_id, |r| {
        r.status = status::PAPER_TRIAL.to_string();
        r.trial_deadline = Some(deadline);
        if r.trades_target.is_none() {
            r.trades_target = Some(DEFAULT_TRADES_TARGET);
        }
        if shadow {
            r.shadow_trial_started_at = Some(now);
        }
    })?;

    tracing::info!(
        bot_id = %bot.id,
        run_id = %run_id,
        candidate_hash = %candidate_hash,
        shadow,
        "promotion conductor: activated paper trial{}",
        if shadow {
            " (shadow: live config untouched; accruing evidence for a blocked candidate)"
        } else {
            " (candidate harness now live in paper mode)"
        }
    );
    Ok(())
}

/// Promote: the candidate already proved out in forward paper trading and is already the
/// bot's live harness, so promotion just marks the run promoted and frees the slot.
/// A shadow trial never made the candidate harness live, so it is applied here —
/// promotion is the first (gate-approved) moment a shadow candidate touches config.
/// (`autoOnPromote` invariant: paper-bot self-improvement promotes autonomously; real
/// funds never promote here.)
async fn promote(bot: &TradingBotRecord, run: &SelfImprovementRun) -> Result<(), String> {
    let shadow_harness = if run.shadow_trial_started_at.is_some() {
        let candidate: BacktestConfig = serde_json::from_value(run.candidate_config.clone())
            .map_err(|e| format!("deserialize candidate_config for {}: {e}", run.run_id))?;
        Some(
            serde_json::to_value(&candidate.harness)
                .map_err(|e| format!("serialize candidate harness: {e}"))?,
        )
    } else {
        None
    };
    bots()?
        .update(&bot_key(&bot.id), |b| {
            if let Some(harness) = shadow_harness.clone() {
                b.harness_json = harness;
            }
            b.active_trial_run_id = None;
            b.active_trial_candidate_hash = None;
            b.pre_trial_harness_json = None;
        })
        .map_err(|e| e.to_string())?;
    trial_marker::clear(&bot.id)?;
    evolution_store::update(&bot.id, &run.run_id, |r| {
        r.status = status::PROMOTED.to_string();
        r.approved = true;
    })?;
    tracing::info!(
        bot_id = %bot.id,
        run_id = %run.run_id,
        candidate_hash = %run.candidate_hash,
        "promotion conductor: PROMOTED candidate (forward paper evidence cleared the gate)"
    );
    Ok(())
}

/// Table: revert the bot to its pre-trial baseline harness and free the slot, keeping the
/// run terminal so the conductor won't re-derive it (continuity).
fn table(
    bot: &TradingBotRecord,
    run: &SelfImprovementRun,
    blockers: Vec<String>,
) -> Result<(), String> {
    clear_trial_slot(bot, bot.pre_trial_harness_json.clone())?;
    trial_marker::clear(&bot.id)?;
    evolution_store::update(&bot.id, &run.run_id, |r| {
        r.status = status::TABLED.to_string();
        r.blockers = blockers.clone();
    })?;
    tracing::info!(
        bot_id = %bot.id,
        run_id = %run.run_id,
        "promotion conductor: TABLED candidate; reverted to baseline harness"
    );
    Ok(())
}

/// Clear the bot's trial slot, optionally restoring a harness.
fn clear_trial_slot(
    bot: &TradingBotRecord,
    restore_harness: Option<serde_json::Value>,
) -> Result<(), String> {
    bots()?
        .update(&bot_key(&bot.id), |b| {
            if let Some(h) = restore_harness.clone() {
                b.harness_json = h;
            }
            b.active_trial_run_id = None;
            b.active_trial_candidate_hash = None;
            b.pre_trial_harness_json = None;
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn gate_request(run: &SelfImprovementRun) -> Result<PromotionGateRequest, String> {
    let current: BacktestConfig = serde_json::from_value(run.current_config.clone())
        .map_err(|e| format!("deserialize current_config: {e}"))?;
    let candidate: BacktestConfig = serde_json::from_value(run.candidate_config.clone())
        .map_err(|e| format!("deserialize candidate_config: {e}"))?;
    Ok(PromotionGateRequest {
        current,
        candidate,
        token: None,
        revision_id: run.sandbox_revision_id.clone(),
        train_pct: TRAIN_PCT,
        // The gate reads forward paper evidence from the trade store by candidate_hash;
        // it does not use this field for trial evaluation.
        paper: None,
        min_paper_trades: run.trades_target.unwrap_or(DEFAULT_TRADES_TARGET),
        max_paper_drawdown_pct: MAX_PAPER_DRAWDOWN_PCT,
        risk_budget: Default::default(),
    })
}
