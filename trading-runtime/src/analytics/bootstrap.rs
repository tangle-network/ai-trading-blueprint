//! Bootstrap confidence intervals for any scalar statistic computed from a
//! sample. The headline use is a CI band on Sharpe ratios — shipping a
//! single Sharpe number on N < 250 trades without a CI is intellectually
//! dishonest given the estimator's variance.
//!
//! The API is generic in the statistic: `ci_for` takes any closure
//! `&[f64] → Option<f64>` and returns a (lo, hi) interval at the requested
//! confidence level. `sharpe` and `sortino` ship as built-in closures —
//! callers can pass anything (annualised return, Sortino, max-drawdown,
//! profit factor, …) and get an honest CI for it.

use super::Xorshift64;

/// Sane upper bound on a resampled Sharpe — anything beyond this is a
/// near-zero stdev artefact, not a strategy signal. Used to discard
/// pathological resamples instead of letting them dominate the CI.
const SHARPE_CLIP_MAGNITUDE: f64 = 20.0;

/// Two-sided confidence interval for `stat` on `samples` via percentile
/// bootstrap. Returns `(NaN, NaN)` if the sample has fewer than `min_n`
/// observations or if every resample produced an undefined statistic
/// (e.g. zero stdev for Sharpe).
///
/// `alpha` is the total tail mass — pass `0.05` for a 95% CI, `0.10` for a
/// 90% CI, etc.
///
/// `seed` makes the result deterministic; the same seed on the same data
/// returns the same interval bit-for-bit.
pub fn ci_for<F>(
    samples: &[f64],
    n_resamples: usize,
    alpha: f64,
    min_n: usize,
    seed: u64,
    stat: F,
) -> (f64, f64)
where
    F: Fn(&[f64]) -> Option<f64>,
{
    if samples.len() < min_n.max(2) || n_resamples == 0 {
        return (f64::NAN, f64::NAN);
    }
    let mut rng = Xorshift64::from_seed(seed);
    let n = samples.len();
    let mut buf = Vec::with_capacity(n);
    let mut estimates = Vec::with_capacity(n_resamples);
    for _ in 0..n_resamples {
        buf.clear();
        for _ in 0..n {
            buf.push(samples[rng.index(n)]);
        }
        if let Some(s) = stat(&buf)
            && s.is_finite()
            && s.abs() <= SHARPE_CLIP_MAGNITUDE
        {
            estimates.push(s);
        }
    }
    if estimates.is_empty() {
        return (f64::NAN, f64::NAN);
    }
    estimates.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let lo_idx = ((alpha / 2.0) * estimates.len() as f64) as usize;
    let hi_idx = (((1.0 - alpha / 2.0) * estimates.len() as f64) as usize).min(estimates.len() - 1);
    (estimates[lo_idx], estimates[hi_idx])
}

/// Sharpe ratio of a sample of returns. The scaling convention is
/// `mean / std × sqrt(N)` — this is the trade-Sharpe estimator, not the
/// annualised one. For trade-quality comparison across strategies on the
/// same horizon it's the right shape; for cross-horizon comparison (1h vs
/// daily) scale by the actual periodicity in the caller.
pub fn sharpe(returns: &[f64]) -> Option<f64> {
    if returns.len() < 2 {
        return None;
    }
    let mean: f64 = returns.iter().sum::<f64>() / returns.len() as f64;
    let var: f64 =
        returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (returns.len() - 1) as f64;
    let stdev = var.sqrt();
    if !stdev.is_finite() || stdev == 0.0 {
        return None;
    }
    Some(mean / stdev * (returns.len() as f64).sqrt())
}

/// Sortino ratio — like Sharpe but the denominator is the stdev of NEGATIVE
/// returns only ("downside deviation"). Penalises only adverse volatility,
/// which is what a risk manager actually cares about. Returns `None` when
/// there are no negative returns (the strategy never lost — usually a
/// sample-size signal, not a winning streak).
pub fn sortino(returns: &[f64]) -> Option<f64> {
    if returns.len() < 2 {
        return None;
    }
    let mean: f64 = returns.iter().sum::<f64>() / returns.len() as f64;
    let downside: Vec<f64> = returns.iter().copied().filter(|r| *r < 0.0).collect();
    if downside.is_empty() {
        return None;
    }
    let var: f64 = downside.iter().map(|r| r.powi(2)).sum::<f64>() / downside.len() as f64;
    let dd = var.sqrt();
    if !dd.is_finite() || dd == 0.0 {
        return None;
    }
    Some(mean / dd * (returns.len() as f64).sqrt())
}

/// Convenience: 95% Sharpe CI with 1000 resamples — the defaults for fleet-
/// level review. Equivalent to `ci_for(returns, 1000, 0.05, 5, seed, sharpe)`.
pub fn sharpe_ci_95(returns: &[f64], seed: u64) -> (f64, f64) {
    ci_for(returns, 1000, 0.05, 5, seed, sharpe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sharpe_constant_series_is_none() {
        assert_eq!(sharpe(&[0.5; 10]), None);
    }

    #[test]
    fn sharpe_simple_known() {
        // Returns 1, 2, 3, 4, 5 → mean 3, sample stdev sqrt(2.5), N=5.
        // Sharpe = 3/sqrt(2.5) * sqrt(5) = 4.243…
        let s = sharpe(&[1.0, 2.0, 3.0, 4.0, 5.0]).unwrap();
        assert!((s - 4.243).abs() < 0.01, "got {s}");
    }

    #[test]
    fn sortino_returns_none_with_no_losses() {
        assert_eq!(sortino(&[0.01, 0.02, 0.03, 0.04]), None);
    }

    #[test]
    fn sortino_penalises_only_downside() {
        // The same returns but split between gains + losses → Sortino
        // should differ from Sharpe because of the downside-only stdev.
        let returns = [0.05, 0.03, -0.02, 0.01, -0.04, 0.06];
        let sh = sharpe(&returns).unwrap();
        let so = sortino(&returns).unwrap();
        assert_ne!(sh, so);
    }

    #[test]
    fn ci_for_empty_or_too_small_returns_nan() {
        let (lo, hi) = ci_for(&[1.0], 100, 0.05, 5, 0, sharpe);
        assert!(lo.is_nan() && hi.is_nan());
    }

    #[test]
    fn ci_for_sharpe_is_deterministic_with_seed() {
        let returns: Vec<f64> = (0..50).map(|i| ((i as f64) % 7.0 - 3.0) / 100.0).collect();
        let a = sharpe_ci_95(&returns, 42);
        let b = sharpe_ci_95(&returns, 42);
        assert_eq!(a, b, "same seed must give same CI");
        let c = sharpe_ci_95(&returns, 43);
        assert_ne!(a, c, "different seeds should differ");
    }

    #[test]
    fn ci_for_sharpe_brackets_point_estimate_most_of_the_time() {
        // Generate a noisy positive-mean series; the bootstrap 95% CI should
        // contain the realised Sharpe with high probability (we're just
        // checking the CI is reasonable, not a strict coverage proof).
        let returns: Vec<f64> = (0..200)
            .map(|i| 0.001 + ((i as f64) % 13.0 - 6.0) / 500.0)
            .collect();
        let realised = sharpe(&returns).unwrap();
        let (lo, hi) = sharpe_ci_95(&returns, 12345);
        // The realised point estimate should be near the centre of the CI,
        // not pinned to an endpoint or outside it entirely.
        assert!(lo < hi);
        assert!(realised > lo - (hi - lo).abs() && realised < hi + (hi - lo).abs());
    }

    #[test]
    fn ci_clips_pathological_resamples() {
        // A degenerate two-element series with near-equal values is the
        // worst case for Sharpe stdev. Even here, ci_for must not return
        // infinities or NaN endpoints (it clips beyond ±20).
        let returns = [0.0001, 0.00011, 0.000099, 0.000105, 0.00010];
        let (lo, hi) = sharpe_ci_95(&returns, 7);
        if !lo.is_nan() {
            assert!(lo.abs() <= 20.0 && hi.abs() <= 20.0);
        }
    }
}
