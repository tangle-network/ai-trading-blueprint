use std::collections::HashSet;
use std::sync::Mutex;

use alloy::primitives::{Address, U256, keccak256};
use blueprint_sdk::tangle::extract::{CallId, Caller, TangleArg, TangleResult};
use sandbox_runtime::provision_progress::{self, ProvisionPhase};
use serde_json::{Map, Value};

use crate::state::{TradingBotRecord, bot_key, bots};
use crate::{TradingProvisionOutput, TradingProvisionRequest};
use sandbox_runtime::CreateSandboxParams;
use sandbox_runtime::SandboxRecord;
use trading_runtime::supported_assets::{
    ValuationAdapterKind, default_protocol_for_strategy, supported_assets_for_config,
};

/// Keyed lock set for provision dedup — prevents TOCTOU race between
/// find_bot_by_call and insert. A (service_id, call_id) pair is inserted
/// before the check and removed after the insert, ensuring only one
/// concurrent provision for a given key can proceed.
static PROVISION_INFLIGHT: std::sync::LazyLock<Mutex<HashSet<(u64, u64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

const DEFAULT_PAPER_INITIAL_CAPITAL_USD: &str = "10000";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VaultBinding {
    Factory,
    Direct,
}

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

fn parse_renewal_webhook_url(strategy_config: Option<&Map<String, Value>>) -> Option<String> {
    let obj = strategy_config?;
    let raw = obj.get("renewal_webhook_url").and_then(Value::as_str)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Accept https URLs only — webhooks reach humans/secrets infra and should
    // not be allowed to leak over plaintext. Local dev (http://) is allowed
    // when explicitly opted in via env var.
    let allow_plain_http = std::env::var("ALLOW_PLAIN_HTTP_RENEWAL_WEBHOOK")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    let lower = trimmed.to_ascii_lowercase();
    let scheme_ok =
        lower.starts_with("https://") || (allow_plain_http && lower.starts_with("http://"));
    if !scheme_ok {
        return None;
    }
    Some(trimmed.to_string())
}

fn parse_vault_binding(
    strategy_config: &Map<String, Value>,
    request: &TradingProvisionRequest,
) -> Result<Option<VaultBinding>, String> {
    let Some(raw) = strategy_config.get("vault_binding") else {
        return Ok(None);
    };

    let Some(binding) = raw.as_str() else {
        return Err("strategy_config_json.vault_binding must be a string".to_string());
    };

    match binding.trim().to_ascii_lowercase().as_str() {
        "direct" | "vault" | "existing_vault" => {
            if let Some(raw_addr) = strategy_config
                .get("direct_vault_address")
                .and_then(Value::as_str)
            {
                let addr: alloy::primitives::Address = raw_addr.parse().map_err(|e| {
                    format!("Invalid strategy_config_json.direct_vault_address '{raw_addr}': {e}")
                })?;
                if addr != request.factory_address {
                    return Err(
                        "strategy_config_json.direct_vault_address must match provision vault address"
                            .to_string(),
                    );
                }
            }
            Ok(Some(VaultBinding::Direct))
        }
        "factory" | "vault_factory" => Ok(Some(VaultBinding::Factory)),
        _ => Err("strategy_config_json.vault_binding must be one of: factory, direct".to_string()),
    }
}

fn parse_bool_env(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

fn default_paper_trade_for_request(request: &TradingProvisionRequest) -> bool {
    if let Some(value) = std::env::var("DEFAULT_PAPER_TRADE")
        .ok()
        .and_then(|raw| parse_bool_env(&raw))
    {
        return value;
    }

    let chain_id: u64 = request.chain_id.try_into().unwrap_or(1);
    !matches!(chain_id, 31338 | 31339)
}

fn default_paper_initial_capital_value() -> Value {
    let configured = std::env::var("DEFAULT_PAPER_INITIAL_CAPITAL_USD")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PAPER_INITIAL_CAPITAL_USD.to_string());
    Value::String(configured)
}

fn parse_u64_config(value: &Value) -> Option<u64> {
    match value {
        Value::Number(value) => value.as_u64(),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn configured_protocol_chain_id(
    strategy_config: &Map<String, Value>,
    execution_chain_id: u64,
) -> u64 {
    strategy_config
        .get("protocol_chain_id")
        .and_then(parse_u64_config)
        .or_else(|| {
            std::env::var("PROTOCOL_CHAIN_ID")
                .or_else(|_| std::env::var("FORK_BASE_CHAIN_ID"))
                .ok()
                .and_then(|raw| raw.parse::<u64>().ok())
        })
        .filter(|value| *value > 0)
        .unwrap_or(execution_chain_id)
}

fn default_paper_cash_token_value(
    strategy_config: &Map<String, Value>,
    request: &TradingProvisionRequest,
) -> Option<Value> {
    let execution_chain_id: u64 = request.chain_id.try_into().unwrap_or(1);
    let protocol_chain_id = configured_protocol_chain_id(strategy_config, execution_chain_id);
    trading_runtime::token_metadata::token_address_for_symbol(protocol_chain_id, "USDC")
        .map(|address| Value::String(address.to_string()))
        .or_else(|| Some(Value::String("USDC".to_string())))
}

fn has_configured_asset_token(asset_token: alloy::primitives::Address) -> bool {
    asset_token != alloy::primitives::Address::ZERO
}

fn apply_strategy_defaults(
    strategy_config: &mut Map<String, Value>,
    request: &TradingProvisionRequest,
    paper_trade: bool,
) {
    strategy_config
        .entry("strategy_type".to_string())
        .or_insert_with(|| Value::String(request.strategy_type.clone()));

    if has_configured_asset_token(request.asset_token) {
        strategy_config
            .entry("asset_token".to_string())
            .or_insert_with(|| Value::String(format!("{:#x}", request.asset_token)));
    }

    if paper_trade {
        strategy_config
            .entry("initial_capital_usd".to_string())
            .or_insert_with(default_paper_initial_capital_value);
        if let Some(cash_token) = default_paper_cash_token_value(strategy_config, request) {
            strategy_config
                .entry("cash_token".to_string())
                .or_insert(cash_token);
        }
    }

    let execution_chain_id: u64 = request.chain_id.try_into().unwrap_or(1);
    let protocol_chain_id = configured_protocol_chain_id(strategy_config, execution_chain_id);

    if !strategy_config.contains_key("protocol_chain_id") {
        if protocol_chain_id != execution_chain_id {
            strategy_config.insert(
                "protocol_chain_id".to_string(),
                Value::Number(protocol_chain_id.into()),
            );
        }
    }

    if let Some(default_protocol) = default_protocol_for_strategy(&request.strategy_type) {
        strategy_config
            .entry("available_protocols".to_string())
            .or_insert_with(|| Value::Array(vec![Value::String(default_protocol.to_string())]));

        let supported_assets = supported_assets_for_config(
            &request.strategy_type,
            protocol_chain_id,
            default_protocol,
            Some(&Value::Object(strategy_config.clone())),
        );
        if !supported_assets.is_empty() {
            strategy_config
                .entry("supported_assets".to_string())
                .and_modify(|value| {
                    *value = serde_json::to_value(&supported_assets).unwrap_or(Value::Null);
                })
                .or_insert_with(|| serde_json::to_value(supported_assets).unwrap_or(Value::Null));
        }
    }
}

fn env_address(candidates: &[&str]) -> Option<Address> {
    candidates
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse().ok())
}

fn policy_engine_address_from_env() -> Option<Address> {
    env_address(&[
        "POLICY_ENGINE_ADDRESS",
        "EXECUTION_POLICY_ENGINE",
        "DEPLOY_POLICY_ENGINE",
    ])
}

fn valuation_adapter_address_from_env(kind: ValuationAdapterKind) -> Option<Address> {
    match kind {
        ValuationAdapterKind::None => None,
        ValuationAdapterKind::ChainlinkUsd => env_address(&[
            "CHAINLINK_USD_VALUATOR_ADDRESS",
            "EXECUTION_CHAINLINK_USD_VALUATOR",
            "CHAINLINK_VALUATOR_ADDRESS",
            "DEPLOY_CHAINLINK_USD_VALUATOR",
        ]),
        ValuationAdapterKind::ChainlinkOrUniswapV3Twap => env_address(&[
            "CHAINLINK_USD_VALUATOR_ADDRESS",
            "EXECUTION_CHAINLINK_USD_VALUATOR",
            "CHAINLINK_VALUATOR_ADDRESS",
            "DEPLOY_CHAINLINK_USD_VALUATOR",
        ]),
        ValuationAdapterKind::UniswapV3Twap => env_address(&[
            "UNISWAP_V3_TWAP_VALUATOR_ADDRESS",
            "EXECUTION_UNISWAP_V3_TWAP_VALUATOR",
            "DEPLOY_UNISWAP_V3_TWAP_VALUATOR",
        ]),
        ValuationAdapterKind::WrappedAsset => env_address(&[
            "WRAPPED_ASSET_VALUATOR_ADDRESS",
            "EXECUTION_WRAPPED_ASSET_VALUATOR",
            "WRAPPED_VALUATOR_ADDRESS",
            "DEPLOY_WRAPPED_ASSET_VALUATOR",
        ]),
    }
}

fn uniswap_twap_valuator_address_from_env() -> Option<Address> {
    env_address(&[
        "UNISWAP_V3_TWAP_VALUATOR_ADDRESS",
        "EXECUTION_UNISWAP_V3_TWAP_VALUATOR",
        "DEPLOY_UNISWAP_V3_TWAP_VALUATOR",
    ])
}

fn env_u32(names: &[&str], default: u32) -> u32 {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn env_u128(names: &[&str], default: u128) -> u128 {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn uniswap_twap_fee_tiers_from_env() -> Vec<u32> {
    std::env::var("UNISWAP_V3_TWAP_FEE_TIERS")
        .or_else(|_| std::env::var("EXECUTION_UNISWAP_V3_TWAP_FEE_TIERS"))
        .unwrap_or_else(|_| "500,3000,10000".to_string())
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect::<Vec<_>>()
}

fn uniswap_twap_config_from_env() -> crate::on_chain::UniswapV3TwapConfig {
    crate::on_chain::UniswapV3TwapConfig {
        fee_tiers: uniswap_twap_fee_tiers_from_env(),
        twap_window: env_u32(
            &[
                "UNISWAP_V3_TWAP_WINDOW_SECS",
                "EXECUTION_UNISWAP_V3_TWAP_WINDOW_SECS",
            ],
            1_800,
        ),
        min_harmonic_liquidity: env_u128(
            &[
                "UNISWAP_V3_TWAP_MIN_HARMONIC_LIQUIDITY",
                "EXECUTION_UNISWAP_V3_TWAP_MIN_HARMONIC_LIQUIDITY",
            ],
            1,
        ),
        max_spot_twap_deviation_bps: env_u32(
            &[
                "UNISWAP_V3_TWAP_MAX_SPOT_DEVIATION_BPS",
                "EXECUTION_UNISWAP_V3_TWAP_MAX_SPOT_DEVIATION_BPS",
            ],
            500,
        ),
    }
}

fn vault_supported_asset_configs(
    strategy_type: &str,
    protocol_chain_id: u64,
    deposit_asset: Address,
    strategy_config: &Value,
) -> Result<Vec<crate::on_chain::VaultSupportedAssetConfig>, String> {
    let Some(protocol) = default_protocol_for_strategy(strategy_type) else {
        return Ok(Vec::new());
    };

    supported_assets_for_config(strategy_type, protocol_chain_id, protocol, Some(strategy_config))
        .into_iter()
        .map(|asset| {
            let token: Address = asset.address.parse().map_err(|e| {
                format!(
                    "Invalid supported asset address for {} on chain {}: {e}",
                    asset.symbol, asset.chain_id
                )
            })?;
            let adapter_address = if token == deposit_asset {
                None
            } else {
                match asset.valuation_adapter {
                    ValuationAdapterKind::None => None,
                    ValuationAdapterKind::ChainlinkOrUniswapV3Twap => {
                        valuation_adapter_address_from_env(asset.valuation_adapter)
                    }
                    kind => Some(valuation_adapter_address_from_env(kind).ok_or_else(|| {
                        format!(
                            "{} is supported but missing vault valuation adapter for {:?}. Set the corresponding valuator address env var.",
                            asset.symbol, kind
                        )
                    })?),
                }
            };
            let fallback_adapter_address = match asset.valuation_adapter {
                ValuationAdapterKind::ChainlinkOrUniswapV3Twap => uniswap_twap_valuator_address_from_env(),
                _ => None,
            };
            let twap_config = matches!(
                asset.valuation_adapter,
                ValuationAdapterKind::ChainlinkOrUniswapV3Twap | ValuationAdapterKind::UniswapV3Twap
            )
            .then(uniswap_twap_config_from_env);
            Ok(crate::on_chain::VaultSupportedAssetConfig {
                token,
                symbol: asset.symbol,
                valuation_adapter: asset.valuation_adapter,
                adapter_address,
                fallback_adapter_address,
                twap_config,
            })
        })
        .collect()
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

fn provision_vault_symbol(call_id: u64, bot_id: &str) -> String {
    if call_id > 0 {
        format!("bot{call_id}")
    } else {
        let suffix = bot_id.rsplit('-').next().unwrap_or("vault");
        format!("bot{}", &suffix[..suffix.len().min(8)])
    }
}

fn required_factory_signatures(requested: U256, signer_count: usize) -> Result<U256, String> {
    if signer_count < 2 {
        return Err("Factory vault creation requires at least 2 validator signers".to_string());
    }

    let required = if requested < U256::from(2u64) {
        U256::from(2u64)
    } else {
        requested
    };
    if required > U256::from(signer_count as u64) {
        return Err(format!(
            "Factory vault creation requires_signatures ({required}) exceeds signer count ({signer_count})"
        ));
    }
    Ok(required)
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
#[allow(clippy::too_many_arguments)]
pub async fn provision_core(
    request: TradingProvisionRequest,
    mock_sandbox: Option<SandboxRecord>,
    call_id: u64,
    service_id: u64,
    caller: String,
    tee_backend: Option<&dyn sandbox_runtime::tee::TeeBackend>,
    validation_trust: Option<trading_runtime::ValidationTrust>,
) -> Result<TradingProvisionOutput, String> {
    // 0. Dedup check — if a bot already exists for this (service_id, call_id),
    // return it instead of creating a duplicate. This handles operator restarts
    // that replay past on-chain events.
    //
    // Race-safety: PROVISION_INFLIGHT prevents TOCTOU between the
    // find_bot_by_call check and the later insert. If another concurrent
    // provision for the same key is already running, we block it here.
    if let Ok(matches) = crate::state::bot_lookup_candidates_by_call_id(service_id, call_id) {
        if matches.live.len() > 1 {
            let ids: Vec<String> = matches.live.iter().map(|bot| bot.id.clone()).collect();
            return Err(format!(
                "Multiple live bots already exist for service_id={service_id}, call_id={call_id}: {}. Reset local state before provisioning another agent.",
                ids.join(", ")
            ));
        }

        if let Some(existing) = matches.live.into_iter().next() {
            if call_id == 0 {
                return Err(format!(
                    "Refusing to reuse non-unique call_id=0 for service_id={service_id}; reset local state or fix the job call id source before provisioning another agent."
                ));
            }
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

    // Drop guard: auto-clears PROVISION_INFLIGHT on any exit (success, error, panic).
    let _inflight_guard = InflightGuard(service_id, call_id);

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
        .unwrap_or_else(|| default_paper_trade_for_request(&request));
    let strategy_config_obj = parsed_strategy_config.get_or_insert_with(Default::default);
    let vault_binding = parse_vault_binding(strategy_config_obj, &request)
        .inspect_err(|e| mark_provision_failed(call_id, e))?;
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
        let allow_loopback =
            std::env::var("ALLOW_LOOPBACK_RPC_URLS").is_ok_and(|v| v == "true" || v == "1");
        // Validate user-supplied RPC URL to block SSRF (internal IPs, metadata endpoints)
        trading_runtime::url_validation::validate_rpc_url_with_options(
            &request.rpc_url,
            trading_runtime::url_validation::RpcUrlValidationOptions { allow_loopback },
        )
        .map_err(|e| format!("invalid rpc_url from provision request: {e}"))?
    };

    // 5. Resolve operator address early (needed for vault deployment, env, and bot record)
    let operator_address = op_ctx
        .map(|c| c.operator_address.clone())
        .unwrap_or_default();

    let mut provision_output_vault = Address::ZERO;
    let mut provision_output_share = Address::ZERO;

    // Explicit factory binding means this is an execution-chain factory target.
    // The Tangle BSM cannot call a factory on a different chain, so the operator
    // creates the per-bot vault here and stores the concrete vault address.
    let (vault_address, share_token) = if vault_binding == Some(VaultBinding::Factory)
        && !paper_trade
        && request.factory_address != Address::ZERO
    {
        let op_ctx = op_ctx.ok_or_else(|| {
            "Operator context is required to create an execution-chain bot vault".to_string()
        })?;
        let operator_addr: Address = operator_address
            .parse()
            .map_err(|e| format!("Invalid operator address '{}': {e}", operator_address))?;
        if request.asset_token == Address::ZERO {
            return Err(
                "Execution-chain factory vault creation requires a non-zero asset token"
                    .to_string(),
            );
        }
        let signers = request.signers.to_vec();
        let required_sigs = required_factory_signatures(request.required_signatures, signers.len())
            .inspect_err(|e| mark_provision_failed(call_id, e))?;

        if let Err(e) = provision_progress::update_provision(
            call_id,
            ProvisionPhase::HealthCheck,
            Some("Creating per-bot execution vault".into()),
            None,
            None,
        ) {
            tracing::warn!("Provision progress update failed: {e}");
        }

        let chain =
            trading_runtime::chain::ChainClient::new(&rpc_url, &op_ctx.private_key, chain_id)
                .map_err(|e| {
                    format!("Failed to connect execution chain for vault deployment: {e}")
                })?;
        let salt = keccak256(format!("{service_id}:{call_id}:{bot_id}").as_bytes());
        let deployment = crate::on_chain::deploy_bot_vault(
            &chain,
            request.factory_address,
            service_id,
            request.asset_token,
            operator_addr,
            operator_addr,
            signers,
            required_sigs,
            request.name.clone(),
            provision_vault_symbol(call_id, &bot_id),
            salt,
        )
        .await
        .map_err(|e| {
            let msg = format!("Failed to create execution-chain bot vault: {e}");
            mark_provision_failed(call_id, &msg);
            msg
        })?;

        let protocol_chain_id = configured_protocol_chain_id(strategy_config_obj, chain_id);
        let supported_asset_configs = vault_supported_asset_configs(
            &request.strategy_type,
            protocol_chain_id,
            request.asset_token,
            &Value::Object(strategy_config_obj.clone()),
        )
        .inspect_err(|e| mark_provision_failed(call_id, e))?;
        if !supported_asset_configs.is_empty() {
            let policy_engine = policy_engine_address_from_env().ok_or_else(|| {
                let msg = "Execution-chain vault provisioning requires POLICY_ENGINE_ADDRESS or EXECUTION_POLICY_ENGINE to whitelist supported assets".to_string();
                mark_provision_failed(call_id, &msg);
                msg
            })?;
            crate::on_chain::configure_vault_supported_assets(
                &chain,
                deployment.vault_address,
                policy_engine,
                request.asset_token,
                &supported_asset_configs,
            )
            .await
            .map_err(|e| {
                let msg = format!("Failed to configure supported vault assets: {e}");
                mark_provision_failed(call_id, &msg);
                msg
            })?;
        }

        provision_output_vault = deployment.vault_address;
        provision_output_share = deployment.share_token;
        (
            format!("{:#x}", deployment.vault_address),
            format!("{:#x}", deployment.share_token),
        )
    } else if vault_binding == Some(VaultBinding::Direct) {
        (
            format!("vault:{:#x}", request.factory_address),
            String::new(),
        )
    } else {
        (
            format!("factory:{:#x}", request.factory_address),
            String::new(),
        )
    };

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
    // Pass discovered validator endpoints to sidecar
    if !validator_endpoints.is_empty() {
        env.insert(
            "VALIDATOR_ENDPOINTS".into(),
            serde_json::Value::String(validator_endpoints.join(",")),
        );
    }

    let effective_strategy_config_json = serde_json::to_string(&Value::Object(
        parsed_strategy_config.clone().unwrap_or_default(),
    ))
    .unwrap_or_else(|_| request.strategy_config_json.clone());
    env.insert(
        "STRATEGY_CONFIG".into(),
        serde_json::Value::String(effective_strategy_config_json),
    );

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
            agent_identifier: format!("trading-{}", request.strategy_type),
            env_json,
            metadata_json,
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
            ..Default::default()
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

    let renewal_webhook_url = parse_renewal_webhook_url(parsed_strategy_config.as_ref());
    let strategy_type_for_baseline = request.strategy_type.clone();

    let bot_record = TradingBotRecord {
        id: bot_id.clone(),
        name: request.name.clone(),
        sandbox_id: record.id.clone(),
        vault_address: vault_address.clone(),
        share_token: share_token.clone(),
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
        validation_trust: validation_trust.unwrap_or_default(),
        baseline_backtest: None,
        renewal_webhook_url,
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

    // Baseline backtest — best-effort. Strategies that have historical kline
    // data (dex/yield/perps) get a 30-day backtest using the default harness
    // so dashboards can compare live performance against an offline baseline.
    // Failures (kline source unreachable, network, etc.) are logged and skipped.
    if trading_runtime::backtest::strategy_supports_baseline(&strategy_type_for_baseline) {
        run_baseline_backtest_for_bot(&bot_id, strategy_type_for_baseline.clone()).await;
    } else {
        tracing::debug!(
            bot_id = %bot_id,
            strategy_type = %strategy_type_for_baseline,
            "Skipping baseline backtest: strategy has no kline source"
        );
    }

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

    // 9. Return result. For execution-chain factory targets, the operator has
    //    already created the concrete per-bot vault above. Legacy same-chain
    //    factory targets still return zero and let the BSM resolve botVaults.
    //    workflow_id=0 signals "awaiting secrets" to the frontend.
    Ok(TradingProvisionOutput {
        vault_address: provision_output_vault,
        share_token: provision_output_share,
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
    let validation_trust = match request.validation_trust {
        0 => None, // default → PerTrade
        1 => Some(trading_runtime::ValidationTrust::Envelope),
        2 => Some(trading_runtime::ValidationTrust::SelfOperated),
        other => return Err(format!("Invalid validation_trust discriminant {other}")),
    };
    Ok(TangleResult(
        provision_core(
            request,
            None,
            call_id,
            service_id,
            caller_str,
            None,
            validation_trust,
        )
        .await?,
    ))
}

/// Best-effort baseline backtest — fetches the last 30 days of klines and
/// persists a `BacktestSummary` into the bot record. Failures are logged and
/// swallowed; provisioning never fails because of a baseline backtest issue.
async fn run_baseline_backtest_for_bot(bot_id: &str, strategy_type: String) {
    let lookback = std::env::var("BASELINE_BACKTEST_LOOKBACK_DAYS")
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
        .filter(|days| *days > 0)
        .unwrap_or(trading_runtime::backtest::DEFAULT_BASELINE_LOOKBACK_DAYS);

    let harness = trading_runtime::backtest::HarnessConfig::default();
    match trading_runtime::backtest::run_baseline_backtest(&strategy_type, harness, lookback).await
    {
        Ok(summary) => {
            tracing::info!(
                bot_id = %bot_id,
                strategy_type = %strategy_type,
                lookback_days = lookback,
                total_trades = summary.total_trades,
                win_rate = summary.win_rate,
                sharpe = summary.sharpe_ratio,
                "baseline backtest completed"
            );
            if let Err(e) = crate::state::set_baseline_backtest(bot_id, summary) {
                tracing::warn!(
                    bot_id = %bot_id,
                    "failed to persist baseline backtest summary: {e}"
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                bot_id = %bot_id,
                strategy_type = %strategy_type,
                "baseline backtest skipped (kline source unavailable): {e}"
            );
        }
    }
}
