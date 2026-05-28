//! Polymarket CLOB price-history ingestion.
//!
//! Endpoint:
//!   GET https://clob.polymarket.com/prices-history?market={token_id}
//!       &interval=<1h|6h|1d|1w>&startTs=<sec>&endTs=<sec>
//!
//! Response: `{"history": [{"t": <unix-sec>, "p": <float 0..1>}, …]}`
//!
//! Polymarket reports a single midpoint price per timestamp, not OHLC. We
//! synthesize a degenerate `Candle` with `open == high == low == close == p`
//! and `volume == 0`. This is correct for momentum / EMA / RSI signals — a
//! flat O/H/L/C bar accurately encodes "the implied probability moved from
//! X at time T₁ to Y at time T₂" with no false intra-bar range. Strategies
//! that depend on intra-bar range (mean-reversion off wicks, etc.) should
//! prefer a venue that reports proper OHLCV.

use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde::Deserialize;

use crate::backtest::Interval;
use crate::backtest::types::Candle;
use crate::error::TradingError;

const POLYMARKET_CLOB: &str = "https://clob.polymarket.com";

#[derive(Debug, Deserialize)]
struct PricesHistoryResponse {
    #[serde(default)]
    history: Vec<PricePoint>,
}

#[derive(Debug, Deserialize)]
struct PricePoint {
    t: i64,
    p: f64,
}

fn polymarket_interval(i: Interval) -> Result<&'static str, TradingError> {
    Ok(match i {
        Interval::Hour1 => "1h",
        Interval::Hour4 => "6h",
        Interval::Day1 => "1d",
        Interval::Min1 | Interval::Min5 | Interval::Min15 => {
            return Err(TradingError::MarketDataUnavailable(
                "Polymarket exposes only 1h, 6h, 1d, 1w intervals".into(),
            ));
        }
    })
}

/// `token_id` is the CLOB ERC-1155 token id (a long decimal string identifying
/// a specific YES/NO outcome on a specific market). The agent's other CLOB
/// tools surface these — the caller passes them through unchanged.
pub async fn fetch(
    token_id: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    let client = reqwest::Client::builder()
        .user_agent("TradingBlueprint/1.0 (+polymarket history)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| TradingError::HttpError(e.to_string()))?;

    let interval_str = polymarket_interval(interval)?;
    let bar_sec = interval.duration_ms() / 1000;
    let end_ts = now_secs();
    let start_ts = end_ts.saturating_sub((limit as i64).saturating_mul(bar_sec));

    let url = format!(
        "{POLYMARKET_CLOB}/prices-history?market={token_id}&interval={interval_str}&startTs={start_ts}&endTs={end_ts}",
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
            "Polymarket {status}: {body}"
        )));
    }

    let parsed: PricesHistoryResponse = resp
        .json()
        .await
        .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;

    let mut candles = Vec::with_capacity(parsed.history.len());
    for pt in parsed.history {
        let p = dec_from(pt.p, "price")?;
        candles.push(Candle {
            timestamp: pt.t,
            token: token_id.to_string(),
            // Single midpoint → degenerate OHLC. Volume is unavailable from
            // this endpoint; report 0 (a strategy depending on volume should
            // pick a different venue, or query /clob/book for live depth).
            open: p,
            high: p,
            low: p,
            close: p,
            volume: Decimal::ZERO,
        });
    }
    candles.sort_by_key(|c| c.timestamp);
    candles.dedup_by_key(|c| c.timestamp);
    if candles.len() as u32 > limit {
        let drop = candles.len() - limit as usize;
        candles.drain(..drop);
    }
    Ok(candles)
}

fn dec_from(value: f64, field: &'static str) -> Result<Decimal, TradingError> {
    if !value.is_finite() {
        return Err(TradingError::MarketDataUnavailable(format!(
            "polymarket {field}={value} not finite"
        )));
    }
    Decimal::from_f64(value).ok_or_else(|| {
        TradingError::MarketDataUnavailable(format!("polymarket {field}={value} → Decimal"))
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
    fn interval_mapping_rejects_unsupported() {
        assert_eq!(polymarket_interval(Interval::Hour1).unwrap(), "1h");
        assert_eq!(polymarket_interval(Interval::Hour4).unwrap(), "6h");
        assert_eq!(polymarket_interval(Interval::Day1).unwrap(), "1d");
        assert!(polymarket_interval(Interval::Min1).is_err());
        assert!(polymarket_interval(Interval::Min5).is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn live_fetch_smoke() {
        if std::env::var("POLYMARKET_LIVE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        // Token ids change as markets close; this test just exercises the
        // endpoint and shape — empty result is acceptable.
        let token_id =
            std::env::var("POLYMARKET_TEST_TOKEN_ID").unwrap_or_else(|_| "1".to_string());
        let _ = fetch(&token_id, Interval::Hour1, 24).await;
    }
}
