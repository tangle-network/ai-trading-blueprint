//! Strategy-level self-improvement primitives.
//!
//! This module contains two cooperating online learners:
//!
//! - [`StrategyBandit`] — a UCB1 multi-arm bandit over strategy variants. The
//!   agent runs each arm, records realised reward (P&L or sharpe), and the
//!   bandit allocates exploitation budget to the best performer.
//! - [`SlippageLearner`] — a p95+headroom recommender for `max_slippage_bps`
//!   per token-pair, with a failure backoff that loosens caps when fills fail.
//!
//! Both structures are pure data + algorithmic helpers; persistence is
//! handled by `trading-http-api::learning_store` and re-exported through
//! `trading-blueprint-lib::state::learning_store`.

pub mod bandit;
pub mod slippage;

pub use bandit::{BanditArm, StrategyBandit};
pub use slippage::{PairKey, PairStats, SlippageLearner};

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Cap for the FIFO history of recorded `(variant_id, iteration_id)` pairs
/// per bot. Sized to keep the on-disk JSON blob bounded while comfortably
/// covering the agent's typical phase budget (single-digit-thousand
/// iterations per reflection cycle). Older entries are evicted in
/// insertion order.
pub const MAX_RECORDED_ITERATIONS: usize = 10_000;

/// Combined learning state for a single bot — the on-disk wire format shared
/// across the HTTP API and the blueprint lib.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct BotLearningState {
    #[serde(default)]
    pub bandit: StrategyBandit,
    #[serde(default)]
    pub slippage: SlippageLearner,
    /// Idempotency journal for `(variant_id, iteration_id)` pairs. Capped
    /// at [`MAX_RECORDED_ITERATIONS`] entries with FIFO eviction. Used by
    /// `POST /learning/strategy-outcome` to dedup retried requests.
    ///
    /// Stored as a `VecDeque<String>` (rather than a `HashSet`) so the
    /// FIFO eviction order is stable across restarts; membership is
    /// answered with a linear scan, which is acceptable at the cap of
    /// 10K entries (each lookup is O(N) but amortizes against an O(N) on-disk
    /// JSON serialize anyway).
    #[serde(default)]
    pub recorded_iterations: VecDeque<String>,
}

impl BotLearningState {
    /// Insertion key for `recorded_iterations`. Combining `variant_id` and
    /// `iteration_id` keeps the dedup keyed on both — a retried POST with
    /// the same iteration id but a different variant still records the
    /// new variant; only true duplicates are skipped.
    fn iteration_key(variant_id: &str, iteration_id: &str) -> String {
        // `\x1f` (unit separator) is reserved for in-record delimiters and
        // can't appear in either field by construction.
        format!("{variant_id}\x1f{iteration_id}")
    }

    /// `true` if `(variant_id, iteration_id)` has already been recorded.
    pub fn has_recorded_iteration(&self, variant_id: &str, iteration_id: &str) -> bool {
        let key = Self::iteration_key(variant_id, iteration_id);
        self.recorded_iterations.iter().any(|k| k == &key)
    }

    /// Append `(variant_id, iteration_id)` to the journal, evicting the
    /// oldest entry if the cap has been hit. Idempotent — re-noting an
    /// existing tuple is a no-op.
    pub fn note_iteration(&mut self, variant_id: &str, iteration_id: &str) {
        let key = Self::iteration_key(variant_id, iteration_id);
        if self.recorded_iterations.iter().any(|k| k == &key) {
            return;
        }
        self.recorded_iterations.push_back(key);
        while self.recorded_iterations.len() > MAX_RECORDED_ITERATIONS {
            self.recorded_iterations.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_iteration_dedups() {
        let mut s = BotLearningState::default();
        assert!(!s.has_recorded_iteration("v1", "iter-0"));
        s.note_iteration("v1", "iter-0");
        assert!(s.has_recorded_iteration("v1", "iter-0"));
        // Distinct iteration_id is not a dup.
        assert!(!s.has_recorded_iteration("v1", "iter-1"));
        // Distinct variant_id is not a dup either.
        assert!(!s.has_recorded_iteration("v2", "iter-0"));
        // Re-noting is a no-op (no growth).
        s.note_iteration("v1", "iter-0");
        assert_eq!(s.recorded_iterations.len(), 1);
    }

    #[test]
    fn note_iteration_fifo_evicts_at_cap() {
        let mut s = BotLearningState::default();
        for i in 0..(MAX_RECORDED_ITERATIONS + 5) {
            s.note_iteration("v1", &format!("iter-{i}"));
        }
        assert_eq!(s.recorded_iterations.len(), MAX_RECORDED_ITERATIONS);
        // The first 5 must have been evicted.
        for i in 0..5 {
            assert!(!s.has_recorded_iteration("v1", &format!("iter-{i}")));
        }
        // The most recent entries must still be present.
        assert!(s.has_recorded_iteration("v1", &format!("iter-{}", MAX_RECORDED_ITERATIONS + 4)));
    }
}
