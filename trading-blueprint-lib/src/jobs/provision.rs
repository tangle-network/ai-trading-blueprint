use blueprint_sdk::tangle::extract::{CallId, Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{TradingBotRecord, bot_key, bots, update_provision_progress};
use crate::{TradingProvisionOutput, TradingProvisionRequest};
use sandbox_runtime::CreateSandboxParams;
use sandbox_runtime::SandboxRecord;

/// Provision core logic, testable without Tangle extractors.
///
/// When `mock_sandbox` is `Some`, skips Docker sidecar creation and uses the
/// provided record instead.  Pass `None` in production to create a real
/// sidecar container.
///
/// Note: Vault creation happens on-chain in Solidity `onServiceInitialized`,
/// NOT here.  The `factory_address` field is used as the pre-deployed vault
/// address (set by the BSM contract before the operator receives the job).
pub async fn provision_core(
    request: TradingProvisionRequest,
    mock_sandbox: Option<SandboxRecord>,
    call_id: u64,
    service_id: u64,
) -> Result<TradingProvisionOutput, String> {
    // 1. Generate bot ID and API token
    let bot_id = format!("trading-{}", uuid::Uuid::new_v4());
    let api_token = sandbox_runtime::auth::generate_token();

    update_provision_progress(call_id, service_id, "initializing", "Preparing environment", None, None);

    // 2. Get operator context for shared config (if initialized)
    let op_ctx = crate::context::operator_context();

    // 3. Resolve validator endpoints via discovery module
    //    Tries on-chain discovery (per-service env vars) then VALIDATOR_ENDPOINTS fallback.
    let validator_service_ids_slice: Vec<u64> = request
        .validator_service_ids
        .iter()
        .copied()
        .collect();
    let validator_endpoints = crate::discovery::discover_validator_endpoints(
        &validator_service_ids_slice,
    )
    .await;

    // 4. Resolve config from operator context or env
    let chain_id: u64 = request.chain_id.try_into().unwrap_or(1);

    let rpc_url = if request.rpc_url.is_empty() {
        std::env::var("RPC_URL").unwrap_or_else(|_| "http://localhost:8545".to_string())
    } else {
        request.rpc_url.clone()
    };

    // Vault address comes from the BSM contract (set during onServiceInitialized)
    let vault_address = format!("{}", request.factory_address);

    // Trading API URL points to the shared HTTP API running in the binary
    let trading_api_url = std::env::var("TRADING_API_URL")
        .unwrap_or_else(|_| "http://host.docker.internal:9100".to_string());

    // 5. Build env_json for sidecar
    let mut env = serde_json::Map::new();
    env.insert(
        "TRADING_HTTP_API_URL".into(),
        serde_json::Value::String(trading_api_url.clone()),
    );
    env.insert(
        "TRADING_API_TOKEN".into(),
        serde_json::Value::String(api_token.clone()),
    );
    env.insert(
        "VAULT_ADDRESS".into(),
        serde_json::Value::String(vault_address.clone()),
    );
    env.insert(
        "STRATEGY_TYPE".into(),
        serde_json::Value::String(request.strategy_type.clone()),
    );
    env.insert(
        "STRATEGY_CONFIG".into(),
        serde_json::Value::String(request.strategy_config_json.clone()),
    );
    env.insert(
        "RPC_URL".into(),
        serde_json::Value::String(rpc_url.clone()),
    );
    env.insert(
        "CHAIN_ID".into(),
        serde_json::Value::String(chain_id.to_string()),
    );

    // Pass discovered validator endpoints to sidecar
    if !validator_endpoints.is_empty() {
        env.insert(
            "VALIDATOR_ENDPOINTS".into(),
            serde_json::Value::String(validator_endpoints.join(",")),
        );
    }

    // Merge user-provided env vars
    if !request.env_json.trim().is_empty() {
        if let Ok(user_env) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&request.env_json)
        {
            env.extend(user_env);
        }
    }

    let env_json = serde_json::to_string(&env).unwrap_or_default();

    // 6. Create sidecar sandbox (or use mock)
    update_provision_progress(call_id, service_id, "creating_sidecar", "Launching Docker container", None, None);

    let record = if let Some(r) = mock_sandbox {
        r
    } else {
        let params = CreateSandboxParams {
            name: request.name.clone(),
            image: std::env::var("SIDECAR_IMAGE")
                .unwrap_or_else(|_| sandbox_runtime::DEFAULT_SIDECAR_IMAGE.to_string()),
            stack: String::new(),
            agent_identifier: format!("trading-{}", request.strategy_type),
            env_json,
            metadata_json: String::new(),
            ssh_enabled: false,
            ssh_public_key: String::new(),
            web_terminal_enabled: false,
            max_lifetime_seconds: {
                let days = if request.max_lifetime_days == 0 { 30 } else { request.max_lifetime_days };
                days * 86400
            },
            idle_timeout_seconds: 0,          // No idle timeout for trading bots
            cpu_cores: request.cpu_cores,
            memory_mb: request.memory_mb,
            disk_gb: 10,
            sidecar_token: String::new(), // Auto-generated
            tee_config: None,
        };

        let (r, _attestation) = sandbox_runtime::runtime::create_sidecar(&params, None)
            .await
            .map_err(|e| format!("Failed to create sidecar: {e}"))?;
        r
    };

    // 7. Build TradingBotRecord (before workflow so pack can reference it)
    let operator_address = op_ctx
        .map(|c| c.operator_address.clone())
        .unwrap_or_default();

    let validator_service_ids: Vec<u64> = request
        .validator_service_ids
        .iter()
        .copied()
        .collect();

    let max_lifetime_days = if request.max_lifetime_days == 0 { 30 } else { request.max_lifetime_days };
    // Use timestamp_millis + random bits to avoid collisions in parallel tests
    let workflow_id = {
        let ts = chrono::Utc::now().timestamp_millis() as u64;
        let rand_bits = (uuid::Uuid::new_v4().as_u128() & 0xFFFF) as u64;
        ts.wrapping_mul(100_000).wrapping_add(rand_bits)
    };

    let bot_record = TradingBotRecord {
        id: bot_id.clone(),
        sandbox_id: record.id.clone(),
        vault_address: vault_address.clone(),
        share_token: String::new(),
        strategy_type: request.strategy_type.clone(),
        strategy_config: serde_json::from_str(&request.strategy_config_json).unwrap_or_default(),
        risk_params: serde_json::from_str(&request.risk_params_json).unwrap_or_default(),
        chain_id,
        rpc_url,
        trading_api_url,
        trading_api_token: api_token,
        workflow_id: Some(workflow_id),
        trading_active: true,
        created_at: chrono::Utc::now().timestamp() as u64,
        operator_address,
        validator_service_ids,
        max_lifetime_days,
        paper_trade: true,
        wind_down_started_at: None,
    };

    // 8. Look up strategy pack and run setup commands
    update_provision_progress(call_id, service_id, "running_setup", "Installing strategy dependencies", Some(&bot_id), Some(&record.id));

    let pack = crate::prompts::packs::get_pack(&request.strategy_type);

    if let Some(ref p) = pack {
        for cmd in &p.setup_commands {
            let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
                sidecar_url: record.sidecar_url.clone(),
                command: cmd.clone(),
                cwd: String::new(),
                env_json: String::new(),
                timeout_ms: 300_000, // 5 min for pip installs
                sidecar_token: record.token.clone(),
            };
            if let Err(e) = ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req).await {
                tracing::warn!("Pack setup command failed (non-fatal): {cmd}: {e}");
            }
        }
    }

    // 9. Create cron workflow for trading loop
    update_provision_progress(call_id, service_id, "creating_workflow", "Configuring trading loop", Some(&bot_id), Some(&record.id));
    let (loop_prompt, backend_profile) = match &pack {
        Some(p) => (
            crate::prompts::build_pack_loop_prompt(p),
            crate::prompts::build_pack_agent_profile(p, &bot_record),
        ),
        None => (
            crate::prompts::build_loop_prompt(&request.strategy_type),
            crate::prompts::build_generic_agent_profile(
                &request.strategy_type,
                &bot_record,
            ),
        ),
    };

    let wf = json!({
        "sidecar_url": record.sidecar_url,
        "prompt": loop_prompt,
        "session_id": format!("trading-{bot_id}"),
        "max_turns": pack.as_ref().map(|p| p.max_turns).filter(|&t| t > 0).unwrap_or(10),
        "timeout_ms": pack.as_ref().map(|p| p.timeout_ms).filter(|&t| t > 0).unwrap_or(120_000),
        "sidecar_token": record.token,
        "backend_profile_json": serde_json::to_string(&backend_profile).unwrap_or_default(),
    });
    let workflow_json = wf.to_string();

    let cron_config = if request.trading_loop_cron.is_empty() {
        pack.as_ref()
            .map(|p| p.default_cron.clone())
            .unwrap_or_else(|| "0 */5 * * * *".to_string())
    } else {
        request.trading_loop_cron.clone()
    };

    let next_run = ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run(
        "cron",
        &cron_config,
        None,
    )
    .unwrap_or(None);

    let entry = ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
        id: workflow_id,
        name: format!("trading-loop-{bot_id}"),
        workflow_json,
        trigger_type: "cron".to_string(),
        trigger_config: cron_config,
        sandbox_config_json: String::new(),
        active: true,
        next_run_at: next_run,
        last_run_at: None,
    };

    ai_agent_sandbox_blueprint_lib::workflows::workflows()?
        .insert(
            ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id),
            entry,
        )
        .map_err(|e| format!("Failed to store workflow: {e}"))?;

    // 10. Store bot record
    update_provision_progress(call_id, service_id, "storing_record", "Finalizing bot configuration", Some(&bot_id), Some(&record.id));

    bots()?
        .insert(bot_key(&bot_id), bot_record)
        .map_err(|e| format!("Failed to store bot record: {e}"))?;

    update_provision_progress(call_id, service_id, "complete", "Provision complete", Some(&bot_id), Some(&record.id));

    // 11. Return result
    let vault_addr_parsed: alloy::primitives::Address = vault_address
        .parse()
        .unwrap_or(request.factory_address);

    Ok(TradingProvisionOutput {
        vault_address: vault_addr_parsed,
        share_token: alloy::primitives::Address::ZERO,
        sandbox_id: record.id,
        workflow_id,
    })
}

/// Provision a new trading bot instance (Tangle handler).
pub async fn provision(
    CallId(call_id): CallId,
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingProvisionRequest>,
) -> Result<TangleResult<TradingProvisionOutput>, String> {
    let service_id = crate::context::operator_context()
        .map(|c| c.service_id)
        .unwrap_or(0);
    Ok(TangleResult(provision_core(request, None, call_id, service_id).await?))
}
