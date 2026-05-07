//! Per-bot persistence of strategy-bandit + slippage-learner state.
//!
//! Each bot stores a single JSON file under `state_dir/learning/{bot_id}.json`
//! that round-trips both [`StrategyBandit`] and [`SlippageLearner`]. The store
//! follows the same on-disk layout pattern as
//! `trading-http-api::routes::envelope` — a flat directory of JSON blobs keyed
//! by sanitized bot id, written eagerly and read on demand.

use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use trading_runtime::learning::{SlippageLearner, StrategyBandit};

/// Combined learning state for a single bot.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct BotLearningState {
    #[serde(default)]
    pub bandit: StrategyBandit,
    #[serde(default)]
    pub slippage: SlippageLearner,
}

/// Coarse process-wide write lock — guards file writes against concurrent
/// callers in the same process. We accept the conservative single-mutex
/// approach because writes are infrequent (post-trade hooks, daily reflection).
static WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn learning_dir() -> PathBuf {
    sandbox_runtime::store::state_dir().join("learning")
}

fn sanitize_bot_id(bot_id: &str) -> String {
    bot_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn learning_path(bot_id: &str) -> PathBuf {
    learning_dir().join(format!("{}.json", sanitize_bot_id(bot_id)))
}

/// Load the learning state for `bot_id`. Returns the default empty state if
/// no file exists yet. A corrupt file is logged and treated as missing so a
/// single bad write can't permanently brick the agent's learner.
pub fn load(bot_id: &str) -> BotLearningState {
    match std::fs::read_to_string(learning_path(bot_id)) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(state) => state,
            Err(e) => {
                tracing::error!(
                    bot_id,
                    "Corrupt learning state file — using empty state: {e}"
                );
                BotLearningState::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BotLearningState::default(),
        Err(e) => {
            tracing::error!(bot_id, "Failed to read learning state: {e}");
            BotLearningState::default()
        }
    }
}

/// Persist `state` for `bot_id`. Write errors are surfaced to the caller so
/// hooks can downgrade them to warnings without losing visibility.
pub fn save(bot_id: &str, state: &BotLearningState) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "learning store mutex poisoned".to_string())?;

    std::fs::create_dir_all(learning_dir()).map_err(|e| format!("create learning dir: {e}"))?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialize learning state: {e}"))?;
    std::fs::write(learning_path(bot_id), json).map_err(|e| format!("write learning state: {e}"))
}

/// Read-modify-write helper. The closure receives the current state and may
/// mutate it; the result is persisted on success.
pub fn update<F>(bot_id: &str, mutate: F) -> Result<BotLearningState, String>
where
    F: FnOnce(&mut BotLearningState),
{
    let mut state = load(bot_id);
    mutate(&mut state);
    save(bot_id, &state)?;
    Ok(state)
}

/// Remove the learning state for `bot_id` (used when a bot is deprovisioned).
pub fn clear(bot_id: &str) -> Result<(), String> {
    let path = learning_path(bot_id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove learning state: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::Address;
    use std::sync::Once;

    fn ensure_state_dir() {
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let tmp = tempfile::TempDir::new().unwrap();
            // SAFETY: called once before any other threads read this env var
            unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };
            std::mem::forget(tmp);
        });
    }

    fn addr(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    #[test]
    fn save_then_load_round_trips_both_structures() {
        ensure_state_dir();
        let bot_id = format!("learning-rt-{}", uuid::Uuid::new_v4());

        let mut state = BotLearningState::default();
        state.bandit.ensure_arm("variant-a");
        state.bandit.ensure_arm("variant-b");
        state.bandit.record_outcome("variant-a", 3.5);
        state.bandit.record_outcome("variant-b", 1.0);

        let token_in = addr(0x11);
        let token_out = addr(0x22);
        state.slippage.record_fill(token_in, token_out, 25);
        state.slippage.record_fill(token_in, token_out, 35);
        state.slippage.record_failure(token_in, token_out);

        save(&bot_id, &state).unwrap();
        let reloaded = load(&bot_id);

        assert_eq!(reloaded, state);
        assert_eq!(reloaded.bandit.total_pulls, 2);
        assert_eq!(reloaded.bandit.best_arm().unwrap().variant_id, "variant-a");
        let pair_stats = reloaded.slippage.stats(token_in, token_out).unwrap();
        assert_eq!(pair_stats.observed_bps.len(), 2);
        assert_eq!(pair_stats.failure_count, 1);
    }

    #[test]
    fn load_missing_returns_default() {
        ensure_state_dir();
        let bot_id = format!("learning-missing-{}", uuid::Uuid::new_v4());
        let state = load(&bot_id);
        assert_eq!(state, BotLearningState::default());
    }

    #[test]
    fn update_mutates_and_persists() {
        ensure_state_dir();
        let bot_id = format!("learning-update-{}", uuid::Uuid::new_v4());

        let _ = update(&bot_id, |s| {
            s.bandit.record_outcome("v1", 2.0);
        })
        .unwrap();

        let later = update(&bot_id, |s| {
            s.bandit.record_outcome("v1", 4.0);
        })
        .unwrap();

        assert_eq!(later.bandit.total_pulls, 2);
        let arm = later
            .bandit
            .arms
            .iter()
            .find(|a| a.variant_id == "v1")
            .unwrap();
        assert!((arm.total_reward - 6.0).abs() < 1e-9);
    }

    #[test]
    fn clear_removes_file_and_is_idempotent() {
        ensure_state_dir();
        let bot_id = format!("learning-clear-{}", uuid::Uuid::new_v4());
        save(&bot_id, &BotLearningState::default()).unwrap();
        clear(&bot_id).unwrap();
        // Second clear must not error out.
        clear(&bot_id).unwrap();
        assert_eq!(load(&bot_id), BotLearningState::default());
    }
}
