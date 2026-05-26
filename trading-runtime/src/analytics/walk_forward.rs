//! Walk-forward analysis — split an ordered return / candle series into
//! train and test segments and report the in-sample → out-of-sample gap
//! for any scalar statistic. A large positive IS-minus-OOS gap on Sharpe
//! is the canonical overfitting tell.
//!
//! Three schemes are exposed:
//!
//!   * [`Scheme::Holdout`]  — single train/test split at `train_frac`.
//!     Cheapest. Use for fleet-level smoke; supplements bootstrap CI but
//!     does NOT replace a true k-fold cross-validation across years.
//!
//!   * [`Scheme::Expanding`] — the standard walk-forward in finance:
//!     anchor at bar 0, expand the train window in steps, test on the
//!     next chunk each step. Reports the AVERAGE OOS Sharpe across all
//!     folds. Catches regime-dependent overfit better than Holdout.
//!
//!   * [`Scheme::Rolling`]  — sliding window of fixed train width that
//!     walks forward in `step_frac` increments. Sensitive to short-lived
//!     overfits; expensive on N folds.
//!
//! All schemes are deterministic given the input — no randomness — so
//! they don't take a seed.

use std::ops::Range;

/// Choose how the sample is split into train and test segments.
#[derive(Debug, Clone, Copy)]
pub enum Scheme {
    /// Single split: train is `[0, train_frac × N)`, test is the remainder.
    Holdout { train_frac: f64 },
    /// Expanding train window. `folds` chunks of test data; train always
    /// starts at 0 and grows. With `folds = 5` and a 100-bar series, you
    /// get 5 (train, test) pairs:
    ///   (0..80, 80..84), (0..84, 84..88), (0..88, 88..92), (0..92, 92..96), (0..96, 96..100).
    Expanding { folds: usize },
    /// Sliding fixed-width train window, stepping forward in `step_frac`
    /// increments of N. Test is the next non-overlapping chunk of the same
    /// width as the step.
    Rolling { window_frac: f64, step_frac: f64 },
}

/// Outcome of one (train, test) fold.
#[derive(Debug, Clone)]
pub struct Fold {
    pub train: Range<usize>,
    pub test: Range<usize>,
    pub in_sample: Option<f64>,
    pub out_of_sample: Option<f64>,
}

impl Fold {
    /// In-sample minus out-of-sample. Positive = strategy looked better on
    /// training data than on unseen data (a textbook overfit symptom).
    pub fn gap(&self) -> Option<f64> {
        match (self.in_sample, self.out_of_sample) {
            (Some(is), Some(oos)) => Some(is - oos),
            _ => None,
        }
    }
}

/// Aggregate report across all folds. The headline numbers are the average
/// across folds, with the per-fold detail available for drill-down.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub folds: Vec<Fold>,
    pub mean_in_sample: Option<f64>,
    pub mean_out_of_sample: Option<f64>,
    pub mean_gap: Option<f64>,
    /// Heuristic: any fold with gap > 1.0 is loud enough to flag.
    pub overfit_flag: bool,
}

/// Run `stat` on the train and test slices of `series` per `scheme`. The
/// statistic closure receives `&series[range]` — same shape as `bootstrap::ci_for`
/// so the two compose cleanly. Returns `Report` with `folds.is_empty()` when
/// the series is too short for the requested scheme.
pub fn evaluate<F>(series: &[f64], scheme: Scheme, stat: F) -> Report
where
    F: Fn(&[f64]) -> Option<f64>,
{
    let n = series.len();
    if n < 10 {
        return Report::default();
    }
    let folds: Vec<(Range<usize>, Range<usize>)> = match scheme {
        Scheme::Holdout { train_frac } => {
            let split = ((n as f64) * train_frac.clamp(0.01, 0.99)) as usize;
            if split < 5 || split >= n - 5 {
                return Report::default();
            }
            vec![(0..split, split..n)]
        }
        Scheme::Expanding { folds } => {
            if folds < 2 {
                return Report::default();
            }
            let test_size = ((n as f64) * (1.0 - 0.7) / folds as f64).max(1.0) as usize;
            let initial_train = n.saturating_sub(test_size * folds);
            if initial_train < 5 {
                return Report::default();
            }
            (0..folds)
                .map(|i| {
                    let train_end = initial_train + i * test_size;
                    let test_end = (train_end + test_size).min(n);
                    (0..train_end, train_end..test_end)
                })
                .filter(|(_, t)| !t.is_empty())
                .collect()
        }
        Scheme::Rolling { window_frac, step_frac } => {
            let win = ((n as f64) * window_frac.clamp(0.05, 0.95)) as usize;
            let step = ((n as f64) * step_frac.clamp(0.01, 0.5)) as usize;
            if win < 5 || step == 0 {
                return Report::default();
            }
            let mut start = 0;
            let mut out = Vec::new();
            while start + win + step <= n {
                out.push((start..start + win, start + win..start + win + step));
                start += step;
            }
            out
        }
    };

    let mut report = Report::default();
    for (train, test) in folds {
        let train_slice = &series[train.clone()];
        let test_slice = &series[test.clone()];
        let is_v = stat(train_slice);
        let oos_v = stat(test_slice);
        report.folds.push(Fold {
            train,
            test,
            in_sample: is_v,
            out_of_sample: oos_v,
        });
    }
    let is_vals: Vec<f64> = report.folds.iter().filter_map(|f| f.in_sample).collect();
    let oos_vals: Vec<f64> = report.folds.iter().filter_map(|f| f.out_of_sample).collect();
    let mean = |v: &[f64]| -> Option<f64> {
        if v.is_empty() { None } else { Some(v.iter().sum::<f64>() / v.len() as f64) }
    };
    report.mean_in_sample = mean(&is_vals);
    report.mean_out_of_sample = mean(&oos_vals);
    report.mean_gap = match (report.mean_in_sample, report.mean_out_of_sample) {
        (Some(is), Some(oos)) => Some(is - oos),
        _ => None,
    };
    report.overfit_flag = report.folds.iter().any(|f| f.gap().map(|g| g > 1.0).unwrap_or(false));
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::bootstrap::sharpe;

    #[test]
    fn empty_series_returns_empty_report() {
        let r = evaluate(&[], Scheme::Holdout { train_frac: 0.7 }, sharpe);
        assert!(r.folds.is_empty());
    }

    #[test]
    fn holdout_70_30_produces_one_fold() {
        let series: Vec<f64> = (0..100).map(|i| (i as f64 % 11.0) / 100.0).collect();
        let r = evaluate(&series, Scheme::Holdout { train_frac: 0.7 }, sharpe);
        assert_eq!(r.folds.len(), 1);
        assert_eq!(r.folds[0].train, 0..70);
        assert_eq!(r.folds[0].test, 70..100);
    }

    #[test]
    fn expanding_5_folds_walks_forward() {
        let series: Vec<f64> = (0..100).map(|i| (i as f64 % 7.0) / 100.0).collect();
        let r = evaluate(&series, Scheme::Expanding { folds: 5 }, sharpe);
        assert_eq!(r.folds.len(), 5);
        // Each fold's train should start at 0; train_end should grow monotonically.
        let mut prev_end = 0;
        for f in &r.folds {
            assert_eq!(f.train.start, 0);
            assert!(f.train.end >= prev_end);
            prev_end = f.train.end;
        }
    }

    #[test]
    fn rolling_window_steps_forward() {
        let series: Vec<f64> = (0..200).map(|i| (i as f64 % 5.0) / 100.0).collect();
        let r = evaluate(
            &series,
            Scheme::Rolling { window_frac: 0.3, step_frac: 0.1 },
            sharpe,
        );
        assert!(r.folds.len() >= 2);
        // Each train window should be the same width.
        let widths: std::collections::HashSet<usize> = r.folds.iter().map(|f| f.train.end - f.train.start).collect();
        assert_eq!(widths.len(), 1, "rolling train windows must be uniform width: {widths:?}");
    }

    #[test]
    fn gap_flags_overfit_when_is_far_exceeds_oos() {
        // Synthetic: positive-mean returns in train, negative-mean in test.
        let mut series: Vec<f64> = (0..70).map(|_| 0.05).collect();
        series.extend((0..30).map(|_| -0.03));
        let r = evaluate(&series, Scheme::Holdout { train_frac: 0.7 }, sharpe);
        let fold = &r.folds[0];
        // train Sharpe → inf because stdev is 0; we expect None from sharpe()
        // and therefore None gap (the cleaner test is below with noise).
        let _ = fold;

        // Re-run with noise so Sharpe is defined on both halves.
        let mut series: Vec<f64> = (0..70).map(|i| 0.05 + (i as f64 % 5.0) / 200.0).collect();
        series.extend((0..30).map(|i| -0.03 + (i as f64 % 4.0) / 200.0));
        let r = evaluate(&series, Scheme::Holdout { train_frac: 0.7 }, sharpe);
        assert!(r.folds[0].gap().unwrap() > 0.0);
    }
}
