//! Self-improvement cadence for deployed paper bots.
//!
//! The promotion conductor can only advance candidates that already exist. This
//! cadence keeps the other half of the loop alive without moving generation into
//! Rust: it launches the sandbox-local TS tools and lets them persist candidates
//! through the existing `/evolution/*` API. It also pokes the MCP task store so
//! delegated code-change tasks recover across ticks instead of being abandoned
//! when a single child execution stalls or fails.

use ai_agent_sandbox_blueprint_lib::{SandboxExecRequest, run_exec_request};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::state::TradingBotRecord;
use trading_http_api::evolution_store::{self, status};

static CADENCE: OnceCell<PersistentStore<SelfImprovementCadenceRecord>> = OnceCell::new();

const DEFAULT_MAINTENANCE_INTERVAL_SECS: i64 = 15 * 60;
const DEFAULT_INTENT_CHECK_INTERVAL_SECS: i64 = 60;
const DEFAULT_GENERATION_INTERVAL_SECS: i64 = 6 * 60 * 60;
const DEFAULT_LAUNCH_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_MAINTENANCE_BOTS_PER_TICK: usize = 3;
const DEFAULT_MAX_INTENT_CHECK_BOTS_PER_TICK: usize = 3;
const DEFAULT_MAX_GENERATION_BOTS_PER_TICK: usize = 1;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SelfImprovementCadenceRecord {
    pub bot_id: String,
    #[serde(default)]
    pub last_maintenance_at: Option<i64>,
    #[serde(default)]
    pub last_intent_check_at: Option<i64>,
    #[serde(default)]
    pub last_generation_at: Option<i64>,
}

fn records() -> Result<&'static PersistentStore<SelfImprovementCadenceRecord>, String> {
    CADENCE
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("self-improvement-cadence.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn record_key(bot_id: &str) -> String {
    format!("self-improvement-cadence:{bot_id}")
}

fn cadence_record(bot_id: &str) -> Result<SelfImprovementCadenceRecord, String> {
    Ok(records()?
        .get(&record_key(bot_id))
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| SelfImprovementCadenceRecord {
            bot_id: bot_id.to_string(),
            ..Default::default()
        }))
}

fn save_cadence_record(record: SelfImprovementCadenceRecord) -> Result<(), String> {
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

fn eligible_paper_bot(bot: &TradingBotRecord) -> bool {
    bot.paper_trade && bot.trading_active && bot.wind_down_started_at.is_none()
}

fn has_open_generation_work(bot: &TradingBotRecord) -> Result<bool, String> {
    if bot.active_trial_run_id.is_some() {
        return Ok(true);
    }
    Ok(evolution_store::list_for_bot(&bot.id)?
        .iter()
        .any(|run| status::is_non_terminal(&run.status)))
}

fn summary_started_generation(summary: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(summary)
        .ok()
        .and_then(|value| value.get("generation").cloned())
        .is_some()
}

/// Advance sandbox-local self-improvement maintenance for active paper bots.
///
/// This launches short-lived background commands inside each bot's sidecar and
/// returns quickly. The background commands write their own logs under
/// `/home/agent/logs/`; persisted MCP/evolution stores are the source of truth.
pub async fn run_self_improvement_cadence(all_bots: &[TradingBotRecord]) {
    let now = chrono::Utc::now().timestamp();
    let maintenance_interval = env_i64(
        "SELF_IMPROVEMENT_MAINTENANCE_INTERVAL_SECS",
        DEFAULT_MAINTENANCE_INTERVAL_SECS,
    );
    let generation_interval = env_i64(
        "SELF_IMPROVEMENT_GENERATION_INTERVAL_SECS",
        DEFAULT_GENERATION_INTERVAL_SECS,
    );
    let intent_check_interval = env_i64(
        "SELF_IMPROVEMENT_INTENT_CHECK_INTERVAL_SECS",
        DEFAULT_INTENT_CHECK_INTERVAL_SECS,
    );
    let max_maintenance = env_usize(
        "SELF_IMPROVEMENT_MAX_MAINTENANCE_BOTS_PER_TICK",
        DEFAULT_MAX_MAINTENANCE_BOTS_PER_TICK,
    );
    let max_intent_checks = env_usize(
        "SELF_IMPROVEMENT_MAX_INTENT_CHECK_BOTS_PER_TICK",
        DEFAULT_MAX_INTENT_CHECK_BOTS_PER_TICK,
    );
    let max_generation = env_usize(
        "SELF_IMPROVEMENT_MAX_GENERATION_BOTS_PER_TICK",
        DEFAULT_MAX_GENERATION_BOTS_PER_TICK,
    );

    let mut maintenance_started = 0usize;
    let mut intent_checks_started = 0usize;
    let mut generation_started = 0usize;

    for bot in all_bots.iter().filter(|bot| eligible_paper_bot(bot)) {
        let mut record = match cadence_record(&bot.id) {
            Ok(record) => record,
            Err(error) => {
                tracing::warn!(bot_id = %bot.id, "self-improvement cadence store error: {error}");
                continue;
            }
        };

        let generation_capacity = generation_started < max_generation;
        let no_open_generation_work = if generation_capacity {
            match has_open_generation_work(bot) {
                Ok(open) => !open,
                Err(error) => {
                    tracing::warn!(bot_id = %bot.id, "self-improvement generation eligibility error: {error}");
                    false
                }
            }
        } else {
            false
        };
        let can_start_generation = generation_capacity && no_open_generation_work;
        let do_maintenance = maintenance_started < max_maintenance
            && due(record.last_maintenance_at, now, maintenance_interval);
        let do_generation =
            can_start_generation && due(record.last_generation_at, now, generation_interval);
        let do_intent_check = !do_generation
            && can_start_generation
            && intent_checks_started < max_intent_checks
            && due(record.last_intent_check_at, now, intent_check_interval);

        if !do_maintenance && !do_generation && !do_intent_check {
            continue;
        }

        match launch_sandbox_cadence(bot, do_generation, do_generation || do_intent_check).await {
            Ok(summary) => {
                if do_maintenance {
                    record.last_maintenance_at = Some(now);
                    maintenance_started += 1;
                }
                if do_intent_check {
                    record.last_intent_check_at = Some(now);
                    intent_checks_started += 1;
                }
                let generation_launched = summary_started_generation(&summary);
                if generation_launched {
                    record.last_generation_at = Some(now);
                    generation_started += 1;
                }
                if let Err(error) = save_cadence_record(record) {
                    tracing::warn!(bot_id = %bot.id, "self-improvement cadence persist error: {error}");
                }
                tracing::info!(bot_id = %bot.id, run_generation = generation_launched, intent_check = do_intent_check, %summary, "self-improvement cadence launched");
            }
            Err(error) => {
                tracing::warn!(bot_id = %bot.id, run_generation = do_generation, "self-improvement cadence launch failed: {error}");
            }
        }
    }
}

async fn launch_sandbox_cadence(
    bot: &TradingBotRecord,
    run_generation: bool,
    allow_intent_generation: bool,
) -> Result<String, String> {
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| format!("load sandbox {}: {e}", bot.sandbox_id))?;
    crate::jobs::activate::ensure_sidecar_runtime_dirs(&sandbox.sidecar_url, &sandbox.token)
        .await
        .map_err(|e| format!("prepare self-improvement dirs: {e}"))?;
    sync_self_improvement_tools_to_sidecar(&sandbox.sidecar_url, &sandbox.token)
        .await
        .map_err(|e| format!("sync self-improvement tools: {e}"))?;
    let intent = format!(
        "Periodic paper-only harness self-improvement for bot {}. Generate a TS-side candidate, record sandbox/evolution lineage, and leave promotion to the paper-trial conductor.",
        bot.id
    );
    let exec_req = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: cadence_launcher_command().to_string(),
        cwd: "/home/agent".to_string(),
        env_json: json!({
            "RUN_GENERATION": if run_generation { "1" } else { "0" },
            "ALLOW_INTENT_GENERATION": if allow_intent_generation { "1" } else { "0" },
            "SELF_IMPROVEMENT_INTENT": intent,
        })
        .to_string(),
        timeout_ms: env_u64(
            "SELF_IMPROVEMENT_CADENCE_LAUNCH_TIMEOUT_MS",
            DEFAULT_LAUNCH_TIMEOUT_MS,
        ),
    };

    let response = run_exec_request(&exec_req, &sandbox.token).await?;
    if response.exit_code != 0 {
        return Err(format!(
            "launcher exit {} stdout={} stderr={}",
            response.exit_code,
            response.stdout.trim(),
            response.stderr.trim()
        ));
    }
    Ok(response.stdout.trim().to_string())
}

fn self_improvement_tool_bundle() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "/home/agent/tools/api-client.js",
            include_str!("../prompts/tools/api_client.js"),
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
            "/home/agent/tools/self-improvement-mcp-server.ts",
            include_str!("../prompts/tools/self_improvement_mcp_server.ts"),
        ),
        (
            "/home/agent/tools/create-mcp-multishot-strategy-task.js",
            include_str!("../prompts/tools/create_mcp_multishot_strategy_task.js"),
        ),
    ]
}

async fn sync_self_improvement_tools_to_sidecar(
    sidecar_url: &str,
    token: &str,
) -> Result<(), String> {
    for (path, content) in self_improvement_tool_bundle() {
        crate::jobs::activate::write_file_to_sidecar(sidecar_url, token, path, content).await?;
    }
    Ok(())
}

fn cadence_launcher_command() -> &'static str {
    r#"node <<'NODE'
const { spawn } = require('node:child_process');
const fs = require('node:fs');

fs.mkdirSync('/home/agent/logs', { recursive: true });

function launch(label, command, args, extraEnv = {}) {
  const logPath = `/home/agent/logs/${label}.log`;
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(command, args, {
    cwd: '/home/agent',
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  return { pid: child.pid, log: logPath };
}

function selectGenerationIntent(defaultIntent) {
  try {
    const loop = require('/home/agent/tools/reflection-loop.js');
    const selected = loop.nextImprovementIntent(defaultIntent);
    if (selected.intent) {
      loop.recordIntentDispatch(selected.intent, { launcher: 'self-improvement-cadence', pid: process.pid });
    }
    return selected;
  } catch (error) {
    return {
      intent: null,
      prompt: defaultIntent,
      error: error && error.message ? error.message : String(error),
    };
  }
}

const mcpRpc = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'self_improvement.list_tasks', arguments: { max_results: 5 } },
})}\n`;

const out = {
  maintenance: launch(
    'self-improvement-maintenance',
    'sh',
    ['-lc', 'printf "%s" "$MCP_RPC" | bun --bun /home/agent/tools/self-improvement-mcp-server.ts'],
    { MCP_RPC: mcpRpc },
  ),
};

const allowIntentGeneration = process.env.RUN_GENERATION === '1' || process.env.ALLOW_INTENT_GENERATION !== '0';
const selected = allowIntentGeneration
  ? selectGenerationIntent(process.env.SELF_IMPROVEMENT_INTENT || 'Periodic paper-only harness self-improvement.')
  : { intent: null, prompt: process.env.SELF_IMPROVEMENT_INTENT || 'Periodic paper-only harness self-improvement.' };
out.selected_generation_intent = selected.intent
  ? {
      intent_id: selected.intent.intent_id,
      priority: selected.intent.priority || null,
      reflection_id: selected.intent.reflection_id || null,
      decision_context_id: selected.intent.decision_context_id || null,
    }
  : null;
if (selected.error) out.intent_selection_error = selected.error;

if (process.env.RUN_GENERATION === '1' || (allowIntentGeneration && selected.intent)) {
  out.generation = launch(
    'self-improvement-generation',
    'bun',
    [
      '--bun',
      '/home/agent/tools/self-improvement-loop.ts',
      'run',
      selected.prompt,
    ],
  );
}

process.stdout.write(JSON.stringify(out));
NODE"#
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: &str) -> TradingBotRecord {
        TradingBotRecord {
            id: id.to_string(),
            name: id.to_string(),
            sandbox_id: format!("sandbox-{id}"),
            vault_address: "0x0000000000000000000000000000000000000001".to_string(),
            share_token: String::new(),
            strategy_type: "dex".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            chain_id: 8453,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9100".to_string(),
            trading_api_token: "token".to_string(),
            workflow_id: None,
            trading_active: true,
            created_at: 1,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: serde_json::Value::Null,
            validation_trust: trading_runtime::ValidationTrust::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        }
    }

    #[test]
    fn due_handles_never_and_elapsed_intervals() {
        assert!(due(None, 1_000, 900));
        assert!(due(Some(100), 1_000, 900));
        assert!(!due(Some(200), 1_000, 900));
    }

    #[test]
    fn eligibility_is_paper_active_and_not_winding_down() {
        let mut candidate = bot("eligible");
        assert!(eligible_paper_bot(&candidate));
        candidate.paper_trade = false;
        assert!(!eligible_paper_bot(&candidate));
        candidate.paper_trade = true;
        candidate.trading_active = false;
        assert!(!eligible_paper_bot(&candidate));
        candidate.trading_active = true;
        candidate.wind_down_started_at = Some(123);
        assert!(!eligible_paper_bot(&candidate));
    }

    #[test]
    fn cadence_launcher_consumes_runtime_reflection_intents() {
        let command = cadence_launcher_command();
        assert!(command.contains("require('/home/agent/tools/reflection-loop.js')"));
        assert!(command.contains("ALLOW_INTENT_GENERATION"));
        assert!(command.contains("loop.nextImprovementIntent"));
        assert!(command.contains("loop.recordIntentDispatch"));
        assert!(command.contains("selected.prompt"));
        assert!(command.contains(
            "process.env.RUN_GENERATION === '1' || (allowIntentGeneration && selected.intent)"
        ));
    }

    #[test]
    fn cadence_syncs_self_improvement_tools_before_launching() {
        let bundle = self_improvement_tool_bundle();
        let paths: Vec<_> = bundle.iter().map(|(path, _)| *path).collect();
        assert!(paths.contains(&"/home/agent/tools/api-client.js"));
        assert!(paths.contains(&"/home/agent/tools/reflection-loop.js"));
        assert!(paths.contains(&"/home/agent/tools/usage-telemetry.js"));
        assert!(paths.contains(&"/home/agent/tools/self-improvement-loop.ts"));
        assert!(paths.contains(&"/home/agent/tools/self-improvement-mcp-server.ts"));
        assert!(paths.contains(&"/home/agent/tools/create-mcp-multishot-strategy-task.js"));
    }

    #[test]
    fn summary_generation_detection_is_json_structural() {
        assert!(summary_started_generation(r#"{"generation":{"pid":123}}"#));
        assert!(!summary_started_generation(
            r#"{"selected_generation_intent":null}"#
        ));
        assert!(!summary_started_generation("generation"));
    }
}
