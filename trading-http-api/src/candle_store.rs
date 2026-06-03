use once_cell::sync::OnceCell;
use rust_decimal::Decimal;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static CANDLES: OnceCell<PersistentStore<StoredCandle>> = OnceCell::new();

/// A candle persisted in the store. Uses String for Decimal fields to match
/// the metrics_store/trade_store pattern (avoids serde precision issues).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredCandle {
    pub timestamp: i64,
    pub token: String,
    pub bot_id: String,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: String,
}

impl StoredCandle {
    /// Convert to the backtest engine's Candle type.
    pub fn to_backtest_candle(&self) -> trading_runtime::backtest::Candle {
        trading_runtime::backtest::Candle {
            timestamp: self.timestamp,
            token: self.token.clone(),
            open: self.open.parse().unwrap_or(Decimal::ZERO),
            high: self.high.parse().unwrap_or(Decimal::ZERO),
            low: self.low.parse().unwrap_or(Decimal::ZERO),
            close: self.close.parse().unwrap_or(Decimal::ZERO),
            volume: self.volume.parse().unwrap_or(Decimal::ZERO),
        }
    }
}

pub fn candles() -> Result<&'static PersistentStore<StoredCandle>, String> {
    CANDLES
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("candle-history.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn candle_key(bot_id: &str, token: &str, timestamp: i64) -> String {
    format!("candle:{bot_id}:{token}:{timestamp}")
}

/// Record a batch of candles. Deduplicates by (bot_id, token, timestamp).
pub fn record_candles(bot_id: &str, candles_batch: &[StoredCandle]) -> Result<usize, String> {
    let store = candles()?;
    let mut recorded = 0;
    for candle in candles_batch {
        let key = candle_key(bot_id, &candle.token, candle.timestamp);
        store
            .insert(key, candle.clone())
            .map_err(|e| e.to_string())?;
        recorded += 1;
    }
    Ok(recorded)
}

pub struct CandleQuery {
    pub bot_id: String,
    pub token: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: usize,
}

pub fn query_candles(q: &CandleQuery) -> Result<Vec<StoredCandle>, String> {
    let bid = q.bot_id.clone();
    let mut all: Vec<StoredCandle> = candles()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| c.bot_id == bid)
        .filter(|c| q.token.as_ref().is_none_or(|t| &c.token == t))
        .filter(|c| q.from.is_none_or(|f| c.timestamp >= f))
        .filter(|c| q.to.is_none_or(|t| c.timestamp <= t))
        .collect();

    all.sort_by_key(|c| c.timestamp);
    if all.len() > q.limit {
        all = all.split_off(all.len() - q.limit);
    }
    Ok(all)
}

pub fn candle_count_for_bot(bot_id: &str) -> Result<usize, String> {
    let bid = bot_id.to_string();
    let count = candles()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| c.bot_id == bid)
        .count();
    Ok(count)
}
