use std::collections::HashSet;
use std::sync::Mutex;

use blueprint_sdk::tangle::extract::{CallId, Caller, TangleArg, TangleResult};
use sandbox_runtime::provision_progress::{self, ProvisionPhase};
use serde_json::{Map, Value};

use crate::state::{TradingBotRecord, bot_key, bots};
use crate::{TradingProvisionOutput, TradingProvisionRequest};
use sandbox_runtime::CreateSandboxParams;
use sandbox_runtime::SandboxRecord;

/// Keyed lock set for provision dedup — prevents TOCTOU race between
/// find_bot_by_call and insert. A (service_id, call_id) pair is inserted
/// before the check and removed after the insert, ensuring only one
/// concurrent provision for a given key can proceed.
static PROVISION_INFLIGHT: std::sync::LazyLock<Mutex<HashSet<(u64, u64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

const DEFAULT_PAPER_INITIAL_CAPITAL_USD: &str = "10000";
const SIDECAR_STORAGE_PATH: &str = "/tmp/sidecar-state";

/// Drop guard that removes a (service_id, call_id) from PROVISION_INFLIGHT.
struct InflightGuard(u64, u64);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = PROVISION_INFLIGHT.lock() {
            set.remove(&(self.0, self.1));
        }
    }
}

fn parse_strategy_config_object(
    strategy_config_json: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let trimmed = strategy_config_json.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let parsed: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("Invalid strategy_config_json: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "strategy_config_json must be a JSON object".to_string())?;

    Ok(Some(obj.clone()))
}

fn parse_runtime_backend_from_strategy_config(
    strategy_config: Option<&Map<String, Value>>,
) -> Result<Option<String>, String> {
    let Some(obj) = strategy_config else {
        return Ok(None);
    };

    let Some(raw) = obj.get("runtime_backend").and_then(Value::as_str) else {
        return Ok(None);
    };

    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "docker" | "container" => Ok(Some("docker".to_string())),
        "firecracker" | "microvm" => Ok(Some("firecracker".to_string())),
        "tee" | "confidential" | "confidential-vm" => Ok(Some("tee".to_string())),
        _ => Err(format!(
            "strategy_config_json.runtime_backend must be one of: docker, firecracker, tee (got '{raw}')"
        )),
    }
}

fn parse_paper_trade_from_strategy_config(
    strategy_config: Option<&Map<String, Value>>,
) -> Result<Option<bool>, String> {
    let Some(obj) = strategy_config else {
        return Ok(None);
    };

    match obj.get("paper_trade") {
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err("strategy_config_json.paper_trade must be a boolean".to_string()),
        None => Ok(None),
    }
}

fn default_paper_initial_capital_value() -> Value {
    let configured = std::env::var("DEFAULT_PAPER_INITIAL_CAPITAL_USD")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PAPER_INITIAL_CAPITAL_USD.to_string());
    Value::String(configured)
}

fn has_configured_asset_token(asset_token: alloy::primitives::Address) -> bool {
    asset_token != alloy::primitives::Address::ZERO
}

fn apply_strategy_defaults(
    strategy_config: &mut Map<String, Value>,
    request: &TradingProvisionRequest,
    paper_trade: bool,
) {
    if has_configured_asset_token(request.asset_token) {
        strategy_config
            .entry("asset_token".to_string())
            .or_insert_with(|| Value::String(format!("{:#x}", request.asset_token)));
    }

    if paper_trade {
        strategy_config
            .entry("initial_capital_usd".to_string())
            .or_insert_with(default_paper_initial_capital_value);
    }
}

fn mark_provision_failed(call_id: u64, error: &str) {
    if let Err(e) = provision_progress::update_provision(
        call_id,
        ProvisionPhase::Failed,
        Some(error.to_string()),
        None,
        None,
    ) {
        tracing::warn!("Provision progress failure update failed: {e}");
    }
}

/// Provision core logic, testable without Tangle extractors.
///
/// When `mock_sandbox` is `Some`, skips Docker sidecar creation and uses the
/// provided record instead.  Pass `None` in production to create a real
/// sidecar container.
///
/// Note: Vault creation happens on-chain in Solidity `onJobResult` (per-bot),
/// NOT here.  The operator returns Address::ZERO for vault_address; the BSM
/// creates the vault via VaultFactory.createBotVault() when it receives the result.
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
    tee_backend: Option<&dyn sandbox_runtime::tee::TeeBackend>,
) -> Result<TradingProvisionOutput, String> {
    // 0. Dedup check — if a bot already exists for this (service_id, call_id),
    // return it instead of creating a duplicate. This handles operator restarts
    // that replay past on-chain events.
    //
    // Race-safety: PROVISION_INFLIGHT prevents TOCTOU between the
    // find_bot_by_call check and the later insert. If another concurrent
    // provision for the same key is already running, we block it here.
    if call_id > 0 {
        if let Ok(Some(existing)) = crate::state::find_bot_by_call(service_id, call_id) {
            tracing::info!(
                bot_id = %existing.id,
                service_id,
                call_id,
                "Provision dedup: returning existing bot for (service_id={service_id}, call_id={call_id})"
            );
            return Ok(TradingProvisionOutput {
                vault_address: existing
                    .vault_address
                    .parse()
                    .unwrap_or(alloy::primitives::Address::ZERO),
                share_token: existing
                    .share_token
                    .parse()
                    .unwrap_or(alloy::primitives::Address::ZERO),
                sandbox_id: existing.sandbox_id,
                workflow_id: existing.workflow_id.unwrap_or(0),
            });
        }

        // Atomically claim this (service_id, call_id) slot. If another call
        // already holds it, reject as duplicate-in-progress.
        let already_inflight = {
            let mut set = PROVISION_INFLIGHT.lock().unwrap_or_else(|e| e.into_inner());
            !set.insert((service_id, call_id))
        };
        if already_inflight {
            return Err(format!(
                "Provision already in progress for (service_id={service_id}, call_id={call_id})"
            ));
        }
    }

    // Drop guard: auto-clears PROVISION_INFLIGHT on any exit (success, error, panic).
    let _inflight_guard = if call_id > 0 {
        Some(InflightGuard(service_id, call_id))
    } else {
        None
    };

    // 1. Generate bot ID and API token
    let bot_id = format!("trading-{}", uuid::Uuid::new_v4());
    let api_token = sandbox_runtime::auth::generate_token();

    // Start tracking provision progress via sandbox-runtime
    if let Err(e) = provision_progress::start_provision(call_id) {
        tracing::warn!("Provision progress tracking failed: {e}");
    }
    if let Err(e) = provision_progress::update_provision_metadata(
        call_id,
        serde_json::json!({ "service_id": service_id }),
    ) {
        tracing::warn!("Provision metadata update failed: {e}");
    }

    let mut parsed_strategy_config = parse_strategy_config_object(&request.strategy_config_json)
        .inspect_err(|e| mark_provision_failed(call_id, e))?;
    let runtime_backend =
        parse_runtime_backend_from_strategy_config(parsed_strategy_config.as_ref())
            .inspect_err(|e| mark_provision_failed(call_id, e))?;
    let paper_trade = parse_paper_trade_from_strategy_config(parsed_strategy_config.as_ref())
        .inspect_err(|e| mark_provision_failed(call_id, e))?
        .unwrap_or(true);
    let strategy_config_obj = parsed_strategy_config.get_or_insert_with(Default::default);
    apply_strategy_defaults(strategy_config_obj, &request, paper_trade);

    // 2. Get operator context for shared config (if initialized)
    let op_ctx = crate::context::operator_context();

    // 3. Resolve validator endpoints via discovery module
    let validator_service_ids_slice: Vec<u64> = request.validator_service_ids.to_vec();
    let validator_endpoints =
        crate::discovery::discover_validator_endpoints(&validator_service_ids_slice).await;

    // 4. Resolve config from operator context or env
    let chain_id: u64 = request.chain_id.try_into().unwrap_or(1);

    let rpc_url = if request.rpc_url.is_empty() {
        std::env::var("RPC_URL").unwrap_or_else(|_| "http://localhost:8545".to_string())
    } else {
        // Validate user-supplied RPC URL to block SSRF (internal IPs, metadata endpoints)
        trading_runtime::url_validation::validate_rpc_url(&request.rpc_url)
            .map_err(|e| format!("invalid rpc_url from provision request: {e}"))?
    };

    // Vault will be created on-chain in onJobResult via VaultFactory.createBotVault().
    // Store factory address prefixed with "factory:" so activate can detect it needs
    // resolution. The BSM creates the real vault on-chain, but never updates the
    // operator-side record — activate resolves it via getServiceVaults().
    let vault_address = format!("factory:{:#x}", request.factory_address);

    // Trading API URL points to the shared HTTP API running in the binary.
    // TRADING_API_URL overrides if explicitly set, otherwise:
    // - SIDECAR_NETWORK_HOST=true → container shares host network → use 127.0.0.1
    // - Otherwise → use host.docker.internal (added via --add-host in sandbox-runtime)
    let trading_api_url = std::env::var("TRADING_API_URL").unwrap_or_else(|_| {
        let host_network =
            std::env::var("SIDECAR_NETWORK_HOST").is_ok_and(|v| v == "true" || v == "1");
        let host = std::env::var("SIDECAR_PUBLIC_HOST").unwrap_or_else(|_| {
            if host_network {
                "127.0.0.1".to_string()
            } else {
                "host.docker.internal".to_string()
            }
        });
        let port = std::env::var("TRADING_API_PORT").unwrap_or_else(|_| "9100".to_string());
        format!("http://{host}:{port}")
    });

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
    // VAULT_ADDRESS will be set later after on-chain vault creation
    // (resolved when secrets are configured via operator API)
    env.insert(
        "STRATEGY_TYPE".into(),
        serde_json::Value::String(request.strategy_type.clone()),
    );
    env.insert(
        "STRATEGY_CONFIG".into(),
        serde_json::Value::String(request.strategy_config_json.clone()),
    );
    env.insert("RPC_URL".into(), serde_json::Value::String(rpc_url.clone()));
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
    env.insert(
        "STORAGE_PATH".into(),
        serde_json::Value::String(SIDECAR_STORAGE_PATH.to_string()),
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
    let launch_detail = if runtime_backend.as_deref() == Some("firecracker") {
        "Launching Firecracker microVM"
    } else {
        "Launching Docker container"
    };
    if let Err(e) = provision_progress::update_provision(
        call_id,
        ProvisionPhase::ContainerCreate,
        Some(launch_detail.into()),
        None,
        None,
    ) {
        tracing::warn!("Provision progress update failed: {e}");
    }

    let record = if let Some(r) = mock_sandbox {
        // Store mock sandbox so activate/wipe can look it up
        let _ = sandbox_runtime::runtime::sandboxes().map(|s| s.insert(r.id.clone(), r.clone()));
        r
    } else {
        let mut metadata = Map::new();
        if let Some(backend) = runtime_backend.as_deref() {
            metadata.insert(
                "runtime_backend".to_string(),
                Value::String(backend.to_string()),
            );
        }
        let metadata_json = Value::Object(metadata).to_string();

        let params = CreateSandboxParams {
            name: request.name.clone(),
            image: std::env::var("SIDECAR_IMAGE")
                .unwrap_or_else(|_| sandbox_runtime::DEFAULT_SIDECAR_IMAGE.to_string()),
            stack: String::new(),
            agent_identifier: format!("trading-{}", request.strategy_type),
            env_json,
            metadata_json,
            ssh_enabled: false,
            ssh_public_key: String::new(),
            web_terminal_enabled: false,
            max_lifetime_seconds: {
                let days = if request.max_lifetime_days == 0 {
                    30
                } else {
                    request.max_lifetime_days
                };
                days * 86400
            },
            idle_timeout_seconds: 0, // No idle timeout for trading bots
            cpu_cores: request.cpu_cores,
            memory_mb: request.memory_mb,
            disk_gb: 10,
            tee_config: None,
            service_id: None,
            owner: String::new(),
            user_env_json: String::new(), // Two-phase: user secrets arrive via operator API
            port_mappings: Vec::new(),
        };

        let (r, _attestation) = sandbox_runtime::runtime::create_sidecar(&params, tee_backend)
            .await
            .map_err(|e| {
                let msg = format!("Failed to create sidecar: {e}");
                mark_provision_failed(call_id, &msg);
                msg
            })?;
        r
    };

    if let Err(e) = provision_progress::update_provision(
        call_id,
        ProvisionPhase::ContainerStart,
        Some("Container launched successfully".into()),
        Some(record.id.clone()),
        None,
    ) {
        tracing::warn!("Provision progress update failed: {e}");
    }

    // 8. Build TradingBotRecord — always awaiting secrets
    let validator_service_ids: Vec<u64> = request.validator_service_ids.to_vec();

    let max_lifetime_days = if request.max_lifetime_days == 0 {
        30
    } else {
        request.max_lifetime_days
    };

    let bot_record = TradingBotRecord {
        id: bot_id.clone(),
        name: request.name.clone(),
        sandbox_id: record.id.clone(),
        vault_address: vault_address.clone(),
        share_token: String::new(),
        strategy_type: request.strategy_type.clone(),
        strategy_config: serde_json::Value::Object(parsed_strategy_config.unwrap_or_default()),
        risk_params: serde_json::from_str(&request.risk_params_json).unwrap_or_else(|e| {
            tracing::warn!("Invalid risk_params_json (using empty): {e}");
            serde_json::Value::Object(Default::default())
        }),
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
        paper_trade,
        wind_down_started_at: None,
        submitter_address: caller,
        trading_loop_cron: request.trading_loop_cron.clone(),
        call_id,
        service_id,
        harness_json: serde_json::to_value(trading_runtime::backtest::HarnessConfig::default())
            .unwrap_or_default(),
        validation_trust: trading_runtime::ValidationTrust::default(),
    };

    // 8. Store bot record
    if let Err(e) = provision_progress::update_provision(
        call_id,
        ProvisionPhase::HealthCheck,
        Some("Finalizing bot configuration".into()),
        None,
        None,
    ) {
        tracing::warn!("Provision progress update failed: {e}");
    }
    if let Err(e) = provision_progress::update_provision_metadata(
        call_id,
        serde_json::json!({ "service_id": service_id, "bot_id": &bot_id, "sandbox_id": &record.id }),
    ) {
        tracing::warn!("Provision metadata update failed: {e}");
    }

    let bot_store = bots().map_err(|e| {
        let msg = format!("Failed to open bot store: {e}");
        mark_provision_failed(call_id, &msg);
        msg
    })?;

    bot_store
        .insert(bot_key(&bot_id), bot_record)
        .map_err(|e| {
            let msg = format!("Failed to store bot record: {e}");
            mark_provision_failed(call_id, &msg);
            msg
        })?;

    // InflightGuard (_inflight_guard) auto-clears PROVISION_INFLIGHT on drop.

    if let Err(e) = provision_progress::update_provision(
        call_id,
        ProvisionPhase::Ready,
        Some("Provision complete — awaiting API key configuration".into()),
        None,
        None,
    ) {
        tracing::warn!("Provision progress update failed: {e}");
    }

    tracing::info!(
        "Bot {bot_id} provisioned (awaiting secrets). Sandbox: {}",
        record.id
    );

    // 9. Return result — vault_address=ZERO because the vault doesn't exist yet.
    //    The BSM creates it on-chain in _handleProvisionResult when this result is submitted.
    //    workflow_id=0 signals "awaiting secrets" to the frontend.
    Ok(TradingProvisionOutput {
        vault_address: alloy::primitives::Address::ZERO,
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
    Ok(TangleResult(
        provision_core(request, None, call_id, service_id, caller_str, None).await?,
    ))
}
