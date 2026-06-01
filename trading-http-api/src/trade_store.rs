use chrono::{DateTime, TimeZone, Utc};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    #[serde(default)]
    pub execution_status: Option<TradeExecutionStatus>,
    #[serde(default)]
    pub clob_order_id: Option<String>,
    #[serde(default)]
    pub amount_out: Option<String>,
    #[serde(default)]
    pub entry_price_usd: Option<String>,
    #[serde(default)]
    pub notional_usd: Option<String>,
    #[serde(default)]
    pub requested_price_usd: Option<String>,
    #[serde(default)]
    pub filled_price_usd: Option<String>,
    #[serde(default)]
    pub filled_amount: Option<String>,
    #[serde(default)]
    pub slippage_bps: Option<String>,
    #[serde(default)]
    pub execution_reason: Option<String>,
    #[serde(default)]
    pub prediction_metadata: Option<PredictionTradeMetadata>,
    #[serde(default)]
    pub hyperliquid_metadata: Option<HyperliquidTradeMetadata>,
    #[serde(default)]
    pub valuation_status: TradeValuationStatus,
    pub validation: StoredValidation,

    // ── Execution quality metrics (#2) ──────────────────────────────
    /// Mid price at the moment the signal/decision was generated
    #[serde(default)]
    pub signal_price: Option<String>,
    /// Actual fill price from the exchange
    #[serde(default)]
    pub fill_price: Option<String>,
    /// Time from signal generation to fill confirmation (milliseconds)
    #[serde(default)]
    pub signal_to_fill_ms: Option<u64>,

    // ── Decision trace (#5) ─────────────────────────────────────────
    /// What triggered this trade (rule signal, agent decision, or both)
    #[serde(default)]
    pub decision_source: Option<String>,
    /// The strategy runner signal that recommended this trade (if any)
    #[serde(default)]
    pub runner_signal: Option<serde_json::Value>,
    /// Agent's reasoning for this trade (free-text from the LLM)
    #[serde(default)]
    pub agent_reasoning: Option<String>,
    /// Harness config version that was active when this trade was made
    #[serde(default)]
    pub harness_version: Option<u32>,
    /// Candidate strategy/config hash under paper evaluation. Promotion gates
    /// derive paper evidence from persisted trades matching this hash.
    #[serde(default)]
    pub candidate_hash: Option<String>,
    /// Exact sandbox/code revision that produced this paper trade. This is the
    /// strongest evidence key for Revision Arena promotion decisions.
    #[serde(default)]
    pub revision_id: Option<String>,
    /// Risk-budget decision that authorized this live trade or paper/live probe.
    /// Lets the allocator enforce per-decision trade caps and audit drift later.
    #[serde(default)]
    pub risk_budget_decision_id: Option<String>,
    /// Realized paper PnL percentage for this candidate-scoped paper trade.
    #[serde(default)]
    pub paper_pnl_pct: Option<String>,
    /// Candidate paper equity after this trade, used to derive drawdown.
    #[serde(default)]
    pub paper_equity_after: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct HyperliquidTradeMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduce_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub market_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub market_question: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PredictionTradeMetadata {
    #[serde(default)]
    pub venue: Option<String>,
    #[serde(default)]
    pub market_type: Option<String>,
    #[serde(default)]
    pub condition_id: Option<String>,
    #[serde(default)]
    pub token_id: Option<String>,
    #[serde(default)]
    pub asset: Option<String>,
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub market_question: Option<String>,
    #[serde(default)]
    pub outcome_label: Option<String>,
    #[serde(default)]
    pub outcome_index: Option<u8>,
    #[serde(default)]
    pub market_slug: Option<String>,
    #[serde(default)]
    pub resolution_source: Option<String>,
    #[serde(default)]
    pub resolution_time: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TradeExecutionStatus {
    Paper,
    Submitted,
    Confirmed,
    Filled,
    Partial,
    NoFill,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TradeValuationStatus {
    #[default]
    Unpriced,
    Priced,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformVolumeBucketSize {
    Hour,
    Day,
}

impl PlatformVolumeBucketSize {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.unwrap_or("day").trim().to_ascii_lowercase().as_str() {
            "hour" | "hourly" | "1h" => Ok(Self::Hour),
            "day" | "daily" | "1d" => Ok(Self::Day),
            other => Err(format!(
                "unsupported volume bucket '{other}', expected hour or day"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
        }
    }

    fn seconds(self) -> i64 {
        match self {
            Self::Hour => 60 * 60,
            Self::Day => 24 * 60 * 60,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PlatformVolumeBucket {
    pub timestamp: DateTime<Utc>,
    pub bucket_usd: f64,
    pub paper_usd: f64,
    pub live_usd: f64,
    pub priced_trade_count: usize,
    pub total_trade_count: usize,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct PlatformVolumeSummary {
    pub total_usd: f64,
    pub paper_usd: f64,
    pub live_usd: f64,
    pub priced_trade_count: usize,
    pub total_trade_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlatformVolumeResponse {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub bucket: &'static str,
    pub buckets: Vec<PlatformVolumeBucket>,
    pub summary: PlatformVolumeSummary,
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

pub fn platform_trades(limit: usize, offset: usize) -> Result<PaginatedTrades, String> {
    let mut all: Vec<TradeRecord> = trades()?.values().map_err(|e| e.to_string())?;

    // Sort by timestamp descending (newest first)
    all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let total = all.len();
    let page = all.into_iter().skip(offset).take(limit).collect();

    Ok(PaginatedTrades {
        trades: page,
        total,
    })
}

fn floor_to_bucket(timestamp: DateTime<Utc>, bucket: PlatformVolumeBucketSize) -> DateTime<Utc> {
    let bucket_seconds = bucket.seconds();
    let floored = timestamp.timestamp().div_euclid(bucket_seconds) * bucket_seconds;
    Utc.timestamp_opt(floored, 0).single().unwrap_or(timestamp)
}

fn parse_positive_notional(value: Option<&str>) -> Option<f64> {
    value?
        .parse::<f64>()
        .ok()
        .filter(|amount| amount.is_finite() && *amount > 0.0)
}

pub fn platform_volume(
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket: PlatformVolumeBucketSize,
) -> Result<PlatformVolumeResponse, String> {
    if from > to {
        return Err("from must be before to".to_string());
    }

    let first_bucket = floor_to_bucket(from, bucket);
    let last_bucket = floor_to_bucket(to, bucket);
    let mut buckets = BTreeMap::<DateTime<Utc>, PlatformVolumeBucket>::new();
    let mut cursor = first_bucket;
    while cursor <= last_bucket {
        buckets.insert(
            cursor,
            PlatformVolumeBucket {
                timestamp: cursor,
                bucket_usd: 0.0,
                paper_usd: 0.0,
                live_usd: 0.0,
                priced_trade_count: 0,
                total_trade_count: 0,
            },
        );
        cursor += chrono::Duration::seconds(bucket.seconds());
    }

    for trade in trades()?.values().map_err(|e| e.to_string())? {
        if trade.timestamp < from || trade.timestamp > to {
            continue;
        }

        let bucket_timestamp = floor_to_bucket(trade.timestamp, bucket);
        let Some(entry) = buckets.get_mut(&bucket_timestamp) else {
            continue;
        };
        entry.total_trade_count += 1;

        let Some(notional) = parse_positive_notional(trade.notional_usd.as_deref()) else {
            continue;
        };
        entry.bucket_usd += notional;
        entry.priced_trade_count += 1;
        if trade.paper_trade {
            entry.paper_usd += notional;
        } else {
            entry.live_usd += notional;
        }
    }

    let buckets: Vec<PlatformVolumeBucket> = buckets.into_values().collect();
    let summary = buckets
        .iter()
        .fold(PlatformVolumeSummary::default(), |mut acc, bucket| {
            acc.total_usd += bucket.bucket_usd;
            acc.paper_usd += bucket.paper_usd;
            acc.live_usd += bucket.live_usd;
            acc.priced_trade_count += bucket.priced_trade_count;
            acc.total_trade_count += bucket.total_trade_count;
            acc
        });

    Ok(PlatformVolumeResponse {
        from,
        to,
        bucket: bucket.as_str(),
        buckets,
        summary,
    })
}

pub fn paper_trades_for_candidate(
    bot_id: &str,
    candidate_hash: &str,
) -> Result<Vec<TradeRecord>, String> {
    let bid = bot_id.to_string();
    let hash = candidate_hash.to_string();
    let mut all: Vec<TradeRecord> = trades()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| {
            t.bot_id == bid && t.paper_trade && t.candidate_hash.as_deref() == Some(hash.as_str())
        })
        .collect();
    all.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    Ok(all)
}

pub fn paper_trades_for_revision(
    bot_id: &str,
    revision_id: &str,
) -> Result<Vec<TradeRecord>, String> {
    let bid = bot_id.to_string();
    let revision = revision_id.to_string();
    let mut all: Vec<TradeRecord> = trades()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| {
            t.bot_id == bid && t.paper_trade && t.revision_id.as_deref() == Some(revision.as_str())
        })
        .collect();
    all.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    Ok(all)
}

pub fn live_trades_for_risk_decision(
    bot_id: &str,
    decision_id: &str,
) -> Result<Vec<TradeRecord>, String> {
    let bid = bot_id.to_string();
    let decision = decision_id.to_string();
    let mut all: Vec<TradeRecord> = trades()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| {
            t.bot_id == bid
                && !t.paper_trade
                && t.risk_budget_decision_id.as_deref() == Some(decision.as_str())
        })
        .collect();
    all.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    Ok(all)
}

/// Returns the number of trade records awaiting retry.
pub fn pending_retry_count() -> usize {
    pending_retries().lock().map(|p| p.len()).unwrap_or(0)
}
