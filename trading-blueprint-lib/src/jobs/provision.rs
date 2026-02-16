use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{TradingBotRecord, bot_key, bots};
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
) -> Result<TradingProvisionOutput, String> {
    // 1. Generate bot ID and API token
    let bot_id = format!("trading-{}", uuid::Uuid::new_v4());
    let api_token = sandbox_runtime::auth::generate_token();

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

    // 7. Create cron workflow for trading loop
    let workflow_prompt = crate::prompts::build_loop_prompt(&request.strategy_type);
    let workflow_json = json!({
        "sidecar_url": record.sidecar_url,
        "prompt": workflow_prompt,
        "session_id": format!("trading-{bot_id}"),
        "max_turns": 10,
        "timeout_ms": 120_000,
        "sidecar_token": record.token,
    })
    .to_string();

    let workflow_id = chrono::Utc::now().timestamp_millis() as u64;
    let cron_config = if request.trading_loop_cron.is_empty() {
        "0 */5 * * * *".to_string() // Default: every 5 minutes
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

    // 8. Store TradingBotRecord
    let operator_address = op_ctx
        .map(|c| c.operator_address.clone())
        .unwrap_or_default();

    let validator_service_ids: Vec<u64> = request
        .validator_service_ids
        .iter()
        .copied()
        .collect();

    let max_lifetime_days = if request.max_lifetime_days == 0 { 30 } else { request.max_lifetime_days };

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
    };

    bots()?
        .insert(bot_key(&bot_id), bot_record)
        .map_err(|e| format!("Failed to store bot record: {e}"))?;

    // 9. Return result
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
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingProvisionRequest>,
) -> Result<TangleResult<TradingProvisionOutput>, String> {
    Ok(TangleResult(provision_core(request, None).await?))
}
