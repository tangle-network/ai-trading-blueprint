use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static RUNS: OnceCell<PersistentStore<SelfImprovementRun>> = OnceCell::new();

/// Paper-trial promotion lifecycle for a self-improvement candidate.
///
/// Generation + evolutionary search live in the TS `@tangle-network/agent-eval`
/// harness; this status machine is the box-side bridge that takes a backtest-passing
/// candidate, accrues real paper-trading evidence under its revision, and promotes it
/// live only after the existing `promotion_gate_inner` approves. States are stored in
/// the existing `SelfImprovementRun.status` string — no parallel candidate store.
pub mod status {
    /// Candidate cleared backtest (walk-forward + not overfit) but has no paper evidence yet.
    pub const BACKTEST_PASS: &str = "backtest_pass";
    /// Candidate is running in paper mode under its trial revision, accruing tagged trades.
    pub const PAPER_TRIAL: &str = "paper_trial";
    /// Accrued >= trades_target paper trades; ready for the promotion gate sweep.
    pub const EVIDENCE_MET: &str = "evidence_met";
    /// Promotion gate approved + revision activated live.
    pub const PROMOTED: &str = "promoted";
    /// Trial expired or gate rejected; kept for continuity so we don't re-derive it.
    pub const TABLED: &str = "tabled";

    /// A run still in flight (the sweep should keep working it; "resume", not "restart").
    pub fn is_non_terminal(status: &str) -> bool {
        matches!(status, BACKTEST_PASS | PAPER_TRIAL | EVIDENCE_MET)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SelfImprovementRun {
    pub run_id: String,
    pub bot_id: String,
    pub created_at: i64,
    pub user_intent: String,
    pub candidate_hash: String,
    pub approved: bool,
    pub status: String,
    pub blockers: Vec<String>,
    pub candles_used: usize,
    pub current_config: serde_json::Value,
    pub candidate_config: serde_json::Value,
    pub paper_evidence: Option<serde_json::Value>,
    #[serde(default)]
    pub base_snapshot_id: Option<String>,
    #[serde(default)]
    pub sandbox_revision_id: Option<String>,
    /// Unix-seconds deadline after which a `paper_trial` with insufficient evidence is tabled.
    #[serde(default)]
    pub trial_deadline: Option<i64>,
    /// Paper trades required under this candidate's revision before the promotion sweep runs the gate.
    #[serde(default)]
    pub trades_target: Option<u64>,
}

pub fn runs() -> Result<&'static PersistentStore<SelfImprovementRun>, String> {
    RUNS.get_or_try_init(|| {
        let path = sandbox_runtime::store::state_dir().join("evolution-runs.json");
        PersistentStore::open(path).map_err(|e| e.to_string())
    })
    .map_err(|e: String| e)
}

fn run_key(bot_id: &str, run_id: &str) -> String {
    format!("self-improve:{bot_id}:{run_id}")
}

pub fn insert(run: SelfImprovementRun) -> Result<(), String> {
    let key = run_key(&run.bot_id, &run.run_id);
    runs()?.insert(key, run).map_err(|e| e.to_string())
}

pub fn get(bot_id: &str, run_id: &str) -> Result<Option<SelfImprovementRun>, String> {
    runs()?
        .get(&run_key(bot_id, run_id))
        .map_err(|e| e.to_string())
}

/// Mutate a run in place (used by the promotion sweep to advance lifecycle state).
pub fn update<F: FnOnce(&mut SelfImprovementRun)>(
    bot_id: &str,
    run_id: &str,
    f: F,
) -> Result<(), String> {
    let key = run_key(bot_id, run_id);
    let mut run = runs()?
        .get(&key)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("self-improve run '{run_id}' not found for bot '{bot_id}'"))?;
    f(&mut run);
    runs()?.insert(key, run).map_err(|e| e.to_string())
}

pub fn list_for_bot(bot_id: &str) -> Result<Vec<SelfImprovementRun>, String> {
    let mut values: Vec<SelfImprovementRun> = runs()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|run| run.bot_id == bot_id)
        .collect();
    values.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(values)
}

/// All runs still in flight across every bot, oldest-first so the sweep works them
/// in arrival order. This is the "candidate pool" — no separate store; the pool is
/// just the non-terminal slice of the existing run history (continuity / resume).
pub fn list_non_terminal() -> Result<Vec<SelfImprovementRun>, String> {
    let mut values: Vec<SelfImprovementRun> = runs()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|run| status::is_non_terminal(&run.status))
        .collect();
    values.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_terminal_covers_in_flight_states_only() {
        // In-flight: the sweep must keep working these (resume, not restart).
        assert!(status::is_non_terminal(status::BACKTEST_PASS));
        assert!(status::is_non_terminal(status::PAPER_TRIAL));
        assert!(status::is_non_terminal(status::EVIDENCE_MET));
        // Terminal: the sweep must leave these alone.
        assert!(!status::is_non_terminal(status::PROMOTED));
        assert!(!status::is_non_terminal(status::TABLED));
        // Legacy statuses written before the lifecycle existed are terminal —
        // the sweep must never resurrect a historical "blocked" run.
        assert!(!status::is_non_terminal("blocked"));
        assert!(!status::is_non_terminal("staged_for_operator_approval"));
    }
}
