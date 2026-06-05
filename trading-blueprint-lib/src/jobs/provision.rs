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
use trading_http_api::routes::hyperliquid::normalize_hyperliquid_api_wallet_name;
use trading_runtime::supported_assets::{
    ValuationAdapterKind, all_execution_protocols, default_protocol_for_strategy,
    default_protocols_for_strategy, supported_assets_for_config,
};

/// Keyed lock set for provision dedup — prevents TOCTOU race between
/// find_bot_by_call and insert. A (service_id, call_id) pair is inserted
/// before the check and removed after the insert, ensuring only one
/// concurrent provision for a given key can proceed.
static PROVISION_INFLIGHT: std::sync::LazyLock<Mutex<HashSet<(u64, u64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

const DEFAULT_PAPER_INITIAL_CAPITAL_USD: &str = "10000";
const HYPERLIQUID_ACCOUNT_SOURCE_HYPEREVM_VAULT: &str = "hyperevm_vault_contract";
const HYPERLIQUID_API_WALLET_APPROVAL_AFTER_FUNDING: &str = "corewriter_after_funding";
const HYPERLIQUID_API_WALLET_APPROVAL_PENDING: &str = "pending_corewriter_approval";
const MIN_OWNER_POSITION_FRACTION: f64 = 0.01;
const MAX_OWNER_POSITION_FRACTION: f64 = 1.0;

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

fn normalized_permitted_caller(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn strategy_config_permitted_callers(config: &Map<String, Value>) -> Vec<String> {
    let mut callers = Vec::new();
    for key in [
        "permitted_callers",
        "permittedCallers",
        "allowed_callers",
        "authorized_callers",
    ] {
        let Some(values) = config.get(key).and_then(Value::as_array) else {
            continue;
        };
        for value in values.iter().filter_map(Value::as_str) {
            let Some(caller) = normalized_permitted_caller(value) else {
                continue;
            };
            if !callers
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(&caller))
            {
                callers.push(caller);
            }
        }
    }
    callers
}

fn ensure_strategy_config_permitted_caller(config: &mut Map<String, Value>, caller: &str) {
    let Some(caller) = normalized_permitted_caller(caller) else {
        return;
    };

    let mut callers = strategy_config_permitted_callers(config);
    if !callers
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&caller))
    {
        callers.push(caller);
    }

    config.insert(
        "permitted_callers".to_string(),
        Value::Array(callers.into_iter().map(Value::String).collect()),
    );
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

fn parse_f64_config(value: &Value) -> Option<f64> {
    match value {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn owner_position_sizing_fraction(
    strategy_config: &Map<String, Value>,
) -> Result<Option<f64>, String> {
    let Some(raw_position_sizing) = strategy_config.get("position_sizing") else {
        return Ok(None);
    };

    let position_sizing = raw_position_sizing
        .as_object()
        .ok_or_else(|| "strategy_config_json.position_sizing must be a JSON object".to_string())?;

    if let Some(method) = position_sizing.get("method").and_then(Value::as_str)
        && method.trim() != "fixed_fraction"
    {
        return Err(
            "strategy_config_json.position_sizing.method must be fixed_fraction".to_string(),
        );
    }

    let Some(raw_fraction) = position_sizing.get("fraction") else {
        return Err("strategy_config_json.position_sizing.fraction is required".to_string());
    };
    let fraction = parse_f64_config(raw_fraction).ok_or_else(|| {
        "strategy_config_json.position_sizing.fraction must be a number".to_string()
    })?;

    if !fraction.is_finite()
        || !(MIN_OWNER_POSITION_FRACTION..=MAX_OWNER_POSITION_FRACTION).contains(&fraction)
    {
        return Err(format!(
            "strategy_config_json.position_sizing.fraction must be between {MIN_OWNER_POSITION_FRACTION} and {MAX_OWNER_POSITION_FRACTION}"
        ));
    }

    Ok(Some(fraction))
}

pub(crate) fn harness_for_strategy_config(
    strategy_config: &Map<String, Value>,
) -> Result<trading_runtime::backtest::HarnessConfig, String> {
    let mut harness = trading_runtime::backtest::HarnessConfig::default();
    if let Some(fraction) = owner_position_sizing_fraction(strategy_config)? {
        harness.position_sizing =
            trading_runtime::backtest::PositionSizing::FixedFraction { fraction };
    }
    harness
        .validate()
        .map_err(|errors| format!("Harness validation failed: {}", errors.join("; ")))?;
    Ok(harness)
}

pub(crate) fn harness_json_for_strategy_config(
    strategy_config: &Map<String, Value>,
) -> Result<Value, String> {
    let harness = harness_for_strategy_config(strategy_config)?;
    let mut harness_json = serde_json::to_value(harness)
        .map_err(|e| format!("Failed to serialize harness config: {e}"))?;
    let Some(harness_obj) = harness_json.as_object_mut() else {
        return Err("Harness serialization did not produce a JSON object".to_string());
    };

    if let Some(min_order_usd) =
        optional_f64_config(strategy_config, "min_order_usd", 0.0, f64::MAX)?
    {
        harness_obj.insert("min_order_usd".to_string(), Value::from(min_order_usd));
    }

    merge_mm_harness(strategy_config, harness_obj)?;
    merge_json_object_harness(strategy_config, harness_obj, "portfolio");
    merge_json_object_harness(strategy_config, harness_obj, "yield");
    merge_json_object_harness(strategy_config, harness_obj, "volatility");
    merge_json_object_harness(strategy_config, harness_obj, "perps");

    Ok(harness_json)
}

fn optional_f64_config(
    config: &Map<String, Value>,
    field: &str,
    min: f64,
    max: f64,
) -> Result<Option<f64>, String> {
    let Some(raw) = config.get(field) else {
        return Ok(None);
    };
    let value = parse_f64_config(raw)
        .ok_or_else(|| format!("strategy_config_json.{field} must be a number"))?;
    if !value.is_finite() || value < min || value > max {
        return Err(format!(
            "strategy_config_json.{field} must be between {min} and {max}"
        ));
    }
    Ok(Some(value))
}

fn optional_nested_f64_config(
    config: &Map<String, Value>,
    object_field: &str,
    field: &str,
    min: f64,
    max: f64,
) -> Result<Option<f64>, String> {
    let Some(raw_object) = config.get(object_field) else {
        return Ok(None);
    };
    let object = raw_object
        .as_object()
        .ok_or_else(|| format!("strategy_config_json.{object_field} must be a JSON object"))?;
    let Some(raw) = object.get(field) else {
        return Ok(None);
    };
    let value = parse_f64_config(raw)
        .ok_or_else(|| format!("strategy_config_json.{object_field}.{field} must be a number"))?;
    if !value.is_finite() || value < min || value > max {
        return Err(format!(
            "strategy_config_json.{object_field}.{field} must be between {min} and {max}"
        ));
    }
    Ok(Some(value))
}

fn merge_mm_harness(
    strategy_config: &Map<String, Value>,
    harness_obj: &mut Map<String, Value>,
) -> Result<(), String> {
    let mut mm = strategy_config
        .get("mm")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if let Some(target) = optional_f64_config(strategy_config, "target_base_weight", 0.0, 1.0)?.or(
        optional_nested_f64_config(strategy_config, "mm", "target_base_weight", 0.0, 1.0)?,
    ) {
        mm.insert("target_base_weight".to_string(), Value::from(target));
    }
    if let Some(band) = optional_f64_config(strategy_config, "rebalance_band_pct", 0.0, 1.0)?.or(
        optional_nested_f64_config(strategy_config, "mm", "rebalance_band_pct", 0.0, 1.0)?,
    ) {
        mm.insert("rebalance_band_pct".to_string(), Value::from(band));
    }

    if !mm.is_empty() {
        harness_obj.insert("mm".to_string(), Value::Object(mm));
    }
    Ok(())
}

fn merge_json_object_harness(
    strategy_config: &Map<String, Value>,
    harness_obj: &mut Map<String, Value>,
    field: &str,
) {
    if let Some(object) = strategy_config.get(field).and_then(Value::as_object) {
        harness_obj.insert(field.to_string(), Value::Object(object.clone()));
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

fn default_hyperliquid_protocol_chain_id(execution_chain_id: u64) -> u64 {
    if is_hyperevm_chain(execution_chain_id) {
        execution_chain_id
    } else {
        998
    }
}

fn default_protocol_chain_id_for_protocol(protocol: &str, execution_chain_id: u64) -> u64 {
    match protocol.trim().to_ascii_lowercase().as_str() {
        "hyperliquid" => default_hyperliquid_protocol_chain_id(execution_chain_id),
        "gmx_v2" | "vertex" => 42161,
        "polymarket_clob" => 137,
        _ => execution_chain_id,
    }
}

fn default_protocol_chain_id_for_strategy(
    strategy_type: &str,
    execution_chain_id: u64,
) -> Option<u64> {
    match trading_runtime::supported_assets::normalize_strategy_type(strategy_type).as_str() {
        "perp" => Some(42161),
        "hyperliquid_perp" => Some(default_hyperliquid_protocol_chain_id(execution_chain_id)),
        _ => None,
    }
}

fn string_array_value(values: &[&str]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::String((*value).to_string()))
            .collect(),
    )
}

fn default_protocol_chain_ids_value(execution_chain_id: u64) -> Value {
    let mut chains = Map::new();
    for protocol in all_execution_protocols() {
        chains.insert(
            (*protocol).to_string(),
            Value::Number(
                default_protocol_chain_id_for_protocol(protocol, execution_chain_id).into(),
            ),
        );
    }
    Value::Object(chains)
}

fn configured_protocol_chain_id_for_protocol(
    strategy_config: &Map<String, Value>,
    protocol: &str,
    execution_chain_id: u64,
) -> u64 {
    strategy_config
        .get("protocol_chain_ids")
        .and_then(Value::as_object)
        .and_then(|chains| chains.get(protocol))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or_else(|| default_protocol_chain_id_for_protocol(protocol, execution_chain_id))
}

fn configured_protocols_for_strategy(
    strategy_type: &str,
    strategy_config: &Map<String, Value>,
) -> Vec<String> {
    strategy_config
        .get("available_protocols")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| {
            default_protocols_for_strategy(strategy_type)
                .iter()
                .map(|value| (*value).to_string())
                .collect()
        })
}

fn asset_gate_strategy_for_protocol<'a>(request_strategy_type: &'a str, protocol: &str) -> &'a str {
    match protocol.trim().to_ascii_lowercase().as_str() {
        "uniswap_v3" | "aerodrome" => "dex",
        "aave_v3" | "morpho_vault" => "yield",
        "polymarket_clob" => "prediction",
        "hyperliquid" => "hyperliquid_perp",
        _ => request_strategy_type,
    }
}

fn has_configured_asset_token(asset_token: alloy::primitives::Address) -> bool {
    asset_token != alloy::primitives::Address::ZERO
}

fn apply_volatility_defaults(strategy_config: &mut Map<String, Value>) {
    strategy_config
        .entry("volatility_params".to_string())
        .or_insert_with(|| {
            serde_json::json!({
                "realized_window_hours": 24,
                "implied_proxy_sources": [
                    "hyperliquid_funding",
                    "gmx_funding",
                    "vertex_funding",
                    "polymarket_spreads"
                ],
                "delta_hedge_threshold_pct": 5.0,
                "max_position_pct": 5.0,
                "max_loss_pct": 3.0,
                "stop_condition": "paper_safe_no_live_execution"
            })
        });
    strategy_config
        .entry("decision_evidence".to_string())
        .or_insert_with(|| {
            serde_json::json!({
                "tool_module": "volatility-tick.js",
                "metrics_path": "/home/agent/metrics/latest.json",
                "decisions_path": "/home/agent/logs/decisions.jsonl"
            })
        });
    strategy_config
        .entry("paper_safe".to_string())
        .or_insert(Value::Bool(true));
}

fn apply_strategy_defaults(
    strategy_config: &mut Map<String, Value>,
    request: &TradingProvisionRequest,
    paper_trade: bool,
    bot_id: &str,
) -> Result<(), String> {
    let normalized_strategy =
        trading_runtime::supported_assets::normalize_strategy_type(&request.strategy_type);

    strategy_config
        .entry("strategy_type".to_string())
        .or_insert_with(|| Value::String(request.strategy_type.clone()));

    if has_configured_asset_token(request.asset_token) {
        strategy_config
            .entry("asset_token".to_string())
            .or_insert_with(|| Value::String(format!("{:#x}", request.asset_token)));
    }

    let execution_chain_id: u64 = request.chain_id.try_into().unwrap_or(1);
    if !strategy_config.contains_key("protocol_chain_id")
        && let Some(default_chain_id) =
            default_protocol_chain_id_for_strategy(&request.strategy_type, execution_chain_id)
    {
        strategy_config.insert(
            "protocol_chain_id".to_string(),
            Value::Number(default_chain_id.into()),
        );
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

    let protocol_chain_id = configured_protocol_chain_id(strategy_config, execution_chain_id);

    if !strategy_config.contains_key("protocol_chain_id") && protocol_chain_id != execution_chain_id
    {
        strategy_config.insert(
            "protocol_chain_id".to_string(),
            Value::Number(protocol_chain_id.into()),
        );
    }

    let preferred_protocols = default_protocols_for_strategy(&request.strategy_type)
        .iter()
        .copied()
        .filter(|protocol| all_execution_protocols().contains(protocol))
        .collect::<Vec<_>>();
    if !preferred_protocols.is_empty() {
        strategy_config
            .entry("preferred_protocols".to_string())
            .or_insert_with(|| string_array_value(&preferred_protocols));
    }
    strategy_config
        .entry("available_protocols".to_string())
        .or_insert_with(|| string_array_value(all_execution_protocols()));
    strategy_config
        .entry("protocol_chain_ids".to_string())
        .or_insert_with(|| default_protocol_chain_ids_value(execution_chain_id));

    let supported_assets =
        configured_protocols_for_strategy(&request.strategy_type, strategy_config)
            .iter()
            .flat_map(|protocol| {
                let asset_strategy =
                    asset_gate_strategy_for_protocol(&request.strategy_type, protocol);
                let asset_chain_id = configured_protocol_chain_id_for_protocol(
                    strategy_config,
                    protocol,
                    execution_chain_id,
                );
                supported_assets_for_config(
                    asset_strategy,
                    asset_chain_id,
                    protocol,
                    Some(&Value::Object(strategy_config.clone())),
                )
            })
            .collect::<Vec<_>>();
    if !supported_assets.is_empty() {
        strategy_config
            .entry("supported_assets".to_string())
            .and_modify(|value| {
                *value = serde_json::to_value(&supported_assets).unwrap_or(Value::Null);
            })
            .or_insert_with(|| serde_json::to_value(supported_assets).unwrap_or(Value::Null));
    }

    if normalized_strategy == "volatility" {
        apply_volatility_defaults(strategy_config);
    }

    apply_hyperliquid_perp_defaults(strategy_config, request, paper_trade, bot_id)
}

#[derive(Clone, Debug)]
pub struct StrategyPackRealignment {
    pub strategy_type: String,
    pub strategy_config: Value,
    pub harness_json: Value,
}

fn remove_strategy_pack_derived_fields(strategy_config: &mut Map<String, Value>) {
    for key in [
        "strategy_type",
        "protocol_chain_id",
        "protocol_chain_ids",
        "available_protocols",
        "preferred_protocols",
        "supported_assets",
        "asset_universe",
        "asset_token",
        "cash_token",
        "protocol",
        "target_protocol",
        "venue",
        "exchange",
        "adapter",
        "hyperliquid_execution_model",
        "hyperliquid_account",
        "hyperliquid_account_address",
        "hyperliquid_account_source",
        "hyperliquid_api_wallet_address",
        "hyperliquid_api_wallet_approval",
        "hyperliquid_api_wallet_approval_status",
        "hyperliquid_api_wallet_name",
    ] {
        strategy_config.remove(key);
    }
}

/// Rebuild strategy-pack-owned config for an existing paper bot.
///
/// This is intentionally narrower than full reprovisioning: it preserves owner
/// risk knobs and learned metadata, but clears derived protocol/universe fields
/// that would otherwise keep a stale sandbox pointed at the wrong venue.
pub fn realign_existing_bot_strategy_pack(
    bot: &TradingBotRecord,
    target_strategy_type: &str,
    prompt: &str,
    asset_token: Address,
) -> Result<StrategyPackRealignment, String> {
    let strategy_type =
        trading_runtime::supported_assets::normalize_strategy_type(target_strategy_type);
    let mut strategy_config = bot.strategy_config.as_object().cloned().unwrap_or_default();
    remove_strategy_pack_derived_fields(&mut strategy_config);

    let prompt = prompt.trim();
    if !prompt.is_empty() {
        strategy_config.insert("user_prompt".to_string(), Value::String(prompt.to_string()));
    }
    strategy_config.insert("paper_trade".to_string(), Value::Bool(bot.paper_trade));

    let request = TradingProvisionRequest {
        name: bot.name.clone(),
        strategy_type: strategy_type.clone(),
        strategy_config_json: String::new(),
        risk_params_json: serde_json::to_string(&bot.risk_params).unwrap_or_else(|_| "{}".into()),
        factory_address: Address::ZERO,
        asset_token,
        signers: Vec::new(),
        required_signatures: U256::ZERO,
        chain_id: U256::from(bot.chain_id),
        rpc_url: bot.rpc_url.clone(),
        trading_loop_cron: bot.trading_loop_cron.clone(),
        cpu_cores: 1,
        memory_mb: 512,
        max_lifetime_days: bot.max_lifetime_days,
        validator_service_ids: bot.validator_service_ids.clone(),
        max_collateral_bps: U256::ZERO,
        validation_trust: bot.validation_trust as u8,
    };

    apply_strategy_defaults(&mut strategy_config, &request, bot.paper_trade, &bot.id)?;
    let harness_json = harness_json_for_strategy_config(&strategy_config)?;

    Ok(StrategyPackRealignment {
        strategy_type,
        strategy_config: Value::Object(strategy_config),
        harness_json,
    })
}

fn is_hyperliquid_perp_strategy(strategy_type: &str) -> bool {
    matches!(
        strategy_type.trim().to_ascii_lowercase().as_str(),
        "hyperliquid_perp" | "hyperliquid-perp"
    )
}

fn is_hyperevm_chain(chain_id: u64) -> bool {
    matches!(chain_id, 998 | 999)
}

fn apply_hyperliquid_perp_defaults(
    strategy_config: &mut Map<String, Value>,
    request: &TradingProvisionRequest,
    paper_trade: bool,
    bot_id: &str,
) -> Result<(), String> {
    if !is_hyperliquid_perp_strategy(&request.strategy_type) {
        return Ok(());
    }

    strategy_config
        .entry("available_protocols".to_string())
        .or_insert_with(|| Value::Array(vec![Value::String("hyperliquid".to_string())]));

    let execution_chain_id: u64 = request.chain_id.try_into().unwrap_or(1);
    if is_hyperevm_chain(execution_chain_id) && !paper_trade {
        strategy_config
            .entry("hyperliquid_execution_model".to_string())
            .or_insert_with(|| Value::String("hyperevm_vault_agent".to_string()));
        strategy_config
            .entry("hyperliquid_account_source".to_string())
            .or_insert_with(|| {
                Value::String(HYPERLIQUID_ACCOUNT_SOURCE_HYPEREVM_VAULT.to_string())
            });
        strategy_config
            .entry("hyperliquid_api_wallet_approval".to_string())
            .or_insert_with(|| {
                Value::String(HYPERLIQUID_API_WALLET_APPROVAL_AFTER_FUNDING.to_string())
            });
        let api_wallet_name = normalize_hyperliquid_api_wallet_name(
            strategy_config
                .get("hyperliquid_api_wallet_name")
                .and_then(Value::as_str),
            bot_id,
        )
        .map_err(|e| format!("Invalid Hyperliquid API wallet name: {e}"))?;
        strategy_config.insert(
            "hyperliquid_api_wallet_name".to_string(),
            Value::String(api_wallet_name),
        );
    }

    Ok(())
}

fn apply_hyperliquid_account_metadata(
    strategy_config: &mut Map<String, Value>,
    strategy_type: &str,
    chain_id: u64,
    paper_trade: bool,
    vault_address: Address,
    api_wallet_address: Option<&str>,
) {
    if !is_hyperliquid_perp_strategy(strategy_type) || !is_hyperevm_chain(chain_id) || paper_trade {
        return;
    }

    let vault = format!("{vault_address:#x}");
    strategy_config.insert(
        "hyperliquid_account_address".to_string(),
        Value::String(vault.clone()),
    );
    strategy_config.insert("hyperliquid_account".to_string(), Value::String(vault));
    strategy_config.insert(
        "hyperliquid_account_source".to_string(),
        Value::String(HYPERLIQUID_ACCOUNT_SOURCE_HYPEREVM_VAULT.to_string()),
    );
    strategy_config
        .entry("hyperliquid_api_wallet_approval".to_string())
        .or_insert_with(|| {
            Value::String(HYPERLIQUID_API_WALLET_APPROVAL_AFTER_FUNDING.to_string())
        });
    strategy_config
        .entry("hyperliquid_api_wallet_approval_status".to_string())
        .or_insert_with(|| Value::String(HYPERLIQUID_API_WALLET_APPROVAL_PENDING.to_string()));

    if let Some(address) = api_wallet_address
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        strategy_config
            .entry("hyperliquid_api_wallet_address".to_string())
            .or_insert_with(|| Value::String(address.to_string()));
    }
}

fn hyperliquid_api_wallet_address_from_env() -> Result<Option<String>, String> {
    for name in ["HYPERLIQUID_API_WALLET_ADDRESS", "HYPERLIQUID_API_ADDRESS"] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            let address: Address = value
                .parse()
                .map_err(|e| format!("{name} must be an address: {e}"))?;
            return Ok(Some(format!("{address:#x}")));
        }
    }

    for name in [
        "HYPERLIQUID_API_WALLET_PRIVATE_KEY",
        "HYPERLIQUID_API_PRIVATE_KEY",
    ] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            return trading_http_api::operator_address_from_private_key(value)
                .map(Some)
                .map_err(|e| format!("{name} is invalid: {e}"));
        }
    }

    Ok(None)
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

fn should_configure_vault_supported_assets(
    strategy_type: &str,
    chain_id: u64,
    paper_trade: bool,
) -> bool {
    if is_hyperliquid_perp_strategy(strategy_type) && is_hyperevm_chain(chain_id) && !paper_trade {
        return false;
    }

    true
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
    if signer_count < 3 {
        return Err(
            "Factory vault creation requires at least 3 validator signers and a 2/3 supermajority"
                .to_string(),
        );
    }

    let floor = U256::from((signer_count * 2).div_ceil(3));
    let required = if requested < floor { floor } else { requested };
    if required > U256::from(signer_count as u64) {
        return Err(format!(
            "Factory vault creation requires_signatures ({required}) exceeds signer count ({signer_count})"
        ));
    }
    Ok(required)
}

/// Recreate and reactivate missing paper-trade sidecars for active bots.
///
/// When the operator's local sandbox state is lost but the bot record survives
/// (e.g. the host was rebuilt and the data volume re-attached), the sandbox
/// container is gone while `bot.sandbox_id` still points at it. provision
/// dedups existing bots and activate only injects into an existing sandbox, so
/// nothing recreates it. For paper bots this rebuilds the same base env,
/// creates a fresh sidecar, repoints the bot at the new sandbox id, and
/// re-injects the operator AI keys. Live-money bots are intentionally skipped
/// because the
/// operator cannot safely reconstruct user exchange/API secrets from the bot
/// record alone.
pub async fn ensure_active_bot_sandboxes() -> usize {
    let bots = match crate::state::list_bots(None, 10_000, 0) {
        Ok(page) => page.bots,
        Err(e) => {
            tracing::warn!("self-heal: list_bots failed: {e}");
            return 0;
        }
    };
    let ai_env = match crate::operator_credentials::operator_ai_env() {
        Ok(env) => env,
        Err(e) => {
            tracing::warn!("self-heal: missing operator AI credentials: {e}");
            return 0;
        }
    };

    let mut healed = 0usize;
    for bot in bots {
        if !bot.trading_active || bot.wind_down_started_at.is_some() {
            continue;
        }
        if !bot.paper_trade {
            tracing::warn!(
                bot_id = %bot.id,
                sandbox_id = %bot.sandbox_id,
                "self-heal: refusing to recreate missing live-money sandbox without user secrets"
            );
            continue;
        }
        if sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).is_ok() {
            continue;
        }

        match recreate_bot_sandbox(&bot).await {
            Ok(_) => {
                if let Err(e) =
                    crate::jobs::activate_bot_with_secrets(&bot.id, ai_env.clone(), None).await
                {
                    tracing::warn!(bot_id = %bot.id, %e, "self-heal: re-activate failed");
                    continue;
                }
                healed += 1;
            }
            Err(e) => tracing::warn!(bot_id = %bot.id, %e, "self-heal: sandbox recreate failed"),
        }
    }

    if healed > 0 {
        tracing::info!("self-heal: recreated {healed} missing paper bot sandbox(es)");
    }
    healed
}

fn bot_recreate_env_json(bot: &crate::state::TradingBotRecord) -> String {
    // Mirror the base (secret-free) env provision_core builds for the sidecar.
    let mut env = Map::new();
    env.insert(
        "TRADING_HTTP_API_URL".into(),
        Value::String(bot.trading_api_url.clone()),
    );
    env.insert(
        "TRADING_API_TOKEN".into(),
        Value::String(bot.trading_api_token.clone()),
    );
    env.insert(
        "STRATEGY_TYPE".into(),
        Value::String(bot.strategy_type.clone()),
    );
    env.insert("RPC_URL".into(), Value::String(bot.rpc_url.clone()));
    env.insert("CHAIN_ID".into(), Value::String(bot.chain_id.to_string()));
    env.insert(
        "OPERATOR_ADDRESS".into(),
        Value::String(bot.operator_address.clone()),
    );
    env.insert(
        "SUBMITTER_ADDRESS".into(),
        Value::String(bot.submitter_address.clone()),
    );
    if !bot.vault_address.is_empty() {
        env.insert(
            "VAULT_ADDRESS".into(),
            Value::String(bot.vault_address.clone()),
        );
    }
    env.insert(
        "STRATEGY_CONFIG".into(),
        Value::String(serde_json::to_string(&bot.strategy_config).unwrap_or_default()),
    );
    serde_json::to_string(&env).unwrap_or_default()
}

fn build_recreated_bot_sandbox_params(bot: &crate::state::TradingBotRecord) -> CreateSandboxParams {
    let lifetime_days = if bot.max_lifetime_days == 0 {
        30
    } else {
        bot.max_lifetime_days
    };
    CreateSandboxParams {
        name: bot.name.clone(),
        image: std::env::var("SIDECAR_IMAGE")
            .unwrap_or_else(|_| sandbox_runtime::DEFAULT_SIDECAR_IMAGE.to_string()),
        agent_identifier: format!("trading-{}", bot.strategy_type),
        env_json: bot_recreate_env_json(bot),
        capabilities_json: r#"["all_harness"]"#.to_string(),
        max_lifetime_seconds: lifetime_days * 86400,
        idle_timeout_seconds: 0,
        disk_gb: 10,
        ..Default::default()
    }
}

async fn create_recreated_bot_sandbox(
    bot: &crate::state::TradingBotRecord,
    reason: &str,
) -> Result<String, String> {
    let params = build_recreated_bot_sandbox_params(bot);
    let (record, _attestation) = sandbox_runtime::runtime::create_sidecar(&params, None)
        .await
        .map_err(|e| format!("{reason} create_sidecar failed: {e}"))?;

    // Repoint the bot at the new sandbox. Must update the record under its
    // canonical key (`bot:{id}`), not the raw id — otherwise get_bot/activate
    // keep reading the stale sandbox_id.
    crate::state::bots()?
        .update(&crate::state::bot_key(&bot.id), |b| {
            b.sandbox_id = record.id.clone();
        })
        .map_err(|e| format!("{reason} save bot failed: {e}"))?;

    tracing::info!(
        bot_id = %bot.id,
        old_sandbox = %bot.sandbox_id,
        new_sandbox = %record.id,
        %reason,
        "recreated bot sidecar sandbox"
    );
    Ok(record.id)
}

/// Self-heal one bot whose sidecar sandbox is missing from operator-local state.
///
/// Caller is responsible for re-injecting secrets afterwards via
/// `activate_bot_with_secrets`.
pub async fn recreate_bot_sandbox(bot: &crate::state::TradingBotRecord) -> Result<String, String> {
    if sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).is_ok() {
        return Ok(bot.sandbox_id.clone());
    }

    create_recreated_bot_sandbox(bot, "self-heal").await
}

/// Recreate a bot sidecar even when the old sandbox still exists.
///
/// Strategy-pack repair needs this because sandbox-runtime preserves the base
/// env across secret injection/wipe. A strategy retarget must launch a fresh
/// base env containing the updated STRATEGY_TYPE and STRATEGY_CONFIG.
pub async fn force_recreate_bot_sandbox(
    bot: &crate::state::TradingBotRecord,
) -> Result<String, String> {
    let old_record = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).ok();

    match create_recreated_bot_sandbox(bot, "strategy-repair").await {
        Ok(new_sandbox_id) => {
            if let Some(old_record) = old_record {
                cleanup_stale_bot_sandbox(bot, &old_record).await;
            }
            Ok(new_sandbox_id)
        }
        Err(first_error) => {
            let Some(old_record) = old_record else {
                return Err(first_error);
            };
            tracing::warn!(
                bot_id = %bot.id,
                sandbox_id = %bot.sandbox_id,
                error = %first_error,
                "strategy repair: initial fresh sidecar create failed; deleting stale sidecar and retrying"
            );
            cleanup_stale_bot_sandbox(bot, &old_record).await;
            create_recreated_bot_sandbox(bot, "strategy-repair").await
        }
    }
}

async fn cleanup_stale_bot_sandbox(
    bot: &crate::state::TradingBotRecord,
    old_record: &SandboxRecord,
) {
    if let Err(error) = sandbox_runtime::runtime::delete_sidecar(old_record, None).await {
        tracing::warn!(
            bot_id = %bot.id,
            sandbox_id = %old_record.id,
            %error,
            "strategy repair: failed to delete stale sidecar after recreate"
        );
    }
    if let Ok(store) = sandbox_runtime::runtime::sandboxes() {
        let _ = store.remove(&old_record.id);
    }
}

fn build_trading_sandbox_params(
    request: &TradingProvisionRequest,
    env_json: String,
    runtime_backend: Option<&str>,
) -> CreateSandboxParams {
    let mut metadata = Map::new();
    if let Some(backend) = runtime_backend {
        metadata.insert(
            "runtime_backend".to_string(),
            Value::String(backend.to_string()),
        );
    }
    let metadata_json = Value::Object(metadata).to_string();

    CreateSandboxParams {
        name: request.name.clone(),
        image: std::env::var("SIDECAR_IMAGE")
            .unwrap_or_else(|_| sandbox_runtime::DEFAULT_SIDECAR_IMAGE.to_string()),
        agent_identifier: format!("trading-{}", request.strategy_type),
        env_json,
        metadata_json,
        capabilities_json: r#"["all_harness"]"#.to_string(),
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
    tracing::info!(
        call_id,
        service_id,
        strategy_type = %request.strategy_type,
        "Provision core starting"
    );
    // 0. Dedup check — if a bot already exists for this (service_id, call_id),
    // return it instead of creating a duplicate. This handles operator restarts
    // that replay past on-chain events.
    //
    // Race-safety: PROVISION_INFLIGHT prevents TOCTOU between the
    // find_bot_by_call check and the later insert. If another concurrent
    // provision for the same key is already running, we block it here.
    if let Ok(matches) = crate::state::bot_lookup_candidates_by_call_id(service_id, call_id) {
        tracing::debug!(
            call_id,
            service_id,
            live_matches = matches.live.len(),
            stale_matches = matches.stale.len(),
            "Provision dedup lookup completed"
        );
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
    tracing::debug!(
        call_id,
        service_id,
        already_inflight,
        "Provision inflight slot checked"
    );
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
    } else {
        tracing::debug!(call_id, service_id, "Provision progress tracking started");
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
    ensure_strategy_config_permitted_caller(strategy_config_obj, &caller);
    let vault_binding = parse_vault_binding(strategy_config_obj, &request)
        .inspect_err(|e| mark_provision_failed(call_id, e))?;
    apply_strategy_defaults(strategy_config_obj, &request, paper_trade, &bot_id)
        .inspect_err(|e| mark_provision_failed(call_id, e))?;
    let harness_json = harness_json_for_strategy_config(strategy_config_obj)
        .inspect_err(|e| mark_provision_failed(call_id, e))?;

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

        let api_wallet_address =
            hyperliquid_api_wallet_address_from_env()?.unwrap_or_else(|| operator_address.clone());

        apply_hyperliquid_account_metadata(
            strategy_config_obj,
            &request.strategy_type,
            chain_id,
            paper_trade,
            deployment.vault_address,
            Some(&api_wallet_address),
        );

        if should_configure_vault_supported_assets(&request.strategy_type, chain_id, paper_trade) {
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
        let params = build_trading_sandbox_params(&request, env_json, runtime_backend.as_deref());

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
        harness_json,
        validation_trust: validation_trust.unwrap_or_default(),
        baseline_backtest: None,
        renewal_webhook_url,
        active_trial_run_id: None,
        active_trial_candidate_hash: None,
        pre_trial_harness_json: None,
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
    tracing::info!(
        call_id,
        service_id,
        caller = %caller_str,
        strategy_type = %request.strategy_type,
        validation_trust = request.validation_trust,
        "Provision handler received Tangle job"
    );
    let validation_trust = match request.validation_trust {
        0 => None, // default → PerTrade
        1 => Some(trading_runtime::ValidationTrust::Envelope),
        2 => Some(trading_runtime::ValidationTrust::SelfOperated),
        other => {
            let msg = format!("Invalid validation_trust discriminant {other}");
            let _ = provision_progress::start_provision(call_id);
            mark_provision_failed(call_id, &msg);
            return Err(msg);
        }
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

#[cfg(test)]
mod tests {
    //! Pin the arena → provision → on-chain wiring. The arena emits a
    //! strategy_config with a particular shape (see
    //! `arena/src/lib/assetUniverse.ts::buildDexAssetUniverse`); the
    //! provision flow consumes it to build `VaultSupportedAssetConfig` per
    //! asset, and `crate::on_chain::resolve_asset_valuation_adapter` then
    //! resolves each adapter address from env.
    //!
    //! These tests are unit-level (no chain). They lock the resolution
    //! invariants so a future arena rename or env-var rename surfaces here
    //! instead of bricking provision in production.
    use super::*;
    use trading_runtime::supported_assets::ValuationAdapterKind;
    // Mutex serializes env-var mutations across parallel tests; this whole
    // module pokes at process env, which is shared.
    use std::sync::Mutex;
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Sample admin address used as a stand-in for both the deposit asset
    /// and the configured valuator addresses in these tests.
    const DEPOSIT_USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const TWAP_VALUATOR: &str = "0x0000000000000000000000000000000000000111";
    const CHAINLINK_VALUATOR: &str = "0x0000000000000000000000000000000000000222";
    const CUSTOM_TOKEN: &str = "0x0000000000000000000000000000000000000333";
    const KNOWN_TOKEN_WETH: &str = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const HYPEREVM_TESTNET_USDC: &str = "0x2B3370eE501B4a559b57D449569354196457D8Ab";
    const HYPERLIQUID_VAULT: &str = "0x0000000000000000000000000000000000000998";
    const HYPERLIQUID_API_WALLET: &str = "0x0000000000000000000000000000000000000a91";

    #[test]
    fn ensure_strategy_config_permitted_caller_preserves_existing_callers() {
        let mut config = serde_json::json!({
            "permittedCallers": ["0xaaaa000000000000000000000000000000000001"],
            "max_slippage": 0.5
        })
        .as_object()
        .cloned()
        .unwrap();

        ensure_strategy_config_permitted_caller(
            &mut config,
            "0xbbbb000000000000000000000000000000000002",
        );

        let callers = config
            .get("permitted_callers")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(callers.len(), 2);
        assert!(
            callers.iter().any(|value| {
                value.as_str() == Some("0xaaaa000000000000000000000000000000000001")
            })
        );
        assert!(
            callers.iter().any(|value| {
                value.as_str() == Some("0xbbbb000000000000000000000000000000000002")
            })
        );
    }

    #[test]
    fn ensure_strategy_config_permitted_caller_dedupes_case_insensitively() {
        let mut config = serde_json::json!({
            "permitted_callers": ["0xAAAA000000000000000000000000000000000001"]
        })
        .as_object()
        .cloned()
        .unwrap();

        ensure_strategy_config_permitted_caller(
            &mut config,
            "0xaaaa000000000000000000000000000000000001",
        );

        let callers = config
            .get("permitted_callers")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(callers.len(), 1);
        assert_eq!(
            callers[0].as_str(),
            Some("0xAAAA000000000000000000000000000000000001")
        );
    }

    fn set_env(unlock: &std::sync::MutexGuard<'_, ()>, vars: &[(&str, Option<&str>)]) {
        let _ = unlock; // tie env mutation to the lock guard's lifetime
        for (k, v) in vars {
            // SAFETY: serialized by ENV_LOCK against other env-touching tests.
            unsafe {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    fn provision_request(strategy_type: &str, chain_id: u64) -> TradingProvisionRequest {
        TradingProvisionRequest {
            name: "test bot".to_string(),
            strategy_type: strategy_type.to_string(),
            strategy_config_json: "{}".to_string(),
            risk_params_json: "{}".to_string(),
            factory_address: Address::ZERO,
            asset_token: Address::ZERO,
            signers: vec![],
            required_signatures: U256::ZERO,
            chain_id: U256::from(chain_id),
            rpc_url: String::new(),
            trading_loop_cron: String::new(),
            cpu_cores: 1,
            memory_mb: 512,
            max_lifetime_days: 30,
            validator_service_ids: vec![],
            max_collateral_bps: U256::ZERO,
            validation_trust: 0,
        }
    }

    fn realignment_test_bot(strategy_type: &str, strategy_config: Value) -> TradingBotRecord {
        TradingBotRecord {
            id: "trading-realign-test".to_string(),
            name: "ETH Perp Sentinel".to_string(),
            sandbox_id: "sandbox-realign-test".to_string(),
            vault_address: "0x0000000000000000000000000000000000000000".to_string(),
            share_token: String::new(),
            strategy_type: strategy_type.to_string(),
            strategy_config,
            risk_params: serde_json::json!({"max_drawdown_pct": 10}),
            chain_id: 84532,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9100".to_string(),
            trading_api_token: "token".to_string(),
            workflow_id: Some(1),
            trading_active: true,
            created_at: 1,
            operator_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: "0x1234567890abcdef1234567890abcdef12345678".to_string(),
            trading_loop_cron: String::new(),
            call_id: 1,
            service_id: 1,
            harness_json: serde_json::json!({}),
            validation_trust: trading_runtime::ValidationTrust::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        }
    }

    #[test]
    fn realign_existing_bot_strategy_pack_replaces_stale_perp_protocol_context() {
        let prompt =
            "I want an agent that trades ETH perps on Hyperliquid with strict drawdown limits.";
        let bot = realignment_test_bot(
            "perp",
            serde_json::json!({
                "user_prompt": prompt,
                "strategy_type": "perp",
                "protocol_chain_id": 84532,
                "available_protocols": ["gmx_v2"],
                "supported_assets": [{"symbol": "ETH", "protocol": "gmx_v2", "chain_id": 42161}],
                "asset_universe": {"allowed_assets": [{"symbol": "ETH", "protocol": "gmx_v2"}]},
                "asset_token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                "cash_token": "USDC",
                "protocol": "gmx_v2",
                "position_sizing": {"method": "fixed_fraction", "fraction": 0.1}
            }),
        );

        let realigned = realign_existing_bot_strategy_pack(
            &bot,
            "hyperliquid_perp",
            prompt,
            HYPEREVM_TESTNET_USDC.parse().unwrap(),
        )
        .expect("realign strategy pack");

        assert_eq!(realigned.strategy_type, "hyperliquid_perp");
        let config = realigned
            .strategy_config
            .as_object()
            .expect("config object");
        assert_eq!(
            config.get("strategy_type").and_then(Value::as_str),
            Some("hyperliquid_perp")
        );
        assert_eq!(
            config.get("protocol_chain_id").and_then(Value::as_u64),
            Some(998)
        );
        assert_eq!(
            config.get("available_protocols"),
            Some(&serde_json::json!(all_execution_protocols()))
        );
        assert_eq!(
            config.get("preferred_protocols"),
            Some(&serde_json::json!(["hyperliquid"]))
        );
        assert_eq!(
            config
                .get("protocol_chain_ids")
                .and_then(Value::as_object)
                .and_then(|chains| chains.get("hyperliquid"))
                .and_then(Value::as_u64),
            Some(998)
        );
        assert_eq!(
            config
                .get("asset_token")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase),
            Some(HYPEREVM_TESTNET_USDC.to_ascii_lowercase())
        );
        let supported_assets = realigned
            .strategy_config
            .get("supported_assets")
            .and_then(Value::as_array)
            .expect("supported assets");
        assert!(
            supported_assets.iter().any(|asset| {
                asset.get("protocol").and_then(Value::as_str) == Some("hyperliquid")
                    && asset.get("chain_id").and_then(Value::as_u64) == Some(998)
            }),
            "supported assets must include Hyperliquid on HyperEVM"
        );
        assert!(config.get("asset_universe").is_none());
        assert!(config.get("protocol").is_none());
        assert_eq!(
            realigned
                .strategy_config
                .pointer("/position_sizing/fraction")
                .and_then(Value::as_f64),
            Some(0.1)
        );
        assert_eq!(
            config.get("paper_trade").and_then(Value::as_bool),
            Some(true)
        );
        assert!(realigned.harness_json.is_object());
    }

    #[test]
    fn trading_sandbox_params_request_all_harness_runtime() {
        let request = provision_request("hyperliquid_perp", 998);

        let params = build_trading_sandbox_params(
            &request,
            r#"{"TRADING_API_TOKEN":"redacted"}"#.into(),
            Some("firecracker"),
        );

        assert_eq!(params.capabilities_json, r#"["all_harness"]"#);
        assert_eq!(params.agent_identifier, "trading-hyperliquid_perp");
        assert_eq!(params.idle_timeout_seconds, 0);
        assert_eq!(params.max_lifetime_seconds, 30 * 86_400);
        let metadata: Value = serde_json::from_str(&params.metadata_json).unwrap();
        assert_eq!(
            metadata.get("runtime_backend").and_then(Value::as_str),
            Some("firecracker")
        );
    }

    #[test]
    fn hyperliquid_perp_defaults_set_hyperevm_account_model() {
        let mut config = Map::new();
        let request = provision_request("hyperliquid_perp", 998);

        apply_strategy_defaults(&mut config, &request, false, "trading-test-bot")
            .expect("strategy defaults");

        assert_eq!(
            config.get("available_protocols"),
            Some(&serde_json::json!(all_execution_protocols()))
        );
        assert_eq!(
            config.get("preferred_protocols"),
            Some(&serde_json::json!(["hyperliquid"]))
        );
        assert_eq!(
            config
                .get("hyperliquid_execution_model")
                .and_then(Value::as_str),
            Some("hyperevm_vault_agent")
        );
        assert_eq!(
            config
                .get("hyperliquid_account_source")
                .and_then(Value::as_str),
            Some(HYPERLIQUID_ACCOUNT_SOURCE_HYPEREVM_VAULT)
        );
        assert_eq!(
            config
                .get("hyperliquid_api_wallet_approval")
                .and_then(Value::as_str),
            Some(HYPERLIQUID_API_WALLET_APPROVAL_AFTER_FUNDING)
        );
        let api_wallet_name = config
            .get("hyperliquid_api_wallet_name")
            .and_then(Value::as_str)
            .expect("API wallet name");
        assert!(api_wallet_name.starts_with("hl-"));
        assert_eq!(api_wallet_name.len(), 16);
    }

    #[test]
    fn hyperliquid_perp_defaults_to_hyperevm_protocol_chain_from_base_operator() {
        let mut config = Map::new();
        let request = provision_request("hyperliquid_perp", 84532);

        apply_strategy_defaults(&mut config, &request, true, "trading-test-bot")
            .expect("strategy defaults");

        assert_eq!(
            config.get("protocol_chain_id").and_then(Value::as_u64),
            Some(998)
        );
        assert_eq!(
            config.get("available_protocols"),
            Some(&serde_json::json!(all_execution_protocols()))
        );
        assert_eq!(
            config
                .get("protocol_chain_ids")
                .and_then(Value::as_object)
                .and_then(|chains| chains.get("hyperliquid"))
                .and_then(Value::as_u64),
            Some(998)
        );
    }

    #[test]
    fn perp_defaults_expose_gmx_vertex_and_arbitrum_protocol_context() {
        let mut config = Map::new();
        let request = provision_request("perp", 84532);

        apply_strategy_defaults(&mut config, &request, true, "trading-test-bot")
            .expect("strategy defaults");

        assert_eq!(
            config.get("available_protocols"),
            Some(&serde_json::json!(all_execution_protocols()))
        );
        assert_eq!(
            config.get("preferred_protocols"),
            Some(&serde_json::json!(["gmx_v2", "vertex"]))
        );
        assert_eq!(
            config.get("protocol_chain_id"),
            Some(&serde_json::json!(42161))
        );
        assert_eq!(config.get("paper_trade"), None);
    }

    #[test]
    fn volatility_defaults_expose_params_protocols_and_evidence_paths() {
        let mut config = Map::new();
        let request = provision_request("volatility", 84532);

        apply_strategy_defaults(&mut config, &request, true, "trading-test-bot")
            .expect("strategy defaults");

        assert_eq!(
            config.get("available_protocols"),
            Some(&serde_json::json!([
                "uniswap_v3",
                "aerodrome",
                "aave_v3",
                "morpho_vault",
                "polymarket_clob",
                "gmx_v2",
                "vertex",
                "hyperliquid"
            ]))
        );
        assert_eq!(
            config.get("preferred_protocols"),
            Some(&serde_json::json!([
                "polymarket_clob",
                "uniswap_v3",
                "gmx_v2",
                "hyperliquid",
                "vertex"
            ]))
        );
        assert_eq!(
            config
                .get("volatility_params")
                .and_then(|value| value.get("realized_window_hours")),
            Some(&serde_json::json!(24))
        );
        assert_eq!(
            config
                .get("decision_evidence")
                .and_then(|value| value.get("tool_module"))
                .and_then(Value::as_str),
            Some("volatility-tick.js")
        );
        assert_eq!(config.get("paper_safe"), Some(&Value::Bool(true)));
    }

    #[test]
    fn owner_position_sizing_overrides_default_harness_fraction() {
        let config = serde_json::json!({
            "position_sizing": {
                "method": "fixed_fraction",
                "fraction": 0.15
            }
        })
        .as_object()
        .unwrap()
        .clone();

        let harness = harness_for_strategy_config(&config).unwrap();

        match harness.position_sizing {
            trading_runtime::backtest::PositionSizing::FixedFraction { fraction } => {
                assert_eq!(fraction, 0.15);
            }
            _ => panic!("expected fixed-fraction position sizing"),
        }
    }

    #[test]
    fn strategy_harness_json_preserves_mm_execution_knobs() {
        let config = serde_json::json!({
            "position_sizing": {
                "method": "fixed_fraction",
                "fraction": 0.25
            },
            "mm": {
                "target_base_weight": 0.62,
                "rebalance_band_pct": 0.01
            },
            "min_order_usd": 5
        })
        .as_object()
        .unwrap()
        .clone();

        let harness = harness_json_for_strategy_config(&config).unwrap();

        assert_eq!(harness["position_sizing"]["fraction"], 0.25);
        assert_eq!(harness["mm"]["target_base_weight"], 0.62);
        assert_eq!(harness["mm"]["rebalance_band_pct"], 0.01);
        assert_eq!(harness["min_order_usd"], 5.0);
    }

    #[test]
    fn strategy_harness_json_preserves_portfolio_execution_knobs() {
        let config = serde_json::json!({
            "portfolio": {
                "rebalance_band_pct": 0.02,
                "assets": [
                    { "symbol": "WETH", "target_weight": 0.78 },
                    { "symbol": "USDC", "target_weight": 0.22 }
                ]
            }
        })
        .as_object()
        .unwrap()
        .clone();

        let harness = harness_json_for_strategy_config(&config).unwrap();

        assert_eq!(harness["portfolio"]["rebalance_band_pct"], 0.02);
        assert_eq!(harness["portfolio"]["assets"][0]["target_weight"], 0.78);
        assert_eq!(harness["portfolio"]["assets"][1]["target_weight"], 0.22);
    }

    #[test]
    fn strategy_harness_json_preserves_volatility_and_perp_knobs() {
        let config = serde_json::json!({
            "volatility": {
                "realized_window_hours": 24,
                "delta_hedge_threshold_pct": 5
            },
            "perps": {
                "venues": ["gmx_v2", "vertex"],
                "max_leverage": 2
            }
        })
        .as_object()
        .unwrap()
        .clone();

        let harness = harness_json_for_strategy_config(&config).unwrap();

        assert_eq!(harness["volatility"]["realized_window_hours"], 24);
        assert_eq!(harness["volatility"]["delta_hedge_threshold_pct"], 5);
        assert_eq!(harness["perps"]["venues"][0], "gmx_v2");
        assert_eq!(harness["perps"]["venues"][1], "vertex");
        assert_eq!(harness["perps"]["max_leverage"], 2);
    }

    #[test]
    fn owner_position_sizing_rejects_unsafe_fraction() {
        let config = serde_json::json!({
            "position_sizing": {
                "method": "fixed_fraction",
                "fraction": 1.5
            }
        })
        .as_object()
        .unwrap()
        .clone();

        let err = harness_for_strategy_config(&config).unwrap_err();

        assert!(err.contains("position_sizing.fraction must be between"));
    }

    #[test]
    fn hyperliquid_account_metadata_persists_deployed_vault_account() {
        let mut config = Map::new();
        let vault: Address = HYPERLIQUID_VAULT.parse().unwrap();

        apply_hyperliquid_account_metadata(
            &mut config,
            "hyperliquid_perp",
            998,
            false,
            vault,
            Some(HYPERLIQUID_API_WALLET),
        );

        assert_eq!(
            config
                .get("hyperliquid_account_address")
                .and_then(Value::as_str),
            Some(HYPERLIQUID_VAULT)
        );
        assert_eq!(
            config.get("hyperliquid_account").and_then(Value::as_str),
            Some(HYPERLIQUID_VAULT)
        );
        assert_eq!(
            config
                .get("hyperliquid_api_wallet_address")
                .and_then(Value::as_str),
            Some(HYPERLIQUID_API_WALLET)
        );
        assert_eq!(
            config
                .get("hyperliquid_api_wallet_approval_status")
                .and_then(Value::as_str),
            Some(HYPERLIQUID_API_WALLET_APPROVAL_PENDING)
        );
    }

    #[test]
    fn hyperliquid_api_wallet_metadata_prefers_dedicated_private_key() {
        let guard = ENV_LOCK.lock().unwrap();
        set_env(
            &guard,
            &[
                ("HYPERLIQUID_API_WALLET_ADDRESS", None),
                ("HYPERLIQUID_API_ADDRESS", None),
                (
                    "HYPERLIQUID_API_WALLET_PRIVATE_KEY",
                    Some("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
                ),
                ("HYPERLIQUID_API_PRIVATE_KEY", None),
            ],
        );

        let address = hyperliquid_api_wallet_address_from_env()
            .expect("api wallet address")
            .expect("derived address");

        assert_eq!(address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
        set_env(
            &guard,
            &[
                ("HYPERLIQUID_API_WALLET_ADDRESS", None),
                ("HYPERLIQUID_API_ADDRESS", None),
                ("HYPERLIQUID_API_WALLET_PRIVATE_KEY", None),
                ("HYPERLIQUID_API_PRIVATE_KEY", None),
            ],
        );
    }

    #[test]
    fn hyperliquid_account_metadata_skips_paper_mode() {
        let mut config = Map::new();
        let vault: Address = HYPERLIQUID_VAULT.parse().unwrap();

        apply_hyperliquid_account_metadata(
            &mut config,
            "hyperliquid_perp",
            998,
            true,
            vault,
            Some(HYPERLIQUID_API_WALLET),
        );

        assert!(config.get("hyperliquid_account_address").is_none());
        assert!(config.get("hyperliquid_api_wallet_address").is_none());
    }

    #[test]
    fn hyperliquid_api_wallet_approval_defers_for_live_hyperevm_perp() {
        let mut config = Map::new();
        let request = provision_request("hyperliquid_perp", 998);

        apply_strategy_defaults(&mut config, &request, false, "trading-test-bot")
            .expect("strategy defaults");

        assert_eq!(
            config
                .get("hyperliquid_api_wallet_approval")
                .and_then(Value::as_str),
            Some(HYPERLIQUID_API_WALLET_APPROVAL_AFTER_FUNDING)
        );
        assert_eq!(
            config
                .get("hyperliquid_api_wallet_approval_status")
                .and_then(Value::as_str),
            None
        );
    }

    #[test]
    fn hyperliquid_api_wallet_name_rejects_invalid_configured_name() {
        let mut config = Map::new();
        config.insert(
            "hyperliquid_api_wallet_name".to_string(),
            Value::String("abcdefghijklmnopq".to_string()),
        );
        let request = provision_request("hyperliquid_perp", 998);

        let err = apply_strategy_defaults(&mut config, &request, false, "trading-test-bot")
            .expect_err("overlong API wallet name should fail");

        assert!(err.contains("Invalid Hyperliquid API wallet name"));
        assert!(err.contains("16 characters or fewer"));
    }

    #[test]
    fn required_factory_signatures_rejects_less_than_three_signers() {
        let err = required_factory_signatures(U256::ZERO, 2).expect_err("2 signers is below floor");

        assert!(err.contains("at least 3 validator signers"));
    }

    #[test]
    fn required_factory_signatures_defaults_to_two_thirds_floor() {
        assert_eq!(
            required_factory_signatures(U256::ZERO, 3).expect("3 signers"),
            U256::from(2u64)
        );
        assert_eq!(
            required_factory_signatures(U256::ZERO, 4).expect("4 signers"),
            U256::from(3u64)
        );
        assert_eq!(
            required_factory_signatures(U256::from(2u64), 5).expect("5 signers"),
            U256::from(4u64)
        );
    }

    #[test]
    fn required_factory_signatures_honors_stricter_valid_request() {
        assert_eq!(
            required_factory_signatures(U256::from(4u64), 4).expect("4 of 4 is valid"),
            U256::from(4u64)
        );
    }

    /// Arena emits `valuation_adapter: "chainlink_or_uniswap_v3_twap"` for a
    /// custom (non-Chainlink-bundled) asset. Provision must resolve that to
    /// a `VaultSupportedAssetConfig` whose `adapter_address` is the
    /// Chainlink primary (when env-set) and `fallback_adapter_address` is
    /// the TWAP valuator. This is the canonical shape consumed by
    /// `resolve_asset_valuation_adapter`.
    #[test]
    fn arena_custom_asset_resolves_to_chainlink_or_twap_config() {
        let lock = ENV_LOCK.lock().expect("env lock");
        set_env(
            &lock,
            &[
                ("CHAINLINK_USD_VALUATOR_ADDRESS", Some(CHAINLINK_VALUATOR)),
                ("UNISWAP_V3_TWAP_VALUATOR_ADDRESS", Some(TWAP_VALUATOR)),
            ],
        );

        let strategy_config = serde_json::json!({
            "asset_universe": {
                "allowed_assets": [
                    {
                        "address": CUSTOM_TOKEN,
                        "symbol": "CUSTOM",
                        "valuation_adapter": "chainlink_or_uniswap_v3_twap",
                    }
                ]
            }
        });

        let deposit: Address = DEPOSIT_USDC.parse().unwrap();
        let configs = vault_supported_asset_configs("dex", 1, deposit, &strategy_config)
            .expect("resolve configs");

        assert_eq!(configs.len(), 1, "one custom asset → one config");
        let cfg = &configs[0];
        assert_eq!(cfg.symbol, "CUSTOM");
        assert_eq!(
            cfg.valuation_adapter,
            ValuationAdapterKind::ChainlinkOrUniswapV3Twap,
        );
        assert_eq!(
            cfg.adapter_address.unwrap(),
            CHAINLINK_VALUATOR.parse::<Address>().unwrap(),
            "primary adapter must be the Chainlink valuator",
        );
        assert_eq!(
            cfg.fallback_adapter_address.unwrap(),
            TWAP_VALUATOR.parse::<Address>().unwrap(),
            "fallback adapter must be the TWAP valuator",
        );
        assert!(
            cfg.twap_config.is_some(),
            "TWAP config must be wired so the on-chain step can call setPairFromFactory*",
        );
    }

    /// A `chainlink_or_uniswap_v3_twap` asset still resolves cleanly when
    /// only the TWAP valuator env is set — primary is left None and the
    /// on-chain resolver falls through to the TWAP adapter. Catches the
    /// path where Chainlink is unavailable on a chain.
    #[test]
    fn arena_custom_asset_with_no_chainlink_env_resolves_to_twap_only() {
        let lock = ENV_LOCK.lock().expect("env lock");
        set_env(
            &lock,
            &[
                ("CHAINLINK_USD_VALUATOR_ADDRESS", None),
                ("EXECUTION_CHAINLINK_USD_VALUATOR", None),
                ("CHAINLINK_VALUATOR_ADDRESS", None),
                ("DEPLOY_CHAINLINK_USD_VALUATOR", None),
                ("UNISWAP_V3_TWAP_VALUATOR_ADDRESS", Some(TWAP_VALUATOR)),
            ],
        );

        let strategy_config = serde_json::json!({
            "asset_universe": {
                "allowed_assets": [
                    {
                        "address": CUSTOM_TOKEN,
                        "symbol": "CUSTOM",
                        "valuation_adapter": "chainlink_or_uniswap_v3_twap",
                    }
                ]
            }
        });

        let deposit: Address = DEPOSIT_USDC.parse().unwrap();
        let configs = vault_supported_asset_configs("dex", 1, deposit, &strategy_config)
            .expect("resolve configs");

        let cfg = &configs[0];
        assert!(
            cfg.adapter_address.is_none(),
            "no Chainlink env → primary adapter is None",
        );
        assert_eq!(
            cfg.fallback_adapter_address.unwrap(),
            TWAP_VALUATOR.parse::<Address>().unwrap(),
            "TWAP valuator is the fallback",
        );
    }

    /// Arena marks a Chainlink-bundled asset with
    /// `valuation_adapter: "chainlink_usd"`. Provision must resolve the
    /// primary to the Chainlink valuator and leave the TWAP fallback empty.
    #[test]
    fn arena_known_chainlink_asset_resolves_to_chainlink_only() {
        let lock = ENV_LOCK.lock().expect("env lock");
        set_env(
            &lock,
            &[
                ("CHAINLINK_USD_VALUATOR_ADDRESS", Some(CHAINLINK_VALUATOR)),
                ("UNISWAP_V3_TWAP_VALUATOR_ADDRESS", Some(TWAP_VALUATOR)),
            ],
        );

        let strategy_config = serde_json::json!({
            "asset_universe": {
                "allowed_assets": [
                    {
                        "address": KNOWN_TOKEN_WETH,
                        "symbol": "WETH",
                        "valuation_adapter": "chainlink_usd",
                    }
                ]
            }
        });

        let deposit: Address = DEPOSIT_USDC.parse().unwrap();
        let configs = vault_supported_asset_configs("dex", 1, deposit, &strategy_config)
            .expect("resolve configs");

        let cfg = &configs[0];
        assert_eq!(cfg.valuation_adapter, ValuationAdapterKind::ChainlinkUsd);
        assert_eq!(
            cfg.adapter_address.unwrap(),
            CHAINLINK_VALUATOR.parse::<Address>().unwrap(),
        );
        assert!(
            cfg.fallback_adapter_address.is_none(),
            "Chainlink-only mode: no TWAP fallback expected",
        );
        assert!(
            cfg.twap_config.is_none(),
            "Chainlink-only mode does not need TWAP pair config",
        );
    }

    /// Hard error path: a `chainlink_usd` asset with NO Chainlink env set
    /// fails fast with a message naming the symbol — the operator runbook
    /// step that wires `CHAINLINK_USD_VALUATOR_ADDRESS` was skipped.
    #[test]
    fn missing_chainlink_env_fails_provision_with_actionable_message() {
        let lock = ENV_LOCK.lock().expect("env lock");
        set_env(
            &lock,
            &[
                ("CHAINLINK_USD_VALUATOR_ADDRESS", None),
                ("EXECUTION_CHAINLINK_USD_VALUATOR", None),
                ("CHAINLINK_VALUATOR_ADDRESS", None),
                ("DEPLOY_CHAINLINK_USD_VALUATOR", None),
                ("UNISWAP_V3_TWAP_VALUATOR_ADDRESS", Some(TWAP_VALUATOR)),
            ],
        );

        let strategy_config = serde_json::json!({
            "asset_universe": {
                "allowed_assets": [
                    {
                        "address": KNOWN_TOKEN_WETH,
                        "symbol": "WETH",
                        "valuation_adapter": "chainlink_usd",
                    }
                ]
            }
        });

        let deposit: Address = DEPOSIT_USDC.parse().unwrap();
        let err = vault_supported_asset_configs("dex", 1, deposit, &strategy_config)
            .expect_err("must fail without Chainlink env");

        assert!(
            err.contains("WETH") && err.contains("ChainlinkUsd"),
            "error must name the symbol + adapter kind so the operator can fix it; got: {err}",
        );
    }

    #[test]
    fn hyperliquid_hyperevm_live_vault_skips_generic_policy_wiring() {
        assert!(
            !should_configure_vault_supported_assets("hyperliquid_perp", 998, false),
            "HyperliquidVaultFactory is lightweight and has no PolicyEngine"
        );
        assert!(
            !should_configure_vault_supported_assets("hyperliquid-perp", 999, false),
            "hyphenated alias should use the same HyperEVM vault behavior"
        );
    }

    #[test]
    fn generic_vault_strategies_still_configure_policy_assets() {
        assert!(should_configure_vault_supported_assets("dex", 1, false));
        assert!(should_configure_vault_supported_assets(
            "perp", 42161, false
        ));
        assert!(
            should_configure_vault_supported_assets("hyperliquid_perp", 998, true),
            "paper mode does not deploy the lightweight execution vault"
        );
    }
}
