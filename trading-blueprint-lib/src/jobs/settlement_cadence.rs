//! Paper prediction-market settlement cadence.
//!
//! [`trading_http_api::paper_settlement::settle_resolved_paper_positions`] redeems
//! a paper bot's resolved Polymarket conditional-token positions to their terminal
//! $1/$0 payout. Before this cadence it was only reachable on-demand via
//! `POST /clob/settlement/run`, so a held paper bet's P&L never realized in normal
//! operation — a winning YES stayed marked at its last midpoint forever.
//!
//! This cadence closes that gap by sweeping eligible paper prediction bots on the
//! same cron tick that already drives the promotion / self-improvement /
//! observatory cadences (`workflow_tick.rs`). It is:
//!
//! - **Paper-only**: real-money bots redeem through the on-chain CTF path and are
//!   never touched here (mirrors the route handler's `paper_trade` guard).
//! - **Prediction-only**: only the `prediction`/`polymarket` strategy family holds
//!   conditional-token inventory worth settling.
//! - **Fail-closed per bot**: the underlying settlement already leaves a position
//!   open on any Gamma error or unresolved market; here, one bot's settlement
//!   error is logged and never aborts the sweep for the others.

use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

use crate::state::TradingBotRecord;

static CADENCE: OnceCell<PersistentStore<SettlementCadenceRecord>> = OnceCell::new();

/// How often a single bot is swept. Prediction markets resolve on the order of
/// hours-to-days, so a per-tick (≈1/min) Gamma sweep would be wasteful; default
/// to 15 minutes, overridable via `PAPER_SETTLEMENT_INTERVAL_SECS`.
const DEFAULT_SETTLEMENT_INTERVAL_SECS: i64 = 15 * 60;
/// Cap Gamma fan-out per tick so a large fleet can't stampede the public API.
const DEFAULT_MAX_SETTLEMENT_BOTS_PER_TICK: usize = 8;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SettlementCadenceRecord {
    pub bot_id: String,
    #[serde(default)]
    pub last_settlement_at: Option<i64>,
}

fn records() -> Result<&'static PersistentStore<SettlementCadenceRecord>, String> {
    CADENCE
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("paper-settlement-cadence.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn record_key(bot_id: &str) -> String {
    format!("paper-settlement-cadence:{bot_id}")
}

/// Persist the last-settlement timestamp for a bot. Uses `insert` (upsert)
/// rather than `update` because the backing `LocalDatabase::update` is a no-op
/// when the key doesn't exist yet — the first sweep of a new bot must still
/// record its stamp so the interval gate actually advances.
fn stamp_settlement(store: &PersistentStore<SettlementCadenceRecord>, bot_id: &str, now: i64) {
    let key = record_key(bot_id);
    if let Err(e) = store.insert(
        key,
        SettlementCadenceRecord {
            bot_id: bot_id.to_string(),
            last_settlement_at: Some(now),
        },
    ) {
        tracing::warn!(bot_id = %bot_id, "paper settlement cadence: stamp failed: {e}");
    }
}

fn env_secs(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn due(last: Option<i64>, now: i64, interval_secs: i64) -> bool {
    last.is_none_or(|last| now.saturating_sub(last) >= interval_secs)
}

/// True for a live paper bot whose strategy family holds Polymarket conditional
/// inventory. Real-money and non-prediction bots are excluded by construction.
fn eligible_settlement_bot(bot: &TradingBotRecord) -> bool {
    let family = bot.strategy_type.trim().to_ascii_lowercase();
    bot.paper_trade
        && bot.trading_active
        && bot.wind_down_started_at.is_none()
        && matches!(family.as_str(), "prediction" | "polymarket")
}

/// Sweep eligible paper prediction bots, settling any whose markets have resolved.
///
/// Iterates the provided bots (the same `runnable_bots` slice the other cadences
/// receive), skips bots that aren't paper prediction bots or aren't yet due, and
/// calls the shared settlement routine for each. Per-bot failures are logged and
/// do not abort the remaining bots.
pub async fn run_settlement_cadence(all_bots: &[TradingBotRecord]) {
    let interval_secs = env_secs(
        "PAPER_SETTLEMENT_INTERVAL_SECS",
        DEFAULT_SETTLEMENT_INTERVAL_SECS,
    );
    let max_bots = env_usize(
        "PAPER_SETTLEMENT_MAX_BOTS_PER_TICK",
        DEFAULT_MAX_SETTLEMENT_BOTS_PER_TICK,
    );
    let now = chrono::Utc::now().timestamp();

    let store = match records() {
        Ok(store) => store,
        Err(e) => {
            tracing::warn!("paper settlement cadence disabled: {e}");
            return;
        }
    };

    let mut swept = 0usize;
    for bot in all_bots.iter().filter(|bot| eligible_settlement_bot(bot)) {
        if swept >= max_bots {
            break;
        }

        let key = record_key(&bot.id);
        let last = store
            .get(&key)
            .ok()
            .flatten()
            .and_then(|r| r.last_settlement_at);
        if !due(last, now, interval_secs) {
            continue;
        }
        swept += 1;

        // Stamp the attempt before awaiting Gamma so a slow/erroring sweep doesn't
        // let the same bot be re-picked on overlapping ticks. Settlement itself is
        // idempotent (already-redeemed positions net to zero), so a missed stamp
        // would at worst re-examine, never double-settle.
        let bot_id = bot.id.clone();
        stamp_settlement(store, &bot_id, now);

        // `clob` is unused for resolution (Gamma is a separate public API); the
        // settlement signature accepts it for future book-aware exit pricing.
        match trading_http_api::paper_settlement::settle_resolved_paper_positions(&bot_id, None)
            .await
        {
            Ok(report) => {
                if !report.settled.is_empty() {
                    tracing::info!(
                        bot_id = %bot_id,
                        examined = report.positions_examined,
                        settled = report.settled.len(),
                        skipped = report.skipped.len(),
                        "paper settlement cadence settled resolved positions"
                    );
                } else if report.positions_examined > 0 {
                    tracing::debug!(
                        bot_id = %bot_id,
                        examined = report.positions_examined,
                        skipped = report.skipped.len(),
                        "paper settlement cadence: no resolved positions this sweep"
                    );
                }
            }
            Err(e) => {
                // Fail-closed: the position store is untouched on error; one bot's
                // failure must not abort the sweep for the rest of the fleet.
                tracing::warn!(bot_id = %bot_id, "paper settlement cadence sweep failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bot(id: &str, strategy: &str, paper: bool, active: bool) -> TradingBotRecord {
        TradingBotRecord {
            id: id.to_string(),
            name: id.to_string(),
            sandbox_id: format!("sandbox-{id}"),
            vault_address: "0x0000000000000000000000000000000000000001".to_string(),
            share_token: String::new(),
            strategy_type: strategy.to_string(),
            strategy_config: json!({}),
            risk_params: json!({}),
            chain_id: 8453,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9100".to_string(),
            trading_api_token: "tok".to_string(),
            workflow_id: None,
            trading_active: active,
            created_at: 0,
            operator_address: String::new(),
            validator_service_ids: Vec::new(),
            max_lifetime_days: 0,
            paper_trade: paper,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: serde_json::Value::Null,
            validation_trust: trading_runtime::ValidationTrust::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        }
    }

    #[test]
    fn selects_only_paper_prediction_bots() {
        // Paper prediction bots (both family aliases) are eligible.
        assert!(eligible_settlement_bot(&bot(
            "p1",
            "prediction",
            true,
            true
        )));
        assert!(eligible_settlement_bot(&bot(
            "p2",
            "polymarket",
            true,
            true
        )));

        // Real-money prediction bot: excluded (redeems on-chain).
        assert!(!eligible_settlement_bot(&bot(
            "real",
            "prediction",
            false,
            true
        )));

        // Paper but wrong family: nothing to settle.
        assert!(!eligible_settlement_bot(&bot("dex", "dex", true, true)));
        assert!(!eligible_settlement_bot(&bot("mm", "mm", true, true)));

        // Paper prediction but inactive: excluded.
        assert!(!eligible_settlement_bot(&bot(
            "stopped",
            "prediction",
            true,
            false
        )));

        // Wind-down paper prediction bot: excluded.
        let mut winding = bot("wind", "prediction", true, true);
        winding.wind_down_started_at = Some(1);
        assert!(!eligible_settlement_bot(&winding));
    }

    #[test]
    fn family_match_is_case_and_whitespace_tolerant() {
        assert!(eligible_settlement_bot(&bot(
            "p",
            " Prediction ",
            true,
            true
        )));
    }

    #[test]
    fn due_respects_interval() {
        assert!(due(None, 1_000, 900));
        assert!(due(Some(0), 1_000, 900));
        assert!(!due(Some(500), 1_000, 900));
    }
}
