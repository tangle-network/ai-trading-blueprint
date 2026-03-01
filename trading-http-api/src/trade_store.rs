use chrono::{DateTime, Utc};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

static TRADES: OnceCell<PersistentStore<TradeRecord>> = OnceCell::new();

/// Trades that failed to persist and should be retried on the next write.
static PENDING_RETRIES: OnceCell<Mutex<Vec<(String, TradeRecord)>>> = OnceCell::new();

fn pending_retries() -> &'static Mutex<Vec<(String, TradeRecord)>> {
    PENDING_RETRIES.get_or_init(|| Mutex::new(Vec::new()))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TradeRecord {
    pub id: String,
    pub bot_id: String,
    pub timestamp: DateTime<Utc>,
    pub action: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub min_amount_out: String,
    pub target_protocol: String,
    pub tx_hash: String,
    pub block_number: Option<u64>,
    pub gas_used: Option<String>,
    pub paper_trade: bool,
    pub validation: StoredValidation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredValidation {
    pub approved: bool,
    pub aggregate_score: u32,
    pub intent_hash: String,
    pub responses: Vec<StoredValidatorResponse>,
    #[serde(default)]
    pub simulation: Option<StoredSimulation>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct StoredSimulation {
    pub success: bool,
    pub gas_used: u64,
    pub risk_score: u32,
    pub warnings: Vec<String>,
    pub output_amount: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredValidatorResponse {
    pub validator: String,
    pub score: u32,
    pub reasoning: String,
    pub signature: String,
    /// Chain ID from the validator's EIP-712 domain
    #[serde(default)]
    pub chain_id: Option<u64>,
    /// TradeValidator contract address used for EIP-712 verification
    #[serde(default)]
    pub verifying_contract: Option<String>,
    /// ISO 8601 timestamp of when the validator produced this response
    #[serde(default)]
    pub validated_at: Option<String>,
}

pub fn trades() -> Result<&'static PersistentStore<TradeRecord>, String> {
    TRADES
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("trade-history.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn trade_key(id: &str) -> String {
    format!("trade:{id}")
}

/// Maximum number of retry attempts for a single persistence operation.
const MAX_RETRIES: u32 = 3;

/// Backoff durations for each retry attempt.
const RETRY_BACKOFF_MS: [u64; 3] = [10, 50, 200];

/// Attempt to flush any previously-failed trade records before writing a new one.
fn drain_pending_retries(store: &PersistentStore<TradeRecord>) {
    let drained = {
        let Ok(mut pending) = pending_retries().lock() else {
            return;
        };
        std::mem::take(&mut *pending)
    };

    for (key, record) in drained {
        if let Err(e) = store.insert(key.clone(), record.clone()) {
            tracing::error!(trade_id = %record.id, "Still cannot persist previously-failed trade: {e}");
            if let Ok(mut pending) = pending_retries().lock() {
                pending.push((key, record));
            }
        } else {
            tracing::info!(trade_id = %record.id, "Recovered previously-failed trade record");
        }
    }
}

/// Record a trade with retry logic.
///
/// Retries up to 3 times with async backoff (does not block the tokio runtime).
/// If all retries fail, the trade is kept in memory and will be retried on the
/// next `record_trade` call. Returns an error so callers know the trade was not
/// durably persisted.
pub async fn record_trade(record: TradeRecord) -> Result<(), String> {
    let store = trades()?;
    let key = trade_key(&record.id);

    // First, try to flush any previously-failed records.
    drain_pending_retries(store);

    // Attempt to persist with retries.
    let mut last_err = String::new();
    for attempt in 0..MAX_RETRIES {
        match store.insert(key.clone(), record.clone()) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                tracing::error!(
                    trade_id = %record.id,
                    attempt = attempt + 1,
                    "Trade persistence failed (attempt {}/{}): {last_err}",
                    attempt + 1,
                    MAX_RETRIES,
                );
                if attempt + 1 < MAX_RETRIES {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        RETRY_BACKOFF_MS[attempt as usize],
                    ))
                    .await;
                }
            }
        }
    }

    // All retries exhausted -- keep in memory for next call.
    tracing::error!(
        trade_id = %record.id,
        "All {} persistence attempts failed, queuing for retry: {last_err}",
        MAX_RETRIES,
    );
    if let Ok(mut pending) = pending_retries().lock() {
        pending.push((key, record));
    }
    Err(format!(
        "Trade persistence failed after {MAX_RETRIES} attempts: {last_err}"
    ))
}

pub fn get_trade(id: &str) -> Result<Option<TradeRecord>, String> {
    trades()?.get(&trade_key(id)).map_err(|e| e.to_string())
}

pub struct PaginatedTrades {
    pub trades: Vec<TradeRecord>,
    pub total: usize,
}

pub fn trades_for_bot(
    bot_id: &str,
    limit: usize,
    offset: usize,
) -> Result<PaginatedTrades, String> {
    let bid = bot_id.to_string();
    let mut all: Vec<TradeRecord> = trades()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| t.bot_id == bid)
        .collect();

    // Sort by timestamp descending (newest first)
    all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let total = all.len();
    let page = all.into_iter().skip(offset).take(limit).collect();

    Ok(PaginatedTrades {
        trades: page,
        total,
    })
}

/// Returns the number of trade records awaiting retry.
pub fn pending_retry_count() -> usize {
    pending_retries().lock().map(|p| p.len()).unwrap_or(0)
}
