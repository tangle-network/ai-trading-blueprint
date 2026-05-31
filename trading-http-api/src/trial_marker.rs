//! Active paper-trial marker, keyed by bot.
//!
//! The promotion conductor (in `trading-blueprint-lib`, which owns the bots store
//! and the tick) sets this when it activates a self-improvement candidate as a bot's
//! live paper strategy. The execute path — which is bot-strategy-agnostic and has no
//! dependency on the bots store — reads it to tag the bot's paper trades to the
//! candidate's `candidate_hash`, so the promotion gate can find forward paper evidence
//! under that candidate. Cleared when the trial promotes or is tabled.
//!
//! This is the boundary-respecting bridge: the conductor writes here (it depends on
//! this crate), `execute.rs` reads here (same crate) — no cross-crate state coupling,
//! no sidecar/JS change.

use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static MARKERS: OnceCell<PersistentStore<TrialMarker>> = OnceCell::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrialMarker {
    pub bot_id: String,
    pub candidate_hash: String,
    #[serde(default)]
    pub revision_id: Option<String>,
    pub run_id: String,
}

pub fn markers() -> Result<&'static PersistentStore<TrialMarker>, String> {
    MARKERS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("trial-markers.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn marker_key(bot_id: &str) -> String {
    format!("trial-marker:{bot_id}")
}

pub fn set(marker: TrialMarker) -> Result<(), String> {
    let key = marker_key(&marker.bot_id);
    markers()?.insert(key, marker).map_err(|e| e.to_string())
}

pub fn get(bot_id: &str) -> Result<Option<TrialMarker>, String> {
    markers()?
        .get(&marker_key(bot_id))
        .map_err(|e| e.to_string())
}

pub fn clear(bot_id: &str) -> Result<(), String> {
    markers()?
        .remove(&marker_key(bot_id))
        .map(|_| ())
        .map_err(|e| e.to_string())
}
