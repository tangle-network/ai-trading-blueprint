use blueprint_sdk::tangle::extract::{CallId, Caller, TangleArg, TangleResult};
use sandbox_runtime::provision_progress::{self, ProvisionPhase};

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
///
/// Two-phase provisioning (always):
///   1. Sidecar created with base env only (no secrets)
///   2. Bot record stored with `trading_active=false`
///   3. Returns `workflow_id: 0` to signal "awaiting secrets"
///   4. User pushes secrets via operator API → sidecar recreated → workflow created
///
/// Any `env_json` in the on-chain request is **ignored** to prevent secrets
/// from leaking into on-chain calldata.
pub async fn provision_core(
    request: TradingProvisionRequest,
    mock_sandbox: Option<SandboxRecord>,
    call_id: u64,
    service_id: u64,
    caller: String,
) -> Result<TradingProvisionOutput, String> {
    // 1. Generate bot ID and API token
    let bot_id = format!("trading-{}", uuid::Uuid::new_v4());
    let api_token = sandbox_runtime::auth::generate_token();

    // Start tracking provision progress via sandbox-runtime
    let _ = provision_progress::start_provision(call_id);
    let _ = provision_progress::update_provision_metadata(
        call_id,
        serde_json::json!({ "service_id": service_id }),
    );

    // 2. Get operator context for shared config (if initialized)
    let op_ctx = crate::context::operator_context();

    // 3. Resolve validator endpoints via discovery module
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

    // 5. Resolve operator address early (needed in both env and bot record)
    let operator_address = op_ctx
        .map(|c| c.operator_address.clone())
        .unwrap_or_default();

    // 6. Build base env_json for sidecar (no secrets — never from on-chain data)
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
    env.insert(
        "OPERATOR_ADDRESS".into(),
        serde_json::Value::String(operator_address.clone()),
    );
    env.insert(
        "SUBMITTER_ADDRESS".into(),
        serde_json::Value::String(caller.clone()),
    );

    // Pass discovered validator endpoints to sidecar
    if !validator_endpoints.is_empty() {
        env.insert(
            "VALIDATOR_ENDPOINTS".into(),
            serde_json::Value::String(validator_endpoints.join(",")),
        );
    }

    let env_json = serde_json::to_string(&env).unwrap_or_default();

    // 6. Create sidecar sandbox (or use mock)
    let _ = provision_progress::update_provision(
        call_id,
        ProvisionPhase::ContainerCreate,
        Some("Launching Docker container".into()),
        None,
    );

    let record = if let Some(r) = mock_sandbox {
        // Store mock sandbox so activate/wipe can look it up
        let _ = sandbox_runtime::runtime::sandboxes()
            .map(|s| s.insert(r.id.clone(), r.clone()));
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
            tee_config: None,
            owner: String::new(),
            user_env_json: String::new(), // Two-phase: user secrets arrive via operator API
        };

        let (r, _attestation) = sandbox_runtime::runtime::create_sidecar(&params, None)
            .await
            .map_err(|e| format!("Failed to create sidecar: {e}"))?;
        r
    };

    let _ = provision_progress::update_provision(
        call_id,
        ProvisionPhase::ContainerStart,
        Some("Container launched successfully".into()),
        Some(record.id.clone()),
    );

    // 8. Build TradingBotRecord — always awaiting secrets
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
        workflow_id: None,
        trading_active: false,
        created_at: chrono::Utc::now().timestamp() as u64,
        operator_address,
        validator_service_ids,
        max_lifetime_days,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: caller,
        trading_loop_cron: request.trading_loop_cron.clone(),
    };

    // 8. Store bot record
    let _ = provision_progress::update_provision(
        call_id,
        ProvisionPhase::HealthCheck,
        Some("Finalizing bot configuration".into()),
        None,
    );
    let _ = provision_progress::update_provision_metadata(
        call_id,
        serde_json::json!({ "service_id": service_id, "bot_id": &bot_id, "sandbox_id": &record.id }),
    );

    bots()?
        .insert(bot_key(&bot_id), bot_record)
        .map_err(|e| format!("Failed to store bot record: {e}"))?;

    let _ = provision_progress::update_provision(
        call_id,
        ProvisionPhase::Ready,
        Some("Provision complete — awaiting API key configuration".into()),
        None,
    );

    tracing::info!("Bot {bot_id} provisioned (awaiting secrets). Sandbox: {}, Vault: {vault_address}", record.id);

    // 9. Return result — workflow_id=0 signals "awaiting secrets" to the frontend
    let vault_addr_parsed: alloy::primitives::Address = vault_address
        .parse()
        .unwrap_or(request.factory_address);

    Ok(TradingProvisionOutput {
        vault_address: vault_addr_parsed,
        share_token: alloy::primitives::Address::ZERO,
        sandbox_id: record.id,
        workflow_id: 0,
    })
}

/// Provision a new trading bot instance (Tangle handler).
pub async fn provision(
    CallId(call_id): CallId,
    Caller(caller): Caller,
    TangleArg(request): TangleArg<TradingProvisionRequest>,
) -> Result<TangleResult<TradingProvisionOutput>, String> {
    let service_id = crate::context::operator_context()
        .map(|c| c.service_id)
        .unwrap_or(0);
    let caller_addr = alloy::primitives::Address::from(caller);
    let caller_str = format!("{caller_addr:#x}");
    Ok(TangleResult(provision_core(request, None, call_id, service_id, caller_str).await?))
}
