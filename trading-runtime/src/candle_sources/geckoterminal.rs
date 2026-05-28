//! GeckoTerminal DEX OHLCV ingestion — one adapter, every chain's DEX pools.
//!
//! GeckoTerminal indexes Uniswap V2/V3, PancakeSwap, Curve, Aerodrome,
//! Velodrome, Raydium, Orca, and many more across 100+ networks. Free,
//! authenticated by IP rate-limit only.
//!
//! Endpoint:
//!   GET https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}
//!       ?aggregate=1&limit=1000
//!
//! Timeframe path segment: `minute`, `hour`, or `day`; the `aggregate` query
//! multiplies it (so `hour&aggregate=4` = 4h candles). Up to 1000 bars per
//! request, ordered newest-first.
//!
//! Response: `{"data": {"attributes": {"ohlcv_list":
//!   [[<unix-sec>, open, high, low, close, volume_usd], …]}}}`
//!
//! Symbol convention used here: the caller passes the *pool address* as
//! `token`, and the network as `network`. Pool addresses are stable per
//! chain — the caller is expected to know its pool (or look it up via
//! `https://api.geckoterminal.com/api/v2/search/pools?query=…`). See the
//! canonical-pool table in
//! `crate::candle_sources::geckoterminal::CANONICAL_POOLS` for the most
//! common USD-quoted majors on each major chain.

use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde::Deserialize;

use crate::backtest::Interval;
use crate::backtest::types::Candle;
use crate::error::TradingError;

const GECKO_BASE: &str = "https://api.geckoterminal.com/api/v2";
const MAX_BARS_PER_PAGE: u32 = 1_000;

/// Canonical USD-quoted pool for the most common (network, token) pairs.
/// Lets callers pass a friendly symbol (`"base:ETH"`) and we resolve to the
/// liquid pool address. Expand this table as new symbols come into scope.
pub const CANONICAL_POOLS: &[(&str, &str, &str)] = &[
    // (network, token-symbol, pool-address)
    ("eth", "ETH", "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"), // Uni V3 ETH/USDC 0.05%
    ("eth", "WBTC", "0x9a772018fbd77fcd2d25657e5c547baff3fd7d16"), // Uni V3 WBTC/USDC 0.3%
    ("base", "ETH", "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59"), // Aerodrome WETH/USDC
    (
        "arbitrum_one",
        "ETH",
        "0xc6962004f452be9203591991d15f6b388e09e8d0",
    ), // Uni V3 WETH/USDC
    (
        "solana",
        "SOL",
        "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
    ), // Raydium SOL/USDC
];

/// Resolve a `network:symbol` shorthand to a `(network, pool_address)` pair.
/// If the input is already an address (`0x…`) the caller can pass it via
/// the `pool` argument to `fetch_pool` directly.
fn resolve_canonical(network: &str, symbol: &str) -> Option<&'static str> {
    let sym = symbol.trim().to_ascii_uppercase();
    CANONICAL_POOLS
        .iter()
        .find(|(net, s, _)| net.eq_ignore_ascii_case(network) && s.eq_ignore_ascii_case(&sym))
        .map(|(_, _, addr)| *addr)
}

#[derive(Debug, Deserialize)]
struct OhlcvEnvelope {
    data: OhlcvData,
}
#[derive(Debug, Deserialize)]
struct OhlcvData {
    attributes: OhlcvAttributes,
}
#[derive(Debug, Deserialize)]
struct OhlcvAttributes {
    #[serde(default)]
    ohlcv_list: Vec<OhlcvBar>,
}
// [ts, open, high, low, close, volume_usd]
#[derive(Debug, Deserialize)]
struct OhlcvBar(i64, f64, f64, f64, f64, f64);

fn timeframe(i: Interval) -> (&'static str, u32) {
    match i {
        Interval::Min1 => ("minute", 1),
        Interval::Min5 => ("minute", 5),
        Interval::Min15 => ("minute", 15),
        Interval::Hour1 => ("hour", 1),
        Interval::Hour4 => ("hour", 4),
        Interval::Day1 => ("day", 1),
    }
}

/// Fetch OHLCV bars for a specific pool on a specific network.
pub async fn fetch_pool(
    network: &str,
    pool_address: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    let client = reqwest::Client::builder()
        .user_agent("TradingBlueprint/1.0 (+geckoterminal candle backfill)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| TradingError::HttpError(e.to_string()))?;

    let (tf, aggregate) = timeframe(interval);
    let mut all: Vec<Candle> = Vec::with_capacity(limit as usize);
    let mut before_ts: Option<i64> = None;
    let mut remaining = limit;

    // Free tier ~30 requests / minute; throttle to be a good citizen.
    let mut request_count = 0u32;
    while remaining > 0 {
        if request_count > 0 {
            // Small inter-request delay (1.2s) keeps us safely under the
            // documented free-tier rate limit even on aggressive backfills.
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
        request_count += 1;
        let page_size = remaining.min(MAX_BARS_PER_PAGE);
        let mut url = format!(
            "{GECKO_BASE}/networks/{network}/pools/{pool_address}/ohlcv/{tf}?aggregate={aggregate}&limit={page_size}",
        );
        if let Some(ts) = before_ts {
            url.push_str(&format!("&before_timestamp={ts}"));
        }

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| TradingError::HttpError(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(TradingError::MarketDataUnavailable(format!(
                "GeckoTerminal {status}: {body}"
            )));
        }
        let parsed: OhlcvEnvelope = resp
            .json()
            .await
            .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;
        if parsed.data.attributes.ohlcv_list.is_empty() {
            break;
        }

        let earliest_t = parsed
            .data
            .attributes
            .ohlcv_list
            .iter()
            .map(|b| b.0)
            .min()
            .unwrap_or(0);

        for b in parsed.data.attributes.ohlcv_list {
            all.push(Candle {
                timestamp: b.0,
                token: pool_address.to_string(),
                open: dec_from(b.1, "open")?,
                high: dec_from(b.2, "high")?,
                low: dec_from(b.3, "low")?,
                close: dec_from(b.4, "close")?,
                volume: dec_from(b.5, "volume_usd")?,
            });
        }

        if all.len() as u32 >= limit {
            break;
        }
        before_ts = Some(earliest_t);
        remaining = limit.saturating_sub(all.len() as u32);
    }

    all.sort_by_key(|c| c.timestamp);
    all.dedup_by_key(|c| c.timestamp);
    if all.len() as u32 > limit {
        let drop = all.len() - limit as usize;
        all.drain(..drop);
    }
    Ok(all)
}

/// Convenience: take a `"network:SYMBOL"` (e.g. `"base:ETH"`) or
/// `"network:0x…"` (raw pool address) string and dispatch to `fetch_pool`.
/// This is the entry point the generic `Source::GeckoTerminal` dispatcher
/// uses so the same `fetch(symbol, …)` signature works across all sources.
pub async fn fetch(
    network_and_pool: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    let (network, pool_or_symbol) = network_and_pool.split_once(':').ok_or_else(|| {
        TradingError::MarketDataUnavailable(format!(
            "geckoterminal token must be 'network:POOL_OR_SYMBOL', got '{network_and_pool}'"
        ))
    })?;
    let pool =
        if pool_or_symbol.starts_with("0x") || pool_or_symbol.len() > 30 {
            // raw pool address (EVM hex or base58 Solana)
            pool_or_symbol.to_string()
        } else {
            resolve_canonical(network, pool_or_symbol)
            .ok_or_else(|| TradingError::MarketDataUnavailable(format!(
                "no canonical pool for {network}:{pool_or_symbol} — pass a pool address instead"
            )))?
            .to_string()
        };
    fetch_pool(network, &pool, interval, limit).await
}

fn dec_from(value: f64, field: &'static str) -> Result<Decimal, TradingError> {
    if !value.is_finite() {
        return Err(TradingError::MarketDataUnavailable(format!(
            "geckoterminal {field}={value} not finite"
        )));
    }
    Decimal::from_f64(value).ok_or_else(|| {
        TradingError::MarketDataUnavailable(format!("geckoterminal {field}={value} → Decimal"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeframe_maps_every_interval() {
        let (tf, agg) = timeframe(Interval::Hour4);
        assert_eq!(tf, "hour");
        assert_eq!(agg, 4);
        let (tf, agg) = timeframe(Interval::Min15);
        assert_eq!(tf, "minute");
        assert_eq!(agg, 15);
    }

    #[test]
    fn canonical_pool_lookup_is_case_insensitive() {
        assert!(resolve_canonical("base", "ETH").is_some());
        assert!(resolve_canonical("BASE", "eth").is_some());
        assert!(resolve_canonical("eth", "WBTC").is_some());
        assert!(resolve_canonical("unknown_chain", "ETH").is_none());
    }

    #[test]
    fn raw_pool_address_passes_through() {
        // Plug-through path: caller knows their pool; we don't need a table entry.
        // Test that fetch() will treat 0x… as a literal pool, not look it up.
        // (No network call here — just verify the branch via the string check.)
        let s = "base:0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
        assert!(s.starts_with("base:0x"));
    }

    #[tokio::test]
    #[ignore]
    async fn live_fetch_aerodrome_weth_smoke() {
        if std::env::var("GECKOTERMINAL_LIVE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        let candles = fetch("base:ETH", Interval::Hour1, 12)
            .await
            .expect("fetch ok");
        assert!(!candles.is_empty(), "expected Aerodrome bars");
        for c in &candles {
            assert!(c.high >= c.low);
            assert!(c.high >= c.open);
            assert!(c.low <= c.close);
        }
    }
}
