//! Cross-strategy analytics primitives — operate on a stream of trade
//! returns or a candle series, **strategy-form agnostic**. Any strategy that
//! produces a list of realised PnLs (HarnessConfig-driven, hand-coded
//! Rust impl, LLM-on-loop, meta-harness-evolved) gets honest uncertainty
//! quantification, overfit detection, and regime conditioning for free.
//!
//! Modules:
//!   * [`bootstrap`] — confidence intervals for any scalar statistic via
//!     resampling-with-replacement. Sharpe is just one application.
//!   * [`walk_forward`] — in-sample → out-of-sample split for overfit
//!     detection. Holdout, expanding, and rolling schemes.
//!   * [`monte_carlo`] — trade-order and bar-return shuffle to test
//!     whether the realised Sharpe sits where chance would put it.
//!   * [`regime`] — causal bar classifier (trending / chop / breakout /
//!     squeeze). Use to condition strategy reports by market state or to
//!     gate live entries.
//!
//! Design rules these modules follow:
//!   1. **No panics on the main path.** Degenerate inputs (empty, NaN,
//!      constant series, zero stdev) return `None` / `NaN` honestly.
//!   2. **Deterministic given a seed.** All randomness goes through a
//!      pluggable seed for reproducibility — bootstrap CIs and Monte
//!      Carlo runs are repeatable bit-for-bit.
//!   3. **No new deps.** Pure std + the workspace's existing pinned crates.
//!   4. **No look-ahead.** Regime classification at bar `i` uses only
//!      bars `[0, i]` — same causality rule the backtest engine enforces.

pub mod bootstrap;
pub mod monte_carlo;
pub mod regime;
pub mod walk_forward;

/// Deterministic xorshift64* PRNG. Returns `u64` in one step.
///
/// Used by bootstrap CI and Monte Carlo shuffles. Strategy-orchestration
/// loops (evolutionary search, reflective improvement) live in agent-eval —
/// not here — so this PRNG stays crate-private.
pub(crate) struct Xorshift64(pub(crate) u64);

impl Xorshift64 {
    pub(crate) fn from_seed(seed: u64) -> Self {
        Self(seed.wrapping_add(0x9E3779B97F4A7C15))
    }
    pub(crate) fn next(&mut self) -> u64 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        self.0 = s;
        s
    }
    pub(crate) fn index(&mut self, len: usize) -> usize {
        debug_assert!(len > 0);
        (self.next() as usize) % len
    }
}
