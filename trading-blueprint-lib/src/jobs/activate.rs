//! Bot activation with off-chain secrets (phase 2 of two-phase provisioning).
//!
//! After a bot is provisioned on-chain with base env only, the user pushes
//! secrets through the operator API. This module handles injecting user secrets
//! into the sidecar, running strategy pack setup, and creating the cron workflow.
//!
//! The sandbox-runtime handles base/user env separation internally:
//! - `inject_secrets(id, user_env)` merges user env on top of base env
//! - `wipe_secrets(id)` removes user env, preserving base env

use serde_json::json;

use crate::state::{bot_key, bots, clear_activation, get_bot, update_activation_progress};

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
    // 1. Load and validate
    update_activation_progress(bot_id, "validating", "Loading bot configuration");

    let bot = get_bot(bot_id)?.ok_or_else(|| format!("Bot {bot_id} not found"))?;

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
        let user_env_json = serde_json::to_string(&user_env).unwrap_or_default();
        let mut stored = r.clone();
        stored.user_env_json = user_env_json;
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
            &bot.strategy_type,
            &bot.trading_api_url,
            &bot.trading_api_token,
            &bot.operator_address,
        )
        .await
        {
            tracing::warn!("Pre-built tool deployment failed (non-fatal): {e}");
        }
    }

    // 4. Create workflow
    update_activation_progress(bot_id, "creating_workflow", "Configuring trading loop");
    let workflow_id = {
        let ts = chrono::Utc::now().timestamp_millis() as u64;
        let rand_bits = (uuid::Uuid::new_v4().as_u128() & 0xFFFF) as u64;
        ts.wrapping_mul(100_000).wrapping_add(rand_bits)
    };

    let (loop_prompt, backend_profile) = match &pack {
        Some(p) => (
            crate::prompts::build_pack_loop_prompt(p),
            crate::prompts::build_pack_agent_profile(p, &bot),
        ),
        None => (
            crate::prompts::build_loop_prompt(&bot.strategy_type),
            crate::prompts::build_generic_agent_profile(&bot.strategy_type, &bot),
        ),
    };

    let wf = json!({
        "sidecar_url": record.sidecar_url,
        "prompt": loop_prompt,
        "session_id": format!("trading-{bot_id}"),
        "max_turns": pack.as_ref().map(|p| p.max_turns).filter(|&t| t > 0).unwrap_or(10),
        "timeout_ms": pack.as_ref().map(|p| p.timeout_ms).filter(|&t| t > 0).unwrap_or(600_000),
        "sidecar_token": record.token,
        "backend_profile_json": serde_json::to_string(&backend_profile).unwrap_or_default(),
    });

    let cron_config = if !bot.trading_loop_cron.is_empty() {
        bot.trading_loop_cron.clone()
    } else {
        pack.as_ref()
            .map(|p| p.default_cron.clone())
            .unwrap_or_else(|| "0 */5 * * * *".to_string())
    };

    let next_run =
        ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run("cron", &cron_config, None)
            .unwrap_or(None);

    let entry = ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
        id: workflow_id,
        name: format!("trading-loop-{bot_id}"),
        workflow_json: wf.to_string(),
        trigger_type: "cron".to_string(),
        trigger_config: cron_config,
        sandbox_config_json: String::new(),
        active: true,
        next_run_at: next_run,
        last_run_at: None,
        owner: String::new(),
    };

    ai_agent_sandbox_blueprint_lib::workflows::workflows()?
        .insert(
            ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id),
            entry,
        )
        .map_err(|e| format!("Failed to store workflow: {e}"))?;

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

/// Deploy pre-built trading tools to the sidecar filesystem.
///
/// Writes smart, self-contained tools that do the heavy lifting so the agent
/// can focus on decision-making. Common tools for all strategies + strategy-specific tools.
/// Also writes `/home/agent/config/api.json` so tools can call the Trading HTTP API.
async fn write_prebuilt_tools(
    sidecar_url: &str,
    token: &str,
    strategy_type: &str,
    api_url: &str,
    api_token: &str,
    operator_address: &str,
) -> Result<(), String> {
    // Write API config so tools can find the Trading HTTP API
    let config_json = serde_json::json!({
        "api_url": api_url,
        "token": api_token,
        "operator_address": operator_address,
    })
    .to_string();
    write_file_to_sidecar(
        sidecar_url,
        token,
        "/home/agent/config/api.json",
        &config_json,
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

    // Strategy-specific smart tools
    if strategy_type.starts_with("prediction") || strategy_type == "mm" {
        // Smart analyzer: scans markets, fetches prices, filters to actionable opportunities
        write_file_to_sidecar(
            sidecar_url,
            token,
            "/home/agent/tools/analyze-opportunities.js",
            include_str!("../prompts/tools/analyze_opportunities.js"),
        )
        .await?;
        // One-command trade executor: circuit-breaker → validate → execute → log
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
        // Keep legacy tools for fallback (agent can use either)
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
    }

    tracing::info!("Deployed pre-built trading tools for strategy: {strategy_type}");
    Ok(())
}

/// Write a file to the sidecar filesystem via the exec API.
///
/// Uses an environment variable to pass content, avoiding shell escaping issues.
async fn write_file_to_sidecar(
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
    let bot = get_bot(bot_id)?.ok_or_else(|| format!("Bot {bot_id} not found"))?;

    // Check sandbox state — secrets_configured is derived from sandbox record
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).ok();
    if let Some(ref s) = sandbox {
        if !s.has_user_secrets() {
            return Err("Bot has no secrets to wipe".to_string());
        }
    }

    // Stop and remove workflow
    if let Some(wf_id) = bot.workflow_id {
        let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id);
        let _ =
            ai_agent_sandbox_blueprint_lib::workflows::workflows().map(|store| store.remove(&key));
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
