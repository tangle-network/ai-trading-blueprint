use chrono::{DateTime, Utc};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static METRICS: OnceCell<PersistentStore<MetricSnapshot>> = OnceCell::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MetricSnapshot {
    pub timestamp: DateTime<Utc>,
    pub bot_id: String,
    pub account_value_usd: String,
    pub unrealized_pnl: String,
    pub realized_pnl: String,
    pub high_water_mark: String,
    pub drawdown_pct: String,
    pub positions_count: u32,
    pub trade_count: u32,
}

pub fn snapshots() -> Result<&'static PersistentStore<MetricSnapshot>, String> {
    METRICS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("metrics-snapshots.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn snapshot_key(bot_id: &str, ts: &DateTime<Utc>) -> String {
    format!("snap:{bot_id}:{}", ts.timestamp_millis())
}

pub fn record_snapshot(snapshot: MetricSnapshot) -> Result<(), String> {
    let key = snapshot_key(&snapshot.bot_id, &snapshot.timestamp);
    snapshots()?.insert(key, snapshot).map_err(|e| e.to_string())
}

pub struct PaginatedSnapshots {
    pub snapshots: Vec<MetricSnapshot>,
    pub total: usize,
}

pub fn snapshots_for_bot(
    bot_id: &str,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    limit: usize,
) -> Result<PaginatedSnapshots, String> {
    let bid = bot_id.to_string();
    let mut all: Vec<MetricSnapshot> = snapshots()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| s.bot_id == bid)
        .filter(|s| from.map_or(true, |f| s.timestamp >= f))
        .filter(|s| to.map_or(true, |t| s.timestamp <= t))
        .collect();

    // Sort by timestamp ascending (oldest first for time-series)
    all.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    let total = all.len();
    let page = all.into_iter().take(limit).collect();

    Ok(PaginatedSnapshots {
        snapshots: page,
        total,
    })
}
