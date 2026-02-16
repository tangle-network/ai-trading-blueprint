use chrono::{DateTime, Utc};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static TRADES: OnceCell<PersistentStore<TradeRecord>> = OnceCell::new();

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

pub fn record_trade(record: TradeRecord) -> Result<(), String> {
    let key = trade_key(&record.id);
    trades()?.insert(key, record).map_err(|e| e.to_string())
}

pub fn get_trade(id: &str) -> Result<Option<TradeRecord>, String> {
    trades()?.get(&trade_key(id)).map_err(|e| e.to_string())
}

pub struct PaginatedTrades {
    pub trades: Vec<TradeRecord>,
    pub total: usize,
}

pub fn trades_for_bot(bot_id: &str, limit: usize, offset: usize) -> Result<PaginatedTrades, String> {
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

    Ok(PaginatedTrades { trades: page, total })
}
