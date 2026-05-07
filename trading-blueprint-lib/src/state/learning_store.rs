//! Per-bot persistence of strategy-bandit + slippage-learner state.
//!
//! Re-exports the canonical implementation from
//! `trading_http_api::learning_store`. The canonical store lives in the HTTP
//! crate so post-trade hooks (`routes::execute`) and `/learning/*` endpoints
//! can mutate the on-disk state without crossing the dependency cycle into
//! `trading-blueprint-lib`. Lifecycle code in this crate (e.g. wind-down)
//! reaches the same state through this re-export.

pub use trading_http_api::learning_store::{
    BotLearningState, clear, load, observed_slippage_bps, recommend_max_slippage_bps,
    record_failure, record_fill, record_strategy_outcome, save, update,
};

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::Address;
    use once_cell::sync::Lazy;

    /// One-time install of an in-process learning-dir override that bypasses
    /// `BLUEPRINT_STATE_DIR` entirely. Sibling tests in this crate
    /// (`operator_chat`, `state::tests::test_state_queries`) mutate the env
    /// var and drop their tempdirs, which races with our writes when run
    /// concurrently. Routing through `learning_store::set_test_dir` removes
    /// us from that critical section.
    static SHARED_DIR_INSTALLED: Lazy<()> = Lazy::new(|| {
        let tmp = tempfile::TempDir::new().expect("create shared temp learning dir");
        let path = tmp.path().to_path_buf();
        std::mem::forget(tmp);
        trading_http_api::learning_store::set_test_dir(path);
    });

    fn ensure_state_dir() {
        Lazy::force(&SHARED_DIR_INSTALLED);
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
