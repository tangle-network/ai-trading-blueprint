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

use crate::operator_chat::{AgenticChatTurnOptions, SidecarChatTarget};
use crate::state::TradingBotRecord;
use crate::workflow_compat::{WorkflowRunRecord, WorkflowRunStatus, WorkflowRunTranscriptRecord};

static CADENCE: OnceCell<PersistentStore<ObservatoryCadenceRecord>> = OnceCell::new();

const DEFAULT_INTERVAL_SECS: i64 = 4 * 60 * 60;
const DEFAULT_JITTER_SECS: i64 = 15 * 60;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_AGENTIC_REFLECTION_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_BOTS_PER_TICK: usize = 2;
const DEFAULT_MAX_RUNS_PER_BOT_PER_DAY: usize = 6;
const DEFAULT_MAX_COST_USD_PER_BOT_PER_DAY: f64 = 0.0;
const OBSERVATORY_JSON_BEGIN: &str = "TANGLE_OBSERVATORY_JSON>";
const OBSERVATORY_JSON_END: &str = "<TANGLE_OBSERVATORY_END";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ObservatoryCadenceRecord {
    pub bot_id: String,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub day_key: Option<String>,
    #[serde(default)]
    pub runs_today: usize,
    #[serde(default)]
    pub cost_today_usd: f64,
    #[serde(default)]
    pub last_jitter_secs: Option<i64>,
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

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(default)
}

fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| match value.trim().to_ascii_lowercase().as_str() {
            "0" | "false" | "no" | "off" | "disabled" => false,
            "1" | "true" | "yes" | "on" | "enabled" => true,
            _ => default,
        })
        .unwrap_or(default)
}

fn due(last: Option<i64>, now: i64, interval_secs: i64, jitter_secs: i64) -> bool {
    last.is_none_or(|last| {
        now.saturating_sub(last) >= interval_secs.saturating_add(jitter_secs.max(0))
    })
}

fn eligible_observatory_bot(bot: &TradingBotRecord) -> bool {
    bot.trading_active && bot.wind_down_started_at.is_none()
}

pub fn observatory_workflow_id(bot: &TradingBotRecord) -> u64 {
    bot.workflow_id
        .map(|workflow_id| workflow_id + 3)
        .unwrap_or_else(|| stable_hash_u64(&format!("observatory:{}", bot.id)))
}

fn utc_day_key(timestamp: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0)
        .map(|time| time.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "1970-01-01".to_string())
}

fn stable_hash_u64(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn deterministic_jitter_secs(bot_id: &str, day_key: &str, max_jitter_secs: i64) -> i64 {
    if max_jitter_secs <= 0 {
        return 0;
    }
    (stable_hash_u64(&format!("{bot_id}:{day_key}")) % (max_jitter_secs as u64 + 1)) as i64
}

fn align_cadence_day(record: &mut ObservatoryCadenceRecord, day_key: &str) -> bool {
    if record.day_key.as_deref() == Some(day_key) {
        return false;
    }
    record.day_key = Some(day_key.to_string());
    record.runs_today = 0;
    record.cost_today_usd = 0.0;
    record.last_jitter_secs = None;
    true
}

fn observatory_run_cost_usd(records: &Value) -> f64 {
    let structured_cost = records
        .get("records")
        .and_then(|records| records.get("usage_summary"))
        .and_then(|usage| usage.get("cost_usd"))
        .and_then(Value::as_f64)
        .unwrap_or_else(|| {
            records
                .get("records")
                .and_then(|records| records.get("reflection_runs"))
                .and_then(Value::as_array)
                .and_then(|runs| runs.first())
                .and_then(|run| run.get("usage_summary"))
                .and_then(|usage| usage.get("cost_usd"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        })
        .max(0.0);
    let agentic_cost = records
        .get("agentic_reflection")
        .and_then(|agentic| {
            agentic.get("cost_usd").and_then(Value::as_f64).or_else(|| {
                agentic
                    .get("usage_event")
                    .and_then(|usage| usage.get("cost_usd"))
                    .and_then(Value::as_f64)
            })
        })
        .unwrap_or(0.0)
        .max(0.0);
    structured_cost + agentic_cost
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

fn observatory_agentic_reflection_enabled() -> bool {
    env_bool("OBSERVATORY_AGENTIC_REFLECTION_ENABLED", true)
}

fn observatory_agentic_reflection_timeout_ms() -> u64 {
    env_u64(
        "OBSERVATORY_AGENTIC_REFLECTION_TIMEOUT_MS",
        DEFAULT_AGENTIC_REFLECTION_TIMEOUT_MS,
    )
}

fn observatory_agentic_session_id(bot: &TradingBotRecord, started_at: u64) -> String {
    format!("convo-{}-{started_at}", bot.id)
}

fn record_array_len(records: &Value, key: &str) -> usize {
    records
        .get("records")
        .and_then(|records| records.get(key))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn latest_pressure_level(records: &Value) -> String {
    records
        .get("records")
        .and_then(|records| records.get("delegation_pressure"))
        .and_then(|pressure| pressure.get("pressure_level"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

fn observatory_agentic_reflection_prompt(
    bot: &TradingBotRecord,
    run_id: &str,
    records: &Value,
) -> String {
    let reflection_runs = record_array_len(records, "reflection_runs");
    let ideas = record_array_len(records, "ideas");
    let delegated_sessions = record_array_len(records, "delegated_work_sessions");
    let research_tasks = record_array_len(records, "research_tasks");
    let world_digests = record_array_len(records, "world_signal_digests");
    let pressure_level = latest_pressure_level(records);
    format!(
        "You are the trading bot's operator agent running a read-only Observatory reflection.\n\n\
Bot:\n\
- id: {bot_id}\n\
- name: {bot_name}\n\
- strategy_type: {strategy_type}\n\
- chain_id: {chain_id}\n\
- paper_trade: {paper_trade}\n\
- observatory_run_id: {run_id}\n\n\
Fresh structured records just landed:\n\
- reflection_runs: {reflection_runs}\n\
- world_signal_digests: {world_digests}\n\
- ideas: {ideas}\n\
- delegated_work_sessions: {delegated_sessions}\n\
- research_tasks: {research_tasks}\n\
- delegation_pressure: {pressure_level}\n\n\
Inspect the workspace if useful:\n\
- /home/agent/memory/observatory/reflection-runs.jsonl\n\
- /home/agent/memory/observatory/world-signal-digests.jsonl\n\
- /home/agent/memory/observatory/ideas.jsonl\n\
- /home/agent/memory/observatory/delegated-work-sessions.jsonl\n\
- /home/agent/memory/observatory/research-tasks.jsonl\n\
- /home/agent/memory/decision-contexts.jsonl\n\
- /home/agent/logs/decisions.jsonl\n\
- /home/agent/telemetry/llm-usage.jsonl\n\n\
Constraints:\n\
- Do not trade.\n\
- Do not mutate live config.\n\
- Do not promote anything.\n\
- Do not create delegated work in this reflection.\n\
- Keep it under 180 words.\n\n\
Return exactly four compact sections:\n\
Observed, Concern, Next safe action, Missing evidence.",
        bot_id = bot.id,
        bot_name = bot.name,
        strategy_type = bot.strategy_type,
        chain_id = bot.chain_id,
        paper_trade = bot.paper_trade,
    )
}

fn records_with_agentic_reflection(
    mut records: Value,
    agentic: Option<&crate::operator_chat::AgenticChatTurnResult>,
    error: Option<&str>,
) -> Value {
    let reflection = if let Some(agentic) = agentic {
        json!({
            "enabled": true,
            "session_id": agentic.session_id,
            "status": agentic.status,
            "input_tokens": agentic.input_tokens,
            "output_tokens": agentic.output_tokens,
            "cost_usd": agentic.cost_usd,
            "trace_id": agentic.trace_id,
            "assistant_text": agentic.assistant_text,
            "usage_event": agentic.usage_event,
        })
    } else {
        json!({
            "enabled": observatory_agentic_reflection_enabled(),
            "status": "unavailable",
            "error": error,
        })
    };

    if let Some(object) = records.as_object_mut() {
        object.insert("agentic_reflection".to_string(), reflection);
        return records;
    }

    json!({
        "records": records,
        "agentic_reflection": reflection,
    })
}

fn records_with_queued_agentic_reflection(mut records: Value, session_id: &str) -> Value {
    let reflection = json!({
        "enabled": true,
        "status": "queued",
        "session_id": session_id,
    });
    if let Some(object) = records.as_object_mut() {
        object.insert("agentic_reflection".to_string(), reflection);
        return records;
    }
    json!({
        "records": records,
        "agentic_reflection": reflection,
    })
}

/// First scalar string under `key` (or first element of the plural array
/// form, e.g. "models") anywhere in a usage event payload.
fn usage_event_string(usage: &Value, key: &str) -> Option<String> {
    fn lookup(value: &Value, key: &str, plural: &str, depth: u8) -> Option<String> {
        if depth == 0 {
            return None;
        }
        let object = value.as_object()?;
        if let Some(found) = object.get(key).and_then(Value::as_str) {
            if !found.is_empty() {
                return Some(found.to_string());
            }
        }
        if let Some(found) = object
            .get(plural)
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
        {
            if !found.is_empty() {
                return Some(found.to_string());
            }
        }
        object
            .values()
            .find_map(|nested| lookup(nested, key, plural, depth - 1))
    }
    lookup(usage, key, &format!("{key}s"), 4)
}

/// Bound a run result for storage WITHOUT breaking JSON validity. The old
/// implementation cut the serialized string at 20k bytes, which left every
/// large result unparseable downstream (UI cost display, eval capture).
fn truncate_result(value: &Value) -> String {
    const MAX_BYTES: usize = 20_000;
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    if text.len() <= MAX_BYTES {
        return text;
    }
    let mut shrunk = value.clone();
    shrink_string_leaves(&mut shrunk, 2_000);
    let text = serde_json::to_string(&shrunk).unwrap_or_else(|_| "{}".to_string());
    if text.len() <= MAX_BYTES {
        return text;
    }
    json!({
        "truncated": true,
        "original_bytes": text.len(),
        "top_level_keys": value
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
    })
    .to_string()
}

fn shrink_string_leaves(value: &mut Value, max_chars: usize) {
    match value {
        Value::String(text) => {
            if text.chars().count() > max_chars {
                let mut shortened: String = text.chars().take(max_chars).collect();
                shortened.push_str("…[truncated]");
                *text = shortened;
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| shrink_string_leaves(item, max_chars)),
        Value::Object(object) => object
            .values_mut()
            .for_each(|item| shrink_string_leaves(item, max_chars)),
        _ => {}
    }
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
        "/home/agent/tools/trading-trace-analysts.ts",
        include_str!("../prompts/tools/trading_trace_analysts.ts"),
    )
    .await?;
    crate::jobs::activate::write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/observatory-pressure.js",
        include_str!("../prompts/tools/observatory_pressure.js"),
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
    let trigger = options.trigger.clone();
    let requested_by = options.requested_by.clone().unwrap_or_default();
    let exec_req = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: "node /home/agent/tools/observatory-loop.js".to_string(),
        cwd: "/home/agent".to_string(),
        env_json: json!({
            "BOT_ID": bot.id,
            "BOT_NAME": bot.name,
            "TRADING_BOT_ID": bot.id,
            "TRADING_BOT_NAME": bot.name,
            "OBSERVATORY_TRIGGER": trigger.clone(),
            "OBSERVATORY_REQUESTED_BY": requested_by.clone(),
        })
        .to_string(),
        timeout_ms: env_u64("OBSERVATORY_TRIGGER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    };

    let response = run_exec_request(&exec_req, &sandbox.token)
        .await
        .map_err(|e| format!("observatory exec failed: {e}"))?;
    let exec_completed_at = chrono::Utc::now().timestamp().max(0) as u64;
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
        let _ = crate::workflow_compat::persist_workflow_run_record(WorkflowRunRecord {
            run_id: fallback_run_id.clone(),
            workflow_id,
            status: WorkflowRunStatus::Failed,
            started_at,
            completed_at: Some(exec_completed_at),
            session_id: None,
            trace_id: None,
            duration_ms: exec_completed_at
                .saturating_sub(started_at)
                .saturating_mul(1000),
            input_tokens: 0,
            output_tokens: 0,
            result: None,
            error: Some(error.clone()),
            loop_mode: Some("deterministic".to_string()),
            model: None,
            provider: None,
            cost_usd: None,
            harness: None,
        });
        return Err(error);
    };

    let run_id = run_id_from_records(&records, &fallback_run_id);
    let agentic_enabled = observatory_agentic_reflection_enabled();
    let agentic_session_id = observatory_agentic_session_id(bot, started_at);
    let completed_at = chrono::Utc::now().timestamp().max(0) as u64;
    let result_records = if agentic_enabled {
        records_with_queued_agentic_reflection(records.clone(), &agentic_session_id)
    } else {
        records_with_agentic_reflection(records.clone(), None, None)
    };
    crate::workflow_compat::persist_workflow_run_record(WorkflowRunRecord {
        run_id: run_id.clone(),
        workflow_id,
        status: if agentic_enabled {
            WorkflowRunStatus::Running
        } else {
            WorkflowRunStatus::Completed
        },
        started_at,
        completed_at: (!agentic_enabled).then_some(completed_at),
        session_id: agentic_enabled.then_some(agentic_session_id.clone()),
        trace_id: records
            .get("records_written")
            .and_then(|written| written.get("reflection_run_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        duration_ms: completed_at.saturating_sub(started_at).saturating_mul(1000),
        input_tokens: 0,
        output_tokens: 0,
        result: Some(truncate_result(&result_records)),
        error: None,
        loop_mode: Some(if agentic_enabled {
            "agentic".to_string()
        } else {
            "deterministic".to_string()
        }),
        model: None,
        provider: None,
        cost_usd: None,
        // The queued agentic reflection runs through the bot's selected
        // harness; the deterministic tool pass involves no agent CLI.
        harness: agentic_enabled
            .then(|| crate::harness::agent_harness_for_bot(&bot.strategy_config)),
    })
    .map_err(|e| format!("persist observatory run history: {e}"))?;

    if agentic_enabled {
        let target = SidecarChatTarget {
            sandbox_id: sandbox.id.clone(),
            sidecar_url: sandbox.sidecar_url.clone(),
            sidecar_token: sandbox.token.clone(),
        };
        let prompt = observatory_agentic_reflection_prompt(bot, &run_id, &records);
        let bot_id = bot.id.clone();
        let run_id_for_task = run_id.clone();
        let records_for_task = records.clone();
        let session_id_for_task = agentic_session_id.clone();
        let agent_harness_for_task = crate::harness::agent_harness_for_bot(&bot.strategy_config);
        tokio::spawn(async move {
            let agentic_result = crate::operator_chat::run_bounded_agentic_exec_turn(
                target,
                AgenticChatTurnOptions {
                    session_id: session_id_for_task.clone(),
                    message: prompt,
                    user_metadata: json!({
                        "transport": "observatory",
                        "source": trigger.clone(),
                        "requested_by": requested_by.clone(),
                        "bot_id": bot_id.clone(),
                        "run_id": run_id_for_task.clone(),
                    }),
                    assistant_metadata: json!({
                        "transport": "model/direct",
                        "surface": "observatory",
                        "operation": "read-only-reflection",
                        "bot_id": bot_id.clone(),
                        "run_id": run_id_for_task.clone(),
                    }),
                    timeout_ms: observatory_agentic_reflection_timeout_ms(),
                    surface: "observatory".to_string(),
                    operation: "read-only-reflection".to_string(),
                    bot_id: Some(bot_id.clone()),
                    run_id: Some(run_id_for_task.clone()),
                },
            )
            .await;
            let completed_at = chrono::Utc::now().timestamp().max(0) as u64;
            let (agentic, error) = match agentic_result {
                Ok(agentic) => (Some(agentic), None),
                Err(error) => {
                    tracing::warn!(
                        bot_id = %bot_id,
                        run_id = %run_id_for_task,
                        "observatory agentic reflection failed: {error}"
                    );
                    (None, Some(error))
                }
            };
            let result_records = records_with_agentic_reflection(
                records_for_task,
                agentic.as_ref(),
                error.as_deref(),
            );
            if let Some(agentic) = agentic.as_ref() {
                if let Err(error) = crate::workflow_compat::persist_workflow_run_transcript(
                    WorkflowRunTranscriptRecord {
                        run_id: run_id_for_task.clone(),
                        session_id: agentic.session_id.clone(),
                        captured_at: completed_at,
                        messages: agentic.messages.clone(),
                    },
                ) {
                    tracing::warn!(
                        bot_id = %bot_id,
                        run_id = %run_id_for_task,
                        "persist observatory run transcript failed: {error}"
                    );
                }
            }
            if let Err(error) =
                crate::workflow_compat::persist_workflow_run_record(WorkflowRunRecord {
                    run_id: run_id_for_task.clone(),
                    workflow_id,
                    status: WorkflowRunStatus::Completed,
                    started_at,
                    completed_at: Some(completed_at),
                    session_id: Some(session_id_for_task),
                    trace_id: agentic
                        .as_ref()
                        .and_then(|agentic| agentic.trace_id.clone())
                        .or_else(|| {
                            result_records
                                .get("records_written")
                                .and_then(|written| written.get("reflection_run_id"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        }),
                    duration_ms: completed_at.saturating_sub(started_at).saturating_mul(1000),
                    input_tokens: agentic
                        .as_ref()
                        .map(|agentic| agentic.input_tokens)
                        .unwrap_or(0),
                    output_tokens: agentic
                        .as_ref()
                        .map(|agentic| agentic.output_tokens)
                        .unwrap_or(0),
                    result: Some(truncate_result(&result_records)),
                    error: None,
                    loop_mode: Some("agentic".to_string()),
                    model: agentic
                        .as_ref()
                        .and_then(|agentic| usage_event_string(&agentic.usage_event, "model")),
                    provider: agentic
                        .as_ref()
                        .and_then(|agentic| usage_event_string(&agentic.usage_event, "provider")),
                    cost_usd: agentic.as_ref().and_then(|agentic| agentic.cost_usd),
                    harness: Some(agent_harness_for_task.clone()),
                })
            {
                tracing::warn!(
                    bot_id = %bot_id,
                    run_id = %run_id_for_task,
                    "persist observatory completed run history failed: {error}"
                );
            }
        });
    }

    Ok(ObservatoryRunResult {
        bot_id: bot.id.clone(),
        run_id,
        started_at,
        completed_at,
        workflow_id: Some(workflow_id),
        records: result_records,
    })
}

pub async fn run_observatory_cadence(all_bots: &[TradingBotRecord]) {
    let now = chrono::Utc::now().timestamp();
    let day_key = utc_day_key(now);
    let interval = env_i64("OBSERVATORY_INTERVAL_SECS", DEFAULT_INTERVAL_SECS);
    let max_jitter_secs = env_i64("OBSERVATORY_JITTER_SECS", DEFAULT_JITTER_SECS);
    let max_bots = env_usize("OBSERVATORY_MAX_BOTS_PER_TICK", DEFAULT_MAX_BOTS_PER_TICK);
    let max_runs_per_bot_per_day = env_usize(
        "OBSERVATORY_MAX_RUNS_PER_BOT_PER_DAY",
        DEFAULT_MAX_RUNS_PER_BOT_PER_DAY,
    );
    let max_cost_per_bot_per_day = env_f64(
        "OBSERVATORY_MAX_COST_USD_PER_BOT_PER_DAY",
        DEFAULT_MAX_COST_USD_PER_BOT_PER_DAY,
    );
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
        let day_changed = align_cadence_day(&mut record, &day_key);
        if record.runs_today >= max_runs_per_bot_per_day {
            if day_changed {
                if let Err(error) = save_cadence_record(record.clone()) {
                    tracing::warn!(bot_id = %bot.id, "observatory cadence day reset persist error: {error}");
                }
            }
            tracing::debug!(
                bot_id = %bot.id,
                runs_today = record.runs_today,
                max_runs_per_bot_per_day,
                "observatory cadence skipped by daily run cap"
            );
            continue;
        }
        if max_cost_per_bot_per_day > 0.0 && record.cost_today_usd >= max_cost_per_bot_per_day {
            if day_changed {
                if let Err(error) = save_cadence_record(record.clone()) {
                    tracing::warn!(bot_id = %bot.id, "observatory cadence day reset persist error: {error}");
                }
            }
            tracing::debug!(
                bot_id = %bot.id,
                cost_today_usd = record.cost_today_usd,
                max_cost_per_bot_per_day,
                "observatory cadence skipped by daily cost cap"
            );
            continue;
        }
        let jitter_secs = deterministic_jitter_secs(&bot.id, &day_key, max_jitter_secs);
        record.last_jitter_secs = Some(jitter_secs);
        if !due(record.last_run_at, now, interval, jitter_secs) {
            if day_changed {
                if let Err(error) = save_cadence_record(record) {
                    tracing::warn!(bot_id = %bot.id, "observatory cadence day reset persist error: {error}");
                }
            }
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
                record.runs_today = record.runs_today.saturating_add(1);
                record.cost_today_usd =
                    (record.cost_today_usd + observatory_run_cost_usd(&result.records)).max(0.0);
                started += 1;
                if let Err(error) = save_cadence_record(record) {
                    tracing::warn!(bot_id = %bot.id, "observatory cadence persist error: {error}");
                }
                tracing::info!(
                    bot_id = %bot.id,
                    run_id = %result.run_id,
                    jitter_secs,
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
    let script_result = serde_json::from_str::<Value>(response.stdout.trim()).unwrap_or_else(
        |_| json!({ "ok": true, "parse_warning": "feedback script stdout was not JSON" }),
    );
    Ok(json!({
        "feedback": entry,
        "delegated_work_session": script_result.get("delegated_work_session").cloned().unwrap_or(Value::Null),
        "dispatch": script_result.get("dispatch").cloned().unwrap_or(Value::Null),
    }))
}

fn uuid_like(value: &Value) -> String {
    let _ = value;
    uuid::Uuid::new_v4().simple().to_string()[..18].to_string()
}

fn read_observatory_records_command() -> &'static str {
    r#"node - <<'NODE'
const fs = require('fs');
const os = require('os');
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
function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
function dedupeBySessionId(sessions, limit = 100) {
  const byId = new Map();
  for (const session of sessions) {
    const sessionId = session && typeof session === 'object' ? session.session_id : null;
    if (!sessionId) continue;
    const existing = byId.get(sessionId);
    if (!existing || timestampMs(session.created_at) >= timestampMs(existing.created_at)) {
      byId.set(sessionId, session);
    }
  }
  return [...byId.values()]
    .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))
    .slice(0, limit);
}
function semanticIdeaKey(idea) {
  if (!idea || typeof idea !== 'object') return null;
  const botId = String(idea.bot_id || '');
  const proposedAction = String(idea.proposed_action || '');
  const thesis = String(idea.thesis || idea.title || '').trim().toLowerCase();
  if (!botId || !thesis) return null;
  return `semantic:${botId}:${proposedAction}:${thesis}`;
}
function dedupeByIdeaKey(ideas, limit = 100) {
  const byKey = new Map();
  for (const idea of ideas) {
    if (!idea || typeof idea !== 'object') continue;
    const keys = [
      idea.dedupe_key,
      semanticIdeaKey(idea),
      idea.idea_id ? `id:${idea.idea_id}` : null,
    ].filter(Boolean);
    if (keys.length === 0) continue;
    let existing = null;
    for (const key of keys) {
      if (byKey.has(key)) {
        existing = byKey.get(key);
        break;
      }
    }
    const candidateAt = timestampMs(idea.updated_at || idea.created_at);
    const existingAt = timestampMs(existing?.updated_at || existing?.created_at);
    const winner = !existing || candidateAt >= existingAt ? idea : existing;
    for (const key of keys) byKey.set(key, winner);
  }
  const seen = new Set();
  return [...byKey.values()]
    .filter((idea) => {
      const id = idea.idea_id || semanticIdeaKey(idea);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => timestampMs(b.updated_at || b.created_at) - timestampMs(a.updated_at || a.created_at))
    .slice(0, limit);
}
function activeDelegationStatus(status) {
  return /dispatch|queued|running|pending|await|open/i.test(String(status || ''));
}
function terminalDelegationStatus(status) {
  return /complete|pass|done|blocked|failed|error|reject|cancel/i.test(String(status || ''));
}
const DEFAULT_ACTIVE_DISPATCH_TTL_SECS = 30 * 60;
function staleDispatchMarker(session, nowMs, ttlMs) {
  if (!activeDelegationStatus(session && session.status)) return false;
  const status = String(session.status || '').toLowerCase();
  const source = String(session.source || '').toLowerCase();
  if (status !== 'dispatched' && source !== 'improvement-dispatch') return false;
  const createdMs = timestampMs(session.created_at);
  return createdMs > 0 && nowMs - createdMs > ttlMs;
}
function activeDelegationSessions(sessions, nowMs = Date.now(), dispatchTtlMs = DEFAULT_ACTIVE_DISPATCH_TTL_SECS * 1000) {
  return sessions.filter((session) =>
    activeDelegationStatus(session.status) && !staleDispatchMarker(session, nowMs, dispatchTtlMs)
  );
}
function delegationPressure(sessions, usage = {}) {
  const unique = dedupeBySessionId(sessions, 500);
  const activeDispatchTtlSecs = Number.isFinite(Number(process.env.OBSERVATORY_ACTIVE_DISPATCH_TTL_SECS))
    ? Number(process.env.OBSERVATORY_ACTIVE_DISPATCH_TTL_SECS)
    : DEFAULT_ACTIVE_DISPATCH_TTL_SECS;
  const activeDispatchTtlMs = Math.max(1, activeDispatchTtlSecs) * 1000;
  const nowMs = Date.now();
  const active = activeDelegationSessions(unique, nowMs, activeDispatchTtlMs);
  const staleActive = unique.filter((session) => staleDispatchMarker(session, nowMs, activeDispatchTtlMs));
  const terminal = unique.filter((session) => terminalDelegationStatus(session.status));
  const byStatus = {};
  const bySource = {};
  for (const session of unique) {
    const status = String(session.status || 'unknown');
    const source = String(session.source || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
  }
  const load1 = os.loadavg()[0] || 0;
  const cpuCount = os.cpus().length || 1;
  const cpuPressure = Number((load1 / cpuCount).toFixed(3));
  const maxActiveDelegations = Number.isFinite(Number(process.env.OBSERVATORY_MAX_ACTIVE_DELEGATIONS))
    ? Number(process.env.OBSERVATORY_MAX_ACTIVE_DELEGATIONS)
    : 3;
  const maxCpuPressure = Number.isFinite(Number(process.env.OBSERVATORY_MAX_CPU_PRESSURE))
    ? Number(process.env.OBSERVATORY_MAX_CPU_PRESSURE)
    : 0.85;
  const minFreeMemoryMb = Number.isFinite(Number(process.env.OBSERVATORY_MIN_FREE_MEMORY_MB))
    ? Number(process.env.OBSERVATORY_MIN_FREE_MEMORY_MB)
    : 512;
  const memoryFreeMb = Math.round(os.freemem() / 1024 / 1024);
  const memoryTotalMb = Math.round(os.totalmem() / 1024 / 1024);
  const denyReasons = [];
  if (active.length >= maxActiveDelegations) denyReasons.push('active_delegation_cap');
  if (cpuPressure >= maxCpuPressure) denyReasons.push('cpu_pressure_cap');
  if (memoryFreeMb < minFreeMemoryMb) denyReasons.push('memory_floor');
  const mediumActiveThreshold = Math.max(2, Math.ceil(maxActiveDelegations * 0.67));
  return {
    unique_sessions: unique.length,
    active_sessions: active.length,
    stale_active_sessions: staleActive.length,
    terminal_sessions: terminal.length,
    duplicate_rows_removed: Math.max(0, sessions.length - unique.length),
    by_status: byStatus,
    by_source: bySource,
    usage_reporting_status: usage.reporting_status || 'not_applicable',
    usage_event_count: Number(usage.event_count || 0),
    total_tokens: Number(usage.total_tokens || 0),
    cost_usd: Number(usage.cost_usd || 0),
    system: {
      load_1m: Number(load1.toFixed(3)),
      cpu_count: cpuCount,
      cpu_pressure: cpuPressure,
      memory_free_mb: memoryFreeMb,
      memory_total_mb: memoryTotalMb,
    },
    limits: {
      max_active_delegations: maxActiveDelegations,
      max_cpu_pressure: maxCpuPressure,
      min_free_memory_mb: minFreeMemoryMb,
      active_dispatch_ttl_secs: activeDispatchTtlSecs,
    },
    pressure_level: denyReasons.length > 0 ? 'high' : active.length >= mediumActiveThreshold || cpuPressure >= Math.max(0.5, maxCpuPressure * 0.7) ? 'medium' : 'low',
    allows_new_delegation: denyReasons.length === 0,
    deny_reasons: denyReasons,
  };
}
const root = '/home/agent/memory/observatory';
const reflectionRuns = parseJsonl(read(`${root}/reflection-runs.jsonl`), 100);
const rawDelegatedWorkSessions = parseJsonl(read(`${root}/delegated-work-sessions.jsonl`), 500);
const delegatedWorkSessions = dedupeBySessionId(rawDelegatedWorkSessions, 100);
const ideas = dedupeByIdeaKey(parseJsonl(read(`${root}/ideas.jsonl`), 500), 100);
const latestReflection = reflectionRuns
  .slice()
  .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))[0] || null;
const pressure = delegationPressure(rawDelegatedWorkSessions, latestReflection?.usage_summary);
const payload = {
  schema_version: 1,
  world_signal_digests: parseJsonl(read(`${root}/world-signal-digests.jsonl`), 100),
  reflection_runs: reflectionRuns,
  ideas,
  research_tasks: parseJsonl(read(`${root}/research-tasks.jsonl`), 100),
  delegated_work_sessions: delegatedWorkSessions,
  owner_feedback: parseJsonl(read(`${root}/owner-feedback.jsonl`), 100),
  delegation_pressure: pressure,
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
const researchTasksFile = `${root}/research-tasks.jsonl`;
const delegatedFile = `${root}/delegated-work-sessions.jsonl`;
const maxActiveDelegations = Number(process.env.OBSERVATORY_MAX_ACTIVE_DELEGATIONS || 3);

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
function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
function dedupeBySessionId(sessions, limit = 500) {
  const byId = new Map();
  for (const session of sessions) {
    const sessionId = session && typeof session === 'object' ? session.session_id : null;
    if (!sessionId) continue;
    const existing = byId.get(sessionId);
    if (!existing || timestampMs(session.created_at) >= timestampMs(existing.created_at)) {
      byId.set(sessionId, session);
    }
  }
  return [...byId.values()]
    .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))
    .slice(0, limit);
}
function sha(value, len = 18) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, len);
}
function activeDelegationStatus(status) {
  return /dispatch|queued|running|pending|await|open/i.test(String(status || ''));
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
function researchTaskPrompt(idea) {
  return `Research-only Observatory task for bot ${entry.bot_id}.

Idea: ${idea?.title || entry.idea_id}
Thesis: ${idea?.thesis || 'No idea thesis recorded.'}
Expected value: ${idea?.expected_value || 'Improve the bot world model before any behavior change.'}

Answer these questions:
1. What external market, protocol, venue, news, liquidity, funding, or on-chain signals would change this bot's next decision?
2. Which sources should be checked, and which are unavailable or stale?
3. What is the smallest actionable finding the bot should carry into its next reflection or paper-only strategy change?

Constraints:
- Read-only research. Do not execute trades, mutate live config, promote candidates, or touch funds.
- Prefer compact source-grounded findings over broad summaries.
- Return uncertainty explicitly when source coverage is weak.
- Persist the result under /home/agent/memory/observatory/research-results.jsonl when a worker processes this task.`;
}
function createResearchTask(idea) {
  const taskId = `research_${sha({
    feedback_id: entry.feedback_id,
    idea_id: entry.idea_id,
    bot_id: entry.bot_id,
    created_at: entry.created_at,
  }, 20)}`;
  const task = {
    task_id: taskId,
    bot_id: entry.bot_id,
    idea_id: entry.idea_id,
    feedback_id: entry.feedback_id || null,
    owner: entry.owner || null,
    created_at: entry.created_at,
    updated_at: entry.created_at,
    status: 'queued_research',
    worker: 'observatory-research-queue',
    worker_launch: 'manual_or_research_tick',
    title: idea?.title || `Research ${entry.idea_id}`,
    thesis: idea?.thesis || null,
    evidence_refs: Array.isArray(idea?.evidence_refs) ? idea.evidence_refs : [],
    prompt: researchTaskPrompt(idea),
    acceptance_criteria: [
      'Source-grounded finding or explicit unavailable-source reason is recorded.',
      'Result is read-only and does not mutate trading, promotion, or live config.',
      'Next action is small enough for owner review or paper-only self-improvement.',
    ],
    safety_limits: {
      can_touch_funds: false,
      can_trade: false,
      can_promote: false,
      max_parallel_research_delegations: maxActiveDelegations,
    },
    result_ref: null,
    result_summary: null,
  };
  appendJsonl(researchTasksFile, task);
  return {
    ok: true,
    task_id: taskId,
    status: 'queued_research',
    artifact_ref: `artifact://observatory/research-tasks#${taskId}`,
    task,
  };
}

appendJsonl(feedbackFile, entry);

const action = String(entry.action || '');
const idea = parseJsonl(ideasFile).reverse().find((item) => item.idea_id === entry.idea_id) || null;
const existingDelegations = dedupeBySessionId(parseJsonl(delegatedFile));
const activeDelegations = existingDelegations.filter((item) => activeDelegationStatus(item.status));
const existingActiveForIdea = activeDelegations.find((item) => item.idea_id === entry.idea_id);
let delegated = null;
let dispatch = null;
if (action === 'delegate_research' || action === 'delegate_build') {
  if (existingActiveForIdea) {
    delegated = {
      ...existingActiveForIdea,
      status: existingActiveForIdea.status || 'already_active',
      pressure_guard: 'existing_active_for_idea',
    };
    dispatch = {
      ok: true,
      status: 'already_active',
      task_id: existingActiveForIdea.task_id || null,
    };
  } else if (activeDelegations.length >= maxActiveDelegations) {
    delegated = {
      session_id: `owner_delegate_pressure_${sha({ feedback_id: entry.feedback_id, idea_id: entry.idea_id, action })}`,
      bot_id: entry.bot_id,
      source: 'owner-feedback:pressure-guard',
      status: 'pressure_blocked',
      created_at: entry.created_at,
      idea_id: entry.idea_id,
      task_id: null,
      summary: `Delegation blocked because ${activeDelegations.length} active delegation(s) already exist for this bot.`,
      artifact_ref: `artifact://observatory/ideas#${entry.idea_id}`,
      pressure_guard: 'max_active_delegations',
      active_delegation_count: activeDelegations.length,
      max_active_delegations: maxActiveDelegations,
    };
    appendJsonl(delegatedFile, delegated);
  } else {
    if (action === 'delegate_build') {
      dispatch = dispatchBuildTask(idea);
    } else {
      dispatch = createResearchTask(idea);
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
        : `Owner queued read-only research for ${idea?.title || entry.idea_id}.`,
      artifact_ref: dispatch?.task_id
        ? action === 'delegate_build'
          ? `artifact://mcp-self-improvement/tasks/${dispatch.task_id}.json`
          : dispatch.artifact_ref
        : `artifact://observatory/ideas#${entry.idea_id}`,
      dispatch_error: dispatch && !dispatch.ok ? dispatch.error : null,
    };
    appendJsonl(delegatedFile, delegated);
  }
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
    fn observatory_workflow_uses_dedicated_slot() {
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

        assert_eq!(observatory_workflow_id(&bot), 13);
    }

    #[test]
    fn scheduler_jitter_is_stable_and_bounded() {
        let first = deterministic_jitter_secs("bot-1", "2026-06-04", 900);
        let second = deterministic_jitter_secs("bot-1", "2026-06-04", 900);
        assert_eq!(first, second);
        assert!((0..=900).contains(&first));
        assert_eq!(deterministic_jitter_secs("bot-1", "2026-06-04", 0), 0);
    }

    #[test]
    fn observatory_workflow_id_falls_back_for_sandbox_only_bots() {
        let mut bot = TradingBotRecord {
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
            workflow_id: None,
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
        let first = observatory_workflow_id(&bot);
        let second = observatory_workflow_id(&bot);
        assert_eq!(first, second);
        assert_ne!(first, 0);

        bot.workflow_id = Some(10);
        assert_eq!(observatory_workflow_id(&bot), 13);
    }

    #[test]
    fn due_respects_interval_plus_jitter() {
        assert!(due(None, 1_000, 3_600, 900));
        assert!(!due(Some(1_000), 4_599, 3_600, 0));
        assert!(due(Some(1_000), 4_600, 3_600, 0));
        assert!(!due(Some(1_000), 5_499, 3_600, 900));
        assert!(due(Some(1_000), 5_500, 3_600, 900));
    }

    #[test]
    fn cadence_record_resets_daily_counters() {
        let mut record = ObservatoryCadenceRecord {
            bot_id: "bot-1".to_string(),
            last_run_at: Some(1),
            day_key: Some("2026-06-03".to_string()),
            runs_today: 4,
            cost_today_usd: 0.25,
            last_jitter_secs: Some(11),
        };
        assert!(align_cadence_day(&mut record, "2026-06-04"));
        assert_eq!(record.day_key.as_deref(), Some("2026-06-04"));
        assert_eq!(record.runs_today, 0);
        assert_eq!(record.cost_today_usd, 0.0);
        assert_eq!(record.last_jitter_secs, None);
        assert!(!align_cadence_day(&mut record, "2026-06-04"));
    }

    #[test]
    fn observatory_cost_is_extracted_from_current_run_payload() {
        let top_level = json!({
            "records": {
                "usage_summary": { "cost_usd": 0.0123 },
                "reflection_runs": [
                    { "usage_summary": { "cost_usd": 9.0 } }
                ]
            }
        });
        assert_eq!(observatory_run_cost_usd(&top_level), 0.0123);

        let nested = json!({
            "records": {
                "reflection_runs": [
                    { "usage_summary": { "cost_usd": 0.0456 } }
                ]
            }
        });
        assert_eq!(observatory_run_cost_usd(&nested), 0.0456);

        let with_agentic = json!({
            "records": {
                "usage_summary": { "cost_usd": 0.01 }
            },
            "agentic_reflection": {
                "cost_usd": 0.02
            }
        });
        assert!((observatory_run_cost_usd(&with_agentic) - 0.03).abs() < f64::EPSILON);
    }

    #[test]
    fn agentic_reflection_prompt_is_read_only_and_evidence_grounded() {
        let bot = TradingBotRecord {
            id: "bot_1".to_string(),
            name: "Bot".to_string(),
            sandbox_id: "sandbox".to_string(),
            vault_address: String::new(),
            share_token: String::new(),
            strategy_type: "dex".to_string(),
            strategy_config: Value::Null,
            risk_params: Value::Null,
            chain_id: 8453,
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
        let prompt = observatory_agentic_reflection_prompt(
            &bot,
            "obs-1",
            &json!({
                "records": {
                    "reflection_runs": [{}],
                    "world_signal_digests": [{}],
                    "ideas": [{}],
                    "delegated_work_sessions": [{}],
                    "research_tasks": [{}],
                    "delegation_pressure": { "pressure_level": "low" }
                }
            }),
        );

        assert!(prompt.contains("Do not trade."));
        assert!(prompt.contains("Do not mutate live config."));
        assert!(prompt.contains("Do not create delegated work"));
        assert!(prompt.contains("/home/agent/memory/observatory/reflection-runs.jsonl"));
        assert!(prompt.contains("Return exactly four compact sections"));
        assert!(prompt.contains("delegation_pressure: low"));
    }

    #[test]
    fn reader_script_uses_framed_json_markers() {
        assert!(read_observatory_records_command().contains("TANGLE' + '_OBSERVATORY_JSON>"));
        assert!(read_observatory_records_command().contains("reflection-runs.jsonl"));
        assert!(read_observatory_records_command().contains("owner-feedback.jsonl"));
        assert!(read_observatory_records_command().contains("research-tasks.jsonl"));
        assert!(read_observatory_records_command().contains("dedupeBySessionId"));
        assert!(read_observatory_records_command().contains("delegation_pressure"));
        assert!(read_observatory_records_command().contains("allows_new_delegation"));
        assert!(read_observatory_records_command().contains("active_delegation_cap"));
    }

    #[test]
    fn feedback_script_dispatches_delegate_build_and_records_research_tasks() {
        let script = append_observatory_feedback_command();
        assert!(script.contains("self_improvement.create_task"));
        assert!(script.contains("delegate_build"));
        assert!(script.contains("research-tasks.jsonl"));
        assert!(script.contains("createResearchTask"));
        assert!(script.contains("queued read-only research"));
        assert!(script.contains("delegated-work-sessions.jsonl"));
        assert!(script.contains("paper-only delegated build"));
        assert!(script.contains("OBSERVATORY_MAX_ACTIVE_DELEGATIONS"));
        assert!(script.contains("pressure_blocked"));
    }

    #[test]
    fn feedback_syncs_self_improvement_pressure_probe_dependency() {
        let source = include_str!("observatory_cadence.rs");
        assert!(source.contains("/home/agent/tools/self-improvement-loop.ts"));
        assert!(source.contains("/home/agent/tools/observatory-pressure.js"));
        assert!(source.contains("observatory_pressure.js"));
        assert!(source.contains("run_bounded_agentic_exec_turn"));
        assert!(source.contains("persist_workflow_run_transcript"));
    }
}
