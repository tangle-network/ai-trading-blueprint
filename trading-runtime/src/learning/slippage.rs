//! Online slippage learner — recommends `max_slippage_bps` per token-pair from
//! observed fills, with a failure-backoff that loosens caps when fills fail.
//!
//! ## Recommendation rule
//!
//! For a (token_in, token_out) pair we keep up to 100 recent observed slippage
//! bps and:
//!
//! 1. compute the p95 of those observations,
//! 2. add 20% headroom (`p95 * 1.2`),
//! 3. clamp to `[10, 1000]` bps,
//! 4. if recent failures exceed `pulls / 5`, widen by an extra 50 bps.
//!
//! When no data is available we return the caller-supplied fallback.

use alloy::primitives::Address;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

/// Maximum number of recent observations retained per pair.
pub const MAX_OBSERVATIONS: usize = 100;
/// Hard lower bound on the recommended slippage (bps).
pub const MIN_RECOMMENDED_BPS: u32 = 10;
/// Hard upper bound on the recommended slippage (bps).
pub const MAX_RECOMMENDED_BPS: u32 = 1000;
/// Multiplicative headroom applied to the observed p95.
pub const P95_HEADROOM: f64 = 1.2;
/// Additive widening (bps) applied when failures dominate the recent window.
pub const FAILURE_BACKOFF_BPS: u32 = 50;
/// Failures-to-pulls ratio that triggers the widening backoff (1/5).
pub const FAILURE_BACKOFF_NUMERATOR: u64 = 1;
pub const FAILURE_BACKOFF_DENOMINATOR: u64 = 5;

/// Stable, JSON-friendly key for a (token_in, token_out) pair.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct PairKey {
    pub token_in: Address,
    pub token_out: Address,
}

impl PairKey {
    pub fn new(token_in: Address, token_out: Address) -> Self {
        Self {
            token_in,
            token_out,
        }
    }
}

/// Per-pair statistics — recent observations, current recommendation, and
/// running failure count.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PairStats {
    /// Last `<= MAX_OBSERVATIONS` observed slippage values (bps).
    pub observed_bps: VecDeque<u32>,
    /// Current cached recommendation (bps).
    pub current_max_bps: u32,
    /// Running count of failures observed for this pair.
    pub failure_count: u64,
}

impl PairStats {
    fn record(&mut self, observed_bps: u32) {
        if self.observed_bps.len() == MAX_OBSERVATIONS {
            self.observed_bps.pop_front();
        }
        self.observed_bps.push_back(observed_bps);
        self.current_max_bps = self.compute_recommendation();
    }

    fn record_failure(&mut self) {
        self.failure_count = self.failure_count.saturating_add(1);
        self.current_max_bps = self.compute_recommendation();
    }

    fn compute_recommendation(&self) -> u32 {
        if self.observed_bps.is_empty() {
            return MIN_RECOMMENDED_BPS;
        }

        let mut sorted: Vec<u32> = self.observed_bps.iter().copied().collect();
        sorted.sort_unstable();
        let p95 = percentile(&sorted, 0.95);
        let target = (p95 * P95_HEADROOM).round();
        let mut bps = clamp_to_u32(target);

        // Failure backoff: if recent failures exceed pulls/5, loosen by 50bps.
        let pulls = self.observed_bps.len() as u64;
        if pulls > 0
            && self.failure_count.saturating_mul(FAILURE_BACKOFF_DENOMINATOR)
                > pulls.saturating_mul(FAILURE_BACKOFF_NUMERATOR)
        {
            bps = bps.saturating_add(FAILURE_BACKOFF_BPS);
        }
        bps.clamp(MIN_RECOMMENDED_BPS, MAX_RECOMMENDED_BPS)
    }
}

/// Observed-slippage learner. Maintains [`PairStats`] keyed by [`PairKey`].
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SlippageLearner {
    pub per_pair: HashMap<PairKey, PairStats>,
}

impl SlippageLearner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a successful-fill slippage observation.
    pub fn record_fill(
        &mut self,
        token_in: Address,
        token_out: Address,
        observed_bps: u32,
    ) {
        self.per_pair
            .entry(PairKey::new(token_in, token_out))
            .or_default()
            .record(observed_bps);
    }

    /// Increment the failure counter for a pair (used on 4xx/5xx execution outcomes).
    pub fn record_failure(&mut self, token_in: Address, token_out: Address) {
        self.per_pair
            .entry(PairKey::new(token_in, token_out))
            .or_default()
            .record_failure();
    }

    /// Recommended `max_slippage_bps` for `(token_in, token_out)`. Returns
    /// `fallback` (clamped to bounds) when no observations exist.
    pub fn recommend_max_bps(
        &self,
        token_in: Address,
        token_out: Address,
        fallback: u32,
    ) -> u32 {
        match self.per_pair.get(&PairKey::new(token_in, token_out)) {
            Some(stats) if !stats.observed_bps.is_empty() => stats.current_max_bps,
            _ => fallback.clamp(MIN_RECOMMENDED_BPS, MAX_RECOMMENDED_BPS),
        }
    }

    /// Expose stats for diagnostic endpoints.
    pub fn stats(&self, token_in: Address, token_out: Address) -> Option<&PairStats> {
        self.per_pair.get(&PairKey::new(token_in, token_out))
    }
}

fn percentile(sorted: &[u32], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0] as f64;
    }
    let idx = q * (sorted.len() - 1) as f64;
    let lower = idx.floor() as usize;
    let upper = idx.ceil() as usize;
    let weight = idx - lower as f64;
    let lo = sorted[lower] as f64;
    let hi = sorted[upper] as f64;
    lo + (hi - lo) * weight
}

fn clamp_to_u32(value: f64) -> u32 {
    if value.is_nan() || value <= 0.0 {
        return MIN_RECOMMENDED_BPS;
    }
    if value >= u32::MAX as f64 {
        return MAX_RECOMMENDED_BPS;
    }
    value as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    #[test]
    fn record_fill_updates_observation_window() {
        let mut s = SlippageLearner::new();
        let a = addr(1);
        let b = addr(2);
        s.record_fill(a, b, 30);
        s.record_fill(a, b, 40);
        s.record_fill(a, b, 50);
        let stats = s.stats(a, b).unwrap();
        assert_eq!(stats.observed_bps.len(), 3);
        // current_max_bps is the cached recommendation.
        assert!(stats.current_max_bps >= MIN_RECOMMENDED_BPS);
    }

    #[test]
    fn observation_window_caps_at_100() {
        let mut s = SlippageLearner::new();
        let a = addr(1);
        let b = addr(2);
        for i in 0..150 {
            s.record_fill(a, b, (i % 100) as u32 + 5);
        }
        let stats = s.stats(a, b).unwrap();
        assert_eq!(stats.observed_bps.len(), MAX_OBSERVATIONS);
    }

    #[test]
    fn recommend_max_bps_uses_p95_with_headroom() {
        let mut s = SlippageLearner::new();
        let a = addr(1);
        let b = addr(2);
        // Linear-interpolation p95: with 20 sorted observations indexed 0..19,
        // p95 lands at index 0.95 * 19 = 18.05 — between sorted[18] and sorted[19].
        // 19 fills at 50 bps + 1 at 100 bps -> sorted[18]=50, sorted[19]=100,
        // p95 = 50 + (100-50)*0.05 = 52.5; recommendation = round(52.5 * 1.2) = 63 bps.
        for _ in 0..19 {
            s.record_fill(a, b, 50);
        }
        s.record_fill(a, b, 100);
        let rec = s.recommend_max_bps(a, b, 200);
        assert!(
            (60..=70).contains(&rec),
            "expected ~63 bps (p95~52.5 * 1.2), got {rec}"
        );

        // p95 is sensitive to the upper tail: adding more 100-bps fills lifts
        // sorted[18] from 50 toward 100, pushing the recommendation toward 120.
        for _ in 0..3 {
            s.record_fill(a, b, 100);
        }
        let rec_high = s.recommend_max_bps(a, b, 200);
        assert!(
            rec_high > rec,
            "expected upper-tail observations to raise the recommendation, got {rec} -> {rec_high}"
        );
    }

    #[test]
    fn recommend_max_bps_clamped_to_bounds() {
        let mut s = SlippageLearner::new();
        let a = addr(1);
        let b = addr(2);
        // Below floor: a single low observation should still be >= 10 bps.
        s.record_fill(a, b, 1);
        let rec = s.recommend_max_bps(a, b, 50);
        assert!(rec >= MIN_RECOMMENDED_BPS);

        // Above ceiling.
        let c = addr(3);
        let d = addr(4);
        for _ in 0..10 {
            s.record_fill(c, d, 5_000);
        }
        let rec = s.recommend_max_bps(c, d, 50);
        assert_eq!(rec, MAX_RECOMMENDED_BPS);
    }

    #[test]
    fn fallback_used_when_no_observations() {
        let s = SlippageLearner::new();
        let a = addr(1);
        let b = addr(2);
        let rec = s.recommend_max_bps(a, b, 75);
        assert_eq!(rec, 75);
        // Fallback also gets clamped.
        let too_high = s.recommend_max_bps(a, b, 9_999);
        assert_eq!(too_high, MAX_RECOMMENDED_BPS);
    }

    #[test]
    fn failure_backoff_widens_recommendation() {
        let mut s = SlippageLearner::new();
        let a = addr(1);
        let b = addr(2);
        // 5 fills at 50 bps -> p95 ≈ 50, rec ≈ 60.
        for _ in 0..5 {
            s.record_fill(a, b, 50);
        }
        let baseline = s.recommend_max_bps(a, b, 0);

        // 2 failures with 5 pulls: failures*5 (10) > pulls*1 (5) -> backoff fires.
        s.record_failure(a, b);
        s.record_failure(a, b);
        let widened = s.recommend_max_bps(a, b, 0);

        assert!(
            widened > baseline,
            "expected backoff to widen recommendation: baseline={baseline} widened={widened}"
        );
        assert!(widened - baseline >= FAILURE_BACKOFF_BPS - 1);
    }

    #[test]
    fn percentile_handles_edge_cases() {
        assert_eq!(percentile(&[], 0.95), 0.0);
        assert_eq!(percentile(&[42], 0.95), 42.0);
        let sorted = [10u32, 20, 30, 40, 50];
        let p95 = percentile(&sorted, 0.95);
        assert!((46.0..=50.0).contains(&p95));
    }

    #[test]
    fn record_failure_without_observations_is_safe() {
        let mut s = SlippageLearner::new();
        let a = addr(1);
        let b = addr(2);
        s.record_failure(a, b);
        let stats = s.stats(a, b).unwrap();
        assert_eq!(stats.failure_count, 1);
        assert_eq!(stats.observed_bps.len(), 0);
    }
}
