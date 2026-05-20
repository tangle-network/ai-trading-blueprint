use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static RUNS: OnceCell<PersistentStore<SelfImprovementRun>> = OnceCell::new();

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
}

pub fn runs() -> Result<&'static PersistentStore<SelfImprovementRun>, String> {
    RUNS.get_or_try_init(|| {
        let path = sandbox_runtime::store::state_dir().join("evolution-runs.json");
        PersistentStore::open(path).map_err(|e| e.to_string())
    })
    .map_err(|e: String| e)
}

pub fn insert(run: SelfImprovementRun) -> Result<(), String> {
    let key = format!("self-improve:{}:{}", run.bot_id, run.run_id);
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
