//! Causal bar-level regime classification — emits a regime label per bar
//! using only information available up to that bar. Two consumers:
//!
//!   * **Report conditioning.** Slice strategy performance by regime to
//!     answer "where does this strategy actually work?" — momentum
//!     strategies should outperform during `Trending` and underperform
//!     during `Chop`; mean-reversion the inverse. Mixed performance with
//!     no regime sensitivity is a yellow flag.
//!
//!   * **Live gating.** Optional pre-trade gate the agent can call on
//!     each tick: refuse to enter momentum trades during `Chop`, refuse
//!     to enter mean-revert trades during `Trending`, etc.
//!
//! Features (all causal, computed from existing `backtest::indicators`):
//!   * ATR(14) as % of close — current volatility level.
//!   * EMA(50) slope across the last `slope_lookback` bars — trend
//!     strength + direction.
//!   * Stdev(returns, 30) / mean(|returns|, 30) — coefficient of variation
//!     of returns; high CV → chop, low CV → directional move.
//!
//! Thresholds default to crypto-vol calibrations — pass [`Thresholds`]
//! explicitly for other asset classes.

use rust_decimal::prelude::ToPrimitive;

use crate::backtest::indicators::{atr, ema};
use crate::backtest::types::Candle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Regime {
    /// Sustained directional move — EMA slope above threshold, ATR%
    /// moderate. Momentum strategies favoured.
    Trending,
    /// Choppy / mean-reverting — ATR% high relative to trend strength.
    /// Mean-revert strategies favoured.
    Chop,
    /// Sharp expansion in ATR% beyond historical band — fresh impulse
    /// move. Breakout strategies favoured; many momentum strategies
    /// chase too late here.
    Breakout,
    /// Volatility-compressed flat tape — ATR% below historical band, no
    /// trend. Most strategies should sit out; a coiled-spring setup
    /// often precedes the next Breakout.
    Squeeze,
    /// Insufficient history at this bar to classify. Bars within the
    /// warmup window or with NaN feature values land here.
    Unknown,
}

impl Regime {
    pub fn label(self) -> &'static str {
        match self {
            Self::Trending => "trending",
            Self::Chop => "chop",
            Self::Breakout => "breakout",
            Self::Squeeze => "squeeze",
            Self::Unknown => "unknown",
        }
    }
}

/// Calibration thresholds. Defaults are crypto-hourly figures; for slower
/// asset classes (FX hourly, daily equities) the ATR% thresholds should
/// drop ~5×.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    /// EMA period for the trend feature.
    pub trend_ema_period: usize,
    /// Lookback in bars over which to measure the EMA slope.
    pub slope_lookback: usize,
    /// ATR period.
    pub atr_period: usize,
    /// Minimum |slope| (as % of price per bar) to be considered trending.
    pub trending_min_slope_pct: f64,
    /// ATR% above this counts as a breakout (high vol).
    pub breakout_min_atr_pct: f64,
    /// ATR% below this counts as a squeeze (low vol).
    pub squeeze_max_atr_pct: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        // Hourly-bar crypto defaults — eyeballed from BTC/ETH/SOL recent
        // history. Override per asset class.
        Self {
            trend_ema_period: 50,
            slope_lookback: 24,
            atr_period: 14,
            trending_min_slope_pct: 0.05,
            breakout_min_atr_pct: 2.0,
            squeeze_max_atr_pct: 0.5,
        }
    }
}

fn extract_f64s(candles: &[Candle]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut highs = Vec::with_capacity(candles.len());
    let mut lows = Vec::with_capacity(candles.len());
    let mut closes = Vec::with_capacity(candles.len());
    for c in candles {
        highs.push(c.high.to_f64().unwrap_or(0.0));
        lows.push(c.low.to_f64().unwrap_or(0.0));
        closes.push(c.close.to_f64().unwrap_or(0.0));
    }
    (highs, lows, closes)
}

/// Classify every bar in `candles`. The first `t.trend_ema_period +
/// t.slope_lookback` bars return [`Regime::Unknown`] (insufficient history).
pub fn classify_series(candles: &[Candle], t: Thresholds) -> Vec<Regime> {
    if candles.is_empty() {
        return Vec::new();
    }
    let (highs, lows, closes) = extract_f64s(candles);
    let ema_vals = ema(&closes, t.trend_ema_period);
    let atr_vals = atr(&highs, &lows, &closes, t.atr_period);

    let mut out = Vec::with_capacity(candles.len());
    let warmup = t.trend_ema_period + t.slope_lookback;

    for i in 0..candles.len() {
        if i < warmup || i >= ema_vals.len() || i >= atr_vals.len() {
            out.push(Regime::Unknown);
            continue;
        }
        let price = closes[i];
        if price <= 0.0 {
            out.push(Regime::Unknown);
            continue;
        }

        // Trend feature: % slope of EMA over the lookback.
        let ema_now = ema_vals[i];
        let ema_then = ema_vals[i.saturating_sub(t.slope_lookback)];
        let slope_pct = if ema_then > 0.0 {
            (ema_now - ema_then) / ema_then * 100.0 / t.slope_lookback as f64
        } else {
            0.0
        };

        // Volatility feature: ATR as % of price.
        let atr_pct = atr_vals[i] / price * 100.0;

        let regime = if atr_pct >= t.breakout_min_atr_pct {
            Regime::Breakout
        } else if atr_pct <= t.squeeze_max_atr_pct {
            Regime::Squeeze
        } else if slope_pct.abs() >= t.trending_min_slope_pct {
            Regime::Trending
        } else {
            Regime::Chop
        };
        out.push(regime);
    }
    out
}

/// Count how many bars landed in each regime. Bars in [`Regime::Unknown`]
/// (insufficient warmup) are excluded.
pub fn distribution(regimes: &[Regime]) -> std::collections::BTreeMap<&'static str, usize> {
    let mut map = std::collections::BTreeMap::new();
    for r in regimes {
        if matches!(r, Regime::Unknown) {
            continue;
        }
        *map.entry(r.label()).or_insert(0) += 1;
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;

    /// Build synthetic candles with a configurable per-bar high/low spread
    /// as a fraction of the close (e.g. 0.005 = high is 0.5% above close).
    /// The default of 0.005 forces a baseline ATR of ~1% of price — fine
    /// for trending-test cases but it has to be smaller for squeeze tests
    /// (a 1% bar range is by definition not low-vol).
    fn synth_candles_with_spread(closes: &[f64], spread: f64) -> Vec<Candle> {
        closes
            .iter()
            .enumerate()
            .map(|(i, &c)| Candle {
                timestamp: 1_000_000 + (i as i64) * 3600,
                token: "TEST".into(),
                open: Decimal::from_f64_retain(c).unwrap(),
                high: Decimal::from_f64_retain(c * (1.0 + spread)).unwrap(),
                low: Decimal::from_f64_retain(c * (1.0 - spread)).unwrap(),
                close: Decimal::from_f64_retain(c).unwrap(),
                volume: Decimal::from_f64_retain(100.0).unwrap(),
            })
            .collect()
    }

    fn synth_candles(closes: &[f64]) -> Vec<Candle> {
        synth_candles_with_spread(closes, 0.005)
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(classify_series(&[], Thresholds::default()).is_empty());
    }

    #[test]
    fn short_series_is_all_unknown() {
        // 20 bars is below the default 50+24 warmup → every bar Unknown.
        let candles = synth_candles(&vec![100.0; 20]);
        let regimes = classify_series(&candles, Thresholds::default());
        assert!(regimes.iter().all(|r| matches!(r, Regime::Unknown)));
    }

    #[test]
    fn monotone_uptrend_classifies_as_trending() {
        let closes: Vec<f64> = (0..200).map(|i| 100.0 + i as f64 * 0.5).collect();
        let candles = synth_candles(&closes);
        let regimes = classify_series(&candles, Thresholds::default());
        let trending = regimes.iter().filter(|r| matches!(r, Regime::Trending)).count();
        // Most non-warmup bars should be Trending; require ≥50% just to
        // be robust to where the breakout/chop fringe lands.
        let classifiable = regimes.iter().filter(|r| !matches!(r, Regime::Unknown)).count();
        assert!(trending * 2 >= classifiable, "trending={trending}, classifiable={classifiable}");
    }

    #[test]
    fn flat_low_vol_series_classifies_as_squeeze() {
        // Tiny noise around 100.0 with a near-zero bar spread so ATR% is
        // truly small (the default 0.5% spread is high enough on its own
        // to cross the squeeze threshold — squeeze is about quiet bars,
        // not just a flat close path).
        let closes: Vec<f64> = (0..200)
            .map(|i| 100.0 + ((i as f64 * 0.13).sin()) * 0.05)
            .collect();
        let candles = synth_candles_with_spread(&closes, 0.0005);
        let regimes = classify_series(&candles, Thresholds::default());
        let squeeze = regimes.iter().filter(|r| matches!(r, Regime::Squeeze)).count();
        let classifiable = regimes.iter().filter(|r| !matches!(r, Regime::Unknown)).count();
        assert!(squeeze * 2 >= classifiable, "squeeze={squeeze}, classifiable={classifiable}");
    }

    #[test]
    fn distribution_excludes_unknown() {
        let regimes = vec![Regime::Trending, Regime::Trending, Regime::Chop, Regime::Unknown];
        let d = distribution(&regimes);
        assert_eq!(d.get("trending"), Some(&2));
        assert_eq!(d.get("chop"), Some(&1));
        assert!(!d.contains_key("unknown"));
    }
}
