use once_cell::sync::Lazy;
use once_cell::sync::OnceCell;
use rust_decimal::Decimal;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

static CANDLES: OnceCell<PersistentStore<StoredCandle>> = OnceCell::new();
static CANDLE_RECORD_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// A candle persisted in the store. Uses String for Decimal fields to match
/// the metrics_store/trade_store pattern (avoids serde precision issues).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredCandle {
    pub timestamp: i64,
    pub token: String,
    pub bot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at_ms: Option<i64>,
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

fn normalize_key_part(value: Option<&str>, fallback: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_ascii_lowercase()
}

fn candle_key(
    bot_id: &str,
    token: &str,
    source: Option<&str>,
    interval: Option<&str>,
    timestamp: i64,
) -> String {
    let token = normalize_key_part(Some(token), "unknown");
    let source = normalize_key_part(source, "unspecified");
    let interval = normalize_key_part(interval, "unspecified");
    format!("candle:{bot_id}:{token}:{source}:{interval}:{timestamp}")
}

/// Record a batch of candles. Deduplicates by bot, token, source, interval, and timestamp.
pub fn record_candles(bot_id: &str, candles_batch: &[StoredCandle]) -> Result<usize, String> {
    let store = candles()?;
    let _guard = CANDLE_RECORD_LOCK
        .lock()
        .map_err(|_| "candle record lock poisoned".to_string())?;
    let mut next: HashMap<String, StoredCandle> = store
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|candle| {
            let key = candle_key(
                &candle.bot_id,
                &candle.token,
                candle.source.as_deref(),
                candle.interval.as_deref(),
                candle.timestamp,
            );
            (key, candle)
        })
        .collect();
    let mut recorded = 0;
    for candle in candles_batch {
        let key = candle_key(
            bot_id,
            &candle.token,
            candle.source.as_deref(),
            candle.interval.as_deref(),
            candle.timestamp,
        );
        next.insert(key, candle.clone());
        recorded += 1;
    }
    store.replace(next).map_err(|e| e.to_string())?;
    Ok(recorded)
}

pub struct CandleQuery {
    pub bot_id: String,
    pub token: Option<String>,
    pub source: Option<String>,
    pub interval: Option<String>,
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
        .filter(|c| {
            q.token
                .as_ref()
                .is_none_or(|t| c.token.eq_ignore_ascii_case(t))
        })
        .filter(|c| {
            q.source.as_ref().is_none_or(|source| {
                c.source
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(source))
            })
        })
        .filter(|c| {
            q.interval.as_ref().is_none_or(|interval| {
                c.interval
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(interval))
            })
        })
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
