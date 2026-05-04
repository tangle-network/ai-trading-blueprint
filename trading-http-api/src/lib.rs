pub mod amounts;
pub mod auth;
pub mod candle_store;
pub mod live_portfolio;
pub mod metrics_store;
pub mod routes;
pub mod session_auth;
pub mod trade_store;

use alloy::primitives::Address;
use axum::Router;
use rust_decimal::Decimal;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;

use trading_runtime::PortfolioState;
use trading_runtime::chain::ChainClient;
use trading_runtime::executor::TradeExecutor;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::polymarket_clob::ClobClient;
use trading_runtime::validator_client::ValidatorClient;

pub struct TradingApiState {
    pub market_client: MarketDataClient,
    pub validator_client: ValidatorClient,
    pub executor: TradeExecutor,
    pub portfolio: RwLock<PortfolioState>,
    pub api_token: String,
    pub vault_address: String,
    pub validator_endpoints: Vec<String>,
    pub validation_deadline_secs: u64,
    /// Bot ID that owns this API instance.
    pub bot_id: String,
    /// Paper trading mode — trades are logged but not executed on-chain.
    pub paper_trade: bool,
    /// Wallet address of the bot owner (for session auth verification).
    pub operator_address: String,
    /// Address of the user who provisioned this bot (for session auth).
    #[allow(dead_code)]
    pub submitter_address: String,
    /// Sidecar container base URL (e.g. "http://localhost:8080").
    pub sidecar_url: String,
    /// Bearer token for authenticating with the sidecar API.
    pub sidecar_token: String,
    /// JSON-RPC URL for simulation (if available).
    pub rpc_url: Option<String>,
    /// Chain ID for simulation (defaults to 1 if not set).
    pub chain_id: Option<u64>,
    /// Polymarket CLOB client (None if not configured).
    pub clob_client: Option<Arc<ClobClient>>,
}

pub fn build_router(state: Arc<TradingApiState>) -> Router {
    Router::new()
        .merge(routes::health::router())
        .merge(routes::market_data::router())
        .merge(routes::portfolio::router())
        .merge(routes::validate::router())
        .merge(routes::execute::router())
        .merge(routes::clob::router())
        .merge(routes::collateral::router())
        .merge(routes::circuit::router())
        .merge(routes::adapters::router())
        .merge(routes::metrics::router())
        .merge(routes::trades::router())
        .merge(routes::backtest::router())
        .merge(routes::candles::router())
        .merge(routes::evolution::router())
        .merge(routes::session::router())
        .merge(routes::supported_assets::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .layer(sandbox_runtime::operator_api::build_cors_layer())
        .with_state(state)
}

/// Resolved bot context for per-request state in multi-bot mode.
///
/// This is a lightweight struct that doesn't depend on `trading-blueprint-lib`.
/// The auth middleware resolves a bot by token and inserts this into extensions.
#[derive(Clone, Debug)]
pub struct BotContext {
    pub bot_id: String,
    pub vault_address: String,
    pub paper_trade: bool,
    pub chain_id: u64,
    pub rpc_url: String,
    pub strategy_config: serde_json::Value,
    pub risk_params: serde_json::Value,
    pub validator_endpoints: Vec<String>,
    /// Validation trust level — determines per-trade vs envelope vs self-operated.
    pub validation_trust: trading_runtime::ValidationTrust,
}

const DEFAULT_MIN_AAVE_HEALTH_FACTOR: &str = "1.5";
const MIN_ALLOWED_AAVE_HEALTH_FACTOR: &str = "1.01";
const WAD_DECIMAL: &str = "1000000000000000000";

/// Shared state for the multi-bot trading HTTP API.
///
/// Unlike `TradingApiState` (per-bot), this holds operator-level config.
/// Per-bot fields (vault_address, api_token, etc.) are resolved per-request
/// by the auth middleware via `resolve_bot`.
pub struct MultiBotTradingState {
    /// Operator private key for signing transactions (hex-encoded).
    pub operator_private_key: String,
    /// Market data API base URL (e.g., CoinGecko).
    pub market_data_base_url: String,
    /// Default validation deadline in seconds.
    pub validation_deadline_secs: u64,
    /// Minimum validator score for trade approval.
    pub min_validator_score: u32,
    /// Resolves a bearer token into a BotContext. Injected by the binary.
    #[allow(clippy::type_complexity)]
    pub resolve_bot: Box<dyn Fn(&str) -> Option<BotContext> + Send + Sync>,
    /// Polymarket CLOB client (None if not configured).
    pub clob_client: Option<Arc<ClobClient>>,
    /// Shared chain client for nonce serialization across concurrent requests.
    ///
    /// Alloy's `NonceFiller` tracks the pending nonce per-provider. A fresh
    /// `ChainClient` per request would cause parallel requests to read the same
    /// on-chain nonce, resulting in one transaction reverting. Sharing a single
    /// `ChainClient` (cloned, which shares internal nonce state) prevents this.
    pub chain_client: Option<ChainClient>,
    /// RPC URL that the shared chain client is bound to.
    pub chain_client_rpc_url: Option<String>,
    /// Chain ID that the shared chain client is bound to.
    pub chain_client_chain_id: Option<u64>,
}

impl MultiBotTradingState {
    pub fn trusted_envelope_signers(&self) -> Vec<String> {
        let mut signers = Vec::new();
        if let Ok(operator) = operator_address_from_private_key(&self.operator_private_key) {
            signers.push(operator);
        }
        if let Ok(raw) = std::env::var("TRADING_ENVELOPE_TRUSTED_SIGNERS") {
            signers.extend(
                raw.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned),
            );
        }
        signers.sort();
        signers.dedup();
        signers
    }
}

pub fn operator_address_from_private_key(private_key: &str) -> Result<String, String> {
    use alloy::signers::local::PrivateKeySigner;

    let signer: PrivateKeySigner = private_key
        .parse()
        .map_err(|e| format!("Invalid operator private key: {e}"))?;
    Ok(format!("{:#x}", signer.address()))
}

fn positive_u64_from_value(value: Option<&serde_json::Value>) -> Option<u64> {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_u64().filter(|value| *value > 0),
        Some(serde_json::Value::String(raw)) => raw.parse::<u64>().ok().filter(|value| *value > 0),
        _ => None,
    }
}

fn positive_u64_from_env(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
}

pub fn protocol_chain_id_from_config(
    execution_chain_id: u64,
    strategy_config: &serde_json::Value,
) -> u64 {
    positive_u64_from_value(strategy_config.get("protocol_chain_id"))
        .or_else(|| positive_u64_from_value(strategy_config.get("fork_base_chain_id")))
        .or_else(|| positive_u64_from_env("PROTOCOL_CHAIN_ID"))
        .or_else(|| positive_u64_from_env("FORK_BASE_CHAIN_ID"))
        .unwrap_or(execution_chain_id)
}

pub fn protocol_chain_id_from_env(execution_chain_id: u64) -> u64 {
    positive_u64_from_env("PROTOCOL_CHAIN_ID")
        .or_else(|| positive_u64_from_env("FORK_BASE_CHAIN_ID"))
        .unwrap_or(execution_chain_id)
}

pub fn available_protocols_from_config(strategy_config: &serde_json::Value) -> Option<Vec<String>> {
    let value = strategy_config.get("available_protocols")?;
    let protocols = match value {
        serde_json::Value::Array(values) => values
            .iter()
            .filter_map(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        serde_json::Value::String(raw) => raw
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };

    (!protocols.is_empty()).then_some(protocols)
}

pub fn validate_protocol_available(
    strategy_config: &serde_json::Value,
    target_protocol: &str,
) -> Result<(), String> {
    let Some(protocols) = available_protocols_from_config(strategy_config) else {
        return Ok(());
    };

    if protocols.iter().any(|protocol| protocol == target_protocol) {
        return Ok(());
    }

    Err(format!(
        "Protocol {target_protocol} is not available for this bot. Available protocols: {}",
        protocols.join(", ")
    ))
}

fn decimal_from_value(value: Option<&serde_json::Value>) -> Option<Decimal> {
    match value {
        Some(serde_json::Value::Number(number)) => Decimal::from_str(&number.to_string()).ok(),
        Some(serde_json::Value::String(raw)) => Decimal::from_str(raw.trim()).ok(),
        _ => None,
    }
}

pub fn min_aave_health_factor_from_risk_params(
    risk_params: &serde_json::Value,
) -> Result<(Decimal, String), String> {
    let value = decimal_from_value(
        risk_params
            .get("min_aave_health_factor")
            .or_else(|| risk_params.get("minAaveHealthFactor")),
    )
    .unwrap_or_else(|| Decimal::from_str(DEFAULT_MIN_AAVE_HEALTH_FACTOR).unwrap());
    let floor = Decimal::from_str(MIN_ALLOWED_AAVE_HEALTH_FACTOR).unwrap();
    if value < floor {
        return Err(format!(
            "risk_params.min_aave_health_factor must be at least {floor}"
        ));
    }
    let wad = (value * Decimal::from_str(WAD_DECIMAL).unwrap()).trunc();
    Ok((value, wad.to_string()))
}

pub fn enrich_yield_safety_metadata(
    target_protocol: &str,
    action: &str,
    risk_params: &serde_json::Value,
    metadata: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if target_protocol != "aave_v3" || !matches!(action, "borrow" | "withdraw") {
        return Ok(metadata.clone());
    }

    let (min_health_factor, min_health_factor_wad) =
        min_aave_health_factor_from_risk_params(risk_params)?;
    let mut enriched = match metadata {
        serde_json::Value::Object(map) => map.clone(),
        serde_json::Value::Null => serde_json::Map::new(),
        _ => return Err("Aave borrow/withdraw metadata must be a JSON object".to_string()),
    };
    enriched.insert(
        "min_aave_health_factor".to_string(),
        serde_json::Value::String(min_health_factor.to_string()),
    );
    enriched.insert(
        "min_aave_health_factor_wad".to_string(),
        serde_json::Value::String(min_health_factor_wad),
    );
    Ok(serde_json::Value::Object(enriched))
}

#[derive(Clone, Debug)]
struct MorphoVaultAllowlistEntry {
    chain_id: u64,
    vault_address: Address,
    asset: Address,
}

fn address_from_json(value: Option<&serde_json::Value>, field: &str) -> Result<Address, String> {
    let raw = value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{field} is required"))?;
    let address = raw
        .parse::<Address>()
        .map_err(|e| format!("Invalid {field} '{raw}': {e}"))?;
    if address == Address::ZERO {
        return Err(format!("{field} must not be zero"));
    }
    Ok(address)
}

fn parse_morpho_vault_allowlist(
    value: &serde_json::Value,
) -> Result<Vec<MorphoVaultAllowlistEntry>, String> {
    let entries = value
        .as_array()
        .ok_or_else(|| "morpho_vaults must be an array".to_string())?;

    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let chain_id = positive_u64_from_value(entry.get("chain_id"))
                .ok_or_else(|| format!("morpho_vaults[{index}].chain_id is required"))?;
            let vault_address =
                address_from_json(entry.get("vault_address"), "morpho_vaults[].vault_address")?;
            let asset = address_from_json(entry.get("asset"), "morpho_vaults[].asset")?;
            Ok(MorphoVaultAllowlistEntry {
                chain_id,
                vault_address,
                asset,
            })
        })
        .collect()
}

fn morpho_vault_allowlist(
    strategy_config: &serde_json::Value,
) -> Result<Vec<MorphoVaultAllowlistEntry>, String> {
    if let Some(value) = strategy_config.get("morpho_vaults") {
        return parse_morpho_vault_allowlist(value);
    }

    let Some(raw) = std::env::var("MORPHO_VAULT_ALLOWLIST")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(Vec::new());
    };

    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid MORPHO_VAULT_ALLOWLIST JSON: {e}"))?;
    parse_morpho_vault_allowlist(&value)
}

pub fn validate_morpho_protocol_request(
    strategy_config: &serde_json::Value,
    protocol_chain_id: u64,
    target_protocol: &str,
    action: &str,
    token_in: &str,
    token_out: &str,
    metadata: &serde_json::Value,
) -> Result<(), String> {
    if target_protocol == "morpho" {
        return Err(
            "Protocol 'morpho' is ambiguous and disabled for execution; use 'morpho_vault'"
                .to_string(),
        );
    }
    if target_protocol != "morpho_vault" {
        return Ok(());
    }

    let vault_address = address_from_json(metadata.get("vault_address"), "metadata.vault_address")?;
    let expected_asset_raw = if action.eq_ignore_ascii_case("withdraw") {
        token_out
    } else {
        token_in
    };
    let expected_asset = expected_asset_raw.parse::<Address>().map_err(|e| {
        format!("Invalid Morpho vault asset token '{expected_asset_raw}' for {action}: {e}")
    })?;

    let allowlist = morpho_vault_allowlist(strategy_config)?;
    if allowlist.is_empty() {
        return Err(
            "No Morpho vault allowlist configured. Add strategy_config.morpho_vaults or MORPHO_VAULT_ALLOWLIST before using morpho_vault."
                .to_string(),
        );
    }

    if allowlist.iter().any(|entry| {
        entry.chain_id == protocol_chain_id
            && entry.vault_address == vault_address
            && entry.asset == expected_asset
    }) {
        return Ok(());
    }

    Err(format!(
        "Morpho vault {} is not allowlisted for asset {} on {}",
        vault_address, expected_asset, protocol_chain_id
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protocol_allow_list_accepts_configured_protocols() {
        let config = json!({ "available_protocols": ["gmx_v2", "vertex"] });
        assert!(validate_protocol_available(&config, "gmx_v2").is_ok());
        assert!(validate_protocol_available(&config, "vertex").is_ok());
        assert!(validate_protocol_available(&config, "hyperliquid").is_err());
    }

    #[test]
    fn missing_protocol_allow_list_is_unrestricted() {
        assert!(validate_protocol_available(&json!({}), "hyperliquid").is_ok());
    }

    #[test]
    fn legacy_morpho_protocol_is_rejected() {
        let err = validate_morpho_protocol_request(
            &json!({}),
            1,
            "morpho",
            "supply",
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000001",
            &json!({}),
        )
        .expect_err("legacy morpho should fail closed");
        assert!(err.contains("ambiguous"));
    }

    #[test]
    fn morpho_vault_requires_allowlisted_vault_asset_and_chain() {
        let config = json!({
            "morpho_vaults": [{
                "chain_id": 1,
                "vault_address": "0x0000000000000000000000000000000000000099",
                "asset": "0x0000000000000000000000000000000000000001"
            }]
        });

        assert!(
            validate_morpho_protocol_request(
                &config,
                1,
                "morpho_vault",
                "supply",
                "0x0000000000000000000000000000000000000001",
                "0x0000000000000000000000000000000000000001",
                &json!({"vault_address": "0x0000000000000000000000000000000000000099"}),
            )
            .is_ok()
        );

        let err = validate_morpho_protocol_request(
            &config,
            8453,
            "morpho_vault",
            "supply",
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000001",
            &json!({"vault_address": "0x0000000000000000000000000000000000000099"}),
        )
        .expect_err("wrong chain should be rejected");
        assert!(err.contains("not allowlisted"));
    }

    #[test]
    fn min_aave_health_factor_defaults_to_one_point_five() {
        let (value, wad) = min_aave_health_factor_from_risk_params(&json!({})).unwrap();
        assert_eq!(value.to_string(), "1.5");
        assert_eq!(wad, "1500000000000000000");
    }

    #[test]
    fn min_aave_health_factor_rejects_too_low_values() {
        let err =
            min_aave_health_factor_from_risk_params(&json!({"min_aave_health_factor": "1.0"}))
                .expect_err("too-low health factor should fail closed");
        assert!(err.contains("at least 1.01"));
    }

    #[test]
    fn enrich_yield_safety_metadata_injects_canonical_health_factor() {
        let metadata = enrich_yield_safety_metadata(
            "aave_v3",
            "borrow",
            &json!({"min_aave_health_factor": 1.6}),
            &json!({"rate_mode": 2}),
        )
        .unwrap();
        assert_eq!(metadata["rate_mode"], 2);
        assert_eq!(metadata["min_aave_health_factor"], "1.6");
        assert_eq!(
            metadata["min_aave_health_factor_wad"],
            "1600000000000000000"
        );
    }
}

/// Build a multi-bot trading HTTP API router.
///
/// This serves `/validate`, `/execute`, and `/health` for ALL bots.
/// The auth middleware resolves the calling bot from the bearer token and
/// injects the bot record into request extensions.
pub fn build_multi_bot_router(state: Arc<MultiBotTradingState>) -> Router {
    use axum::routing::get;
    Router::new()
        .route("/health", get(multi_bot_health))
        .route("/ready", get(multi_bot_ready))
        .merge(routes::market_data::multi_bot_router())
        .merge(routes::portfolio::multi_bot_router())
        .merge(routes::validate::multi_bot_router())
        .merge(routes::execute::multi_bot_router())
        .merge(routes::collateral::multi_bot_router())
        .merge(routes::circuit::multi_bot_router())
        .merge(routes::adapters::multi_bot_router())
        .merge(routes::metrics::multi_bot_router())
        .merge(routes::trades::multi_bot_router())
        .merge(routes::backtest::multi_bot_router())
        .merge(routes::candles::multi_bot_router())
        .merge(routes::evolution::multi_bot_router())
        .merge(routes::hyperliquid::multi_bot_router())
        .merge(routes::strategy::multi_bot_router())
        .merge(routes::supported_assets::multi_bot_router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::multi_bot_auth_middleware,
        ))
        .layer(sandbox_runtime::operator_api::build_cors_layer())
        .with_state(state)
}

fn multi_bot_readiness_payload(state: &MultiBotTradingState) -> (bool, serde_json::Value) {
    let rpc_ready = state
        .chain_client_rpc_url
        .as_ref()
        .is_some_and(|url| !url.trim().is_empty())
        || state.chain_client.is_some();
    let simulation_ready = rpc_ready;

    (
        rpc_ready,
        serde_json::json!({
        "status": if rpc_ready { "ok" } else { "degraded" },
        "mode": "multi",
        "rpc_ready": rpc_ready,
        "validator_count": serde_json::Value::Null,
        "validator_quorum_ready": serde_json::Value::Null,
        "simulation_ready": simulation_ready,
        "vault_ready": serde_json::Value::Null,
        }),
    )
}

async fn multi_bot_health(
    axum::extract::State(state): axum::extract::State<Arc<MultiBotTradingState>>,
) -> axum::Json<serde_json::Value> {
    let (_, payload) = multi_bot_readiness_payload(&state);
    axum::Json(payload)
}

async fn multi_bot_ready(
    axum::extract::State(state): axum::extract::State<Arc<MultiBotTradingState>>,
) -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
    let (ready, payload) = multi_bot_readiness_payload(&state);
    (
        if ready {
            axum::http::StatusCode::OK
        } else {
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        },
        axum::Json(payload),
    )
}
