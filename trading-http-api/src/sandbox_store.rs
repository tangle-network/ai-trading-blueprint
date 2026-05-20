use chrono::{DateTime, Utc};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static SNAPSHOTS: OnceCell<PersistentStore<SandboxSnapshot>> = OnceCell::new();
static REVISIONS: OnceCell<PersistentStore<SandboxRevision>> = OnceCell::new();
static ACTIVE_REVISIONS: OnceCell<PersistentStore<ActiveSandboxRevision>> = OnceCell::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SandboxSnapshot {
    pub snapshot_id: String,
    pub bot_id: String,
    pub created_at: DateTime<Utc>,
    pub base_repo: String,
    pub base_ref: String,
    pub base_commit: String,
    pub base_image_digest: String,
    pub workspace_digest: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SandboxRevision {
    pub revision_id: String,
    pub bot_id: String,
    pub created_at: DateTime<Utc>,
    pub base_snapshot_id: String,
    #[serde(default)]
    pub parent_revision_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    pub user_intent: String,
    pub patch_sha256: String,
    pub patch: String,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActiveSandboxRevision {
    pub bot_id: String,
    pub revision_id: String,
    pub activated_at: DateTime<Utc>,
    pub reason: String,
    #[serde(default)]
    pub rollback_from: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SandboxLineage {
    pub bot_id: String,
    pub active_revision: Option<ActiveSandboxRevision>,
    pub snapshots: Vec<SandboxSnapshot>,
    pub revisions: Vec<SandboxRevision>,
}

pub fn snapshots() -> Result<&'static PersistentStore<SandboxSnapshot>, String> {
    SNAPSHOTS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("sandbox-snapshots.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

pub fn revisions() -> Result<&'static PersistentStore<SandboxRevision>, String> {
    REVISIONS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("sandbox-revisions.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

pub fn active_revisions() -> Result<&'static PersistentStore<ActiveSandboxRevision>, String> {
    ACTIVE_REVISIONS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("sandbox-active-revisions.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn snapshot_key(bot_id: &str, snapshot_id: &str) -> String {
    format!("sandbox-snapshot:{bot_id}:{snapshot_id}")
}

fn revision_key(bot_id: &str, revision_id: &str) -> String {
    format!("sandbox-revision:{bot_id}:{revision_id}")
}

fn active_key(bot_id: &str) -> String {
    format!("sandbox-active:{bot_id}")
}

pub fn insert_snapshot(snapshot: SandboxSnapshot) -> Result<(), String> {
    snapshots()?
        .insert(
            snapshot_key(&snapshot.bot_id, &snapshot.snapshot_id),
            snapshot,
        )
        .map_err(|e| e.to_string())
}

pub fn get_snapshot(bot_id: &str, snapshot_id: &str) -> Result<Option<SandboxSnapshot>, String> {
    snapshots()?
        .get(&snapshot_key(bot_id, snapshot_id))
        .map_err(|e| e.to_string())
}

pub fn insert_revision(revision: SandboxRevision) -> Result<(), String> {
    revisions()?
        .insert(
            revision_key(&revision.bot_id, &revision.revision_id),
            revision,
        )
        .map_err(|e| e.to_string())
}

pub fn get_revision(bot_id: &str, revision_id: &str) -> Result<Option<SandboxRevision>, String> {
    revisions()?
        .get(&revision_key(bot_id, revision_id))
        .map_err(|e| e.to_string())
}

pub fn set_active_revision(active: ActiveSandboxRevision) -> Result<(), String> {
    active_revisions()?
        .insert(active_key(&active.bot_id), active)
        .map_err(|e| e.to_string())
}

pub fn active_revision(bot_id: &str) -> Result<Option<ActiveSandboxRevision>, String> {
    active_revisions()?
        .get(&active_key(bot_id))
        .map_err(|e| e.to_string())
}

pub fn lineage(bot_id: &str) -> Result<SandboxLineage, String> {
    let bid = bot_id.to_string();
    let mut snapshots: Vec<SandboxSnapshot> = snapshots()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|snapshot| snapshot.bot_id == bid)
        .collect();
    snapshots.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let mut revisions: Vec<SandboxRevision> = revisions()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|revision| revision.bot_id == bid)
        .collect();
    revisions.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    Ok(SandboxLineage {
        bot_id: bot_id.to_string(),
        active_revision: active_revision(bot_id)?,
        snapshots,
        revisions,
    })
}
