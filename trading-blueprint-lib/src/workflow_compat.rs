//! Compat shim for the sibling `ai-agent-sandbox-blueprint-lib::workflows` API.
//!
//! The sibling repo refactored away its per-run history surface
//! (`WorkflowRunRecord`, `WorkflowRunStatus`, `WorkflowRunTranscriptRecord`,
//! `workflow_runs`, `list_workflow_runs_for_workflows`, `get_workflow_run`,
//! `get_workflow_run_transcript`, `insert_workflow_run_transcript_for_testing`,
//! `apply_workflow_failure`) and replaced it with a `WorkflowExecution`
//! summary attached to each workflow's `latest_execution`.
//!
//! The trading-blueprint-bin still exposes per-run history via
//! `/api/bots/:id/runs` and `/api/bots/:id/runs/:run_id`. Rather than gut
//! that endpoint surface or downgrade it to "feature unavailable", this
//! module provides the same shape backed by blueprint-state JSON stores.
//! Runtime code persists every observed latest execution here before the
//! sibling runtime overwrites its one-slot `latest_execution` summary.

// Several items in this module are only consumed by the integration tests
// (`tests/operator_api_tests.rs`). They're public-API for the test crate
// but unused from the bin binary itself, which trips clippy's `dead-code`
// detector under `-D warnings`. Allow at the module level.
#![allow(dead_code)]

use ai_agent_sandbox_blueprint_lib::workflows::{WorkflowEntry, WorkflowLatestExecution};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// Per-workflow run record. Field shape preserved from the old sibling type
/// so existing call sites compile without churn.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkflowRunRecord {
    pub run_id: String,
    pub workflow_id: u64,
    pub status: WorkflowRunStatus,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub session_id: Option<String>,
    pub trace_id: Option<String>,
    pub duration_ms: u64,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub result: Option<String>,
    pub error: Option<String>,
    /// "deterministic" (cron tick, no LLM) or "agentic" (model-driven run).
    /// First-class so UIs can stop rendering 5-minute cron ticks as agent
    /// activity. None on legacy rows.
    #[serde(default)]
    pub loop_mode: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// Agent harness (sidecar backend) the run executed through —
    /// `opencode`, `claude-code`, or `codex`. None for deterministic runs
    /// (no agent CLI involved) and legacy rows.
    #[serde(default)]
    pub harness: Option<String>,
}

/// Per-run transcript record. Same shape the bin's tests already construct.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkflowRunTranscriptRecord {
    pub run_id: String,
    pub session_id: String,
    pub captured_at: u64,
    pub messages: serde_json::Value,
}

static RUNS: OnceCell<PersistentStore<WorkflowRunRecord>> = OnceCell::new();
static TRANSCRIPTS: OnceCell<PersistentStore<WorkflowRunTranscriptRecord>> = OnceCell::new();

/// Wrapper that mirrors the sibling's old `PersistentStore`-shape `.insert`
/// signature (returns `Result<(), String>`) so call sites compile without
/// edits. Internally backed by `runs_store()`.
pub struct WorkflowRunsStore;

impl WorkflowRunsStore {
    pub fn insert(&self, key: String, record: WorkflowRunRecord) -> Result<(), String> {
        workflow_runs_store()?
            .insert(key, record)
            .map_err(|e| e.to_string())
    }
}

/// Mirrors the sibling's old `workflow_runs()` accessor — returns a handle
/// to the run-history store. Wrapped in `Result` to match the original
/// signature (which could fail on store init).
pub fn workflow_runs() -> Result<WorkflowRunsStore, String> {
    Ok(WorkflowRunsStore)
}

fn workflow_runs_store() -> Result<&'static PersistentStore<WorkflowRunRecord>, String> {
    RUNS.get_or_try_init(|| {
        let path = sandbox_runtime::store::state_dir().join("workflow-runs.json");
        PersistentStore::open(path).map_err(|e| e.to_string())
    })
    .map_err(|err: String| err)
}

fn workflow_run_transcripts_store()
-> Result<&'static PersistentStore<WorkflowRunTranscriptRecord>, String> {
    TRANSCRIPTS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("workflow-run-transcripts.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|err: String| err)
}

pub fn workflow_run_record_from_latest_execution(
    workflow_id: u64,
    latest: WorkflowLatestExecution,
) -> WorkflowRunRecord {
    WorkflowRunRecord {
        run_id: format!("latest-{workflow_id}-{}", latest.executed_at),
        workflow_id,
        status: if latest.success {
            WorkflowRunStatus::Completed
        } else {
            WorkflowRunStatus::Failed
        },
        started_at: latest.executed_at,
        completed_at: Some(latest.executed_at),
        session_id: (!latest.session_id.is_empty()).then_some(latest.session_id),
        trace_id: (!latest.trace_id.is_empty()).then_some(latest.trace_id),
        duration_ms: latest.duration_ms,
        input_tokens: latest.input_tokens,
        output_tokens: latest.output_tokens,
        result: (!latest.result.is_empty()).then_some(latest.result),
        error: (!latest.error.is_empty()).then_some(latest.error),
        // The sibling execution summary carries no model identity; token
        // presence is the reliable discriminator for these records.
        loop_mode: Some(if latest.input_tokens > 0 || latest.output_tokens > 0 {
            "agentic".to_string()
        } else {
            "deterministic".to_string()
        }),
        model: None,
        provider: None,
        cost_usd: None,
        // The sibling execution summary carries no harness identity either.
        harness: None,
    }
}

pub fn latest_execution_run_for_workflow(
    workflow_id: u64,
) -> Result<Option<WorkflowRunRecord>, String> {
    let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id);
    let latest = ai_agent_sandbox_blueprint_lib::workflows::workflow_runtime()
        .map_err(|e| e.to_string())?
        .get(&key)
        .map_err(|e| e.to_string())?
        .and_then(|metadata| metadata.latest_execution);

    Ok(latest.map(|execution| workflow_run_record_from_latest_execution(workflow_id, execution)))
}

pub fn persist_latest_execution_run(
    workflow_id: u64,
    latest: WorkflowLatestExecution,
) -> Result<WorkflowRunRecord, String> {
    let record = workflow_run_record_from_latest_execution(workflow_id, latest);
    workflow_runs_store()?
        .insert(record.run_id.clone(), record.clone())
        .map_err(|e| e.to_string())?;
    Ok(record)
}

pub fn persist_workflow_run_record(record: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    workflow_runs_store()?
        .insert(record.run_id.clone(), record.clone())
        .map_err(|e| e.to_string())?;
    Ok(record)
}

pub fn backfill_latest_execution_run(
    workflow_id: u64,
) -> Result<Option<WorkflowRunRecord>, String> {
    let Some(record) = latest_execution_run_for_workflow(workflow_id)? else {
        return Ok(None);
    };
    workflow_runs_store()?
        .insert(record.run_id.clone(), record.clone())
        .map_err(|e| e.to_string())?;
    Ok(Some(record))
}

/// List runs for a set of workflow ids, sorted by started_at desc.
/// Empty input → empty output.
pub fn list_workflow_runs_for_workflows(
    workflow_ids: &[u64],
) -> Result<Vec<WorkflowRunRecord>, String> {
    if workflow_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out: Vec<WorkflowRunRecord> = workflow_runs_store()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|run| workflow_ids.contains(&run.workflow_id))
        .collect();
    // Newest first — matches the sibling's old behavior for cursor pagination.
    out.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.run_id.cmp(&a.run_id))
    });
    Ok(out)
}

/// Look up a single run by id.
pub fn get_workflow_run(run_id: &str) -> Result<Option<WorkflowRunRecord>, String> {
    workflow_runs_store()?
        .get(run_id)
        .map_err(|e| e.to_string())
}

/// Look up a transcript by run id.
pub fn get_workflow_run_transcript(
    run_id: &str,
) -> Result<Option<WorkflowRunTranscriptRecord>, String> {
    workflow_run_transcripts_store()?
        .get(run_id)
        .map_err(|e| e.to_string())
}

pub fn persist_workflow_run_transcript(
    record: WorkflowRunTranscriptRecord,
) -> Result<WorkflowRunTranscriptRecord, String> {
    workflow_run_transcripts_store()?
        .insert(record.run_id.clone(), record.clone())
        .map_err(|e| e.to_string())?;
    Ok(record)
}

/// Test helper that mirrors the sibling's old name — inserts a transcript
/// directly into the bin-local store. Used by `operator_api_tests.rs` to
/// seed transcripts for the runs/transcript replay tests. Result-returning
/// signature mirrors the old sibling helper so call sites that chain
/// `.expect(...)` compile unchanged.
pub fn insert_workflow_run_transcript_for_testing(
    record: WorkflowRunTranscriptRecord,
) -> Result<(), String> {
    persist_workflow_run_transcript(record).map(|_| ())
}

#[cfg(test)]
pub(crate) fn remove_workflow_run_for_testing(run_id: &str) -> Result<(), String> {
    workflow_runs_store()?
        .remove(run_id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) fn remove_workflow_run_transcript_for_testing(run_id: &str) -> Result<(), String> {
    workflow_run_transcripts_store()?
        .remove(run_id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Apply-workflow-failure no-op. The sibling's `store_failed_execution`
/// already records the failure into `WorkflowEntry.latest_execution`, so
/// the old hook was a duplicate write. Kept for compile-time compatibility.
pub fn apply_workflow_failure(_entry: &mut WorkflowEntry, _failed_at: u64) {
    // intentionally empty — see module docs
}
