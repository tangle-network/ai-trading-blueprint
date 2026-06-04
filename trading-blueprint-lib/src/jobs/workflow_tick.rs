//! Trading-aware workflow tick that intercepts the cron tick to detect
//! TTL wind-down conditions and swap the agent prompt accordingly.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

use crate::JsonResponse;
use crate::state::{bot_key, bots};
use crate::wind_down::should_initiate_wind_down;

use crate::prompts::tick_tool_for_strategy;
use ai_agent_sandbox_blueprint_lib::workflows::{
    WorkflowEntry, WorkflowLatestExecution, workflow_key, workflows,
};
use ai_agent_sandbox_blueprint_lib::{SandboxExecRequest, run_exec_request};
use blueprint_sdk::tangle::extract::TangleResult;
use futures_util::{StreamExt, stream};

fn workflow_group_ids(workflow_id: u64) -> [u64; 3] {
    [
        workflow_id,
        workflow_id.saturating_add(1),
        workflow_id.saturating_add(2),
    ]
}

fn workflow_name_belongs_to_bot(name: &str, bot_id: &str) -> bool {
    [
        format!("fast-tick-{bot_id}"),
        format!("research-tick-{bot_id}"),
        format!("conversation-tick-{bot_id}"),
        format!("trading-loop-{bot_id}"),
    ]
    .iter()
    .any(|expected| name == expected)
}

fn workflow_bot_id(name: &str) -> Option<&str> {
    [
        "fast-tick-",
        "research-tick-",
        "conversation-tick-",
        "trading-loop-",
    ]
    .into_iter()
    .find_map(|prefix| name.strip_prefix(prefix))
}

fn workflow_is_current_for_bot(
    workflow: &ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry,
    bot: &crate::state::TradingBotRecord,
) -> bool {
    bot.workflow_id
        .map(workflow_group_ids)
        .is_some_and(|ids| ids.contains(&workflow.id))
}

fn disable_stale_bot_workflows(all_bots: &[crate::state::TradingBotRecord]) -> Result<(), String> {
    let store = workflows()?;
    let all_workflows = store.values().map_err(|e| e.to_string())?;
    let bots_by_id: HashMap<&str, &crate::state::TradingBotRecord> =
        all_bots.iter().map(|bot| (bot.id.as_str(), bot)).collect();

    for workflow in all_workflows {
        let Some(bot_id) = workflow_bot_id(&workflow.name) else {
            continue;
        };
        let Some(bot) = bots_by_id.get(bot_id).copied() else {
            continue;
        };
        if !bot.trading_active || workflow_is_current_for_bot(&workflow, bot) {
            continue;
        }
        if !workflow.active && workflow.next_run_at.is_none() {
            continue;
        }

        let key = workflow_key(workflow.id);
        store
            .update(&key, |entry| {
                entry.active = false;
                entry.next_run_at = None;
            })
            .map_err(|e| {
                format!(
                    "Failed to disable stale workflow {} for bot {}: {e}",
                    workflow.id, bot.id
                )
            })?;
        tracing::info!(
            workflow_id = workflow.id,
            bot_id = %bot.id,
            current_workflow_id = ?bot.workflow_id,
            "Disabled stale duplicate workflow for active bot"
        );
    }

    Ok(())
}

fn disable_stopped_bot_workflows(
    all_bots: &[crate::state::TradingBotRecord],
) -> Result<(), String> {
    let store = workflows()?;
    let all_workflows = store.values().map_err(|e| e.to_string())?;

    for bot in all_bots.iter().filter(|bot| !bot.trading_active) {
        let group_ids = bot.workflow_id.map(workflow_group_ids);
        for workflow in &all_workflows {
            let belongs_to_bot = group_ids.is_some_and(|ids| ids.contains(&workflow.id))
                || workflow_name_belongs_to_bot(&workflow.name, &bot.id);

            if !belongs_to_bot || (!workflow.active && workflow.next_run_at.is_none()) {
                continue;
            }

            let key = workflow_key(workflow.id);
            store
                .update(&key, |entry| {
                    entry.active = false;
                    entry.next_run_at = None;
                })
                .map_err(|e| {
                    format!(
                        "Failed to disable workflow {} for stopped bot {}: {e}",
                        workflow.id, bot.id
                    )
                })?;
            tracing::info!(
                workflow_id = workflow.id,
                bot_id = %bot.id,
                "Disabled workflow for stopped bot before scheduler tick"
            );
        }
    }

    Ok(())
}

fn backfill_active_bot_run_history(all_bots: &[crate::state::TradingBotRecord]) {
    for workflow_id in all_bots
        .iter()
        .filter(|bot| bot.trading_active)
        .filter_map(|bot| bot.workflow_id)
        .flat_map(workflow_group_ids)
    {
        if let Err(err) = crate::workflow_compat::backfill_latest_execution_run(workflow_id) {
            tracing::warn!(
                workflow_id,
                error = %err,
                "Failed to backfill workflow run history before tick"
            );
        }
    }
}

fn workflow_result_text(task: &Value, field: &str) -> Option<String> {
    task.get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn persist_executed_run_history(response: &Value) {
    let Some(executed) = response.get("executed").and_then(Value::as_array) else {
        return;
    };

    for entry in executed {
        let Some(workflow_id) = entry.get("workflowId").and_then(Value::as_u64) else {
            continue;
        };
        let executed_at = entry
            .get("executedAt")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp().max(0) as u64);
        let task = entry.get("task").unwrap_or(&Value::Null);
        let success = task.get("success").and_then(Value::as_bool).unwrap_or(true);
        let status = if success {
            crate::workflow_compat::WorkflowRunStatus::Completed
        } else {
            crate::workflow_compat::WorkflowRunStatus::Failed
        };
        let record = crate::workflow_compat::WorkflowRunRecord {
            run_id: format!("latest-{workflow_id}-{executed_at}"),
            workflow_id,
            status,
            started_at: executed_at,
            completed_at: Some(executed_at),
            session_id: workflow_result_text(task, "sessionId"),
            trace_id: workflow_result_text(task, "traceId"),
            duration_ms: task.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
            input_tokens: task.get("inputTokens").and_then(Value::as_u64).unwrap_or(0) as u32,
            output_tokens: task
                .get("outputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
            result: workflow_result_text(task, "result"),
            error: workflow_result_text(task, "error"),
        };

        if let Err(err) = crate::workflow_compat::persist_workflow_run_record(record) {
            tracing::warn!(
                workflow_id,
                error = %err,
                "Failed to persist workflow run history from workflow response"
            );
        }
    }
}

fn bot_for_executed_workflow<'a>(
    all_bots: &'a [crate::state::TradingBotRecord],
    workflow_id: u64,
    workflow_name: &str,
) -> Option<&'a crate::state::TradingBotRecord> {
    all_bots.iter().find(|bot| {
        bot.workflow_id == Some(workflow_id) || workflow_name_belongs_to_bot(workflow_name, &bot.id)
    })
}

fn set_task_failure(entry: &mut Value, reason: String) {
    if let Some(task) = entry.get_mut("task").and_then(Value::as_object_mut) {
        task.insert("success".to_string(), Value::Bool(false));
        task.insert("error".to_string(), Value::String(reason));
    }
}

fn workflow_timeout_ms(workflow_json: &str, default_timeout_ms: u64) -> u64 {
    serde_json::from_str::<Value>(workflow_json)
        .ok()
        .and_then(|workflow| workflow.get("timeout_ms").and_then(Value::as_u64))
        .unwrap_or(default_timeout_ms)
}

fn inner_workflow_tick_timeout() -> Duration {
    let timeout_ms = std::env::var("TRADING_INNER_WORKFLOW_TICK_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (5_000..=300_000).contains(value))
        .unwrap_or(30_000);
    Duration::from_millis(timeout_ms)
}

fn generic_workflow_tick_enabled_from_value(value: Option<&str>) -> bool {
    value
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(false)
}

fn generic_workflow_tick_enabled() -> bool {
    let value = std::env::var("TRADING_RUN_GENERIC_WORKFLOW_TICK").ok();
    generic_workflow_tick_enabled_from_value(value.as_deref())
}

fn workflow_is_due(
    entry: &ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry,
    now: u64,
) -> bool {
    entry.active
        && entry.trigger_type == "cron"
        && entry.next_run_at.is_some_and(|next_run| next_run <= now)
}

fn fast_tick_bot_and_tool_for_workflow<'a>(
    entry: &ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry,
    all_bots: &'a [crate::state::TradingBotRecord],
) -> Option<(&'a crate::state::TradingBotRecord, &'static str)> {
    if !entry.name.starts_with("fast-tick-") {
        return None;
    }
    all_bots.iter().find_map(|bot| {
        let belongs =
            bot.workflow_id == Some(entry.id) || workflow_name_belongs_to_bot(&entry.name, &bot.id);
        if !belongs {
            return None;
        }
        if !workflow_is_current_for_bot(entry, bot) {
            return None;
        }
        if !bot.trading_active || bot.wind_down_started_at.is_some() {
            return None;
        }
        tick_tool_for_strategy(&bot.strategy_type).map(|tool| (bot, tool))
    })
}

fn fast_tick_concurrency() -> usize {
    std::env::var("TRADING_FAST_TICK_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=128).contains(value))
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(8)
                .clamp(4, 32)
        })
}

fn fast_tick_task_result(
    bot: &crate::state::TradingBotRecord,
    started_at: u64,
    completed_at: u64,
    stdout: String,
    stderr: String,
    exit_code: u32,
    validation_error: Option<String>,
) -> Value {
    let duration_ms = completed_at.saturating_sub(started_at).saturating_mul(1000);
    let trimmed_stdout = stdout.trim().to_string();
    let trimmed_stderr = stderr.trim().to_string();
    let success = exit_code == 0 && validation_error.is_none();
    let error = validation_error.or_else(|| {
        (exit_code != 0).then(|| {
            if trimmed_stderr.is_empty() {
                format!("fast tick tool exited with {exit_code}")
            } else {
                format!("fast tick tool exited with {exit_code}: {trimmed_stderr}")
            }
        })
    });

    let mut task = json!({
        "success": success,
        "sessionId": format!("direct-fast-{}-{started_at}", bot.id),
        "traceId": Value::Null,
        "durationMs": duration_ms,
        "inputTokens": 0,
        "outputTokens": 0,
        "result": trimmed_stdout,
    });
    if let Some(error) = error {
        task["error"] = Value::String(error);
    }
    task
}

async fn run_direct_fast_tick(
    bot: &crate::state::TradingBotRecord,
    tool: &str,
    timeout_ms: u64,
) -> Value {
    let started_at = chrono::Utc::now().timestamp().max(0) as u64;
    let sandbox = match sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id) {
        Ok(sandbox) => sandbox,
        Err(err) => {
            let completed_at = chrono::Utc::now().timestamp().max(0) as u64;
            return fast_tick_task_result(
                bot,
                started_at,
                completed_at,
                String::new(),
                String::new(),
                1,
                Some(format!("sandbox lookup failed: {err}")),
            );
        }
    };

    if let Err(err) =
        sync_canonical_harness_to_sidecar(bot, &sandbox.sidecar_url, &sandbox.token).await
    {
        let completed_at = chrono::Utc::now().timestamp().max(0) as u64;
        return fast_tick_task_result(
            bot,
            started_at,
            completed_at,
            String::new(),
            String::new(),
            1,
            Some(format!("canonical harness sync failed: {err}")),
        );
    }
    if let Err(err) =
        sync_fast_tick_tools_to_sidecar(tool, &sandbox.sidecar_url, &sandbox.token).await
    {
        let completed_at = chrono::Utc::now().timestamp().max(0) as u64;
        return fast_tick_task_result(
            bot,
            started_at,
            completed_at,
            String::new(),
            String::new(),
            1,
            Some(format!("fast tick tool sync failed: {err}")),
        );
    }

    let exec = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: format!("node /home/agent/tools/{tool}"),
        cwd: String::new(),
        env_json: "{}".to_string(),
        timeout_ms,
    };
    let response = match run_exec_request(&exec, &sandbox.token).await {
        Ok(response) => response,
        Err(err) => {
            let completed_at = chrono::Utc::now().timestamp().max(0) as u64;
            return fast_tick_task_result(
                bot,
                started_at,
                completed_at,
                String::new(),
                String::new(),
                1,
                Some(format!("sidecar exec failed: {err}")),
            );
        }
    };
    let completed_at = chrono::Utc::now().timestamp().max(0) as u64;

    let validation_error = if response.exit_code == 0 {
        match serde_json::from_str::<Value>(response.stdout.trim()) {
            Ok(parsed) => {
                let valid_schema =
                    parsed.get("result_schema_version").and_then(Value::as_u64) == Some(1);
                let has_decision = parsed
                    .get("decision")
                    .and_then(|decision| decision.get("action"))
                    .and_then(Value::as_str)
                    .is_some();
                let reported_logs = parsed
                    .get("logs_written")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let reported_metrics = parsed
                    .get("metrics_written")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let reported_context = parsed
                    .get("decision_context_written")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let reported_reflection = parsed
                    .get("reflection_written")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if valid_schema
                    && has_decision
                    && reported_logs
                    && reported_metrics
                    && reported_context
                    && reported_reflection
                {
                    verify_tick_side_effects(bot, &parsed).await.err()
                } else {
                    Some(
                        "Direct fast tick JSON failed schema/decision/metrics/reflection flags"
                            .to_string(),
                    )
                }
            }
            Err(_) => Some("Direct fast tick result was not deterministic JSON".to_string()),
        }
    } else {
        None
    };

    fast_tick_task_result(
        bot,
        started_at,
        completed_at,
        response.stdout,
        response.stderr,
        response.exit_code,
        validation_error,
    )
}

#[derive(Clone, Debug)]
pub struct ManualFastTickResult {
    pub executed_at: u64,
    pub task: Value,
}

impl ManualFastTickResult {
    pub fn latest_execution(&self) -> WorkflowLatestExecution {
        WorkflowLatestExecution {
            executed_at: self.executed_at,
            success: self
                .task
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            result: workflow_result_text(&self.task, "result").unwrap_or_default(),
            error: workflow_result_text(&self.task, "error").unwrap_or_default(),
            trace_id: workflow_result_text(&self.task, "traceId").unwrap_or_default(),
            duration_ms: self
                .task
                .get("durationMs")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            input_tokens: self
                .task
                .get("inputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
            output_tokens: self
                .task
                .get("outputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
            session_id: workflow_result_text(&self.task, "sessionId").unwrap_or_default(),
        }
    }
}

/// Run the same deterministic fast-tick path used by the scheduler for a
/// manual control action. Returns `Ok(None)` for non-fast-tick workflows so
/// callers can fall back to the generic workflow runner.
pub async fn run_manual_fast_tick_for_workflow(
    bot: &crate::state::TradingBotRecord,
    entry: &WorkflowEntry,
) -> Result<Option<ManualFastTickResult>, String> {
    if !entry.name.starts_with("fast-tick-") {
        return Ok(None);
    }
    let belongs =
        bot.workflow_id == Some(entry.id) || workflow_name_belongs_to_bot(&entry.name, &bot.id);
    if !belongs {
        return Err(format!(
            "fast tick workflow {} does not belong to bot {}",
            entry.id, bot.id
        ));
    }
    if !workflow_is_current_for_bot(entry, bot) {
        return Err(format!(
            "fast tick workflow {} is stale for bot {}",
            entry.id, bot.id
        ));
    }
    if !bot.trading_active || bot.wind_down_started_at.is_some() {
        return Err(format!(
            "bot {} is not eligible for a manual fast tick",
            bot.id
        ));
    }

    let tool = tick_tool_for_strategy(&bot.strategy_type).ok_or_else(|| {
        format!(
            "strategy {} has no deterministic tick tool",
            bot.strategy_type
        )
    })?;
    let timeout_ms = workflow_timeout_ms(&entry.workflow_json, 180_000);
    tracing::info!(
        workflow_id = entry.id,
        bot_id = %bot.id,
        strategy = %bot.strategy_type,
        tool,
        "Running manual deterministic fast tick directly"
    );
    let task = run_direct_fast_tick(bot, tool, timeout_ms).await;
    let executed_at = chrono::Utc::now().timestamp().max(0) as u64;
    Ok(Some(ManualFastTickResult { executed_at, task }))
}

async fn sync_canonical_harness_to_sidecar(
    bot: &crate::state::TradingBotRecord,
    sidecar_url: &str,
    token: &str,
) -> Result<(), String> {
    let harness = if bot.harness_json.is_null() {
        serde_json::to_value(trading_runtime::backtest::HarnessConfig::default())
            .map_err(|err| format!("failed to build default harness: {err}"))?
    } else {
        bot.harness_json.clone()
    };
    let harness_json = serde_json::to_string_pretty(&harness)
        .map_err(|err| format!("failed to serialize canonical harness: {err}"))?;

    crate::jobs::activate::write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/config/canonical-harness.json",
        &harness_json,
    )
    .await?;
    crate::jobs::activate::write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/config/harness.json",
        &harness_json,
    )
    .await
}

fn fast_tick_tool_bundle(tool: &str) -> Option<Vec<(&'static str, &'static str)>> {
    let mut files = vec![
        (
            "/home/agent/tools/api-client.js",
            include_str!("../prompts/tools/api_client.js"),
        ),
        (
            "/home/agent/tools/log-decision.js",
            include_str!("../prompts/tools/log_decision.js"),
        ),
        (
            "/home/agent/tools/write-metrics.js",
            include_str!("../prompts/tools/write_metrics.js"),
        ),
        (
            "/home/agent/tools/reflection-loop.js",
            include_str!("../prompts/tools/reflection_loop.js"),
        ),
        (
            "/home/agent/tools/usage-telemetry.js",
            include_str!("../prompts/tools/usage_telemetry.js"),
        ),
        (
            "/home/agent/tools/self-improvement-loop.ts",
            include_str!("../prompts/tools/self_improvement_loop.ts"),
        ),
        (
            "/home/agent/tools/observatory-loop.js",
            include_str!("../prompts/tools/observatory_loop.js"),
        ),
        (
            "/home/agent/tools/observatory-pressure.js",
            include_str!("../prompts/tools/observatory_pressure.js"),
        ),
    ];

    match tool {
        "hyperliquid-tick.js" => files.push((
            "/home/agent/tools/hyperliquid-tick.js",
            include_str!("../prompts/tools/hyperliquid_tick.js"),
        )),
        "dex-tick.js" => {
            files.push((
                "/home/agent/tools/tick-common.js",
                include_str!("../prompts/tools/tick_common.js"),
            ));
            files.push((
                "/home/agent/tools/dex-tick.js",
                include_str!("../prompts/tools/dex_tick.js"),
            ));
        }
        "dex-mm-tick.js" => {
            files.push((
                "/home/agent/tools/tick-common.js",
                include_str!("../prompts/tools/tick_common.js"),
            ));
            files.push((
                "/home/agent/tools/tick-recipe-dsl.js",
                include_str!("../prompts/tools/tick_recipe_dsl.js"),
            ));
            files.push((
                "/home/agent/tools/dex-mm-tick.js",
                include_str!("../prompts/tools/dex_mm_tick.js"),
            ));
        }
        "yield-tick.js" => {
            files.push((
                "/home/agent/tools/tick-common.js",
                include_str!("../prompts/tools/tick_common.js"),
            ));
            files.push((
                "/home/agent/tools/yield-tick.js",
                include_str!("../prompts/tools/yield_tick.js"),
            ));
        }
        "multi-tick.js" => {
            files.push((
                "/home/agent/tools/tick-common.js",
                include_str!("../prompts/tools/tick_common.js"),
            ));
            files.push((
                "/home/agent/tools/multi-tick.js",
                include_str!("../prompts/tools/multi_tick.js"),
            ));
        }
        "volatility-tick.js" => {
            files.push((
                "/home/agent/tools/tick-common.js",
                include_str!("../prompts/tools/tick_common.js"),
            ));
            files.push((
                "/home/agent/tools/volatility-tick.js",
                include_str!("../prompts/tools/volatility_tick.js"),
            ));
        }
        "perp-tick.js" => {
            files.push((
                "/home/agent/tools/tick-common.js",
                include_str!("../prompts/tools/tick_common.js"),
            ));
            files.push((
                "/home/agent/tools/perp-tick.js",
                include_str!("../prompts/tools/perp_tick.js"),
            ));
        }
        _ => return None,
    }

    Some(files)
}

async fn sync_fast_tick_tools_to_sidecar(
    tool: &str,
    sidecar_url: &str,
    token: &str,
) -> Result<(), String> {
    let bundle = fast_tick_tool_bundle(tool)
        .ok_or_else(|| format!("unsupported deterministic tick tool: {tool}"))?;
    for (path, content) in bundle {
        crate::jobs::activate::write_file_to_sidecar(sidecar_url, token, path, content).await?;
    }
    Ok(())
}

async fn run_due_fast_ticks(
    all_bots: &[crate::state::TradingBotRecord],
) -> Result<Vec<Value>, String> {
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let store = workflows()?;
    let all_workflows = store.values().map_err(|e| e.to_string())?;
    let due: Vec<_> = all_workflows
        .into_iter()
        .filter(|entry| workflow_is_due(entry, now))
        .filter_map(|entry| {
            let (bot, tool) = fast_tick_bot_and_tool_for_workflow(&entry, all_bots)?;
            Some((entry, bot.clone(), tool.to_string()))
        })
        .collect();

    for (entry, _, _) in &due {
        let workflow_id = entry.id;
        let key = workflow_key(workflow_id);
        let next_run_at = ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run(
            &entry.trigger_type,
            &entry.trigger_config,
            Some(now),
        )
        .ok()
        .flatten();
        workflows()?
            .update(&key, |workflow| {
                workflow.next_run_at = next_run_at;
            })
            .map_err(|e| e.to_string())?;
    }

    let concurrency = fast_tick_concurrency();
    let mut executed = stream::iter(due)
        .map(|(entry, bot, tool)| async move {
            let workflow_id = entry.id;
            let next_run_at = ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run(
                &entry.trigger_type,
                &entry.trigger_config,
                Some(now),
            )
            .ok()
            .flatten();
            let timeout_ms = workflow_timeout_ms(&entry.workflow_json, 180_000);
            tracing::info!(
                workflow_id,
                bot_id = %bot.id,
                strategy = %bot.strategy_type,
                tool,
                "Running deterministic fast tick directly"
            );
            let task = run_direct_fast_tick(&bot, &tool, timeout_ms).await;
            let executed_at = chrono::Utc::now().timestamp().max(0) as u64;
            (entry, next_run_at, executed_at, task)
        })
        .buffer_unordered(concurrency)
        .collect::<Vec<_>>()
        .await;
    executed.sort_by_key(|(entry, _, _, _)| entry.id);

    let mut response = Vec::new();
    for (entry, next_run_at, executed_at, task) in executed {
        let workflow_id = entry.id;
        let key = workflow_key(workflow_id);
        workflows()?
            .update(&key, |workflow| {
                workflow.last_run_at = Some(executed_at);
                workflow.next_run_at = next_run_at;
            })
            .map_err(|e| e.to_string())?;

        response.push(json!({
            "workflowId": workflow_id,
            "name": entry.name,
            "executedAt": executed_at,
            "lastRunAt": executed_at,
            "nextRunAt": next_run_at,
            "task": task,
        }));
    }

    Ok(response)
}

/// Runtime anti-fabrication check, family-agnostic: confirms the tick actually
/// wrote fresh decisions/metrics plus the decision context and reflection that
/// close the behavior loop. A tick that narrates an action without producing
/// these side effects fails here.
async fn verify_tick_side_effects(
    bot: &crate::state::TradingBotRecord,
    result_json: &Value,
) -> Result<(), String> {
    let started_at = result_json
        .get("run_started_at")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing run_started_at".to_string())?;
    let expected_action = result_json
        .get("decision")
        .and_then(|decision| decision.get("action"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_reason = result_json
        .get("decision")
        .and_then(|decision| decision.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_context_id = result_json
        .get("decision_context")
        .and_then(|context| context.get("context_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_reflection_id = result_json
        .get("reflection")
        .and_then(|reflection| reflection.get("reflection_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|err| err.to_string())?;
    let command = r#"node - <<'NODE'
const fs = require('fs');
const started = Date.parse(process.env.EXPECTED_STARTED_AT || '');
const expectedAction = process.env.EXPECTED_ACTION || '';
const expectedReason = process.env.EXPECTED_REASON || '';
const expectedContextId = process.env.EXPECTED_CONTEXT_ID || '';
const expectedReflectionId = process.env.EXPECTED_REFLECTION_ID || '';

function readLastJsonl(path) {
  try {
    const lines = fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function actionOf(entry) {
  if (!entry) return '';
  if (typeof entry.action === 'string') return entry.action;
  if (entry.decision && typeof entry.decision.action === 'string') return entry.decision.action;
  return '';
}

function reasonOf(entry) {
  if (!entry) return '';
  if (typeof entry.reason === 'string') return entry.reason;
  if (entry.decision && typeof entry.decision.reason === 'string') return entry.decision.reason;
  return '';
}

const decision = readLastJsonl('/home/agent/logs/decisions.jsonl');
const metrics = readJson('/home/agent/metrics/latest.json');
const decisionContext = readLastJsonl('/home/agent/memory/decision-contexts.jsonl');
const reflection = readLastJsonl('/home/agent/memory/reflections.jsonl');
const decisionTs = decision && Date.parse(decision.timestamp || '');
const metricsTs = metrics && Date.parse(metrics.timestamp || '');
const contextTs = decisionContext && Date.parse(decisionContext.timestamp || '');
const reflectionTs = reflection && Date.parse(reflection.timestamp || '');
const decisionOk = Number.isFinite(started)
  && Number.isFinite(decisionTs)
  && decisionTs >= started
  && (!expectedAction || actionOf(decision) === expectedAction)
  && (!expectedReason || reasonOf(decision) === expectedReason);
const metricsOk = Number.isFinite(started)
  && Number.isFinite(metricsTs)
  && metricsTs >= started;
const contextOk = Number.isFinite(started)
  && Number.isFinite(contextTs)
  && contextTs >= started
  && (!expectedContextId || decisionContext.context_id === expectedContextId)
  && (!expectedAction || actionOf(decisionContext) === expectedAction)
  && (!expectedReason || reasonOf(decisionContext) === expectedReason);
const reflectionOk = Number.isFinite(started)
  && Number.isFinite(reflectionTs)
  && reflectionTs >= started
  && (!expectedReflectionId || reflection.reflection_id === expectedReflectionId)
  && decisionContext
  && reflection.decision_context_id === decisionContext.context_id;

console.log(JSON.stringify({
  decision_ok: decisionOk,
  metrics_ok: metricsOk,
  decision_context_ok: contextOk,
  reflection_ok: reflectionOk,
  decision_timestamp: decision && decision.timestamp,
  metrics_timestamp: metrics && metrics.timestamp,
  decision_context_timestamp: decisionContext && decisionContext.timestamp,
  reflection_timestamp: reflection && reflection.timestamp,
  decision_action: actionOf(decision),
  decision_reason: reasonOf(decision),
  decision_context_id: decisionContext && decisionContext.context_id,
  reflection_id: reflection && reflection.reflection_id,
  reflection_decision_context_id: reflection && reflection.decision_context_id,
}));

process.exit(decisionOk && metricsOk && contextOk && reflectionOk ? 0 : 2);
NODE"#;
    let env_json = json!({
        "EXPECTED_STARTED_AT": started_at,
        "EXPECTED_ACTION": expected_action,
        "EXPECTED_REASON": expected_reason,
        "EXPECTED_CONTEXT_ID": expected_context_id,
        "EXPECTED_REFLECTION_ID": expected_reflection_id,
    })
    .to_string();
    let exec = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: command.to_string(),
        cwd: String::new(),
        env_json,
        timeout_ms: 10_000,
    };
    let response = run_exec_request(&exec, &sandbox.token).await?;
    if response.exit_code == 0 {
        return Ok(());
    }
    Err(format!(
        "side effects missing or stale: stdout={} stderr={}",
        response.stdout.trim(),
        response.stderr.trim()
    ))
}

async fn validate_fast_runs(response: &mut Value, all_bots: &[crate::state::TradingBotRecord]) {
    let Some(executed) = response.get_mut("executed").and_then(Value::as_array_mut) else {
        return;
    };

    for entry in executed {
        let workflow_id = entry.get("workflowId").and_then(Value::as_u64).unwrap_or(0);
        let workflow_name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !workflow_name.starts_with("fast-tick-") {
            continue;
        }
        let Some(bot) = bot_for_executed_workflow(all_bots, workflow_id, workflow_name) else {
            continue;
        };
        if !bot.trading_active || bot.wind_down_started_at.is_some() {
            continue;
        }
        if tick_tool_for_strategy(&bot.strategy_type).is_none() {
            continue;
        }

        let task = entry.get("task").unwrap_or(&Value::Null);
        let already_failed_with_error = task.get("success").and_then(Value::as_bool) == Some(false)
            && task
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|error| !error.trim().is_empty());
        if already_failed_with_error {
            continue;
        }

        let result_text = task
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let parsed: Value = match serde_json::from_str(result_text) {
            Ok(parsed) => parsed,
            Err(_) => {
                set_task_failure(
                    entry,
                    "Fast tick result was not deterministic JSON".to_string(),
                );
                continue;
            }
        };

        let valid_schema = parsed.get("result_schema_version").and_then(Value::as_u64) == Some(1);
        let has_decision = parsed
            .get("decision")
            .and_then(|decision| decision.get("action"))
            .and_then(Value::as_str)
            .is_some();
        let reported_logs = parsed
            .get("logs_written")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let reported_metrics = parsed
            .get("metrics_written")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let reported_context = parsed
            .get("decision_context_written")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let reported_reflection = parsed
            .get("reflection_written")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if !valid_schema
            || !has_decision
            || !reported_logs
            || !reported_metrics
            || !reported_context
            || !reported_reflection
        {
            set_task_failure(
                entry,
                "Fast tick JSON failed schema/decision/metrics/reflection flags".to_string(),
            );
            continue;
        }

        if let Err(err) = verify_tick_side_effects(bot, &parsed).await {
            set_task_failure(entry, format!("Fast tick verification failed: {err}"));
        }
    }
}

/// Trading-aware workflow tick.
///
/// Before running the standard workflow tick, checks all active bots for
/// TTL wind-down eligibility. For bots that should start winding down:
/// 1. Records `wind_down_started_at` timestamp
/// 2. Swaps the workflow prompt to the wind-down liquidation prompt
///
/// After the tick completes, runs fee settlement for winding-down bots.
#[tracing::instrument(name = "workflow_tick", skip_all)]
pub async fn trading_workflow_tick() -> Result<TangleResult<JsonResponse>, String> {
    tracing::info!("=== WORKFLOW TICK HANDLER ENTERED ===");

    // 1. Check all active bots for wind-down eligibility
    let mut all_bots = bots()?.values().map_err(|e| e.to_string())?;
    tracing::info!("Found {} bots", all_bots.len());

    disable_stopped_bot_workflows(&all_bots)?;
    disable_stale_bot_workflows(&all_bots)?;
    backfill_active_bot_run_history(&all_bots);

    if crate::jobs::ensure_active_bot_sandboxes().await > 0 {
        all_bots = bots()?.values().map_err(|e| e.to_string())?;
        disable_stale_bot_workflows(&all_bots)?;
        backfill_active_bot_run_history(&all_bots);
    }

    for bot in &all_bots {
        if !should_initiate_wind_down(bot) {
            continue;
        }

        let Some(workflow_id) = bot.workflow_id else {
            continue;
        };

        tracing::info!(
            "Initiating wind-down for bot {} (vault={}, strategy={})",
            bot.id,
            bot.vault_address,
            bot.strategy_type,
        );

        // Build the wind-down prompt
        let wind_down_prompt = crate::prompts::build_wind_down_prompt(bot);

        // Swap the workflow prompt
        let wf_key = workflow_key(workflow_id);
        let updated = workflows()?
            .update(&wf_key, |entry| {
                if let Ok(mut wf) = serde_json::from_str::<Value>(&entry.workflow_json) {
                    wf["prompt"] = Value::String(wind_down_prompt.clone());
                    if let Ok(json_str) = serde_json::to_string(&wf) {
                        entry.workflow_json = json_str;
                    }
                }
            })
            .map_err(|e| format!("Failed to update workflow prompt: {e}"))?;

        if !updated {
            tracing::warn!(
                "Workflow {} not found for bot {} during wind-down",
                workflow_id,
                bot.id,
            );
            continue;
        }

        // Mark the bot as winding down
        let bot_k = bot_key(&bot.id);
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        bots()?
            .update(&bot_k, |b| {
                b.wind_down_started_at = Some(now);
            })
            .map_err(|e| format!("Failed to mark bot wind-down: {e}"))?;

        tracing::info!("Wind-down initiated for bot {}", bot.id);
    }

    // 2. Run deterministic fast ticks (any family with a tick tool) before the
    //    generic LLM runner.
    let runnable_bots = bots()?.values().map_err(|e| e.to_string())?;
    let mut direct_response = json!({
        "count": 0,
        "executed": [],
    });
    let direct_executed = match run_due_fast_ticks(&runnable_bots).await {
        Ok(executed) => executed,
        Err(err) => {
            tracing::error!("direct fast tick failed (non-fatal): {err}");
            Vec::new()
        }
    };
    if !direct_executed.is_empty() {
        direct_response = json!({
            "count": direct_executed.len(),
            "executed": direct_executed,
        });
    }

    // 3. Run the generic LLM workflow runner only when explicitly enabled for
    // the operator. The deterministic fast-tick path above is the trading
    // liveness path; the generic runner is useful for background research but
    // can starve fresh trading ticks when a backlog accumulates.
    let mut response = if generic_workflow_tick_enabled() {
        tracing::info!("Running inner workflow_tick()...");
        match tokio::time::timeout(
            inner_workflow_tick_timeout(),
            ai_agent_sandbox_blueprint_lib::workflows::workflow_tick(),
        )
        .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                tracing::error!("workflow_tick() failed (non-fatal): {e}");
                serde_json::json!({"error": e, "count": 0, "executed": []})
            }
            Err(e) => {
                tracing::error!("workflow_tick() timed out (non-fatal): {e}");
                serde_json::json!({
                    "error": format!("workflow_tick timed out after {}ms", inner_workflow_tick_timeout().as_millis()),
                    "count": 0,
                    "executed": [],
                })
            }
        }
    } else {
        tracing::info!(
            "Skipping generic workflow_tick(); deterministic fast ticks and self-improvement cadence remain active"
        );
        serde_json::json!({"count": 0, "executed": []})
    };
    if let Some(direct_executed) = direct_response.get("executed").and_then(Value::as_array) {
        if let Some(executed) = response.get_mut("executed").and_then(Value::as_array_mut) {
            executed.extend(direct_executed.iter().cloned());
            response["count"] = json!(executed.len());
        }
    }
    validate_fast_runs(&mut response, &runnable_bots).await;
    tracing::info!("workflow_tick() returned: {}", response);
    persist_executed_run_history(&response);

    // 3.5. Promotion conductor: advance self-improvement paper trials (paper bots only).
    //      Activates queued backtest-passing candidates, accrues forward paper evidence
    //      under the candidate, and promotes/tables via the existing promotion gate.
    //      Runs after trades are persisted so this tick's evidence is counted.
    crate::jobs::promotion_conductor::run_promotion_conductor(&runnable_bots).await;

    // 3.6. Self-improvement cadence: recover delegated MCP work and generate new
    //      backtest candidates through the sandbox TS tools when no trial is open.
    crate::jobs::self_improvement_cadence::run_self_improvement_cadence(&runnable_bots).await;

    // 3.7. Observatory cadence: write owner-visible reflection/idea/delegation
    //      artifacts without relying on the generic workflow runner.
    crate::jobs::observatory_cadence::run_observatory_cadence(&runnable_bots).await;

    // 4. Run fee settlement for winding-down bots
    let winding_down: Vec<_> = bots()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|b| b.wind_down_started_at.is_some())
        .collect();

    for bot in &winding_down {
        tracing::info!("Running post-wind-down fee settlement for bot {}", bot.id);
    }

    if !winding_down.is_empty() {
        crate::fees::settle_all_fees().await;
    }

    Ok(TangleResult(JsonResponse {
        json: response.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_bot(bot_id: &str, workflow_id: u64) -> crate::state::TradingBotRecord {
        crate::state::TradingBotRecord {
            id: bot_id.to_string(),
            name: format!("Bot {bot_id}"),
            sandbox_id: format!("sandbox-{bot_id}"),
            vault_address: "0x0000000000000000000000000000000000000001".to_string(),
            share_token: String::new(),
            strategy_type: "dex".to_string(),
            strategy_config: json!({"paper_trade": true}),
            risk_params: json!({}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9100".to_string(),
            trading_api_token: "test-token".to_string(),
            workflow_id: Some(workflow_id),
            trading_active: true,
            created_at: 0,
            operator_address: String::new(),
            validator_service_ids: Vec::new(),
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: Value::Null,
            validation_trust: trading_runtime::ValidationTrust::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        }
    }

    fn fast_workflow(
        bot_id: &str,
        workflow_id: u64,
    ) -> ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
        ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
            id: workflow_id,
            name: format!("fast-tick-{bot_id}"),
            workflow_json: json!({"timeout_ms": 120_000}).to_string(),
            trigger_type: "cron".to_string(),
            trigger_config: "0 */5 * * * *".to_string(),
            sandbox_config_json: String::new(),
            target_kind: 0,
            target_sandbox_id: String::new(),
            target_service_id: 0,
            active: true,
            next_run_at: Some(0),
            last_run_at: None,
            owner: String::new(),
        }
    }

    #[test]
    fn generic_workflow_tick_is_explicit_opt_in() {
        assert!(!generic_workflow_tick_enabled_from_value(None));
        assert!(!generic_workflow_tick_enabled_from_value(Some("0")));
        assert!(!generic_workflow_tick_enabled_from_value(Some("false")));
        assert!(!generic_workflow_tick_enabled_from_value(Some(" no ")));
        assert!(!generic_workflow_tick_enabled_from_value(Some("OFF")));

        assert!(generic_workflow_tick_enabled_from_value(Some("1")));
        assert!(generic_workflow_tick_enabled_from_value(Some("true")));
        assert!(generic_workflow_tick_enabled_from_value(Some("yes")));
    }

    #[test]
    fn fast_tick_selection_includes_current_active_bot() {
        let bot_id = "trading-active-fast";
        let workflow_id = 42;
        let workflow = fast_workflow(bot_id, workflow_id);
        let bots = vec![test_bot(bot_id, workflow_id)];

        let selected = fast_tick_bot_and_tool_for_workflow(&workflow, &bots);

        assert!(selected.is_some(), "active bot should run direct fast tick");
    }

    #[test]
    fn fast_tick_selection_skips_wind_down_bot() {
        let bot_id = "trading-wind-down-fast";
        let workflow_id = 43;
        let workflow = fast_workflow(bot_id, workflow_id);
        let mut bot = test_bot(bot_id, workflow_id);
        bot.wind_down_started_at = Some(123);
        let bots = vec![bot];

        let selected = fast_tick_bot_and_tool_for_workflow(&workflow, &bots);

        assert!(
            selected.is_none(),
            "wind-down bot should not run the normal deterministic fast tick"
        );
    }

    #[test]
    fn fast_tick_bundle_updates_selected_tool_and_shared_runtime() {
        let bundle = fast_tick_tool_bundle("dex-mm-tick.js").expect("mm bundle");
        let paths: Vec<_> = bundle.iter().map(|(path, _)| *path).collect();

        assert!(paths.contains(&"/home/agent/tools/api-client.js"));
        assert!(paths.contains(&"/home/agent/tools/log-decision.js"));
        assert!(paths.contains(&"/home/agent/tools/write-metrics.js"));
        assert!(paths.contains(&"/home/agent/tools/reflection-loop.js"));
        assert!(paths.contains(&"/home/agent/tools/usage-telemetry.js"));
        assert!(paths.contains(&"/home/agent/tools/self-improvement-loop.ts"));
        assert!(paths.contains(&"/home/agent/tools/observatory-pressure.js"));
        assert!(paths.contains(&"/home/agent/tools/tick-common.js"));
        assert!(paths.contains(&"/home/agent/tools/tick-recipe-dsl.js"));
        assert!(paths.contains(&"/home/agent/tools/dex-mm-tick.js"));
    }

    #[test]
    fn fast_tick_bundle_supports_every_tool_mapped_by_prompts() {
        for tool in [
            "hyperliquid-tick.js",
            "dex-tick.js",
            "dex-mm-tick.js",
            "yield-tick.js",
            "multi-tick.js",
            "volatility-tick.js",
            "perp-tick.js",
        ] {
            let bundle = fast_tick_tool_bundle(tool).expect("mapped deterministic tool has bundle");
            let paths: Vec<_> = bundle.iter().map(|(path, _)| *path).collect();
            let expected_path = format!("/home/agent/tools/{tool}");
            assert!(
                paths.iter().any(|path| *path == expected_path),
                "{tool} bundle must install the selected tool"
            );
            assert!(
                paths.contains(&"/home/agent/tools/reflection-loop.js"),
                "{tool} bundle must install the runtime reflection loop"
            );
            assert!(
                paths.contains(&"/home/agent/tools/usage-telemetry.js"),
                "{tool} bundle must install runtime usage telemetry"
            );
            assert!(
                paths.contains(&"/home/agent/tools/self-improvement-loop.ts"),
                "{tool} bundle must install the runtime self-improvement loop"
            );
            assert!(
                paths.contains(&"/home/agent/tools/observatory-pressure.js"),
                "{tool} bundle must install the delegation pressure probe"
            );
        }
    }

    #[tokio::test]
    async fn validate_fast_runs_marks_successful_non_json_fast_tick() {
        let bot_id = "trading-invalid-json-fast";
        let workflow_id = 44;
        let bots = vec![test_bot(bot_id, workflow_id)];
        let mut response = json!({
            "count": 1,
            "executed": [{
                "workflowId": workflow_id,
                "name": format!("fast-tick-{bot_id}"),
                "executedAt": 123,
                "task": {
                    "success": true,
                    "result": "not json"
                }
            }]
        });

        validate_fast_runs(&mut response, &bots).await;

        let task = &response["executed"][0]["task"];
        assert_eq!(task["success"], false);
        assert_eq!(task["error"], "Fast tick result was not deterministic JSON");
    }

    #[tokio::test]
    async fn validate_fast_runs_preserves_existing_failed_direct_tick_error() {
        let bot_id = "trading-preserve-direct-error";
        let workflow_id = 45;
        let bots = vec![test_bot(bot_id, workflow_id)];
        let mut response = json!({
            "count": 1,
            "executed": [{
                "workflowId": workflow_id,
                "name": format!("fast-tick-{bot_id}"),
                "executedAt": 123,
                "task": {
                    "success": false,
                    "error": "sandbox lookup failed: missing sandbox",
                    "result": ""
                }
            }]
        });

        validate_fast_runs(&mut response, &bots).await;

        let task = &response["executed"][0]["task"];
        assert_eq!(task["success"], false);
        assert_eq!(task["error"], "sandbox lookup failed: missing sandbox");
    }

    #[test]
    fn deterministic_ticks_allow_tight_paper_bands_without_lowering_live_floor() {
        let mm = include_str!("../prompts/tools/dex_mm_tick.js");
        let multi = include_str!("../prompts/tools/multi_tick.js");

        assert!(mm.contains("paperTrade ? 0.0001 : 0.01"));
        assert!(multi.contains("paperTrade ? 0.0005 : 0.02"));
    }
}
