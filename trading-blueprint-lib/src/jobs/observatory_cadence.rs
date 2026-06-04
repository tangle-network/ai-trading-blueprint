//! Agent Observatory cadence and manual trigger runner.
//!
//! This path is deliberately separate from the generic workflow tick. The live
//! generic runner is disabled because it can stall; Observatory records must be
//! manually triggerable and scheduler-bounded.

use ai_agent_sandbox_blueprint_lib::{SandboxExecRequest, run_exec_request};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::state::TradingBotRecord;
use crate::workflow_compat::{WorkflowRunRecord, WorkflowRunStatus};

static CADENCE: OnceCell<PersistentStore<ObservatoryCadenceRecord>> = OnceCell::new();

const DEFAULT_INTERVAL_SECS: i64 = 4 * 60 * 60;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_BOTS_PER_TICK: usize = 2;
const OBSERVATORY_JSON_BEGIN: &str = "TANGLE_OBSERVATORY_JSON>";
const OBSERVATORY_JSON_END: &str = "<TANGLE_OBSERVATORY_END";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ObservatoryCadenceRecord {
    pub bot_id: String,
    #[serde(default)]
    pub last_run_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObservatoryTriggerOptions {
    pub trigger: String,
    #[serde(default)]
    pub requested_by: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObservatoryRunResult {
    pub bot_id: String,
    pub run_id: String,
    pub started_at: u64,
    pub completed_at: u64,
    pub workflow_id: Option<u64>,
    pub records: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObservatoryFeedbackInput {
    pub idea_id: String,
    pub action: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
}

fn records() -> Result<&'static PersistentStore<ObservatoryCadenceRecord>, String> {
    CADENCE
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("observatory-cadence.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn record_key(bot_id: &str) -> String {
    format!("observatory-cadence:{bot_id}")
}

fn cadence_record(bot_id: &str) -> Result<ObservatoryCadenceRecord, String> {
    Ok(records()?
        .get(&record_key(bot_id))
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| ObservatoryCadenceRecord {
            bot_id: bot_id.to_string(),
            ..Default::default()
        }))
}

fn save_cadence_record(record: ObservatoryCadenceRecord) -> Result<(), String> {
    records()?
        .insert(record_key(&record.bot_id), record)
        .map_err(|e| e.to_string())
}

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn due(last: Option<i64>, now: i64, interval_secs: i64) -> bool {
    last.is_none_or(|last| now.saturating_sub(last) >= interval_secs)
}

fn eligible_observatory_bot(bot: &TradingBotRecord) -> bool {
    bot.trading_active && bot.wind_down_started_at.is_none()
}

fn observatory_workflow_id(bot: &TradingBotRecord) -> Option<u64> {
    bot.workflow_id.map(|workflow_id| workflow_id + 1)
}

fn run_id_from_records(records: &Value, fallback: &str) -> String {
    records
        .get("records_written")
        .and_then(|written| written.get("reflection_run_id"))
        .and_then(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn truncate_result(value: &Value) -> String {
    let mut text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    if text.len() > 20_000 {
        text.truncate(20_000);
        text.push_str("...");
    }
    text
}

async fn sync_observatory_tool_to_sidecar(sidecar_url: &str, token: &str) -> Result<(), String> {
    crate::jobs::activate::write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/observatory-loop.js",
        include_str!("../prompts/tools/observatory_loop.js"),
    )
    .await
}

async fn sync_observatory_delegation_tools_to_sidecar(
    sidecar_url: &str,
    token: &str,
) -> Result<(), String> {
    sync_observatory_tool_to_sidecar(sidecar_url, token).await?;
    crate::jobs::activate::write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/usage-telemetry.js",
        include_str!("../prompts/tools/usage_telemetry.js"),
    )
    .await?;
    crate::jobs::activate::write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/self-improvement-loop.ts",
        include_str!("../prompts/tools/self_improvement_loop.ts"),
    )
    .await?;
    crate::jobs::activate::write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/self-improvement-mcp-server.ts",
        include_str!("../prompts/tools/self_improvement_mcp_server.ts"),
    )
    .await
}

pub async fn trigger_observatory_for_bot(
    bot: &TradingBotRecord,
    options: ObservatoryTriggerOptions,
) -> Result<ObservatoryRunResult, String> {
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| format!("load sandbox {}: {e}", bot.sandbox_id))?;
    crate::jobs::activate::ensure_sidecar_runtime_dirs(&sandbox.sidecar_url, &sandbox.token)
        .await
        .map_err(|e| format!("prepare observatory dirs: {e}"))?;
    sync_observatory_tool_to_sidecar(&sandbox.sidecar_url, &sandbox.token)
        .await
        .map_err(|e| format!("sync observatory tool: {e}"))?;

    let started_at = chrono::Utc::now().timestamp().max(0) as u64;
    let fallback_run_id = format!("obs-{}-{started_at}", bot.id);
    let exec_req = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: "node /home/agent/tools/observatory-loop.js".to_string(),
        cwd: "/home/agent".to_string(),
        env_json: json!({
            "BOT_ID": bot.id,
            "BOT_NAME": bot.name,
            "TRADING_BOT_ID": bot.id,
            "TRADING_BOT_NAME": bot.name,
            "OBSERVATORY_TRIGGER": options.trigger,
            "OBSERVATORY_REQUESTED_BY": options.requested_by.unwrap_or_default(),
        })
        .to_string(),
        timeout_ms: env_u64("OBSERVATORY_TRIGGER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    };

    let response = run_exec_request(&exec_req, &sandbox.token)
        .await
        .map_err(|e| format!("observatory exec failed: {e}"))?;
    let completed_at = chrono::Utc::now().timestamp().max(0) as u64;
    let workflow_id = observatory_workflow_id(bot);

    let records = if response.exit_code == 0 {
        serde_json::from_str::<Value>(response.stdout.trim()).map_err(|e| {
            format!(
                "observatory JSON parse failed: {e}; stdout={:?}; stderr={:?}",
                response.stdout.chars().take(500).collect::<String>(),
                response.stderr.chars().take(300).collect::<String>()
            )
        })?
    } else {
        let error = format!(
            "observatory tool exited {}: {}",
            response.exit_code,
            response.stderr.trim()
        );
        if let Some(workflow_id) = workflow_id {
            let _ = crate::workflow_compat::persist_workflow_run_record(WorkflowRunRecord {
                run_id: fallback_run_id.clone(),
                workflow_id,
                status: WorkflowRunStatus::Failed,
                started_at,
                completed_at: Some(completed_at),
                session_id: None,
                trace_id: None,
                duration_ms: completed_at.saturating_sub(started_at).saturating_mul(1000),
                input_tokens: 0,
                output_tokens: 0,
                result: None,
                error: Some(error.clone()),
            });
        }
        return Err(error);
    };

    let run_id = run_id_from_records(&records, &fallback_run_id);
    if let Some(workflow_id) = workflow_id {
        crate::workflow_compat::persist_workflow_run_record(WorkflowRunRecord {
            run_id: run_id.clone(),
            workflow_id,
            status: WorkflowRunStatus::Completed,
            started_at,
            completed_at: Some(completed_at),
            session_id: None,
            trace_id: records
                .get("records_written")
                .and_then(|written| written.get("reflection_run_id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            duration_ms: completed_at.saturating_sub(started_at).saturating_mul(1000),
            input_tokens: 0,
            output_tokens: 0,
            result: Some(truncate_result(&records)),
            error: None,
        })
        .map_err(|e| format!("persist observatory run history: {e}"))?;
    }

    Ok(ObservatoryRunResult {
        bot_id: bot.id.clone(),
        run_id,
        started_at,
        completed_at,
        workflow_id,
        records,
    })
}

pub async fn run_observatory_cadence(all_bots: &[TradingBotRecord]) {
    let now = chrono::Utc::now().timestamp();
    let interval = env_i64("OBSERVATORY_INTERVAL_SECS", DEFAULT_INTERVAL_SECS);
    let max_bots = env_usize("OBSERVATORY_MAX_BOTS_PER_TICK", DEFAULT_MAX_BOTS_PER_TICK);
    let mut started = 0usize;

    for bot in all_bots.iter().filter(|bot| eligible_observatory_bot(bot)) {
        if started >= max_bots {
            break;
        }
        let mut record = match cadence_record(&bot.id) {
            Ok(record) => record,
            Err(error) => {
                tracing::warn!(bot_id = %bot.id, "observatory cadence store error: {error}");
                continue;
            }
        };
        if !due(record.last_run_at, now, interval) {
            continue;
        }

        match trigger_observatory_for_bot(
            bot,
            ObservatoryTriggerOptions {
                trigger: "cadence".to_string(),
                requested_by: Some("scheduler".to_string()),
            },
        )
        .await
        {
            Ok(result) => {
                record.last_run_at = Some(now);
                started += 1;
                if let Err(error) = save_cadence_record(record) {
                    tracing::warn!(bot_id = %bot.id, "observatory cadence persist error: {error}");
                }
                tracing::info!(
                    bot_id = %bot.id,
                    run_id = %result.run_id,
                    "observatory cadence wrote record"
                );
            }
            Err(error) => {
                tracing::warn!(bot_id = %bot.id, "observatory cadence failed: {error}");
            }
        }
    }
}

pub async fn read_observatory_records(bot: &TradingBotRecord) -> Result<Value, String> {
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| format!("load sandbox {}: {e}", bot.sandbox_id))?;
    let exec_req = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: read_observatory_records_command().to_string(),
        cwd: "/home/agent".to_string(),
        env_json: "{}".to_string(),
        timeout_ms: env_u64("OBSERVATORY_READ_TIMEOUT_MS", 15_000),
    };
    let response = run_exec_request(&exec_req, &sandbox.token)
        .await
        .map_err(|e| format!("observatory read failed: {e}"))?;
    if response.exit_code != 0 {
        return Err(format!(
            "observatory read exited {}: {}",
            response.exit_code,
            response.stderr.trim()
        ));
    }
    let json = response
        .stdout
        .split_once(OBSERVATORY_JSON_BEGIN)
        .and_then(|(_, rest)| rest.split_once(OBSERVATORY_JSON_END))
        .map(|(payload, _)| payload);
    let Some(payload) = json else {
        return Err(format!(
            "observatory markers not found (stdout={:?}, stderr={:?})",
            response.stdout.chars().take(300).collect::<String>(),
            response.stderr.trim().chars().take(200).collect::<String>(),
        ));
    };
    serde_json::from_str(payload).map_err(|e| format!("observatory read JSON parse failed: {e}"))
}

pub async fn append_observatory_feedback(
    bot: &TradingBotRecord,
    feedback: ObservatoryFeedbackInput,
) -> Result<Value, String> {
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| format!("load sandbox {}: {e}", bot.sandbox_id))?;
    sync_observatory_delegation_tools_to_sidecar(&sandbox.sidecar_url, &sandbox.token)
        .await
        .map_err(|e| format!("sync observatory delegation tools: {e}"))?;
    let now = chrono::Utc::now().to_rfc3339();
    let entry = json!({
        "feedback_id": format!("feedback_{}", uuid_like(&json!({
            "bot_id": bot.id,
            "idea_id": feedback.idea_id,
            "action": feedback.action,
            "created_at": now,
        }))),
        "bot_id": bot.id,
        "idea_id": feedback.idea_id,
        "action": feedback.action,
        "note": feedback.note,
        "owner": feedback.owner,
        "created_at": now,
    });
    let exec_req = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: append_observatory_feedback_command().to_string(),
        cwd: "/home/agent".to_string(),
        env_json: json!({ "OBSERVATORY_FEEDBACK": entry.to_string() }).to_string(),
        timeout_ms: env_u64("OBSERVATORY_FEEDBACK_TIMEOUT_MS", 15_000),
    };
    let response = run_exec_request(&exec_req, &sandbox.token)
        .await
        .map_err(|e| format!("observatory feedback append failed: {e}"))?;
    if response.exit_code != 0 {
        return Err(format!(
            "observatory feedback append exited {}: {}",
            response.exit_code,
            response.stderr.trim()
        ));
    }
    Ok(json!({ "feedback": entry }))
}

fn uuid_like(value: &Value) -> String {
    let _ = value;
    uuid::Uuid::new_v4().simple().to_string()[..18].to_string()
}

fn read_observatory_records_command() -> &'static str {
    r#"node - <<'NODE'
const fs = require('fs');
function read(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}
function parseJsonl(raw, limit = 100) {
  return String(raw || '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(Boolean)
    .slice(-limit)
}
const root = '/home/agent/memory/observatory';
const payload = {
  schema_version: 1,
  world_signal_digests: parseJsonl(read(`${root}/world-signal-digests.jsonl`), 100),
  reflection_runs: parseJsonl(read(`${root}/reflection-runs.jsonl`), 100),
  ideas: parseJsonl(read(`${root}/ideas.jsonl`), 100),
  delegated_work_sessions: parseJsonl(read(`${root}/delegated-work-sessions.jsonl`), 100),
  owner_feedback: parseJsonl(read(`${root}/owner-feedback.jsonl`), 100),
};
const B = 'TANGLE' + '_OBSERVATORY_JSON>';
const E = '<TANGLE' + '_OBSERVATORY_END';
process.stdout.write('\n' + B + JSON.stringify(payload) + E + '\n');
NODE"#
}

fn append_observatory_feedback_command() -> &'static str {
    r#"node - <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const entry = JSON.parse(process.env.OBSERVATORY_FEEDBACK || '{}');
const root = '/home/agent/memory/observatory';
const feedbackFile = `${root}/owner-feedback.jsonl`;
const ideasFile = `${root}/ideas.jsonl`;
const delegatedFile = `${root}/delegated-work-sessions.jsonl`;

function ensure(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
function appendJsonl(file, value) {
  ensure(file);
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}
function parseJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function sha(value, len = 18) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, len);
}
function dispatchBuildTask(idea) {
  const spec = `Owner requested a paper-only delegated build from Observatory idea ${entry.idea_id}.

Idea title: ${idea?.title || entry.idea_id}
Thesis: ${idea?.thesis || 'No idea thesis recorded.'}
Expected value: ${idea?.expected_value || 'Improve the bot operating loop.'}

Acceptance: implement the smallest durable bot-local code/tool/prompt improvement, run deterministic checks, leave live trading and promotion blocked behind existing validator/promotion gates, and persist task status for the Observatory.`;
  const rpc = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'self_improvement.create_task',
      arguments: {
        spec,
        max_rounds: 3,
        selection: 'smallest_diff',
        wait_for_completion: false,
        test_commands: ['bun --bun /home/agent/tools/self-improvement-loop.ts status'],
      },
    },
  };
  const result = spawnSync('bun', ['--bun', '/home/agent/tools/self-improvement-mcp-server.ts'], {
    cwd: '/home/agent',
    input: `${JSON.stringify(rpc)}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: result.stderr || result.stdout || 'self-improvement MCP dispatch failed',
    };
  }
  try {
    const response = JSON.parse(String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    const text = response.result?.content?.[0]?.text;
    const payload = text ? JSON.parse(text) : response;
    return {
      ok: true,
      task_id: payload.task_id || null,
      status: payload.status || 'queued',
      raw: payload,
    };
  } catch (error) {
    return {
      ok: false,
      error: `failed to parse self-improvement MCP response: ${error.message || error}`,
      stdout: result.stdout,
    };
  }
}

appendJsonl(feedbackFile, entry);

const action = String(entry.action || '');
const idea = parseJsonl(ideasFile).reverse().find((item) => item.idea_id === entry.idea_id) || null;
let delegated = null;
let dispatch = null;
if (action === 'delegate_research' || action === 'delegate_build') {
  if (action === 'delegate_build') {
    dispatch = dispatchBuildTask(idea);
  }
  delegated = {
    session_id: `owner_delegate_${sha({ feedback_id: entry.feedback_id, idea_id: entry.idea_id, action })}`,
    bot_id: entry.bot_id,
    source: action === 'delegate_build' ? 'owner-feedback:self-improvement-mcp' : 'owner-feedback:research',
    status: action === 'delegate_build'
      ? dispatch?.ok ? dispatch.status || 'queued' : 'dispatch_failed'
      : 'queued_research',
    created_at: entry.created_at,
    idea_id: entry.idea_id,
    task_id: dispatch?.task_id || null,
    summary: action === 'delegate_build'
      ? `Owner delegated build work for ${idea?.title || entry.idea_id}.`
      : `Owner queued research for ${idea?.title || entry.idea_id}.`,
    artifact_ref: dispatch?.task_id
      ? `artifact://mcp-self-improvement/tasks/${dispatch.task_id}.json`
      : `artifact://observatory/ideas#${entry.idea_id}`,
    dispatch_error: dispatch && !dispatch.ok ? dispatch.error : null,
  };
  appendJsonl(delegatedFile, delegated);
}

process.stdout.write(JSON.stringify({
  ok: true,
  feedback_id: entry.feedback_id || null,
  delegated_work_session: delegated,
  dispatch,
}));
NODE"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observatory_workflow_uses_research_slot() {
        let bot = TradingBotRecord {
            id: "bot_1".to_string(),
            name: "Bot".to_string(),
            sandbox_id: "sandbox".to_string(),
            vault_address: String::new(),
            share_token: String::new(),
            strategy_type: "dex".to_string(),
            strategy_config: Value::Null,
            risk_params: Value::Null,
            chain_id: 0,
            rpc_url: String::new(),
            trading_api_url: String::new(),
            trading_api_token: String::new(),
            workflow_id: Some(10),
            trading_active: true,
            created_at: 0,
            operator_address: String::new(),
            validator_service_ids: Vec::new(),
            max_lifetime_days: 0,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: Value::Null,
            validation_trust: Default::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        };

        assert_eq!(observatory_workflow_id(&bot), Some(11));
    }

    #[test]
    fn reader_script_uses_framed_json_markers() {
        assert!(read_observatory_records_command().contains("TANGLE' + '_OBSERVATORY_JSON>"));
        assert!(read_observatory_records_command().contains("reflection-runs.jsonl"));
        assert!(read_observatory_records_command().contains("owner-feedback.jsonl"));
    }

    #[test]
    fn feedback_script_dispatches_delegate_build_through_mcp() {
        let script = append_observatory_feedback_command();
        assert!(script.contains("self_improvement.create_task"));
        assert!(script.contains("delegate_build"));
        assert!(script.contains("delegated-work-sessions.jsonl"));
        assert!(script.contains("paper-only delegated build"));
    }
}
