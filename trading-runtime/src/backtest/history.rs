//! Historical candle fetcher from public exchange APIs.
//!
//! Fetches OHLCV candles from Binance (US) public API — no auth required.
//! Used to bootstrap the backtest engine with real market data.

use rust_decimal::Decimal;
use serde::Deserialize;

use super::types::Candle;
use crate::error::TradingError;

const BINANCE_US_BASE: &str = "https://api.binance.us/api/v3";
const MAX_CANDLES_PER_REQUEST: u32 = 1000;

/// Supported candle intervals.
#[derive(Debug, Clone, Copy)]
pub enum Interval {
    Min1,
    Min5,
    Min15,
    Hour1,
    Hour4,
    Day1,
}

impl Interval {
    fn as_str(self) -> &'static str {
        match self {
            Self::Min1 => "1m",
            Self::Min5 => "5m",
            Self::Min15 => "15m",
            Self::Hour1 => "1h",
            Self::Hour4 => "4h",
            Self::Day1 => "1d",
        }
    }

    /// Interval duration in milliseconds.
    pub fn duration_ms(self) -> i64 {
        match self {
            Self::Min1 => 60_000,
            Self::Min5 => 300_000,
            Self::Min15 => 900_000,
            Self::Hour1 => 3_600_000,
            Self::Hour4 => 14_400_000,
            Self::Day1 => 86_400_000,
        }
    }
}

/// Map common token symbols to Binance trading pair symbols.
fn binance_symbol(token: &str) -> String {
    let upper = token.to_ascii_uppercase();
    match upper.as_str() {
        "ETH" | "WETH" => "ETHUSD".to_string(),
        "BTC" | "WBTC" => "BTCUSD".to_string(),
        "SOL" => "SOLUSD".to_string(),
        "ARB" => "ARBUSD".to_string(),
        "MATIC" | "POL" => "MATICUSD".to_string(),
        "AVAX" => "AVAXUSD".to_string(),
        "LINK" => "LINKUSD".to_string(),
        "UNI" => "UNIUSD".to_string(),
        "AAVE" => "AAVEUSD".to_string(),
        "OP" => "OPUSD".to_string(),
        _ => format!("{upper}USD"),
    }
}

/// Raw Binance kline response: array of arrays.
/// [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, ...]
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct BinanceKline(
    i64,    // 0: open time (ms)
    String, // 1: open
    String, // 2: high
    String, // 3: low
    String, // 4: close
    String, // 5: volume
    i64,    // 6: close time (ms)
    String, // 7: quote asset volume
    u64,    // 8: number of trades
    String, // 9: taker buy base volume
    String, // 10: taker buy quote volume
    String, // 11: ignore
);

/// Fetch historical candles for a token from Binance public API.
///
/// Returns up to `limit` candles (max 1000 per request, auto-paginated).
/// No API key required.
pub async fn fetch_candles(
    token: &str,
    interval: Interval,
    limit: u32,
) -> Result<Vec<Candle>, TradingError> {
    let client = reqwest::Client::builder()
        .user_agent("TradingBlueprint/1.0")
        .build()
        .map_err(|e| TradingError::HttpError(e.to_string()))?;

    let symbol = binance_symbol(token);
    let mut all_candles = Vec::new();
    let mut end_time: Option<i64> = None;
    let mut remaining = limit;

    while remaining > 0 {
        let batch_size = remaining.min(MAX_CANDLES_PER_REQUEST);
        let mut url = format!(
            "{BINANCE_US_BASE}/klines?symbol={symbol}&interval={}&limit={batch_size}",
            interval.as_str()
        );
        if let Some(et) = end_time {
            url.push_str(&format!("&endTime={et}"));
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
                "Binance API {status}: {body}"
            )));
        }

        let klines: Vec<BinanceKline> = resp
            .json()
            .await
            .map_err(|e| TradingError::MarketDataUnavailable(e.to_string()))?;

        if klines.is_empty() {
            break;
        }

        // Set end_time for next page (before the oldest candle in this batch)
        end_time = Some(klines[0].0 - 1);

        for k in &klines {
            all_candles.push(Candle {
                timestamp: k.0 / 1000, // ms → seconds
                token: token.to_string(),
                open: k.1.parse().unwrap_or(Decimal::ZERO),
                high: k.2.parse().unwrap_or(Decimal::ZERO),
                low: k.3.parse().unwrap_or(Decimal::ZERO),
                close: k.4.parse().unwrap_or(Decimal::ZERO),
                volume: k.5.parse().unwrap_or(Decimal::ZERO),
            });
        }

        remaining = remaining.saturating_sub(klines.len() as u32);

        if klines.len() < batch_size as usize {
            break; // No more data
        }
    }

    // Sort chronologically (pagination fetches newest first)
    all_candles.sort_by_key(|c| c.timestamp);
    all_candles.dedup_by_key(|c| c.timestamp);

    Ok(all_candles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binance_symbol_mapping() {
        assert_eq!(binance_symbol("ETH"), "ETHUSD");
        assert_eq!(binance_symbol("WETH"), "ETHUSD");
        assert_eq!(binance_symbol("BTC"), "BTCUSD");
        assert_eq!(binance_symbol("SOL"), "SOLUSD");
        assert_eq!(binance_symbol("UNKNOWN"), "UNKNOWNUSD");
    }

    #[test]
    fn interval_duration() {
        assert_eq!(Interval::Hour1.duration_ms(), 3_600_000);
        assert_eq!(Interval::Day1.duration_ms(), 86_400_000);
    }

    // Live API test — only runs manually
    #[tokio::test]
    #[ignore]
    async fn fetch_real_candles() {
        let candles = fetch_candles("ETH", Interval::Hour1, 100).await.unwrap();
        assert!(!candles.is_empty());
        assert!(candles.len() <= 100);
        // Should be sorted chronologically
        for w in candles.windows(2) {
            assert!(w[0].timestamp <= w[1].timestamp);
        }
        // Prices should be positive
        for c in &candles {
            assert!(c.open > Decimal::ZERO);
            assert!(c.close > Decimal::ZERO);
        }
        println!(
            "Fetched {} candles, first: ts={}, close={}",
            candles.len(),
            candles[0].timestamp,
            candles[0].close
        );
    }
}
