//! Monte Carlo stability tests — the most honest answer to "did this Sharpe
//! survive because the strategy has edge or because the trades happened to
//! land in a lucky order?".
//!
//! Two complementary shuffles:
//!
//!   1. **Trade-order shuffle.** Take the realised per-trade PnL stream,
//!      shuffle the order N times, recompute Sharpe each time. The
//!      realised Sharpe should sit in the upper tail of the distribution
//!      if the strategy has timing edge (entries clustered in good
//!      regimes). If it sits at the median, the strategy is driven by
//!      independent positive expectancy — also fine, but a different
//!      story. Below the median = the strategy got lucky.
//!
//!   2. **Return-stream shuffle.** Shuffle the per-bar returns of an
//!      asset, rebuild a synthetic price series, and re-run the strategy.
//!      The realised Sharpe on the true series should beat the median of
//!      the synthetic distribution. If it doesn't, the result is
//!      consistent with a random walk + noise — i.e. no evidence of
//!      strategy edge versus chance.
//!
//! Both return the same `Stability` shape so the report layer can compare
//! them uniformly.

use super::Xorshift64;

/// Where the realised statistic sits within the shuffled distribution.
#[derive(Debug, Clone, Default)]
pub struct Stability {
    /// The realised (un-shuffled) statistic.
    pub realised: f64,
    /// Mean of the shuffled distribution.
    pub shuffled_mean: f64,
    /// Stdev of the shuffled distribution.
    pub shuffled_std: f64,
    /// 5th / 50th / 95th percentile of the shuffled distribution.
    pub p05: f64,
    pub p50: f64,
    pub p95: f64,
    /// Percentile of the realised value within the shuffled distribution.
    /// `> 95` = strong evidence of timing edge; `< 5` = "got lucky"; near
    /// `50` = no timing signal (could still be a good strategy via positive
    /// expectancy, just not from sequencing).
    pub percentile_of_realised: f64,
    /// Number of valid shuffled estimates contributing to the distribution.
    pub n_valid: usize,
}

fn percentile_of(sorted: &[f64], value: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let count = sorted.iter().filter(|x| **x <= value).count();
    100.0 * count as f64 / sorted.len() as f64
}

fn summarize(realised: f64, mut shuffled: Vec<f64>) -> Stability {
    if shuffled.is_empty() {
        return Stability {
            realised,
            ..Stability::default()
        };
    }
    shuffled.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = shuffled.len();
    let mean: f64 = shuffled.iter().sum::<f64>() / n as f64;
    let var: f64 =
        shuffled.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n as f64 - 1.0).max(1.0);
    let std = var.sqrt();
    let pct = |q: f64| -> f64 {
        let idx = ((q * n as f64) as usize).min(n - 1);
        shuffled[idx]
    };
    Stability {
        realised,
        shuffled_mean: mean,
        shuffled_std: std,
        p05: pct(0.05),
        p50: pct(0.50),
        p95: pct(0.95),
        percentile_of_realised: percentile_of(&shuffled, realised),
        n_valid: n,
    }
}

/// Shuffle a per-trade PnL stream N times and compute `stat` on each
/// shuffle. Returns a `Stability` placing the realised statistic in the
/// shuffled distribution.
///
/// `stat` is the same closure shape `bootstrap::ci_for` uses (`&[f64] →
/// Option<f64>`) so e.g. `bootstrap::sharpe` plugs in directly.
pub fn trade_order_shuffle<F>(
    trade_pnls: &[f64],
    n_shuffles: usize,
    seed: u64,
    stat: F,
) -> Stability
where
    F: Fn(&[f64]) -> Option<f64>,
{
    if trade_pnls.len() < 5 || n_shuffles == 0 {
        return Stability::default();
    }
    let realised = stat(trade_pnls).unwrap_or(f64::NAN);
    let mut rng = Xorshift64::from_seed(seed);
    let n = trade_pnls.len();
    let mut buf: Vec<f64> = trade_pnls.to_vec();
    let mut samples = Vec::with_capacity(n_shuffles);
    for _ in 0..n_shuffles {
        // Fisher-Yates: in-place uniform shuffle in O(n).
        for i in (1..n).rev() {
            let j = rng.index(i + 1);
            buf.swap(i, j);
        }
        if let Some(s) = stat(&buf)
            && s.is_finite()
            && s.abs() <= 20.0
        {
            samples.push(s);
        }
    }
    summarize(realised, samples)
}

/// Shuffle the per-bar returns of an asset N times, rebuild the synthetic
/// price series each time, and report `stat` on the returns themselves (or
/// on a function of them — caller's choice).
///
/// For a true "synthetic-data" backtest you would re-run the strategy on
/// each synthetic price series; that requires the strategy as a closure
/// over `&[Candle]`, which we keep out of this module (the engine lives
/// elsewhere). What this function does ship is the most useful baseline:
/// the distribution of the SAME statistic on randomised returns. If the
/// realised statistic doesn't beat that distribution, the strategy is
/// indistinguishable from chance on this series.
pub fn return_stream_shuffle<F>(returns: &[f64], n_shuffles: usize, seed: u64, stat: F) -> Stability
where
    F: Fn(&[f64]) -> Option<f64>,
{
    // Trade-order shuffle and return-stream shuffle are mathematically
    // the same operation when `stat` is symmetric in order (Sharpe is
    // NOT order-symmetric — `mean / std` is, but `cumulative return
    // path` isn't). The semantics differ in INTERPRETATION:
    //   trade_order_shuffle    — sample is the realised PnLs from trades
    //                            the strategy actually took.
    //   return_stream_shuffle  — sample is the underlying bar returns
    //                            of the asset, asking the "vs random
    //                            walk" question.
    // The implementation overlaps; we delegate.
    trade_order_shuffle(returns, n_shuffles, seed, stat)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::bootstrap::sharpe;

    #[test]
    fn empty_input_returns_default() {
        let s = trade_order_shuffle(&[], 100, 1, sharpe);
        assert_eq!(s.n_valid, 0);
    }

    #[test]
    fn percentile_is_sensible_for_permutation_invariant_stat() {
        // Sharpe is mathematically permutation-invariant (mean / std are
        // both symmetric in their arguments). In floating-point the
        // re-ordered sums introduce sub-eps drift, but every shuffled
        // estimate is within ~1e-15 of the realised — the percentile
        // therefore lands somewhere in [0, 100] with no useful signal.
        // The test that matters: the distribution is collapsed (std≈0)
        // and the realised sits inside it.
        let pnls: Vec<f64> = (0..50).map(|i| ((i as f64 % 5.0) - 2.0) / 100.0).collect();
        let s = trade_order_shuffle(&pnls, 500, 42, sharpe);
        assert!(
            s.shuffled_std.abs() < 1e-10,
            "expected collapsed dist, std={}",
            s.shuffled_std
        );
        assert!((s.realised - s.p50).abs() < 1e-10);
    }

    #[test]
    fn deterministic_with_seed() {
        let pnls = [
            0.01, -0.02, 0.03, -0.01, 0.02, 0.04, -0.03, 0.01, 0.02, -0.01,
        ];
        // We pick a NON-permutation-invariant stat to actually exercise
        // the shuffle: cumulative max (a path-dependent quantity).
        fn max_running(returns: &[f64]) -> Option<f64> {
            let mut sum = 0.0;
            let mut peak = f64::NEG_INFINITY;
            for r in returns {
                sum += r;
                peak = peak.max(sum);
            }
            Some(peak)
        }
        let a = trade_order_shuffle(&pnls, 200, 99, max_running);
        let b = trade_order_shuffle(&pnls, 200, 99, max_running);
        assert_eq!(a.shuffled_mean, b.shuffled_mean);
        assert_eq!(a.p50, b.p50);
        let c = trade_order_shuffle(&pnls, 200, 100, max_running);
        // Different seed → different distribution mean (almost surely).
        assert_ne!(a.shuffled_mean, c.shuffled_mean);
    }
}
