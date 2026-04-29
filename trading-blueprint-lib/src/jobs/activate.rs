//! Bot activation with off-chain secrets (phase 2 of two-phase provisioning).
//!
//! After a bot is provisioned on-chain with base env only, the user pushes
//! secrets through the operator API. This module handles injecting user secrets
//! into the sidecar, running strategy pack setup, and creating the cron workflow.
//!
//! The sandbox-runtime handles base/user env separation internally:
//! - `inject_secrets(id, user_env)` merges user env on top of base env
//! - `wipe_secrets(id)` removes user env, preserving base env

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::json;

use crate::state::{
    TradingBotRecord, bot_key, bots, clear_activation, get_bot, update_activation_progress,
};

pub(crate) const SIDECAR_PROFILE_INSTRUCTIONS_PATH: &str =
    "/home/agent/.opencode/profile-instructions.md";

/// Per-bot mutex preventing concurrent activate/wipe operations.
/// Ensures only one lifecycle operation runs per bot at a time (RACE-3, RACE-6).
static BOT_LIFECYCLE_LOCKS: std::sync::LazyLock<
    Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn bot_lifecycle_lock(bot_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut map = BOT_LIFECYCLE_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(bot_id.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Result of successful activation.
#[derive(Debug)]
pub struct ActivateResult {
    pub sandbox_id: String,
    pub workflow_id: u64,
    /// Trading API bearer token (set during provision, returned here so callers
    /// don't need a redundant re-read of the bot record).
    pub trading_api_token: String,
    /// Trading API URL (e.g. `http://host:port`).
    pub trading_api_url: String,
}

pub(crate) fn resolve_sidecar_trading_api_url(api_url: &str) -> String {
    if let Ok(explicit) = std::env::var("SIDECAR_TRADING_API_URL") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }

    let host_network = std::env::var("SIDECAR_NETWORK_HOST").is_ok_and(|v| v == "true" || v == "1");
    if host_network {
        return api_url.to_string();
    }

    let Ok(mut parsed) = reqwest::Url::parse(api_url) else {
        return api_url.to_string();
    };

    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("0.0.0.0") => {
            let replacement_host = std::env::var("SIDECAR_INTERNAL_TRADING_API_HOST")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "host.docker.internal".to_string());
            if parsed.set_host(Some(&replacement_host)).is_ok() {
                return parsed.to_string();
            }
            api_url.to_string()
        }
        _ => api_url.to_string(),
    }
}

pub(crate) fn build_sidecar_bot_config(bot: &TradingBotRecord) -> TradingBotRecord {
    let mut sidecar_bot = bot.clone();
    sidecar_bot.trading_api_url = resolve_sidecar_trading_api_url(&bot.trading_api_url);
    sidecar_bot.rpc_url = resolve_sidecar_rpc_url(&bot.rpc_url);
    sidecar_bot
}

pub(crate) fn resolve_sidecar_rpc_url(rpc_url: &str) -> String {
    if let Ok(explicit) = std::env::var("SIDECAR_RPC_URL") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }

    let host_network = std::env::var("SIDECAR_NETWORK_HOST").is_ok_and(|v| v == "true" || v == "1");
    if host_network {
        return rpc_url.to_string();
    }

    let Ok(mut parsed) = reqwest::Url::parse(rpc_url) else {
        return rpc_url.to_string();
    };

    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("0.0.0.0") => {
            let replacement_host = std::env::var("SIDECAR_INTERNAL_RPC_HOST")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "host.docker.internal".to_string());
            if parsed.set_host(Some(&replacement_host)).is_ok() {
                return parsed.to_string();
            }
            rpc_url.to_string()
        }
        _ => rpc_url.to_string(),
    }
}

/// Activate a bot that is awaiting secrets.
///
/// 1. Validates the bot exists and sandbox has no user secrets
/// 2. Injects user secrets via `sandbox_runtime::secret_provisioning::inject_secrets()`
/// 3. Runs strategy pack setup commands
/// 4. Creates cron workflow
/// 5. Updates bot record to active
///
/// When `mock_sandbox` is `Some`, skips Docker sidecar recreation and uses the
/// provided record instead.  Pass `None` in production.
pub async fn activate_bot_with_secrets(
    bot_id: &str,
    user_env: serde_json::Map<String, serde_json::Value>,
    mock_sandbox: Option<sandbox_runtime::SandboxRecord>,
) -> Result<ActivateResult, String> {
    // Acquire per-bot lifecycle lock to prevent RACE-3 (concurrent activation)
    // and RACE-6 (activate + wipe interleave).
    let lock = bot_lifecycle_lock(bot_id);
    let _guard = lock.lock().await;

    // 1. Load and validate
    update_activation_progress(bot_id, "validating", "Loading bot configuration");

    let mut bot = get_bot(bot_id)?.ok_or_else(|| format!("Bot {bot_id} not found"))?;

    // Resolve vault address if still a factory placeholder from provision.
    // The BSM creates the real vault on-chain in _handleProvisionResult, but
    // never updates the operator-side record. Resolve it here before the bot
    // starts trading.
    if bot.vault_address.starts_with("factory:") {
        let factory_hex = bot.vault_address.trim_start_matches("factory:").trim();
        let zero_factory_placeholder =
            factory_hex.eq_ignore_ascii_case("0x0000000000000000000000000000000000000000");

        if bot.paper_trade && zero_factory_placeholder {
            let addr = "0x0000000000000000000000000000000000000000".to_string();
            tracing::info!(
                "Paper-trade bot {bot_id} has no vault factory configured; using zero vault address"
            );
            bot.vault_address = addr.clone();
            if let Ok(store) = bots() {
                let _ = store.update(&bot_key(bot_id), |b| {
                    b.vault_address = addr.clone();
                });
            }
        } else {
            let resolved = resolve_vault_from_factory(&bot).await;
            match resolved {
                Ok(addr) => {
                    tracing::info!("Resolved vault address for {bot_id}: {addr}");
                    bot.vault_address = addr.clone();
                    // Persist the resolved address so future restarts don't re-query
                    if let Ok(store) = bots() {
                        let _ = store.update(&bot_key(bot_id), |b| {
                            b.vault_address = addr.clone();
                        });
                    }
                }
                // Chat-first paper bots can be provisioned before any on-chain vault
                // exists. Keep activation moving even when factory lookup fails.
                Err(e) if bot.paper_trade => {
                    tracing::warn!(
                        "Factory vault unresolved for paper-trade bot {bot_id}; continuing with placeholder {}: {e}",
                        bot.vault_address
                    );
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to resolve vault from factory for {bot_id}: {e}. \
                         Refusing to trade with unresolved vault address."
                    ));
                }
            }
        }
    }

    let sidecar_bot = build_sidecar_bot_config(&bot);
    let sidecar_trading_api_url = sidecar_bot.trading_api_url.clone();

    // Check sandbox state — secrets_configured is derived from sandbox record
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).ok();
    if let Some(ref s) = sandbox {
        if s.has_user_secrets() {
            clear_activation(bot_id);
            return Err(
                "Bot already has secrets configured. Use wipe_bot_secrets first to reconfigure."
                    .to_string(),
            );
        }
    }

    // 2. Inject user secrets into sandbox (sandbox-runtime merges base + user internally)
    update_activation_progress(
        bot_id,
        "recreating_sidecar",
        "Recreating container with secrets",
    );

    let is_mock = mock_sandbox.is_some();
    let record = if let Some(r) = mock_sandbox {
        // Store mock sandbox with user_env_json so has_user_secrets() works for guards
        let mut stored = r.clone();
        stored.user_env_json = serde_json::to_string(&user_env).unwrap_or_default();
        let _ = sandbox_runtime::runtime::sandboxes().map(|s| s.insert(stored.id.clone(), stored));
        r
    } else {
        sandbox_runtime::secret_provisioning::inject_secrets(&bot.sandbox_id, user_env, None)
            .await
            .map_err(|e| format!("Failed to inject secrets: {e}"))?
    };

    // 3. Strategy pack setup (skip in test/mock mode)
    update_activation_progress(bot_id, "running_setup", "Installing strategy dependencies");
    let pack = crate::prompts::packs::get_pack(&bot.strategy_type);
    if is_mock {
        // Mock sandbox — skip exec commands
    } else if let Some(ref p) = pack {
        // Wait for sidecar HTTP server to be ready (container just recreated).
        // Without this, setup commands get ConnectionReset.
        wait_for_sidecar_health(&record.sidecar_url, 20).await;
        ensure_sidecar_runtime_dirs(&record.sidecar_url, &record.token).await?;

        for cmd in &p.setup_commands {
            let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
                sidecar_url: record.sidecar_url.clone(),
                command: cmd.clone(),
                cwd: String::new(),
                env_json: String::new(),
                timeout_ms: 300_000,
            };
            if let Err(e) =
                ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req, &record.token).await
            {
                tracing::warn!("Pack setup command failed (non-fatal): {cmd}: {e}");
            }
        }
    }

    // 3b. Deploy pre-built trading tools (skip in test/mock mode)
    if !is_mock {
        update_activation_progress(
            bot_id,
            "deploying_tools",
            "Installing pre-built trading tools",
        );
        if let Err(e) = write_prebuilt_tools(
            &record.sidecar_url,
            &record.token,
            bot_id,
            bot.chain_id,
            &bot.strategy_type,
            &sidecar_trading_api_url,
            &resolve_sidecar_rpc_url(&bot.rpc_url),
            &bot.vault_address,
            &bot.trading_api_token,
            &bot.operator_address,
            &bot.strategy_config,
        )
        .await
        {
            tracing::warn!("Pre-built tool deployment failed (non-fatal): {e}");
        }

        update_activation_progress(
            bot_id,
            "syncing_instructions",
            "Writing OpenCode profile instructions",
        );
        sync_profile_instructions(&record.sidecar_url, &record.token, &sidecar_bot).await?;
    }

    // 4. Create workflows (split-tick architecture: FAST + RESEARCH + CONVERSATION)
    update_activation_progress(
        bot_id,
        "creating_workflow",
        "Configuring split-tick workflows",
    );

    // Generate a single base ID; research and conversation IDs are deterministic
    // offsets so all three IDs are distinct and cleanup can use base+1, base+2.
    let base_wf_id = {
        let ts = chrono::Utc::now().timestamp_millis() as u64;
        let rand_bits = (uuid::Uuid::new_v4().as_u128() & 0xFFFF) as u64;
        // Reserve 2 slots above for sibling workflows; ensure base is even to
        // keep the namespace aligned.
        (ts.wrapping_mul(100_000).wrapping_add(rand_bits)) & !0b11
    };
    let workflow_id = base_wf_id; // fast tick
    let research_id = base_wf_id + 1; // research tick
    let conversation_id = base_wf_id + 2; // conversation tick

    let backend_profile = match &pack {
        Some(p) => crate::prompts::build_pack_agent_profile(p, &sidecar_bot),
        None => crate::prompts::build_generic_agent_profile(&bot.strategy_type, &sidecar_bot),
    };
    let profile_json = serde_json::to_string(&backend_profile).unwrap_or_default();

    // --- FAST trading tick (3 turns, every 5 min) ---
    let fast_prompt = match &pack {
        Some(p) => crate::prompts::build_pack_loop_prompt(p, &sidecar_bot),
        None => crate::prompts::build_fast_tick_prompt(&bot.strategy_type),
    };
    let fast_cron = if !bot.trading_loop_cron.is_empty() {
        bot.trading_loop_cron.clone()
    } else {
        pack.as_ref()
            .map(|p| p.default_cron.clone())
            .unwrap_or_else(|| "0 */5 * * * *".to_string())
    };

    let fast_wf = json!({
        "sidecar_url": record.sidecar_url,
        "prompt": fast_prompt,
        "session_id": format!("fast-{bot_id}"),
        "max_turns": 5,
        "timeout_ms": 120_000,
        "sidecar_token": record.token,
        "backend_profile_json": &profile_json,
    });

    let next_run =
        ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run("cron", &fast_cron, None)
            .unwrap_or(None);

    let store = ai_agent_sandbox_blueprint_lib::workflows::workflows()?;
    store
        .insert(
            ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id),
            ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
                id: workflow_id,
                name: format!("fast-tick-{bot_id}"),
                workflow_json: fast_wf.to_string(),
                trigger_type: "cron".to_string(),
                trigger_config: fast_cron,
                sandbox_config_json: String::new(),
                target_kind: 0,
                target_sandbox_id: record.id.clone(),
                target_service_id: 0,
                active: true,
                next_run_at: next_run,
                last_run_at: None,
                owner: String::new(),
            },
        )
        .map_err(|e| format!("Failed to store fast workflow: {e}"))?;

    // --- RESEARCH tick (15 turns, every 30 min, offset by 2 min) ---
    let research_prompt = crate::prompts::build_research_tick_prompt(&sidecar_bot);
    let research_cron = "0 2,32 * * * *".to_string();

    let research_wf = json!({
        "sidecar_url": record.sidecar_url,
        "prompt": research_prompt,
        "session_id": format!("research-{bot_id}"),
        "max_turns": 15,
        "timeout_ms": 300_000,
        "sidecar_token": record.token,
        "backend_profile_json": &profile_json,
    });

    let research_next =
        ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run("cron", &research_cron, None)
            .unwrap_or(None);

    store
        .insert(
            ai_agent_sandbox_blueprint_lib::workflows::workflow_key(research_id),
            ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
                id: research_id,
                name: format!("research-tick-{bot_id}"),
                workflow_json: research_wf.to_string(),
                trigger_type: "cron".to_string(),
                trigger_config: research_cron,
                sandbox_config_json: String::new(),
                target_kind: 0,
                target_sandbox_id: record.id.clone(),
                target_service_id: 0,
                active: true,
                next_run_at: research_next,
                last_run_at: None,
                owner: String::new(),
            },
        )
        .map_err(|e| format!("Failed to store research workflow: {e}"))?;

    // --- CONVERSATION tick (10 turns, every 5 min, offset by 1 min) ---
    let conversation_prompt = crate::prompts::build_conversation_tick_prompt();
    let conversation_cron = "0 1,6,11,16,21,26,31,36,41,46,51,56 * * * *".to_string();

    let conversation_wf = json!({
        "sidecar_url": record.sidecar_url,
        "prompt": conversation_prompt,
        "session_id": format!("convo-{bot_id}"),
        "max_turns": 10,
        "timeout_ms": 120_000,
        "sidecar_token": record.token,
        "backend_profile_json": &profile_json,
    });

    let convo_next = ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run(
        "cron",
        &conversation_cron,
        None,
    )
    .unwrap_or(None);

    store
        .insert(
            ai_agent_sandbox_blueprint_lib::workflows::workflow_key(conversation_id),
            ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
                id: conversation_id,
                name: format!("conversation-tick-{bot_id}"),
                workflow_json: conversation_wf.to_string(),
                trigger_type: "cron".to_string(),
                trigger_config: conversation_cron,
                sandbox_config_json: String::new(),
                target_kind: 0,
                target_sandbox_id: record.id.clone(),
                target_service_id: 0,
                active: true,
                next_run_at: convo_next,
                last_run_at: None,
                owner: String::new(),
            },
        )
        .map_err(|e| format!("Failed to store conversation workflow: {e}"))?;

    // 5. Update bot record
    let new_sandbox_id = record.id.clone();
    let trading_api_token = bot.trading_api_token.clone();
    let trading_api_url = bot.trading_api_url.clone();
    bots()?
        .update(&bot_key(bot_id), |b| {
            b.sandbox_id.clone_from(&new_sandbox_id);
            b.workflow_id = Some(workflow_id);
            b.trading_active = true;
        })
        .map_err(|e| format!("Failed to update bot record: {e}"))?;

    update_activation_progress(bot_id, "complete", "Agent activated");
    tracing::info!(
        "Bot {bot_id} activated with secrets. Sandbox: {new_sandbox_id}, Workflow: {workflow_id}"
    );

    // Clear activation progress after a brief delay so frontend can read the final state
    let bot_id_owned = bot_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        clear_activation(&bot_id_owned);
    });

    Ok(ActivateResult {
        sandbox_id: new_sandbox_id,
        workflow_id,
        trading_api_token,
        trading_api_url,
    })
}

/// Wait for the sidecar's HTTP server to respond to health checks.
/// Polls `/health` every second until a 200 response or `max_secs` elapsed.
async fn wait_for_sidecar_health(sidecar_url: &str, max_secs: u64) {
    let url = match sandbox_runtime::http::build_url(sidecar_url, "/health") {
        Ok(u) => u,
        Err(_) => return,
    };
    let client = match sandbox_runtime::util::http_client() {
        Ok(c) => c,
        Err(_) => return,
    };
    for _ in 0..max_secs {
        match client.get(url.clone()).send().await {
            Ok(r) if r.status().is_success() => {
                tracing::debug!("Sidecar health check passed");
                return;
            }
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    tracing::warn!("Sidecar health check timed out after {max_secs}s — proceeding anyway");
}

pub(crate) async fn ensure_sidecar_runtime_dirs(
    sidecar_url: &str,
    token: &str,
) -> Result<(), String> {
    let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: sidecar_url.to_string(),
        command: "sh -lc 'mkdir -p /home/agent/.sidecar/state/opencode /home/agent/.sidecar/state/sessions /home/agent/.opencode /home/agent/.opencode-home/.config /home/agent/config /home/agent/memory/conversations /home/agent/memory/decisions /home/agent/memory/research /home/agent/tools/backup && chmod 0775 /home/agent/.sidecar /home/agent/.sidecar/state /home/agent/.sidecar/state/opencode /home/agent/.sidecar/state/sessions /home/agent/.opencode && { chown -R agent:agent /home/agent/.sidecar /home/agent/.opencode /home/agent/.opencode-home /home/agent/config /home/agent/memory /home/agent/tools 2>/dev/null || true; } && chmod -R u+rwX,g+rwX /home/agent/.sidecar /home/agent/.opencode /home/agent/.opencode-home 2>/dev/null || true'"
            .to_string(),
        cwd: String::new(),
        env_json: String::new(),
        timeout_ms: 30_000,
    };
    ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req, token)
        .await
        .map_err(|e| format!("Failed to prepare sidecar runtime directories: {e}"))?;

    // Bootstrap memory ToC if it doesn't exist
    let toc_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: sidecar_url.to_string(),
        command: r#"sh -lc 'test -f /home/agent/memory/toc.md || cat > /home/agent/memory/toc.md << "TOCEOF"
# Memory Index
Updated: new bot | Iteration: 0

## Conversations
(none yet — your owner can message you anytime)

## Decisions
(none yet — log non-obvious choices here)

## Research
(none yet)

## Performance
- New bot, no trades yet
TOCEOF
'"#
        .to_string(),
        cwd: String::new(),
        env_json: String::new(),
        timeout_ms: 10_000,
    };
    if let Err(e) = ai_agent_sandbox_blueprint_lib::run_exec_request(&toc_req, token).await {
        tracing::warn!("Memory ToC bootstrap failed (non-fatal): {e}");
    }

    let agents_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: sidecar_url.to_string(),
        command: r##"sh -lc 'if [ ! -f /AGENTS.md ]; then cat > /AGENTS.md << "AGENTSEOF"
# Sidecar Workspace

This sandbox is pre-seeded for the trading agent runtime.
Use /home/agent as the writable workspace root.
AGENTSEOF
fi'"##
            .to_string(),
        cwd: String::new(),
        env_json: String::new(),
        timeout_ms: 10_000,
    };
    ai_agent_sandbox_blueprint_lib::run_exec_request(&agents_req, token)
        .await
        .map_err(|e| format!("AGENTS bootstrap failed: {e}"))?;

    let verify_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: sidecar_url.to_string(),
        command: "sh -lc 'test -d /home/agent/.sidecar/state/opencode && test -d /home/agent/.sidecar/state/sessions && test -f /AGENTS.md'"
            .to_string(),
        cwd: String::new(),
        env_json: String::new(),
        timeout_ms: 10_000,
    };
    ai_agent_sandbox_blueprint_lib::run_exec_request(&verify_req, token)
        .await
        .map_err(|e| format!("Sidecar bootstrap verification failed: {e}"))?;

    Ok(())
}

pub(crate) async fn sync_profile_instructions(
    sidecar_url: &str,
    token: &str,
    bot: &TradingBotRecord,
) -> Result<(), String> {
    let instructions = crate::prompts::render_agent_instructions(&bot.strategy_type, bot);
    write_file_to_sidecar(
        sidecar_url,
        token,
        SIDECAR_PROFILE_INSTRUCTIONS_PATH,
        &instructions,
    )
    .await
}

/// Deploy pre-built trading tools to the sidecar filesystem.
///
/// Writes smart, self-contained tools that do the heavy lifting so the agent
/// can focus on decision-making. Common tools for all strategies + strategy-specific tools.
/// Also writes `/home/agent/config/api.json` so tools can call the Trading HTTP API.
pub(crate) async fn write_prebuilt_tools(
    sidecar_url: &str,
    token: &str,
    bot_id: &str,
    chain_id: u64,
    strategy_type: &str,
    api_url: &str,
    rpc_url: &str,
    vault_address: &str,
    api_token: &str,
    operator_address: &str,
    strategy_config: &serde_json::Value,
) -> Result<(), String> {
    // Write workspace package.json with serve script for OpenCode agent
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/package.json",
        r#"{"name":"trading-agent","version":"1.0.0","private":true,"scripts":{"serve":"opencode serve"}}"#,
    )
    .await?;

    // Write API config so tools can find the Trading HTTP API
    let config_json = serde_json::json!({
        "bot_id": bot_id,
        "chain_id": chain_id,
        "api_url": api_url,
        "rpc_url": rpc_url,
        "vault_address": vault_address,
        "token": api_token,
        "operator_address": operator_address,
        "strategy_config": strategy_config,
    })
    .to_string();
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/config/api.json",
        &config_json,
    )
    .await?;

    // Write default harness config for meta-harness evolution
    let default_harness = trading_runtime::backtest::HarnessConfig::default();
    let harness_json =
        serde_json::to_string_pretty(&default_harness).unwrap_or_else(|_| "{}".to_string());
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/config/harness.json",
        &harness_json,
    )
    .await?;

    // Common tools (all strategies)
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/api-client.js",
        include_str!("../prompts/tools/api_client.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/update-phase.js",
        include_str!("../prompts/tools/update_phase.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/log-decision.js",
        include_str!("../prompts/tools/log_decision.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/write-metrics.js",
        include_str!("../prompts/tools/write_metrics.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/get-portfolio.js",
        include_str!("../prompts/tools/get_portfolio.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/aave-reserve-status.js",
        include_str!("../prompts/tools/aave_reserve_status.js"),
    )
    .await?;

    // Core strategy tools used by the current pack loop prompt.
    // Always deploy these to avoid stale/missing tools when a bot is restored
    // from snapshot and reactivated under a different strategy path.
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/analyze-opportunities.js",
        include_str!("../prompts/tools/analyze_opportunities.js"),
    )
    .await?;
    // One-command trade executor: circuit-breaker -> validate -> execute -> log
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/submit-trade.js",
        include_str!("../prompts/tools/submit_trade.js"),
    )
    .await?;
    // Order management: check fills, identify stale orders
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/check-orders.js",
        include_str!("../prompts/tools/check_orders.js"),
    )
    .await?;
    // CLOB collateral management (release/return vault funds for off-chain trading)
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/manage-collateral.js",
        include_str!("../prompts/tools/manage_collateral.js"),
    )
    .await?;
    // Legacy/raw data tools kept for fallback and diagnostics.
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/scan-markets.js",
        include_str!("../prompts/tools/scan_markets.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/check-prices.js",
        include_str!("../prompts/tools/check_prices.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/qa-stochastic-dex.js",
        include_str!("../prompts/tools/qa_stochastic_dex.js"),
    )
    .await?;

    // Meta-harness evolution tools
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/evolve-strategy.js",
        include_str!("../prompts/tools/evolve_strategy.js"),
    )
    .await?;
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/tools/record-candle.js",
        include_str!("../prompts/tools/record_candle.js"),
    )
    .await?;

    tracing::info!("Deployed pre-built trading tools for strategy: {strategy_type}");
    Ok(())
}

/// Write a file to the sidecar filesystem via the exec API.
///
/// Uses an environment variable to pass content, avoiding shell escaping issues.
pub(crate) async fn write_file_to_sidecar(
    sidecar_url: &str,
    token: &str,
    path: &str,
    content: &str,
) -> Result<(), String> {
    let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: sidecar_url.to_string(),
        command: format!(
            r#"node -e "require('fs').writeFileSync(process.argv[1], process.env.FILE_CONTENT)" "{path}""#,
        ),
        cwd: String::new(),
        env_json: serde_json::json!({"FILE_CONTENT": content}).to_string(),
        timeout_ms: 30_000,
    };
    ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req, token)
        .await
        .map_err(|e| format!("Failed to write {path}: {e}"))?;
    tracing::debug!("Wrote pre-built tool: {path}");
    Ok(())
}

pub(crate) fn remove_bot_workflows(bot_id: &str, workflow_id: u64) -> Result<(), String> {
    let store = ai_agent_sandbox_blueprint_lib::workflows::workflows()?;

    for id in [
        workflow_id,
        workflow_id.saturating_add(1),
        workflow_id.saturating_add(2),
    ] {
        let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(id);
        let _ = store.remove(&key);
    }

    let prefixes = [
        format!("fast-tick-{bot_id}"),
        format!("research-tick-{bot_id}"),
        format!("conversation-tick-{bot_id}"),
    ];
    if let Ok(all) = store.values() {
        for entry in all {
            if prefixes.iter().any(|p| entry.name.starts_with(p.as_str())) {
                let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(entry.id);
                let _ = store.remove(&key);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn submit_trade_tool_preserves_query_strings() {
        let tool = include_str!("../prompts/tools/submit_trade.js");
        assert!(tool.contains("path: url.pathname + url.search"));
        assert!(!tool.contains("path: url.pathname,"));
    }
}

/// Remove secrets from a bot: stop workflow, wipe user secrets from sidecar.
///
/// Uses `sandbox_runtime::secret_provisioning::wipe_secrets()` which preserves
/// the base env and only removes user-injected secrets.
///
/// When `mock_sandbox` is `Some`, skips Docker sidecar recreation and uses the
/// provided record instead.  Pass `None` in production.
pub async fn wipe_bot_secrets(
    bot_id: &str,
    mock_sandbox: Option<sandbox_runtime::SandboxRecord>,
) -> Result<(), String> {
    // Acquire per-bot lifecycle lock to prevent RACE-6 (wipe + activate interleave).
    let lock = bot_lifecycle_lock(bot_id);
    let _guard = lock.lock().await;

    let bot = get_bot(bot_id)?.ok_or_else(|| format!("Bot {bot_id} not found"))?;

    // Check sandbox state — secrets_configured is derived from sandbox record
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).ok();
    if let Some(ref s) = sandbox {
        if !s.has_user_secrets() {
            return Err("Bot has no secrets to wipe".to_string());
        }
    }

    // Remove all three split-tick workflows (fast=base, research=base+1, conversation=base+2).
    // Also sweep by name prefix to catch any stale workflows from a prior activation.
    if let Some(wf_id) = bot.workflow_id {
        if let Err(err) = remove_bot_workflows(&bot.id, wf_id) {
            tracing::warn!("Failed to remove workflows for bot {}: {err}", bot.id);
        }
    }

    // Wipe user secrets — sandbox-runtime preserves base env automatically
    let new_record = if let Some(r) = mock_sandbox {
        // Store mock sandbox with cleared user_env_json
        let mut stored = r.clone();
        stored.user_env_json = String::new();
        let _ = sandbox_runtime::runtime::sandboxes().map(|s| s.insert(stored.id.clone(), stored));
        r
    } else {
        sandbox_runtime::secret_provisioning::wipe_secrets(&bot.sandbox_id, None)
            .await
            .map_err(|e| format!("Failed to wipe secrets: {e}"))?
    };

    let new_sandbox_id = new_record.id.clone();
    bots()?
        .update(&bot_key(bot_id), |b| {
            b.sandbox_id.clone_from(&new_sandbox_id);
            b.workflow_id = None;
            b.trading_active = false;
        })
        .map_err(|e| format!("Failed to update bot record: {e}"))?;

    tracing::info!("Bot {bot_id} secrets wiped. Now in awaiting-secrets state.");
    Ok(())
}

/// Resolve the real vault address from VaultFactory.getServiceVaults().
///
/// During provision, the factory address is stored as a placeholder because the
/// BSM creates the real vault on-chain asynchronously. This queries the factory
/// to find the vault deployed for this service.
async fn resolve_vault_from_factory(
    bot: &crate::state::TradingBotRecord,
) -> Result<String, String> {
    use alloy::primitives::Address;
    use alloy::providers::Provider;
    use alloy::providers::ProviderBuilder;
    use alloy::sol_types::SolCall;

    let factory_hex = bot.vault_address.trim_start_matches("factory:").trim();
    let factory_addr: Address = factory_hex
        .parse()
        .map_err(|e| format!("Invalid factory address '{factory_hex}': {e}"))?;

    let rpc_url: reqwest::Url = bot
        .rpc_url
        .parse()
        .map_err(|e| format!("Invalid RPC URL '{}': {e}", bot.rpc_url))?;

    let provider = ProviderBuilder::new().connect_http(rpc_url);

    let has_blueprint_vault_index = local_trading_blueprint_address()?.is_some();
    if has_blueprint_vault_index {
        if let Some(vault) = resolve_blueprint_bot_vault(&provider, bot).await? {
            return Ok(vault);
        }

        if !bot.paper_trade {
            maybe_replay_local_provision_result(bot).await?;
            if let Some(vault) = resolve_blueprint_bot_vault(&provider, bot).await? {
                return Ok(vault);
            }
            return Err(format!(
                "No vault found for service {} call {} in TradingBlueprint.botVaults",
                bot.service_id, bot.call_id
            ));
        }
    }

    // Call VaultFactory.getServiceVaults(service_id)
    let call = trading_runtime::contracts::IVaultFactory::getServiceVaultsCall {
        serviceId: bot.service_id,
    };
    let calldata = call.abi_encode();

    let result = match provider
        .call(
            alloy::rpc::types::TransactionRequest::default()
                .to(factory_addr)
                .input(calldata.into()),
        )
        .await
    {
        Ok(result) => result,
        Err(factory_err) => {
            if let Ok(vault) = resolve_direct_vault_address(&provider, factory_addr).await {
                return Ok(vault);
            }
            return Err(format!("getServiceVaults call failed: {factory_err}"));
        }
    };

    let vaults = <alloy::sol_types::sol_data::Array<alloy::sol_types::sol_data::Address>
        as alloy::sol_types::SolType>::abi_decode(&result)
        .map_err(|e| format!("Failed to decode vault addresses: {e}"));

    let vaults = match vaults {
        Ok(vaults) => vaults,
        Err(decode_err) => {
            if let Ok(vault) = resolve_direct_vault_address(&provider, factory_addr).await {
                return Ok(vault);
            }
            return Err(decode_err);
        }
    };

    match vaults.len() {
        0 => Err("No vaults found for this service".into()),
        1 => Ok(format!("{:#x}", vaults[0])),
        n => Err(format!(
            "Ambiguous: {n} vaults found for service {}; cannot determine owner without explicit vault address",
            bot.service_id
        )),
    }
}

async fn resolve_blueprint_bot_vault<P>(
    provider: &P,
    bot: &crate::state::TradingBotRecord,
) -> Result<Option<String>, String>
where
    P: alloy::providers::Provider,
{
    use alloy::primitives::Address;
    use alloy::sol_types::SolCall;

    let Some(blueprint_addr) = local_trading_blueprint_address()? else {
        return Ok(None);
    };

    let call = trading_runtime::contracts::ITradingBlueprint::botVaultsCall {
        serviceId: bot.service_id,
        callId: bot.call_id,
    };
    let result = provider
        .call(
            alloy::rpc::types::TransactionRequest::default()
                .to(blueprint_addr)
                .input(call.abi_encode().into()),
        )
        .await
        .map_err(|e| format!("botVaults call failed: {e}"))?;

    let vault =
        <alloy::sol_types::sol_data::Address as alloy::sol_types::SolType>::abi_decode(&result)
            .map_err(|e| format!("Failed to decode botVaults address: {e}"))?;

    if vault == Address::ZERO {
        Ok(None)
    } else {
        Ok(Some(format!("{:#x}", vault)))
    }
}

fn local_trading_blueprint_address() -> Result<Option<alloy::primitives::Address>, String> {
    let Some(raw) = std::env::var("TRADING_BLUEPRINT_ADDRESS")
        .or_else(|_| std::env::var("TRADING_BLUEPRINT"))
        .or_else(|_| std::env::var("BLUEPRINT_CONTRACT"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    raw.parse()
        .map(Some)
        .map_err(|e| format!("Invalid TRADING_BLUEPRINT_ADDRESS '{raw}': {e}"))
}

fn local_tangle_contract_address() -> Result<Option<alloy::primitives::Address>, String> {
    let Some(raw) = std::env::var("TANGLE_CONTRACT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    raw.parse()
        .map(Some)
        .map_err(|e| format!("Invalid TANGLE_CONTRACT '{raw}': {e}"))
}

fn local_rpc_allows_anvil_impersonation(rpc_url: &str) -> bool {
    let explicit = std::env::var("LOCAL_ANVIL_REPLAY_JOB_RESULT")
        .ok()
        .is_some_and(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "on"));
    if explicit {
        return true;
    }

    rpc_url.contains("127.0.0.1") || rpc_url.contains("localhost")
}

async fn maybe_replay_local_provision_result(
    bot: &crate::state::TradingBotRecord,
) -> Result<(), String> {
    use alloy::primitives::{Address, Bytes, U256};
    use alloy::sol_types::SolCall;

    if bot.paper_trade || !local_rpc_allows_anvil_impersonation(&bot.rpc_url) {
        return Err("No vaults found for this service".into());
    }

    let Some(blueprint_addr) = local_trading_blueprint_address()? else {
        return Err("No vaults found for this service".into());
    };
    let Some(tangle_addr) = local_tangle_contract_address()? else {
        return Err("No vaults found for this service".into());
    };
    let operator: Address = bot
        .operator_address
        .parse()
        .map_err(|e| format!("Invalid operator address '{}': {e}", bot.operator_address))?;

    tracing::warn!(
        bot_id = %bot.id,
        service_id = bot.service_id,
        call_id = bot.call_id,
        "No bot vault found after provision; replaying local BSM onJobResult hook via Anvil impersonation"
    );

    let call = trading_runtime::contracts::ITradingBlueprint::onJobResultCall {
        serviceId: bot.service_id,
        job: 0,
        jobCallId: bot.call_id,
        operator,
        inputs: Bytes::new(),
        outputs: Bytes::new(),
    };

    let data = format!("0x{}", hex::encode(call.abi_encode()));
    let tangle = format!("{:#x}", tangle_addr);
    let blueprint = format!("{:#x}", blueprint_addr);
    let client = reqwest::Client::new();

    json_rpc(
        &client,
        &bot.rpc_url,
        "anvil_impersonateAccount",
        json!([tangle]),
    )
    .await?;
    json_rpc(
        &client,
        &bot.rpc_url,
        "anvil_setBalance",
        json!([tangle, format!("0x{:x}", U256::from(10u128.pow(20)))]),
    )
    .await?;
    let tx_hash = json_rpc(
        &client,
        &bot.rpc_url,
        "eth_sendTransaction",
        json!([{
            "from": tangle,
            "to": blueprint,
            "data": data,
            "gas": "0x7a1200",
        }]),
    )
    .await?;
    let _ = json_rpc(
        &client,
        &bot.rpc_url,
        "anvil_stopImpersonatingAccount",
        json!([tangle]),
    )
    .await;

    let tx_hash = tx_hash
        .as_str()
        .ok_or_else(|| "eth_sendTransaction returned non-string tx hash".to_string())?
        .to_string();
    wait_for_json_rpc_receipt(&client, &bot.rpc_url, &tx_hash).await?;
    Ok(())
}

async fn json_rpc(
    client: &reqwest::Client,
    rpc_url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let response: serde_json::Value = client
        .post(rpc_url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("{method} request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("{method} response decode failed: {e}"))?;

    if let Some(error) = response.get("error") {
        return Err(format!("{method} failed: {error}"));
    }

    Ok(response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

async fn wait_for_json_rpc_receipt(
    client: &reqwest::Client,
    rpc_url: &str,
    tx_hash: &str,
) -> Result<(), String> {
    for _ in 0..30 {
        let receipt = json_rpc(
            client,
            rpc_url,
            "eth_getTransactionReceipt",
            json!([tx_hash]),
        )
        .await?;
        if !receipt.is_null() {
            let status = receipt
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if status == "0x1" {
                return Ok(());
            }
            return Err(format!(
                "local onJobResult replay reverted: receipt={receipt}"
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(format!(
        "timed out waiting for local onJobResult replay tx {tx_hash}"
    ))
}

async fn resolve_direct_vault_address<P>(
    provider: &P,
    vault_addr: alloy::primitives::Address,
) -> Result<String, String>
where
    P: alloy::providers::Provider,
{
    use alloy::sol_types::SolCall;

    let call = trading_runtime::contracts::ITradingVault::assetCall {};
    provider
        .call(
            alloy::rpc::types::TransactionRequest::default()
                .to(vault_addr)
                .input(call.abi_encode().into()),
        )
        .await
        .map_err(|e| format!("asset() call failed: {e}"))?;

    Ok(format!("{vault_addr:#x}"))
}
