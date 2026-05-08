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
//! module provides the same shape backed by **bin-local in-memory stores**.
//! Behavior identical to the sibling's old impl from the API caller's
//! perspective; persistence is per-process (was: persistent on disk).
//!
//! Long-term plan: promote these stores to disk-backed persistence (the
//! sibling's `PersistentStore` flavor) so runs survive restarts. For the
//! audit-followup PR we accept process-local storage so the bin compiles
//! and the rest of the audit fixes can land.

// Several items in this module are only consumed by the integration tests
// (`tests/operator_api_tests.rs`). They're public-API for the test crate
// but unused from the bin binary itself, which trips clippy's `dead-code`
// detector under `-D warnings`. Allow at the module level.
#![allow(dead_code)]

use ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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
}

/// Per-run transcript record. Same shape the bin's tests already construct.
#[derive(Clone, Debug)]
pub struct WorkflowRunTranscriptRecord {
    pub run_id: String,
    pub session_id: String,
    pub captured_at: u64,
    pub messages: serde_json::Value,
}

// ── In-memory stores (bin-local, process-scoped) ──────────────────────────

fn runs_store() -> &'static Mutex<HashMap<String, WorkflowRunRecord>> {
    static STORE: OnceLock<Mutex<HashMap<String, WorkflowRunRecord>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn transcripts_store() -> &'static Mutex<HashMap<String, WorkflowRunTranscriptRecord>> {
    static STORE: OnceLock<Mutex<HashMap<String, WorkflowRunTranscriptRecord>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Wrapper that mirrors the sibling's old `PersistentStore`-shape `.insert`
/// signature (returns `Result<(), String>`) so call sites compile without
/// edits. Internally backed by `runs_store()`.
pub struct WorkflowRunsStore;

impl WorkflowRunsStore {
    pub fn insert(&self, key: String, record: WorkflowRunRecord) -> Result<(), String> {
        let mut guard = runs_store().lock().map_err(|e| e.to_string())?;
        guard.insert(key, record);
        Ok(())
    }
}

/// Mirrors the sibling's old `workflow_runs()` accessor — returns a handle
/// to the run-history store. Wrapped in `Result` to match the original
/// signature (which could fail on store init).
pub fn workflow_runs() -> Result<WorkflowRunsStore, String> {
    Ok(WorkflowRunsStore)
}

/// List runs for a set of workflow ids, sorted by started_at desc.
/// Empty input → empty output.
pub fn list_workflow_runs_for_workflows(
    workflow_ids: &[u64],
) -> Result<Vec<WorkflowRunRecord>, String> {
    if workflow_ids.is_empty() {
        return Ok(Vec::new());
    }
    let guard = runs_store().lock().map_err(|e| e.to_string())?;
    let mut out: Vec<WorkflowRunRecord> = guard
        .values()
        .filter(|run| workflow_ids.contains(&run.workflow_id))
        .cloned()
        .collect();
    // Newest first — matches the sibling's old behavior for cursor pagination.
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

/// Look up a single run by id.
pub fn get_workflow_run(run_id: &str) -> Result<Option<WorkflowRunRecord>, String> {
    let guard = runs_store().lock().map_err(|e| e.to_string())?;
    Ok(guard.get(run_id).cloned())
}

/// Look up a transcript by run id.
pub fn get_workflow_run_transcript(
    run_id: &str,
) -> Result<Option<WorkflowRunTranscriptRecord>, String> {
    let guard = transcripts_store().lock().map_err(|e| e.to_string())?;
    Ok(guard.get(run_id).cloned())
}

/// Test helper that mirrors the sibling's old name — inserts a transcript
/// directly into the bin-local store. Used by `operator_api_tests.rs` to
/// seed transcripts for the runs/transcript replay tests. Result-returning
/// signature mirrors the old sibling helper so call sites that chain
/// `.expect(...)` compile unchanged.
pub fn insert_workflow_run_transcript_for_testing(
    record: WorkflowRunTranscriptRecord,
) -> Result<(), String> {
    let mut guard = transcripts_store().lock().map_err(|e| e.to_string())?;
    guard.insert(record.run_id.clone(), record);
    Ok(())
}

/// Apply-workflow-failure no-op. The sibling's `store_failed_execution`
/// already records the failure into `WorkflowEntry.latest_execution`, so
/// the old hook was a duplicate write. Kept for compile-time compatibility.
pub fn apply_workflow_failure(_entry: &mut WorkflowEntry, _failed_at: u64) {
    // intentionally empty — see module docs
}
