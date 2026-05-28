//! Drift Protocol (Solana perps) candle ingestion via the public data API.
//!
//! Endpoint:
//!   GET https://data.api.drift.trade/market/{COIN}-PERP/candles/{resolution}
//!       ?limit=N&startTs=<unix-seconds>
//!
//! Resolutions are minutes-encoded as a path segment: 1, 5, 15, 60, 240, 1440.
//!
//! Response shape: `{ "success": true,
//!   "records": [{ "ts": <unix-sec>, "fillOpen": f, "fillHigh": f,
//!                 "fillClose": f, "fillLow": f, "oracleOpen": f, ...,
//!                 "baseVolume": f, "quoteVolume": f }, …] }`
//!
//! Low-liquidity bars often have fillOpen == fillClose == fillHigh == fillLow
//! (no fills in that window); we use the *fill* fields for OHLC so the
//! candle reflects actual executed trades on Drift — the oracle price is
//! authoritative for marking but a strategy backtest wants fill data.

use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde::Deserialize;

use crate::backtest::Interval;
use crate::backtest::types::Candle;
use crate::error::TradingError;

const DRIFT_BASE: &str = "https://data.api.drift.trade";
// Drift's data API rejects limit > 1000 with a 400 ValidationError.
const MAX_BARS_PER_PAGE: u32 = 1_000;

#[derive(Debug, Deserialize)]
struct DriftCandlesResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    records: Vec<DriftRecord>,
}

#[derive(Debug, Deserialize)]
struct DriftRecord {
    ts: i64,
    #[serde(rename = "fillOpen", default)]
    fill_open: f64,
    #[serde(rename = "fillHigh", default)]
    fill_high: f64,
    #[serde(rename = "fillLow", default)]
    fill_low: f64,
    #[serde(rename = "fillClose", default)]
    fill_close: f64,
    #[serde(rename = "baseVolume", default)]
    base_volume: f64,
}

fn drift_resolution(i: Interval) -> &'static str {
    match i {
        Interval::Min1 => "1",
        Interval::Min5 => "5",
        Interval::Min15 => "15",
        Interval::Hour1 => "60",
        Interval::Hour4 => "240",
        Interval::Day1 => "1440",
    }
}

/// Map a token symbol to Drift's perp market id (the bare COIN part of
/// `{COIN}-PERP`). Drift uses the same tickers most venues do for the major
/// markets; unknown symbols are passed through uppercased.
fn drift_market_coin(token: &str) -> String {
    token.trim().to_ascii_uppercase()
}

pub async fn fetch(
    token: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    let client = reqwest::Client::builder()
        .user_agent("TradingBlueprint/1.0 (+drift candle backfill)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| TradingError::HttpError(e.to_string()))?;

    let coin = drift_market_coin(token);
    let resolution = drift_resolution(interval);
    let bar_sec = interval.duration_ms() / 1000;

    let mut all: Vec<Candle> = Vec::with_capacity(limit as usize);
    let mut end_ts = now_secs();
    let mut remaining = limit;

    while remaining > 0 {
        let page_size = remaining.min(MAX_BARS_PER_PAGE) as i64;
        let start_ts = end_ts.saturating_sub(page_size * bar_sec);

        let url = format!(
            "{DRIFT_BASE}/market/{coin}-PERP/candles/{resolution}?limit={page_size}&startTs={start_ts}",
        );

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| TradingError::HttpError(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(TradingError::MarketDataUnavailable(format!(
                "Drift {status}: {body}"
            )));
        }

        let parsed: DriftCandlesResponse = resp
            .json()
            .await
            .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;
        if !parsed.success {
            return Err(TradingError::MarketDataUnavailable(
                "Drift returned success=false".into(),
            ));
        }
        if parsed.records.is_empty() {
            break;
        }

        let earliest_t = parsed.records.iter().map(|r| r.ts).min().unwrap_or(end_ts);
        for r in parsed.records {
            all.push(Candle {
                timestamp: r.ts,
                token: coin.clone(),
                open: dec_from(r.fill_open, "fillOpen")?,
                high: dec_from(r.fill_high, "fillHigh")?,
                low: dec_from(r.fill_low, "fillLow")?,
                close: dec_from(r.fill_close, "fillClose")?,
                volume: dec_from(r.base_volume, "baseVolume")?,
            });
        }

        let next_end = earliest_t.saturating_sub(1);
        if next_end >= end_ts || next_end <= 0 {
            break;
        }
        let consumed = ((end_ts - next_end) / bar_sec).max(1) as u32;
        remaining = remaining.saturating_sub(consumed);
        end_ts = next_end;
    }

    all.sort_by_key(|c| c.timestamp);
    all.dedup_by_key(|c| c.timestamp);
    if all.len() as u32 > limit {
        let drop = all.len() - limit as usize;
        all.drain(..drop);
    }
    Ok(all)
}

fn dec_from(value: f64, field: &'static str) -> Result<Decimal, TradingError> {
    if !value.is_finite() {
        return Err(TradingError::MarketDataUnavailable(format!(
            "drift {field}={value} is not finite"
        )));
    }
    Decimal::from_f64(value).ok_or_else(|| {
        TradingError::MarketDataUnavailable(format!("drift {field}={value} → Decimal"))
    })
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_mapping() {
        assert_eq!(drift_resolution(Interval::Min1), "1");
        assert_eq!(drift_resolution(Interval::Hour1), "60");
        assert_eq!(drift_resolution(Interval::Day1), "1440");
    }

    #[test]
    fn coin_normalization() {
        assert_eq!(drift_market_coin("sol"), "SOL");
        assert_eq!(drift_market_coin("BTC"), "BTC");
    }

    #[tokio::test]
    #[ignore]
    async fn live_fetch_sol_hour_smoke() {
        if std::env::var("DRIFT_LIVE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        let candles = fetch("SOL", Interval::Hour1, 24).await.expect("fetch ok");
        assert!(!candles.is_empty(), "expected SOL bars from Drift");
        for c in &candles {
            assert!(c.high >= c.low);
            assert!(c.high >= c.open);
            assert!(c.low <= c.close);
        }
    }
}
