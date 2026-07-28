//! Multi-venue historical candle ingestion — single dispatch surface so the
//! HTTP API, the agent's `/market-data/candles/fetch` tool, and the backtest
//! engine all pull from the right venue for the strategy.
//!
//! Source selection is canonical: a perp / spot bot trading on Hyperliquid
//! should backtest against Hyperliquid's own candles (the venue with the
//! actual fills), not a CEX proxy. CEX sources (Binance, Coinbase) stay
//! available for cross-venue sanity / wider symbol coverage / US-regulated
//! reference data.
//!
//! Today's source matrix:
//!
//! | Source     | Path                                          | Auth | Notes                                                  |
//! |------------|-----------------------------------------------|------|--------------------------------------------------------|
//! | hyperliquid| `POST api.hyperliquid.xyz/info candleSnapshot`| none | Mainnet candles for HL perps + spot                    |
//! | binance    | `GET  api.binance.us/api/v3/klines`           | none | US klines, broadest universe, 1000 candles per request |
//! | coinbase   | `GET  api.exchange.coinbase.com/products/.../candles` | none | US-regulated reference, granularity in seconds   |
//!
//! Adding a new venue: implement `async fn fetch(symbol, interval, limit) ->
//! Result<Vec<Candle>>`, add it to `Source` + `fetch_from_source`. Adapters
//! for Solana / DEX / Polymarket follow the same pattern but typically need
//! per-pair config (pool address, etc.) which lives in those modules.

use serde::{Deserialize, Serialize};

use crate::backtest::types::Candle;
use crate::backtest::{
    Interval, fetch_candles as binance_fetch, fetch_candles_ending_at as binance_fetch_ending_at,
};
use crate::error::TradingError;

pub mod coinbase;
pub mod drift;
pub mod geckoterminal;
pub mod hyperliquid;
pub mod polymarket;

/// Canonical candle-data venue. Strings are case-insensitive on parse so
/// `target_protocol` values like `"hyperliquid_perp"` resolve to the same
/// source as `"hyperliquid"` (we strip the `_perp` / `_spot` suffix).
///
/// Adding a venue: implement `async fn fetch(symbol, interval, limit) ->
/// Result<Vec<Candle>>`, add a variant here + arms in `name`/`parse`/
/// `fetch_from_source`. Per-pool / per-network venues (subgraphs etc.) can
/// use the `"network:POOL_OR_SYMBOL"` symbol convention modelled by
/// `geckoterminal::fetch` so the dispatch signature stays uniform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Hyperliquid,
    Binance,
    Coinbase,
    Drift,
    Polymarket,
    /// Multi-DEX aggregator across 100+ networks. Pass `token` as
    /// `"network:POOL_OR_SYMBOL"` (e.g. `"base:ETH"`, `"eth:0x88e6…"`).
    GeckoTerminal,
}

/// Explicit half-open candle range in Unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CandleWindow {
    pub start_time_secs: i64,
    pub end_time_secs: i64,
}

impl CandleWindow {
    pub fn new(start_time_secs: i64, end_time_secs: i64) -> Result<Self, TradingError> {
        if start_time_secs < 0 || end_time_secs <= start_time_secs {
            return Err(TradingError::MarketDataUnavailable(format!(
                "invalid candle window [{start_time_secs}, {end_time_secs}); expected 0 <= start < end"
            )));
        }
        Ok(Self {
            start_time_secs,
            end_time_secs,
        })
    }
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Self::Hyperliquid => "hyperliquid",
            Self::Binance => "binance",
            Self::Coinbase => "coinbase",
            Self::Drift => "drift",
            Self::Polymarket => "polymarket",
            Self::GeckoTerminal => "geckoterminal",
        }
    }

    /// Parse a source name (case-insensitive). Accepts a few aliases so the
    /// caller can pass either a `target_protocol` id or a literal source.
    pub fn parse(s: &str) -> Result<Self, String> {
        let key = s.trim().to_ascii_lowercase();
        let key = key
            .strip_suffix("_perp")
            .or_else(|| key.strip_suffix("_spot"))
            .unwrap_or(&key);
        match key {
            "hyperliquid" | "hl" => Ok(Self::Hyperliquid),
            "binance" => Ok(Self::Binance),
            "coinbase" | "cb" => Ok(Self::Coinbase),
            "drift" => Ok(Self::Drift),
            "polymarket" | "poly" => Ok(Self::Polymarket),
            "geckoterminal" | "gecko" | "gt" => Ok(Self::GeckoTerminal),
            other => Err(format!(
                "unknown candle source '{other}' — expected one of: hyperliquid, binance, coinbase, drift, polymarket, geckoterminal"
            )),
        }
    }

    /// Best-default source for a given `target_protocol` id. The strategy's
    /// own venue wins when we have it; CEX fallbacks cover the rest.
    ///
    /// | protocol prefix | source |
    /// |---|---|
    /// | hyperliquid* | Hyperliquid |
    /// | drift, solana* | Drift |
    /// | polymarket | Polymarket |
    /// | uniswap*, pancakeswap*, curve, aerodrome, jupiter | GeckoTerminal (caller supplies network:pool) |
    /// | gmx_v2, vertex | Binance (closest CEX reference for the perp universe) |
    /// | binance, coinbase, * | Binance |
    pub fn default_for_protocol(protocol: &str) -> Self {
        let key = protocol.trim().to_ascii_lowercase();
        if key.starts_with("hyperliquid") {
            return Self::Hyperliquid;
        }
        if key == "drift" || key.starts_with("solana") {
            return Self::Drift;
        }
        if key == "polymarket" {
            return Self::Polymarket;
        }
        if key.starts_with("uniswap")
            || key.starts_with("pancakeswap")
            || key == "curve"
            || key == "aerodrome"
            || key == "jupiter"
        {
            return Self::GeckoTerminal;
        }
        Self::Binance
    }
}

/// Fetch candles from `source` for `symbol` at `interval`, up to `limit` bars.
/// Each source paginates internally up to its venue-specific batch cap.
pub async fn fetch_from_source(
    source: Source,
    symbol: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    match source {
        Source::Hyperliquid => hyperliquid::fetch(symbol, interval, limit).await,
        Source::Binance => binance_fetch(symbol, interval, limit).await,
        Source::Coinbase => coinbase::fetch(symbol, interval, limit).await,
        Source::Drift => drift::fetch(symbol, interval, limit).await,
        Source::Polymarket => polymarket::fetch(symbol, interval, limit).await,
        Source::GeckoTerminal => geckoterminal::fetch(symbol, interval, limit).await,
    }
}

/// Fetch at most `limit` candles inside an explicit `[start, end)` range.
///
/// Venue APIs disagree on whether their end cursor is inclusive. Fetch one
/// extra bar, then enforce the half-open range here so callers get one contract.
pub async fn fetch_from_source_window(
    source: Source,
    symbol: &str,
    interval: Interval,
    limit: u32,
    window: CandleWindow,
) -> Result<Vec<Candle>, TradingError> {
    let window = CandleWindow::new(window.start_time_secs, window.end_time_secs)?;
    let fetch_limit = limit.saturating_add(1);
    let candles = match source {
        Source::Hyperliquid => {
            hyperliquid::fetch_ending_at(symbol, interval, fetch_limit, window.end_time_secs)
                .await?
        }
        Source::Binance => {
            binance_fetch_ending_at(symbol, interval, fetch_limit, window.end_time_secs).await?
        }
        Source::Coinbase => {
            coinbase::fetch_ending_at(symbol, interval, fetch_limit, window.end_time_secs).await?
        }
        Source::Drift => {
            drift::fetch_ending_at(symbol, interval, fetch_limit, window.end_time_secs).await?
        }
        Source::Polymarket => {
            polymarket::fetch_ending_at(symbol, interval, fetch_limit, window.end_time_secs).await?
        }
        Source::GeckoTerminal => {
            geckoterminal::fetch_ending_at(symbol, interval, fetch_limit, window.end_time_secs)
                .await?
        }
    };
    Ok(candles_in_window(candles, window, limit))
}

fn candles_in_window(mut candles: Vec<Candle>, window: CandleWindow, limit: u32) -> Vec<Candle> {
    candles.retain(|candle| {
        candle.timestamp >= window.start_time_secs && candle.timestamp < window.end_time_secs
    });
    candles.sort_by_key(|candle| candle.timestamp);
    candles.dedup_by_key(|candle| candle.timestamp);
    if candles.len() > limit as usize {
        candles.drain(..candles.len() - limit as usize);
    }
    candles
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;

    fn candle(timestamp: i64) -> Candle {
        Candle {
            timestamp,
            token: "TEST".into(),
            open: Decimal::ONE,
            high: Decimal::ONE,
            low: Decimal::ONE,
            close: Decimal::ONE,
            volume: Decimal::ONE,
        }
    }

    #[test]
    fn parses_all_canonical_names() {
        assert_eq!(Source::parse("hyperliquid").unwrap(), Source::Hyperliquid);
        assert_eq!(Source::parse("binance").unwrap(), Source::Binance);
        assert_eq!(Source::parse("coinbase").unwrap(), Source::Coinbase);
    }

    #[test]
    fn parses_aliases_and_suffixes() {
        assert_eq!(Source::parse("HL").unwrap(), Source::Hyperliquid);
        assert_eq!(Source::parse("CB").unwrap(), Source::Coinbase);
        assert_eq!(
            Source::parse("hyperliquid_perp").unwrap(),
            Source::Hyperliquid
        );
        assert_eq!(
            Source::parse("hyperliquid_spot").unwrap(),
            Source::Hyperliquid
        );
    }

    #[test]
    fn unknown_source_rejected() {
        assert!(Source::parse("kraken").is_err());
        assert!(Source::parse("").is_err());
    }

    #[test]
    fn default_for_protocol_picks_native_venue() {
        assert_eq!(
            Source::default_for_protocol("hyperliquid_perp"),
            Source::Hyperliquid
        );
        assert_eq!(
            Source::default_for_protocol("hyperliquid"),
            Source::Hyperliquid
        );
        assert_eq!(Source::default_for_protocol("drift"), Source::Drift);
        assert_eq!(
            Source::default_for_protocol("polymarket"),
            Source::Polymarket
        );
        // DEX adapters → GeckoTerminal (caller passes network:pool)
        assert_eq!(
            Source::default_for_protocol("uniswap_v3"),
            Source::GeckoTerminal
        );
        assert_eq!(
            Source::default_for_protocol("pancakeswap_v3"),
            Source::GeckoTerminal
        );
        assert_eq!(
            Source::default_for_protocol("aerodrome"),
            Source::GeckoTerminal
        );
        // Yield / unmodeled venues fall back to Binance for the broadest universe
        assert_eq!(Source::default_for_protocol("aave_v3"), Source::Binance);
        assert_eq!(Source::default_for_protocol("gmx_v2"), Source::Binance);
    }

    #[test]
    fn parses_new_sources() {
        assert_eq!(Source::parse("drift").unwrap(), Source::Drift);
        assert_eq!(Source::parse("polymarket").unwrap(), Source::Polymarket);
        assert_eq!(Source::parse("poly").unwrap(), Source::Polymarket);
        assert_eq!(
            Source::parse("geckoterminal").unwrap(),
            Source::GeckoTerminal
        );
        assert_eq!(Source::parse("gecko").unwrap(), Source::GeckoTerminal);
        assert_eq!(Source::parse("gt").unwrap(), Source::GeckoTerminal);
    }

    #[test]
    fn candle_window_is_half_open_and_keeps_latest_limit() {
        let window = CandleWindow::new(100, 400).unwrap();
        let selected = candles_in_window(
            vec![
                candle(400),
                candle(100),
                candle(300),
                candle(200),
                candle(99),
            ],
            window,
            2,
        );
        assert_eq!(
            selected.iter().map(|c| c.timestamp).collect::<Vec<_>>(),
            vec![200, 300]
        );
    }

    #[test]
    fn candle_window_rejects_empty_or_reversed_ranges() {
        assert!(CandleWindow::new(100, 100).is_err());
        assert!(CandleWindow::new(101, 100).is_err());
        assert!(CandleWindow::new(-1, 100).is_err());
    }
}
