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
    snapshots()?
        .insert(key, snapshot)
        .map_err(|e| e.to_string())
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
        .filter(|s| from.is_none_or(|f| s.timestamp >= f))
        .filter(|s| to.is_none_or(|t| s.timestamp <= t))
        .collect();

    // Sort by timestamp ascending (oldest first for time-series)
    all.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    let total = all.len();
    let page = if all.len() > limit {
        all.split_off(all.len() - limit)
    } else {
        all
    };

    Ok(PaginatedSnapshots {
        snapshots: page,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    fn ensure_test_state_dir() {
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let tmp = tempfile::TempDir::new().expect("temp state dir");
            // SAFETY: this test module sets the process-wide store directory once
            // before initializing the OnceCell-backed metrics store.
            unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };
            std::mem::forget(tmp);
        });
    }

    fn snapshot(bot_id: &str, minute: u32) -> MetricSnapshot {
        MetricSnapshot {
            timestamp: DateTime::parse_from_rfc3339(&format!("2026-06-03T00:{minute:02}:00Z"))
                .expect("timestamp")
                .with_timezone(&Utc),
            bot_id: bot_id.to_string(),
            account_value_usd: minute.to_string(),
            unrealized_pnl: "0".to_string(),
            realized_pnl: "0".to_string(),
            high_water_mark: minute.to_string(),
            drawdown_pct: "0".to_string(),
            positions_count: 0,
            trade_count: minute,
        }
    }

    #[test]
    fn snapshots_for_bot_returns_latest_limited_window_in_chronological_order() {
        ensure_test_state_dir();
        let bot_id = format!("metrics-window-{}", uuid::Uuid::new_v4());
        for minute in 0..5 {
            record_snapshot(snapshot(&bot_id, minute)).expect("record snapshot");
        }

        let page = snapshots_for_bot(&bot_id, None, None, 2).expect("snapshots");

        assert_eq!(page.total, 5);
        assert_eq!(page.snapshots.len(), 2);
        assert_eq!(page.snapshots[0].trade_count, 3);
        assert_eq!(page.snapshots[1].trade_count, 4);
        assert!(page.snapshots[0].timestamp < page.snapshots[1].timestamp);
    }
}

pub fn latest_snapshot_for_bot(bot_id: &str) -> Result<Option<MetricSnapshot>, String> {
    let bid = bot_id.to_string();
    let latest = snapshots()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| s.bot_id == bid)
        .max_by(|a, b| a.timestamp.cmp(&b.timestamp));

    Ok(latest)
}
