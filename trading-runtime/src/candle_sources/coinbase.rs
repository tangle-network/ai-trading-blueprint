//! Coinbase Exchange (US-regulated) candle ingestion.
//!
//! Endpoint:
//!   GET https://api.exchange.coinbase.com/products/{product_id}/candles
//!       ?granularity=<seconds>&start=<ISO8601>&end=<ISO8601>
//!
//! Response: `[[time, low, high, open, close, volume], …]` (descending time,
//! up to 300 candles per request — Coinbase's published cap).
//!
//! Granularities Coinbase exposes: 60, 300, 900, 3600, 21600, 86400 seconds.
//! `21600` (6h) doesn't map to a `backtest::Interval` we use; we expose only
//! the intersection.

use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde::Deserialize;

use crate::backtest::Interval;
use crate::backtest::types::Candle;
use crate::error::TradingError;

const COINBASE_BASE: &str = "https://api.exchange.coinbase.com";
const MAX_BARS_PER_PAGE: u32 = 300;

// Coinbase returns `[time, low, high, open, close, volume]` where time is an
// integer (unix seconds) and the price/volume cells are JSON NUMBERS, not
// strings — different from Binance and HL. f64 is wide enough for the OHLC
// range we care about; we convert to Decimal immediately so downstream math
// stays exact.
#[derive(Debug, Deserialize)]
struct CoinbaseCandle(i64, f64, f64, f64, f64, f64);

fn coinbase_granularity(i: Interval) -> Result<u32, TradingError> {
    Ok(match i {
        Interval::Min1 => 60,
        Interval::Min5 => 300,
        Interval::Min15 => 900,
        Interval::Hour1 => 3_600,
        Interval::Hour4 => {
            return Err(TradingError::MarketDataUnavailable(
                "coinbase does not support 4h candles natively (granularities: 1m,5m,15m,1h,6h,1d)"
                    .into(),
            ));
        }
        Interval::Day1 => 86_400,
    })
}

/// Map a token symbol to a Coinbase USD product id. Coinbase USDT pairs
/// exist for some tokens; default to USD for the broadest coverage.
fn coinbase_product(token: &str) -> String {
    let upper = token.trim().to_ascii_uppercase();
    match upper.as_str() {
        "WETH" => "ETH-USD".to_string(),
        "WBTC" => "BTC-USD".to_string(),
        _ => format!("{upper}-USD"),
    }
}

pub async fn fetch(
    token: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    let granularity = coinbase_granularity(interval)?;
    let product = coinbase_product(token);
    let bar_sec = granularity as i64;
    let client = reqwest::Client::builder()
        .user_agent("TradingBlueprint/1.0 (+coinbase candle backfill)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| TradingError::HttpError(e.to_string()))?;

    let mut all: Vec<Candle> = Vec::with_capacity(limit as usize);
    let mut end_ts = now_secs();
    let mut remaining = limit;

    while remaining > 0 {
        let page_size = remaining.min(MAX_BARS_PER_PAGE) as i64;
        let start_ts = end_ts.saturating_sub(page_size * bar_sec);

        let url = format!(
            "{COINBASE_BASE}/products/{product}/candles?granularity={granularity}&start={}&end={}",
            iso8601(start_ts),
            iso8601(end_ts),
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
                "Coinbase {status}: {body}"
            )));
        }

        let raw: Vec<CoinbaseCandle> = resp
            .json()
            .await
            .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;
        if raw.is_empty() {
            break;
        }

        let earliest_t = raw.iter().map(|c| c.0).min().unwrap_or(end_ts);
        for c in raw {
            all.push(Candle {
                timestamp: c.0,
                token: token.to_ascii_uppercase(),
                low: dec_from(c.1, "low")?,
                high: dec_from(c.2, "high")?,
                open: dec_from(c.3, "open")?,
                close: dec_from(c.4, "close")?,
                volume: dec_from(c.5, "volume")?,
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
            "coinbase {field}={value} is not a finite number"
        )));
    }
    Decimal::from_f64(value).ok_or_else(|| {
        TradingError::MarketDataUnavailable(format!(
            "coinbase {field}={value} could not be converted to Decimal"
        ))
    })
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Render unix seconds as RFC-3339 / ISO-8601 UTC (Coinbase accepts this form).
fn iso8601(unix_seconds: i64) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(unix_seconds, 0)
        .unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap());
    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn granularity_covers_supported_intervals() {
        assert_eq!(coinbase_granularity(Interval::Min1).unwrap(), 60);
        assert_eq!(coinbase_granularity(Interval::Hour1).unwrap(), 3_600);
        assert_eq!(coinbase_granularity(Interval::Day1).unwrap(), 86_400);
        // Coinbase has no native 4h
        assert!(coinbase_granularity(Interval::Hour4).is_err());
    }

    #[test]
    fn product_normalization() {
        assert_eq!(coinbase_product("eth"), "ETH-USD");
        assert_eq!(coinbase_product("WETH"), "ETH-USD");
        assert_eq!(coinbase_product("btc"), "BTC-USD");
        assert_eq!(coinbase_product("wbtc"), "BTC-USD");
        assert_eq!(coinbase_product("HYPE"), "HYPE-USD");
    }

    #[test]
    fn iso8601_roundtrip_is_utc() {
        let s = iso8601(0);
        assert!(s.ends_with('Z'), "expected trailing Z, got {s}");
        assert_eq!(s, "1970-01-01T00:00:00Z");
    }

    #[tokio::test]
    #[ignore]
    async fn live_fetch_btc_hour_smoke() {
        if std::env::var("COINBASE_LIVE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        let candles = fetch("BTC", Interval::Hour1, 24).await.expect("fetch ok");
        assert!(!candles.is_empty());
        for c in &candles {
            assert!(c.high >= c.low);
            assert!(c.high >= c.open);
            assert!(c.low <= c.close);
        }
    }
}
