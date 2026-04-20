/// RSI (Relative Strength Index) using Wilder smoothing.
///
/// Returns a Vec the same length as `closes`. Indices before the warmup
/// period are filled with 50.0 (neutral).
pub fn rsi(closes: &[f64], period: usize) -> Vec<f64> {
    let n = closes.len();
    if n < 2 || period == 0 {
        return vec![50.0; n];
    }

    let mut result = vec![50.0; n];

    if n <= period {
        return result;
    }

    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;
    for i in 1..=period {
        let change = closes[i] - closes[i - 1];
        if change > 0.0 {
            avg_gain += change;
        } else {
            avg_loss += -change;
        }
    }
    avg_gain /= period as f64;
    avg_loss /= period as f64;

    result[period] = if avg_loss < 1e-12 {
        100.0
    } else {
        let rs = avg_gain / avg_loss;
        100.0 - 100.0 / (1.0 + rs)
    };

    for i in (period + 1)..n {
        let change = closes[i] - closes[i - 1];
        let (gain, loss) = if change > 0.0 {
            (change, 0.0)
        } else {
            (0.0, -change)
        };
        avg_gain = (avg_gain * (period - 1) as f64 + gain) / period as f64;
        avg_loss = (avg_loss * (period - 1) as f64 + loss) / period as f64;
        result[i] = if avg_loss < 1e-12 {
            100.0
        } else {
            let rs = avg_gain / avg_loss;
            100.0 - 100.0 / (1.0 + rs)
        };
    }

    result
}

/// EMA (Exponential Moving Average).
///
/// Seeded with the SMA of the first `period` values. Pre-seed indices use
/// a running average. Returns a Vec the same length as `values`.
pub fn ema(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    if n == 0 || period == 0 {
        return vec![];
    }
    if period == 1 {
        return values.to_vec();
    }

    let mut result = Vec::with_capacity(n);
    let multiplier = 2.0 / (period as f64 + 1.0);

    if n < period {
        let mut sum = 0.0;
        for (i, &v) in values.iter().enumerate() {
            sum += v;
            result.push(sum / (i + 1) as f64);
        }
        return result;
    }

    // Pre-seed: running averages up to period-1
    let mut sum = 0.0;
    for (i, &v) in values[..period].iter().enumerate() {
        sum += v;
        result.push(sum / (i + 1) as f64);
    }
    // Overwrite the seed point with proper SMA
    let sma = sum / period as f64;
    result[period - 1] = sma;

    // EMA from period onwards
    let mut prev = sma;
    for &v in &values[period..] {
        let ema_val = (v - prev) * multiplier + prev;
        result.push(ema_val);
        prev = ema_val;
    }

    result
}

/// SMA (Simple Moving Average) over a rolling window.
pub fn sma(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    if n == 0 || period == 0 {
        return vec![];
    }

    let mut result = Vec::with_capacity(n);
    let mut sum = 0.0;

    for (i, &v) in values.iter().enumerate() {
        sum += v;
        if i >= period {
            sum -= values[i - period];
            result.push(sum / period as f64);
        } else {
            result.push(sum / (i + 1) as f64);
        }
    }

    result
}

/// ATR (Average True Range) using EMA smoothing of true ranges.
///
/// `highs`, `lows`, `closes` must all have the same length.
pub fn atr(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> Vec<f64> {
    let n = highs.len();
    if n == 0 || period == 0 {
        return vec![0.0; n];
    }

    let mut tr = Vec::with_capacity(n);
    tr.push(highs[0] - lows[0]);

    for i in 1..n {
        let hl = highs[i] - lows[i];
        let hc = (highs[i] - closes[i - 1]).abs();
        let lc = (lows[i] - closes[i - 1]).abs();
        tr.push(hl.max(hc).max(lc));
    }

    ema(&tr, period)
}

/// Detect EMA crossovers between a short and long EMA.
///
/// Returns `+1` for golden cross (short crosses above long),
/// `-1` for death cross (short crosses below long), `0` otherwise.
pub fn ema_crossover(short_ema: &[f64], long_ema: &[f64]) -> Vec<i8> {
    let n = short_ema.len().min(long_ema.len());
    let mut signals = vec![0i8; n];

    for i in 1..n {
        let prev_above = short_ema[i - 1] > long_ema[i - 1];
        let curr_above = short_ema[i] > long_ema[i];
        if !prev_above && curr_above {
            signals[i] = 1;
        } else if prev_above && !curr_above {
            signals[i] = -1;
        }
    }

    signals
}

/// MACD (Moving Average Convergence Divergence).
///
/// Returns (macd_line, signal_line, histogram), each the same length as `closes`.
pub fn macd(
    closes: &[f64],
    fast_period: usize,
    slow_period: usize,
    signal_period: usize,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let fast_ema = ema(closes, fast_period);
    let slow_ema = ema(closes, slow_period);

    let n = closes.len();
    let mut macd_line = vec![0.0; n];
    for i in 0..n {
        macd_line[i] = fast_ema[i] - slow_ema[i];
    }

    let signal_line = ema(&macd_line, signal_period);
    let mut histogram = vec![0.0; n];
    for i in 0..n {
        histogram[i] = macd_line[i] - signal_line[i];
    }

    (macd_line, signal_line, histogram)
}

/// Bollinger Bands: (upper, middle, lower).
///
/// Middle = SMA(period), upper/lower = middle ± std_dev * σ.
pub fn bollinger_bands(
    closes: &[f64],
    period: usize,
    std_dev_mult: f64,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = closes.len();
    let middle = sma(closes, period);
    let mut upper = vec![0.0; n];
    let mut lower = vec![0.0; n];

    for i in 0..n {
        let start = if i >= period { i + 1 - period } else { 0 };
        let window = &closes[start..=i];
        let mean = middle[i];
        let variance: f64 =
            window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / window.len() as f64;
        let std_dev = variance.sqrt();
        upper[i] = mean + std_dev_mult * std_dev;
        lower[i] = mean - std_dev_mult * std_dev;
    }

    (upper, middle, lower)
}

/// OBV (On-Balance Volume).
///
/// Cumulative volume where up-close adds and down-close subtracts.
pub fn obv(closes: &[f64], volumes: &[f64]) -> Vec<f64> {
    let n = closes.len().min(volumes.len());
    let mut result = vec![0.0; n];
    if n == 0 {
        return result;
    }
    result[0] = volumes[0];
    for i in 1..n {
        if closes[i] > closes[i - 1] {
            result[i] = result[i - 1] + volumes[i];
        } else if closes[i] < closes[i - 1] {
            result[i] = result[i - 1] - volumes[i];
        } else {
            result[i] = result[i - 1];
        }
    }
    result
}

/// VWAP (Volume-Weighted Average Price) over a rolling window.
pub fn vwap(closes: &[f64], volumes: &[f64], period: usize) -> Vec<f64> {
    let n = closes.len().min(volumes.len());
    let mut result = vec![0.0; n];
    if n == 0 || period == 0 {
        return result;
    }

    let mut sum_pv = 0.0;
    let mut sum_v = 0.0;

    for i in 0..n {
        sum_pv += closes[i] * volumes[i];
        sum_v += volumes[i];
        if i >= period {
            sum_pv -= closes[i - period] * volumes[i - period];
            sum_v -= volumes[i - period];
        }
        result[i] = if sum_v > 0.0 {
            sum_pv / sum_v
        } else {
            closes[i]
        };
    }
    result
}

/// Z-score of price relative to a rolling mean (for mean-reversion signals).
///
/// z = (close - mean) / std_dev. Values > threshold = overbought, < -threshold = oversold.
pub fn z_score(closes: &[f64], lookback: usize) -> Vec<f64> {
    let n = closes.len();
    let mut result = vec![0.0; n];
    if n < 2 || lookback < 2 {
        return result;
    }

    for i in lookback..n {
        let window = &closes[i + 1 - lookback..=i];
        let mean: f64 = window.iter().sum::<f64>() / window.len() as f64;
        let variance: f64 =
            window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / window.len() as f64;
        let std_dev = variance.sqrt();
        result[i] = if std_dev > 1e-10 {
            (closes[i] - mean) / std_dev
        } else {
            0.0
        };
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsi_all_gains_approaches_100() {
        let closes: Vec<f64> = (0..20).map(|i| 100.0 + i as f64).collect();
        let r = rsi(&closes, 14);
        let last = *r.last().unwrap();
        assert!(
            last > 95.0,
            "RSI with all gains should be near 100, got {last}"
        );
    }

    #[test]
    fn rsi_all_losses_approaches_0() {
        let closes: Vec<f64> = (0..20).map(|i| 200.0 - i as f64).collect();
        let r = rsi(&closes, 14);
        let last = *r.last().unwrap();
        assert!(
            last < 5.0,
            "RSI with all losses should be near 0, got {last}"
        );
    }

    #[test]
    fn rsi_flat_is_neutral() {
        let closes = vec![100.0; 20];
        let r = rsi(&closes, 14);
        // Flat prices → no gains or losses → avg_gain and avg_loss both 0
        // Division guard returns 100.0 (all gains = 0, all losses = 0)
        for &v in &r[14..] {
            assert!(
                v == 50.0 || v == 100.0,
                "RSI on flat data should be neutral or 100 (no losses), got {v}"
            );
        }
    }

    #[test]
    fn rsi_warmup_filled_with_neutral() {
        let closes: Vec<f64> = (0..20).map(|i| 100.0 + i as f64).collect();
        let r = rsi(&closes, 14);
        for &v in &r[..14] {
            assert_eq!(v, 50.0, "Warmup values should be 50.0");
        }
    }

    #[test]
    fn ema_tracks_uptrend() {
        let values: Vec<f64> = (0..50).map(|i| 100.0 + i as f64 * 2.0).collect();
        let e = ema(&values, 10);
        assert_eq!(e.len(), 50);
        // EMA should lag but follow the uptrend
        assert!(e[49] > e[30], "EMA should trend up");
        assert!(e[49] < values[49], "EMA lags behind the trend");
    }

    #[test]
    fn ema_period_1_is_identity() {
        let values = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let e = ema(&values, 1);
        assert_eq!(e, values);
    }

    #[test]
    fn sma_known_values() {
        let values = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let s = sma(&values, 3);
        // After warmup: sma[2] = (1+2+3)/3 = 2.0, sma[3] = (2+3+4)/3 = 3.0, sma[4] = (3+4+5)/3 = 4.0
        assert!((s[2] - 2.0).abs() < 1e-10);
        assert!((s[3] - 3.0).abs() < 1e-10);
        assert!((s[4] - 4.0).abs() < 1e-10);
    }

    #[test]
    fn atr_single_candle() {
        let h = vec![110.0];
        let l = vec![90.0];
        let c = vec![100.0];
        let a = atr(&h, &l, &c, 14);
        assert_eq!(a.len(), 1);
        assert!(
            (a[0] - 20.0).abs() < 1e-10,
            "Single candle ATR = high - low"
        );
    }

    #[test]
    fn atr_uses_previous_close_for_gaps() {
        // Gap up: prev close 100, current candle 110-115
        let h = vec![105.0, 115.0];
        let l = vec![95.0, 110.0];
        let c = vec![100.0, 112.0];
        let a = atr(&h, &l, &c, 1);
        // TR[0] = 105 - 95 = 10
        // TR[1] = max(115-110, |115-100|, |110-100|) = max(5, 15, 10) = 15
        // EMA period 1 = identity, so atr[1] = 15
        assert!((a[1] - 15.0).abs() < 1e-10);
    }

    #[test]
    fn ema_crossover_detects_golden_cross() {
        let short = vec![8.0, 9.0, 10.0, 11.0, 12.0];
        let long = vec![10.0, 10.0, 10.0, 10.0, 10.0];
        let signals = ema_crossover(&short, &long);
        // At index 2: short goes from 9 (below 10) to 10 (equal, not above) — no cross
        // At index 3: short goes from 10 (equal = not above) to 11 (above) — golden cross
        assert_eq!(signals[3], 1, "Should detect golden cross");
    }

    #[test]
    fn ema_crossover_detects_death_cross() {
        let short = vec![12.0, 11.0, 10.0, 9.0, 8.0];
        let long = vec![10.0, 10.0, 10.0, 10.0, 10.0];
        let signals = ema_crossover(&short, &long);
        // At index 3: short goes from 10 (equal = not above) to 9 (below) — no cross (wasn't above before)
        // Actually: idx 2: short=10, long=10, prev_above=(11>10)=true, curr_above=(10>10)=false → death cross
        assert_eq!(signals[2], -1, "Should detect death cross");
    }
}
