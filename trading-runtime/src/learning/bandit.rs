//! UCB1 multi-arm bandit over strategy variants.
//!
//! Each [`BanditArm`] tracks a `variant_id` (matching a
//! [`crate::types::StrategyDefinition::id`]), the number of times that arm was
//! pulled, and the cumulative reward (typically realised P&L or a Sharpe-like
//! score over a reflection window).
//!
//! [`StrategyBandit::select_arm`] returns the arm to play next:
//! - any unpulled arm has infinite priority (forced exploration);
//! - otherwise we pick the arm with the highest UCB1 score
//!   `mean_reward + sqrt(2 * ln(total_pulls) / arm.pulls)`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One arm of the strategy bandit — a candidate variant being evaluated.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BanditArm {
    /// Matches a [`crate::types::StrategyDefinition::id`].
    pub variant_id: String,
    /// Number of pulls (selections) so far.
    pub pulls: u64,
    /// Accumulated reward (P&L, Sharpe, or any scalar feedback).
    pub total_reward: f64,
    /// Wall-clock time of the most recent pull.
    pub last_pull_at: Option<DateTime<Utc>>,
}

impl BanditArm {
    pub fn new(variant_id: impl Into<String>) -> Self {
        Self {
            variant_id: variant_id.into(),
            pulls: 0,
            total_reward: 0.0,
            last_pull_at: None,
        }
    }

    /// Mean reward (0.0 if no pulls).
    pub fn mean_reward(&self) -> f64 {
        if self.pulls == 0 {
            0.0
        } else {
            self.total_reward / self.pulls as f64
        }
    }

    /// UCB1 score given the bandit's running total of pulls.
    /// Returns `f64::INFINITY` for unpulled arms so they are tried first.
    pub fn ucb1_score(&self, total_pulls: u64) -> f64 {
        if self.pulls == 0 {
            return f64::INFINITY;
        }
        let exploration =
            (2.0 * (total_pulls.max(1) as f64).ln() / self.pulls as f64).sqrt();
        self.mean_reward() + exploration
    }
}

/// Multi-arm bandit holding one [`BanditArm`] per candidate strategy variant.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct StrategyBandit {
    pub arms: Vec<BanditArm>,
    pub total_pulls: u64,
}

impl StrategyBandit {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct a bandit pre-populated with one arm per variant id.
    pub fn with_variants<I, S>(variant_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            arms: variant_ids.into_iter().map(BanditArm::new).collect(),
            total_pulls: 0,
        }
    }

    /// Add an arm if it isn't already present. Returns `true` if added.
    pub fn ensure_arm(&mut self, variant_id: &str) -> bool {
        if self.arms.iter().any(|a| a.variant_id == variant_id) {
            return false;
        }
        self.arms.push(BanditArm::new(variant_id));
        true
    }

    /// Number of arms (variants) currently registered.
    pub fn arm_count(&self) -> usize {
        self.arms.len()
    }

    /// Pick the next arm using UCB1. Returns `None` when there are no arms.
    pub fn select_arm(&self) -> Option<&BanditArm> {
        if self.arms.is_empty() {
            return None;
        }
        // Force-explore unpulled arms before doing UCB1 math.
        if let Some(unpulled) = self.arms.iter().find(|a| a.pulls == 0) {
            return Some(unpulled);
        }
        self.arms.iter().max_by(|a, b| {
            a.ucb1_score(self.total_pulls)
                .partial_cmp(&b.ucb1_score(self.total_pulls))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    /// Record an observed reward for `variant_id`. Adds the arm if missing —
    /// useful when a daily reflection step reports an outcome for a variant
    /// that wasn't pre-registered.
    pub fn record_outcome(&mut self, variant_id: &str, reward: f64) {
        let now = Utc::now();
        if let Some(arm) = self.arms.iter_mut().find(|a| a.variant_id == variant_id) {
            arm.pulls = arm.pulls.saturating_add(1);
            arm.total_reward += reward;
            arm.last_pull_at = Some(now);
        } else {
            self.arms.push(BanditArm {
                variant_id: variant_id.to_string(),
                pulls: 1,
                total_reward: reward,
                last_pull_at: Some(now),
            });
        }
        self.total_pulls = self.total_pulls.saturating_add(1);
    }

    /// Highest mean-reward arm (ignores exploration term). Unpulled arms are
    /// excluded so we don't report a default-zero "best".
    pub fn best_arm(&self) -> Option<&BanditArm> {
        self.arms
            .iter()
            .filter(|a| a.pulls > 0)
            .max_by(|a, b| {
                a.mean_reward()
                    .partial_cmp(&b.mean_reward())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_arm_prefers_unpulled() {
        let mut b = StrategyBandit::with_variants(["a", "b", "c"]);
        // Pull "a" once so "b" and "c" are still unpulled.
        b.record_outcome("a", 5.0);

        let pick = b.select_arm().unwrap();
        // Must pick an unpulled arm, not the high-reward one.
        assert!(pick.variant_id == "b" || pick.variant_id == "c");
        assert_eq!(pick.pulls, 0);
    }

    #[test]
    fn select_arm_uses_ucb1_after_warmup() {
        let mut b = StrategyBandit::with_variants(["a", "b"]);
        // Warm-up: each arm pulled once with comparable rewards.
        b.record_outcome("a", 1.0);
        b.record_outcome("b", 0.5);

        // Both arms have identical exploration term (pulls=1, total=2),
        // so UCB1 picks the higher mean — "a".
        let pick = b.select_arm().unwrap();
        assert_eq!(pick.variant_id, "a");

        // Confirm UCB1 mechanics: arm a (pulls=10, mean=1.0) vs arm b (pulls=1, mean=0.5).
        // exploration(a) = sqrt(2*ln(11)/10) ~= 0.69, ucb1(a) ~= 1.69
        // exploration(b) = sqrt(2*ln(11)/1)  ~= 2.19, ucb1(b) ~= 2.69
        // -> exploration must drag selection back to "b".
        for _ in 0..9 {
            b.record_outcome("a", 1.0);
        }
        let pick = b.select_arm().unwrap();
        assert_eq!(pick.variant_id, "b");
    }

    #[test]
    fn record_outcome_updates_pulls_and_total() {
        let mut b = StrategyBandit::with_variants(["a"]);
        b.record_outcome("a", 2.0);
        b.record_outcome("a", 4.0);

        let arm = b.arms.iter().find(|a| a.variant_id == "a").unwrap();
        assert_eq!(arm.pulls, 2);
        assert!((arm.total_reward - 6.0).abs() < 1e-9);
        assert!((arm.mean_reward() - 3.0).abs() < 1e-9);
        assert_eq!(b.total_pulls, 2);
        assert!(arm.last_pull_at.is_some());
    }

    #[test]
    fn record_outcome_adds_unknown_variant() {
        let mut b = StrategyBandit::new();
        b.record_outcome("late-arrival", 7.5);

        assert_eq!(b.arms.len(), 1);
        assert_eq!(b.arms[0].variant_id, "late-arrival");
        assert_eq!(b.arms[0].pulls, 1);
    }

    #[test]
    fn best_arm_returns_max_mean_reward() {
        let mut b = StrategyBandit::with_variants(["a", "b", "c"]);
        b.record_outcome("a", 1.0);
        b.record_outcome("a", 1.0);
        b.record_outcome("b", 4.0);
        b.record_outcome("c", 2.0);

        let best = b.best_arm().unwrap();
        assert_eq!(best.variant_id, "b");
    }

    #[test]
    fn best_arm_skips_unpulled() {
        let mut b = StrategyBandit::with_variants(["a", "b"]);
        b.record_outcome("a", -1.0);
        // "b" never pulled — best_arm must return "a" even with negative reward.
        let best = b.best_arm().unwrap();
        assert_eq!(best.variant_id, "a");
    }

    #[test]
    fn best_arm_none_when_empty() {
        let b = StrategyBandit::new();
        assert!(b.best_arm().is_none());
        assert!(b.select_arm().is_none());
    }

    #[test]
    fn ensure_arm_is_idempotent() {
        let mut b = StrategyBandit::new();
        assert!(b.ensure_arm("v1"));
        assert!(!b.ensure_arm("v1"));
        assert_eq!(b.arms.len(), 1);
    }
}
