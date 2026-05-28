//! Hyperliquid mainnet candle ingestion via the public `info` API.
//!
//! This is the native venue for HL perp / spot strategies — the fills the
//! agent's intents will eventually clear against. No auth, no rate limit
//! tier-up needed; the `info` endpoint is open and free.
//!
//! Endpoint:
//!   POST https://api.hyperliquid.xyz/info
//!   body: { "type": "candleSnapshot",
//!           "req": { "coin": "BTC", "interval": "1h",
//!                    "startTime": <ms>, "endTime": <ms> } }
//!
//! Response: `[{ "t":<openMs>, "T":<closeMs>, "s":<coin>, "i":<interval>,
//!               "o":"…", "c":"…", "h":"…", "l":"…", "v":"…", "n":<trades> }]`
//!
//! HL's `candleSnapshot` returns the FULL window between startTime/endTime
//! (no max-batch cap documented in their schema). We paginate by walking
//! `endTime` backward in 5_000-bar chunks for safety.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use crate::backtest::types::Candle;
use crate::backtest::Interval;
use crate::error::TradingError;

const HYPERLIQUID_INFO: &str = "https://api.hyperliquid.xyz/info";
/// HL returns up to a few thousand bars per request comfortably; cap each
/// page to 5000 to bound latency + memory and to fit safely under any
/// undocumented server cap.
const MAX_BARS_PER_PAGE: u32 = 5_000;

#[derive(Debug, Serialize)]
struct CandleSnapshotRequest<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    req: CandleReq<'a>,
}

#[derive(Debug, Serialize)]
struct CandleReq<'a> {
    coin: &'a str,
    interval: &'a str,
    #[serde(rename = "startTime")]
    start_time: i64,
    #[serde(rename = "endTime")]
    end_time: i64,
}

#[derive(Debug, Deserialize)]
struct CandleSnapshot {
    /// open time (ms)
    t: i64,
    /// coin symbol (echoed)
    #[serde(default)]
    #[allow(dead_code)]
    s: Option<String>,
    /// open
    o: String,
    /// close
    c: String,
    /// high
    h: String,
    /// low
    l: String,
    /// volume (base asset)
    v: String,
}

fn hl_interval(i: Interval) -> &'static str {
    match i {
        Interval::Min1 => "1m",
        Interval::Min5 => "5m",
        Interval::Min15 => "15m",
        Interval::Hour1 => "1h",
        Interval::Hour4 => "4h",
        Interval::Day1 => "1d",
    }
}

/// Normalize a token symbol to HL's expected `coin` id. HL uses the bare
/// ticker (`"BTC"`, `"ETH"`, `"HYPE"`, …) — same as the agent's universe —
/// so this is mostly an uppercase + alias unwind.
fn hl_coin(token: &str) -> String {
    let upper = token.trim().to_ascii_uppercase();
    match upper.as_str() {
        "WETH" => "ETH".to_string(),
        "WBTC" => "BTC".to_string(),
        // HL spot pairs vs perps don't share names; this function is for the
        // perp universe (which is what we trade). Callers wanting spot pairs
        // should pass the literal HL spot id (e.g. "@107" for HYPE/USDC).
        _ => upper,
    }
}

/// Fetch up to `limit` HL mainnet candles for `coin` at `interval`, ending
/// at "now". Paginates backward in `MAX_BARS_PER_PAGE` chunks until either
/// `limit` is satisfied or HL returns an empty page (i.e. we've walked
/// past available history for this symbol).
pub async fn fetch(
    token: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    let client = reqwest::Client::builder()
        .user_agent("TradingBlueprint/1.0 (+hyperliquid candle backfill)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| TradingError::HttpError(e.to_string()))?;

    let coin = hl_coin(token);
    let interval_str = hl_interval(interval);
    let bar_ms = interval.duration_ms();

    let mut all: Vec<Candle> = Vec::with_capacity(limit as usize);
    let mut end_ms: i64 = now_ms();
    let mut remaining = limit;

    while remaining > 0 {
        let page_size = remaining.min(MAX_BARS_PER_PAGE) as i64;
        let start_ms = end_ms.saturating_sub(page_size * bar_ms);

        let body = CandleSnapshotRequest {
            kind: "candleSnapshot",
            req: CandleReq {
                coin: &coin,
                interval: interval_str,
                start_time: start_ms,
                end_time: end_ms,
            },
        };

        let resp = client
            .post(HYPERLIQUID_INFO)
            .json(&body)
            .send()
            .await
            .map_err(|e| TradingError::HttpError(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(TradingError::MarketDataUnavailable(format!(
                "Hyperliquid info {status}: {body}"
            )));
        }

        let raw: Vec<CandleSnapshot> = resp
            .json()
            .await
            .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;

        if raw.is_empty() {
            break;
        }

        let earliest_t = raw.iter().map(|c| c.t).min().unwrap_or(end_ms);
        let mut batch: Vec<Candle> = Vec::with_capacity(raw.len());
        for c in raw {
            batch.push(Candle {
                timestamp: c.t / 1000,
                token: coin.clone(),
                open: parse_dec(&c.o, "open")?,
                high: parse_dec(&c.h, "high")?,
                low: parse_dec(&c.l, "low")?,
                close: parse_dec(&c.c, "close")?,
                volume: parse_dec(&c.v, "volume")?,
            });
        }

        // HL returns ascending by t; we accumulate then dedup at the end.
        all.extend(batch);

        // Walk endTime backward by one bar before the earliest we received
        // so the next page covers older history without overlap.
        let next_end = earliest_t.saturating_sub(1);
        if next_end >= end_ms || next_end <= 0 {
            // No older data available (or stuck) — done.
            break;
        }
        let consumed = ((end_ms - next_end) / bar_ms).max(1) as u32;
        remaining = remaining.saturating_sub(consumed);
        end_ms = next_end;
    }

    // Dedup by (token, timestamp) keeping the most recently-fetched copy,
    // then sort ascending. HL's snapshot is authoritative so duplicates
    // across page boundaries are byte-identical, but we still guard.
    all.sort_by_key(|c| c.timestamp);
    all.dedup_by_key(|c| c.timestamp);
    if all.len() as u32 > limit {
        let drop = all.len() - limit as usize;
        all.drain(..drop);
    }
    Ok(all)
}

fn parse_dec(s: &str, field: &'static str) -> Result<Decimal, TradingError> {
    Decimal::from_str(s).map_err(|e| {
        TradingError::MarketDataUnavailable(format!("hyperliquid {field}={s}: {e}"))
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coin_normalization() {
        assert_eq!(hl_coin("eth"), "ETH");
        assert_eq!(hl_coin("WETH"), "ETH");
        assert_eq!(hl_coin("wbtc"), "BTC");
        assert_eq!(hl_coin("HYPE"), "HYPE");
    }

    #[test]
    fn interval_mapping_covers_every_variant() {
        for i in [
            Interval::Min1,
            Interval::Min5,
            Interval::Min15,
            Interval::Hour1,
            Interval::Hour4,
            Interval::Day1,
        ] {
            // just exercise the match — no missing arms
            let _ = hl_interval(i);
        }
    }

    // Network test, opt-in. Set `HYPERLIQUID_LIVE_TEST=1` to exercise the
    // real venue from CI / dev (don't run by default — keeps tests offline).
    #[tokio::test]
    #[ignore]
    async fn live_fetch_btc_hour_smoke() {
        if std::env::var("HYPERLIQUID_LIVE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        let candles = fetch("BTC", Interval::Hour1, 24).await.expect("fetch ok");
        assert!(!candles.is_empty(), "expected at least one BTC bar");
        for c in &candles {
            assert!(c.high >= c.low);
            assert!(c.high >= c.open);
            assert!(c.high >= c.close);
            assert!(c.low <= c.open);
            assert!(c.low <= c.close);
        }
    }
}
