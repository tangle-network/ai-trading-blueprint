//! Hyperliquid native perps trading routes.
//!
//! These endpoints let the agent trade directly on Hyperliquid's L1 via the
//! native REST API (not the on-chain bridge). Supports market/limit/stop/TP
//! orders, leverage management, and position queries.

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::{
    Json, Router,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::time::{Duration, sleep};

use trading_runtime::hyperliquid::{
    AccountInfo, CancelOrderRequest, PlaceOrderRequest, SetLeverageRequest,
};

use crate::{BotContext, MultiBotTradingState};

// ── Lazy-initialized client registry ────────────────────────────────────────

use trading_runtime::hyperliquid::HyperliquidClient;

static HL_CLIENTS: LazyLock<Mutex<HashMap<HyperliquidClientKey, &'static HyperliquidClient>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const HYPERLIQUID_API_WALLET_NAME_MAX_LEN: usize = 16;
const HYPERLIQUID_INFO_URL_MAINNET: &str = "https://api.hyperliquid.xyz/info";
const HYPERLIQUID_INFO_URL_TESTNET: &str = "https://api.hyperliquid-testnet.xyz/info";
const DEFAULT_HYPERLIQUID_EXTRA_AGENT_POLL_ATTEMPTS: usize = 60;
const DEFAULT_HYPERLIQUID_EXTRA_AGENT_POLL_DELAY_MS: u64 = 2_000;
pub(crate) const HYPERLIQUID_EXTRA_AGENT_TIMEOUT_MESSAGE: &str = "Hyperliquid API wallet approval transaction was submitted, but extraAgents did not show the signing wallet before timeout";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct HyperliquidClientKey {
    network: HyperliquidNetwork,
    signing_fingerprint: String,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum HyperliquidNetwork {
    Mainnet,
    Testnet,
}

struct HyperliquidClientConfig {
    private_key: String,
    network: HyperliquidNetwork,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HyperliquidApiWalletKeySource {
    Dedicated,
    LegacyDedicated,
    OperatorFallback,
}

#[derive(Debug)]
pub(crate) struct HyperliquidApiWalletSigningConfig {
    pub(crate) private_key: String,
    pub(crate) source: HyperliquidApiWalletKeySource,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HyperliquidExtraAgent {
    pub name: Option<String>,
    pub address: String,
    #[serde(default, rename = "validUntil")]
    pub valid_until: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct HyperliquidUserRoleResponse {
    pub(crate) role: String,
    #[serde(default)]
    pub(crate) data: Option<serde_json::Value>,
}

pub(crate) fn get_hl_client(
    state: &MultiBotTradingState,
) -> Result<&'static HyperliquidClient, (StatusCode, String)> {
    let config = hyperliquid_client_config(state)?;
    get_hl_client_for_config(config)
}

fn get_hl_client_for_config(
    config: HyperliquidClientConfig,
) -> Result<&'static HyperliquidClient, (StatusCode, String)> {
    if config.private_key.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "HYPERLIQUID_API_WALLET_PRIVATE_KEY is required for Hyperliquid signing".into(),
        ));
    }
    let key = hyperliquid_client_key(&config);
    let mut clients = HL_CLIENTS.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "HL client registry unavailable".to_string(),
        )
    })?;
    if let Some(client) = clients.get(&key) {
        return Ok(*client);
    }

    let client = match config.network {
        HyperliquidNetwork::Testnet => HyperliquidClient::testnet(&config.private_key),
        HyperliquidNetwork::Mainnet => HyperliquidClient::new(&config.private_key),
    }
    .map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("HL init: {}", redact_hyperliquid_error(&e)),
        )
    })?;
    let client = Box::leak(Box::new(client));
    clients.insert(key, client);
    Ok(client)
}

fn hyperliquid_client_config(
    state: &MultiBotTradingState,
) -> Result<HyperliquidClientConfig, (StatusCode, String)> {
    let signing = hyperliquid_api_wallet_signing_config(state)?;
    Ok(HyperliquidClientConfig {
        private_key: signing.private_key,
        network: hyperliquid_network_from_env(),
    })
}

fn hyperliquid_network_from_env() -> HyperliquidNetwork {
    if std::env::var("HYPERLIQUID_TESTNET")
        .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    {
        HyperliquidNetwork::Testnet
    } else {
        HyperliquidNetwork::Mainnet
    }
}

fn hyperliquid_client_key(config: &HyperliquidClientConfig) -> HyperliquidClientKey {
    let mut hasher = Sha256::new();
    hasher.update(config.private_key.as_bytes());
    HyperliquidClientKey {
        network: config.network,
        signing_fingerprint: format!("{:x}", hasher.finalize()),
    }
}

pub(crate) fn hyperliquid_api_wallet_signing_config(
    state: &MultiBotTradingState,
) -> Result<HyperliquidApiWalletSigningConfig, (StatusCode, String)> {
    if let Ok(key) = std::env::var("HYPERLIQUID_API_WALLET_PRIVATE_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Ok(HyperliquidApiWalletSigningConfig {
                private_key: key,
                source: HyperliquidApiWalletKeySource::Dedicated,
            });
        }
    }
    if let Ok(key) = std::env::var("HYPERLIQUID_API_PRIVATE_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Ok(HyperliquidApiWalletSigningConfig {
                private_key: key,
                source: HyperliquidApiWalletKeySource::LegacyDedicated,
            });
        }
    }
    if allow_operator_key_for_hyperliquid() {
        return Ok(HyperliquidApiWalletSigningConfig {
            private_key: state.operator_private_key.trim().to_string(),
            source: HyperliquidApiWalletKeySource::OperatorFallback,
        });
    }
    Err((
        StatusCode::SERVICE_UNAVAILABLE,
        "Hyperliquid signing requires HYPERLIQUID_API_WALLET_PRIVATE_KEY; refusing to reuse the operator key"
            .to_string(),
    ))
}

pub(crate) fn require_hyperliquid_api_wallet_signing_config_for_approval(
    state: &MultiBotTradingState,
    allow_operator_key_for_local_qa: bool,
) -> Result<HyperliquidApiWalletSigningConfig, (StatusCode, String)> {
    let config = hyperliquid_api_wallet_signing_config(state)?;
    if config.source == HyperliquidApiWalletKeySource::OperatorFallback
        && !allow_operator_key_for_local_qa
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid API wallet approval requires HYPERLIQUID_API_WALLET_PRIVATE_KEY; refusing operator-key fallback outside explicit local QA".to_string(),
        ));
    }
    if private_keys_match(&config.private_key, &state.operator_private_key)
        && !allow_operator_key_for_local_qa
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid API wallet approval requires a fresh trading-only API wallet key; refusing to reuse the operator key".to_string(),
        ));
    }
    Ok(config)
}

pub(crate) fn hyperliquid_api_wallet_address_from_private_key(
    private_key: &str,
) -> Result<String, (StatusCode, String)> {
    crate::operator_address_from_private_key(private_key).map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid Hyperliquid API wallet private key: {e}"),
        )
    })
}

fn allow_operator_key_for_hyperliquid() -> bool {
    std::env::var("ALLOW_OPERATOR_KEY_FOR_HYPERLIQUID")
        .is_ok_and(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
}

fn private_keys_match(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        value
            .trim()
            .strip_prefix("0x")
            .unwrap_or(value.trim())
            .to_ascii_lowercase()
    };
    !left.trim().is_empty() && normalize(left) == normalize(right)
}

fn config_string(config: &serde_json::Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn usable_account_address(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty()
        || value.starts_with("factory:")
        || value.starts_with("vault:")
        || value.eq_ignore_ascii_case("0x0000000000000000000000000000000000000000")
    {
        return None;
    }
    Some(value.to_string())
}

fn normalize_account_address(raw: &str, label: &str) -> Result<String, (StatusCode, String)> {
    let value = raw.trim();
    let address: alloy::primitives::Address = value.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid Hyperliquid {label} '{value}': {e}"),
        )
    })?;
    Ok(format!("{address:#x}"))
}

fn concrete_account_address(
    raw: &str,
    label: &str,
) -> Result<Option<String>, (StatusCode, String)> {
    usable_account_address(raw)
        .map(|value| normalize_account_address(&value, label))
        .transpose()
}

fn configured_account_address(
    strategy_config: &serde_json::Value,
) -> Result<Option<String>, (StatusCode, String)> {
    config_string(strategy_config, "hyperliquid_account_address")
        .or_else(|| config_string(strategy_config, "hyperliquid_account"))
        .map(|value| normalize_account_address(&value, "configured account address"))
        .transpose()
}

fn hyperliquid_account_source(config: &serde_json::Value) -> Option<String> {
    config_string(config, "hyperliquid_account_source").map(|source| source.to_ascii_lowercase())
}

pub(crate) fn hyperliquid_account_address(bot: &BotContext) -> Option<String> {
    if bot.paper_trade {
        return hyperliquid_account_address_from_config(&bot.strategy_config, &bot.vault_address);
    }
    authoritative_hyperliquid_account_address(bot).ok()
}

pub(crate) fn hyperliquid_account_address_from_config(
    strategy_config: &serde_json::Value,
    vault_address: &str,
) -> Option<String> {
    config_string(strategy_config, "hyperliquid_account_address")
        .or_else(|| config_string(strategy_config, "hyperliquid_account"))
        .or_else(|| usable_account_address(vault_address))
}

pub(crate) fn require_hyperliquid_account_address(
    bot: &BotContext,
) -> Result<String, (StatusCode, String)> {
    if bot.paper_trade {
        return hyperliquid_account_address(bot).ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Hyperliquid execution requires a configured account address or a concrete bot vault address".to_string(),
            )
        });
    }
    authoritative_hyperliquid_account_address(bot)
}

pub(crate) fn require_hyperliquid_account_address_from_config(
    strategy_config: &serde_json::Value,
    vault_address: &str,
    paper_trade: bool,
) -> Result<String, (StatusCode, String)> {
    if paper_trade {
        return hyperliquid_account_address_from_config(strategy_config, vault_address).ok_or_else(
            || {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Hyperliquid execution requires a configured account address or a concrete bot vault address".to_string(),
                )
            },
        );
    }
    authoritative_hyperliquid_account_address_from_config(strategy_config, vault_address)
}

pub(crate) fn authoritative_hyperliquid_account_address(
    bot: &BotContext,
) -> Result<String, (StatusCode, String)> {
    authoritative_hyperliquid_account_address_from_config(&bot.strategy_config, &bot.vault_address)
}

pub(crate) fn authoritative_hyperliquid_account_address_from_config(
    strategy_config: &serde_json::Value,
    vault_address: &str,
) -> Result<String, (StatusCode, String)> {
    let configured = configured_account_address(strategy_config)?;
    let vault = concrete_account_address(vault_address, "bot vault address")?;
    let source = hyperliquid_account_source(strategy_config);

    if source.as_deref() == Some("hyperevm_vault_contract") {
        let vault = vault.ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Hyperliquid hyperevm_vault_contract account source requires a concrete bot vault address".to_string(),
            )
        })?;
        if let Some(configured) = configured {
            ensure_same_account(&configured, &vault)?;
        }
        return Ok(vault);
    }

    if let Some(source) = source.as_deref() {
        if source != "configured_account" && source != "api_wallet_account" {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("Unsupported Hyperliquid account source '{source}'"),
            ));
        }
        let configured = configured.ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("Hyperliquid account source '{source}' requires strategy_config.hyperliquid_account_address"),
            )
        })?;
        if let Some(vault) = vault {
            ensure_same_account(&configured, &vault)?;
            return Ok(vault);
        }
        return Ok(configured);
    }

    match (vault, configured) {
        (Some(vault), Some(configured)) => {
            ensure_same_account(&configured, &vault)?;
            Ok(vault)
        }
        (Some(vault), None) => Ok(vault),
        (None, Some(configured)) => Ok(configured),
        (None, None) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid live execution requires an authoritative account address".to_string(),
        )),
    }
}

fn ensure_same_account(configured: &str, vault: &str) -> Result<(), (StatusCode, String)> {
    if configured.eq_ignore_ascii_case(vault) {
        Ok(())
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "Hyperliquid configured account does not match the authoritative bot vault account"
                .to_string(),
        ))
    }
}

pub(crate) fn require_optional_hyperliquid_account_address(
    bot: &BotContext,
) -> Result<Option<String>, (StatusCode, String)> {
    if bot.paper_trade {
        return Ok(hyperliquid_account_address(bot));
    }
    match authoritative_hyperliquid_account_address(bot) {
        Ok(account) => Ok(Some(account)),
        Err((StatusCode::SERVICE_UNAVAILABLE, _)) => Ok(None),
        Err(err) => Err(err),
    }
}

pub(crate) fn hyperliquid_requires_api_wallet_approval(config: &serde_json::Value) -> bool {
    hyperliquid_account_source(config)
        .is_some_and(|source| source.eq_ignore_ascii_case("hyperevm_vault_contract"))
        || config.get("hyperliquid_api_wallet_approval").is_some()
}

pub(crate) async fn require_hyperliquid_execution_ready(
    state: &MultiBotTradingState,
    bot: &BotContext,
) -> Result<(), (StatusCode, String)> {
    if bot.paper_trade {
        return Ok(());
    }
    if config_bool(&bot.strategy_config, "hyperliquid_execution_disabled")
        || config_bool(&bot.strategy_config, "hyperliquid_trading_disabled")
        || config_bool(&bot.strategy_config, "hyperliquid_kill_switch")
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Hyperliquid execution is disabled for this bot".to_string(),
        ));
    }

    if hyperliquid_requires_api_wallet_approval(&bot.strategy_config) {
        validate_hyperliquid_api_wallet_name_config(&bot.strategy_config, &bot.bot_id)?;
        let account = authoritative_hyperliquid_account_address(bot)?;
        let expected_wallet = config_string(&bot.strategy_config, "hyperliquid_api_wallet_address");
        let status = config_string(
            &bot.strategy_config,
            "hyperliquid_api_wallet_approval_status",
        )
        .unwrap_or_default();
        if status.eq_ignore_ascii_case("verified_corewriter_approval") {
            let actual = get_hl_client(state)?.wallet_address();
            if let Some(expected) = expected_wallet.as_deref()
                && !expected.trim().eq_ignore_ascii_case(actual.trim())
            {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Configured Hyperliquid API wallet does not match the executor signing key"
                        .to_string(),
                ));
            }
            ensure_hyperliquid_api_wallet_extra_agent(&account, &actual).await?;
        } else {
            let Some(expected) = expected_wallet.as_deref() else {
                return Err((
                    StatusCode::FORBIDDEN,
                    "Hyperliquid API wallet approval is not verified for this vault".to_string(),
                ));
            };
            if !hyperliquid_extra_agents_contains(
                &hyperliquid_extra_agents(&account).await?,
                expected,
            ) {
                return Err((
                    StatusCode::FORBIDDEN,
                    "Hyperliquid API wallet approval is not verified for this vault".to_string(),
                ));
            }
            let actual = get_hl_client(state)?.wallet_address();
            if !expected.trim().eq_ignore_ascii_case(actual.trim()) {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Configured Hyperliquid API wallet does not match the executor signing key"
                        .to_string(),
                ));
            }
        }
    } else if let Some(expected) =
        config_string(&bot.strategy_config, "hyperliquid_api_wallet_address")
    {
        let actual = get_hl_client(state)?.wallet_address();
        if !expected.trim().eq_ignore_ascii_case(actual.trim()) {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Configured Hyperliquid API wallet does not match the executor signing key"
                    .to_string(),
            ));
        }
    }

    Ok(())
}

pub(crate) async fn hyperliquid_user_role(user: &str) -> Result<String, (StatusCode, String)> {
    hyperliquid_user_role_details(user)
        .await
        .map(|body| body.role)
}

pub(crate) async fn hyperliquid_user_role_details(
    user: &str,
) -> Result<HyperliquidUserRoleResponse, (StatusCode, String)> {
    let response = reqwest::Client::new()
        .post(hyperliquid_info_url())
        .json(&serde_json::json!({
            "type": "userRole",
            "user": user,
        }))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid userRole check failed: {e}"),
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid userRole check returned {status}: {body}"),
        ));
    }
    response
        .json::<HyperliquidUserRoleResponse>()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid userRole decode failed: {e}"),
            )
        })
}

pub(crate) fn exchange_vault_address_for_user_role(
    account: &str,
    role: &str,
) -> Result<Option<String>, (StatusCode, String)> {
    match role.trim().to_ascii_lowercase().as_str() {
        "user" => Ok(None),
        "vault" | "subaccount" | "sub_account" => Ok(Some(account.to_string())),
        "missing" => Err((
            StatusCode::FORBIDDEN,
            format!("Hyperliquid account {account} is missing on HyperCore"),
        )),
        other => Err((
            StatusCode::BAD_GATEWAY,
            format!("Unsupported Hyperliquid account role '{other}' for order submission"),
        )),
    }
}

pub(crate) async fn hyperliquid_exchange_vault_address(
    account: &str,
) -> Result<Option<String>, (StatusCode, String)> {
    let role = hyperliquid_user_role(account).await?;
    exchange_vault_address_for_user_role(account, &role)
}

pub(crate) async fn hyperliquid_extra_agents(
    user: &str,
) -> Result<Vec<HyperliquidExtraAgent>, (StatusCode, String)> {
    let response = reqwest::Client::new()
        .post(hyperliquid_info_url())
        .json(&serde_json::json!({
            "type": "extraAgents",
            "user": user,
        }))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid extraAgents check failed: {e}"),
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid extraAgents check returned {status}: {body}"),
        ));
    }
    response
        .json::<Vec<HyperliquidExtraAgent>>()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid extraAgents decode failed: {e}"),
            )
        })
}

pub(crate) async fn wait_for_hyperliquid_api_wallet_extra_agent(
    account: &str,
    wallet: &str,
) -> Result<Vec<HyperliquidExtraAgent>, (StatusCode, String)> {
    let attempts = hyperliquid_extra_agent_poll_attempts();
    let delay_ms = hyperliquid_extra_agent_poll_delay_ms();
    for attempt in 0..attempts {
        let latest = hyperliquid_extra_agents(account).await?;
        if hyperliquid_extra_agents_contains(&latest, wallet) {
            return Ok(latest);
        }
        if attempt + 1 < attempts {
            sleep(Duration::from_millis(delay_ms)).await;
        }
    }
    Err((
        StatusCode::BAD_GATEWAY,
        HYPERLIQUID_EXTRA_AGENT_TIMEOUT_MESSAGE.to_string(),
    ))
}

fn hyperliquid_extra_agent_poll_attempts() -> usize {
    std::env::var("HYPERLIQUID_EXTRA_AGENT_POLL_ATTEMPTS")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|attempts| *attempts > 0)
        .unwrap_or(DEFAULT_HYPERLIQUID_EXTRA_AGENT_POLL_ATTEMPTS)
}

fn hyperliquid_extra_agent_poll_delay_ms() -> u64 {
    std::env::var("HYPERLIQUID_EXTRA_AGENT_POLL_DELAY_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_HYPERLIQUID_EXTRA_AGENT_POLL_DELAY_MS)
}

pub(crate) fn hyperliquid_extra_agents_contains(
    agents: &[HyperliquidExtraAgent],
    wallet: &str,
) -> bool {
    agents
        .iter()
        .any(|agent| agent.address.trim().eq_ignore_ascii_case(wallet.trim()))
}

async fn ensure_hyperliquid_api_wallet_extra_agent(
    account: &str,
    wallet: &str,
) -> Result<(), (StatusCode, String)> {
    let agents = hyperliquid_extra_agents(account).await?;
    if hyperliquid_extra_agents_contains(&agents, wallet) {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "Hyperliquid API wallet approval is not present in extraAgents for this vault"
                .to_string(),
        ))
    }
}

fn hyperliquid_info_url() -> String {
    std::env::var("HYPERLIQUID_INFO_URL")
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| match hyperliquid_network_from_env() {
            HyperliquidNetwork::Mainnet => HYPERLIQUID_INFO_URL_MAINNET.to_string(),
            HyperliquidNetwork::Testnet => HYPERLIQUID_INFO_URL_TESTNET.to_string(),
        })
}

fn validate_hyperliquid_api_wallet_name_config(
    strategy_config: &serde_json::Value,
    bot_id: &str,
) -> Result<(), (StatusCode, String)> {
    normalize_hyperliquid_api_wallet_name(
        strategy_config
            .get("hyperliquid_api_wallet_name")
            .and_then(serde_json::Value::as_str),
        bot_id,
    )
    .map(|_| ())
    .map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid Hyperliquid API wallet name: {e}"),
        )
    })
}

fn config_bool(config: &serde_json::Value, key: &str) -> bool {
    config
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn reject_live_direct_hyperliquid(bot: &BotContext) -> Result<(), (StatusCode, String)> {
    if bot.paper_trade {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        "Live Hyperliquid direct routes are disabled; submit live trades through /execute so PerTrade or signed Envelope authorization can be verified".into(),
    ))
}

// ── Request/Response types ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BracketOrderRequest {
    pub entry: PlaceOrderRequest,
    #[serde(default)]
    pub stop_loss: Option<PlaceOrderRequest>,
    #[serde(default)]
    pub take_profit: Option<PlaceOrderRequest>,
}

#[derive(Serialize)]
pub struct OrderResponse {
    pub status: String,
    pub data: serde_json::Value,
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn place_order(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<PlaceOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let account_address = require_optional_hyperliquid_account_address(&bot)?;
    let resp = client
        .place_order_for_account(&req, account_address.as_deref())
        .await
        .map_err(hyperliquid_bad_gateway)?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn place_bracket(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<BracketOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let account_address = require_optional_hyperliquid_account_address(&bot)?;
    let resp = client
        .place_bracket_for_account(
            &req.entry,
            req.stop_loss.as_ref(),
            req.take_profit.as_ref(),
            account_address.as_deref(),
        )
        .await
        .map_err(hyperliquid_bad_gateway)?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn cancel_order(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<CancelOrderRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let account_address = require_optional_hyperliquid_account_address(&bot)?;
    let resp = client
        .cancel_order_for_account(req.asset, req.order_id, account_address.as_deref())
        .await
        .map_err(hyperliquid_bad_gateway)?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn set_leverage(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<SetLeverageRequest>,
) -> Result<Json<OrderResponse>, (StatusCode, String)> {
    reject_live_direct_hyperliquid(&bot)?;
    let client = get_hl_client(&state)?;
    let resp = client
        .set_leverage(req.asset, req.leverage, req.is_cross)
        .await
        .map_err(hyperliquid_bad_gateway)?;
    Ok(Json(OrderResponse {
        status: "ok".into(),
        data: serde_json::to_value(&resp).unwrap_or_default(),
    }))
}

async fn get_account(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<AccountInfo>, (StatusCode, String)> {
    let client = get_hl_client(&state)?;
    let account_address = require_optional_hyperliquid_account_address(&bot)?;
    let account = client
        .get_account_for(account_address.as_deref())
        .await
        .map_err(hyperliquid_bad_gateway)?;
    Ok(Json(account))
}

async fn get_prices(
    State(state): State<Arc<MultiBotTradingState>>,
) -> Result<Json<std::collections::HashMap<String, String>>, (StatusCode, String)> {
    let client = get_hl_client(&state)?;
    let mids = client.get_mids().await.map_err(hyperliquid_bad_gateway)?;
    Ok(Json(mids))
}

fn hyperliquid_bad_gateway(error: String) -> (StatusCode, String) {
    (StatusCode::BAD_GATEWAY, redact_hyperliquid_error(&error))
}

pub fn normalize_hyperliquid_api_wallet_name(
    configured_name: Option<&str>,
    fallback_bot_id: &str,
) -> Result<String, String> {
    if let Some(candidate) = configured_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return validate_hyperliquid_api_wallet_name(candidate);
    }

    Ok(hyperliquid_api_wallet_fallback_name(fallback_bot_id))
}

fn validate_hyperliquid_api_wallet_name(candidate: &str) -> Result<String, String> {
    if candidate.is_empty() {
        return Err("name is required".to_string());
    }
    if candidate.len() > HYPERLIQUID_API_WALLET_NAME_MAX_LEN {
        return Err(format!(
            "name must be {HYPERLIQUID_API_WALLET_NAME_MAX_LEN} characters or fewer"
        ));
    }
    if !candidate
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("name may only contain ASCII letters, numbers, '-' and '_'".to_string());
    }

    Ok(candidate.to_string())
}

fn hyperliquid_api_wallet_fallback_name(bot_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bot_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("hl-{}", &digest[..HYPERLIQUID_API_WALLET_NAME_MAX_LEN - 3])
}

pub(crate) fn redact_hyperliquid_error(error: &str) -> String {
    error
        .split_whitespace()
        .map(redact_error_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_error_token(token: &str) -> String {
    let Some(scheme_start) = token.find("http://").or_else(|| token.find("https://")) else {
        return token.to_string();
    };
    let (prefix, rest) = token.split_at(scheme_start);
    let trailing = rest
        .find([')', ']', '}'])
        .map(|idx| &rest[idx..])
        .unwrap_or("");
    format!("{prefix}<redacted-url>{trailing}")
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/hyperliquid/order", post(place_order))
        .route("/hyperliquid/bracket", post(place_bracket))
        .route("/hyperliquid/cancel", post(cancel_order))
        .route("/hyperliquid/leverage", post(set_leverage))
        .route("/hyperliquid/account", get(get_account))
        .route("/hyperliquid/prices", get(get_prices))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> MultiBotTradingState {
        MultiBotTradingState {
            operator_private_key:
                "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80".to_string(),
            market_data_base_url: "http://localhost:1234".to_string(),
            validation_deadline_secs: 300,
            min_validator_score: 50,
            resolve_bot: Box::new(|_| None),
            list_envelope_bots: None,
            clob_client: None,
            chain_client: None,
            chain_client_rpc_url: None,
            chain_client_chain_id: None,
            alert_sink: crate::alerts::AlertSink::new(None, None),
            key_provider: trading_runtime::cex::default_provider(),
            rate_limiter: std::sync::Arc::new(crate::rate_limit::PerBotRateLimiter::default()),
            nav_stream_config: None,
            hyperliquid_nav_reconciler: std::sync::Arc::new(
                crate::hyperliquid_nav::DefaultHyperliquidNavReconciler,
            ),
        }
    }

    fn bot(vault_address: &str, strategy_config: serde_json::Value) -> BotContext {
        BotContext {
            bot_id: "bot-1".to_string(),
            vault_address: vault_address.to_string(),
            paper_trade: false,
            chain_id: 998,
            rpc_url: "https://rpc.hyperliquid-testnet.xyz/evm".to_string(),
            strategy_config,
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        }
    }

    #[test]
    fn account_address_uses_vault_when_config_matches() {
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_source": "hyperevm_vault_contract",
                "hyperliquid_account_address": "0x1111111111111111111111111111111111111111"
            }),
        );

        assert_eq!(
            hyperliquid_account_address(&bot).as_deref(),
            Some("0x1111111111111111111111111111111111111111")
        );
    }

    #[test]
    fn account_address_rejects_config_drift_from_vault_lane() {
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_source": "hyperevm_vault_contract",
                "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
            }),
        );

        let err = require_hyperliquid_account_address(&bot)
            .expect_err("config account drift must be rejected");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("does not match"));
    }

    #[test]
    fn account_address_rejects_config_drift_even_without_source() {
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
            }),
        );

        let err = require_hyperliquid_account_address(&bot)
            .expect_err("concrete vault remains authoritative without a source");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("does not match"));
    }

    #[test]
    fn explicit_configured_account_source_allows_non_vault_account() {
        let bot = bot(
            "factory:0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_source": "configured_account",
                "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
            }),
        );

        assert_eq!(
            require_hyperliquid_account_address(&bot)
                .expect("explicit config source should resolve")
                .as_str(),
            "0x2222222222222222222222222222222222222222"
        );
    }

    #[test]
    fn explicit_configured_account_source_cannot_override_concrete_vault() {
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_source": "configured_account",
                "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
            }),
        );

        let err = require_hyperliquid_account_address(&bot)
            .expect_err("concrete vault must remain authoritative for live bots");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("configured account"));
    }

    #[test]
    fn account_address_falls_back_to_concrete_vault() {
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({}),
        );

        assert_eq!(
            hyperliquid_account_address(&bot).as_deref(),
            Some("0x1111111111111111111111111111111111111111")
        );
    }

    #[test]
    fn account_address_rejects_placeholders() {
        let bot = bot(
            "factory:0x1111111111111111111111111111111111111111",
            serde_json::json!({}),
        );

        assert_eq!(hyperliquid_account_address(&bot), None);
    }

    #[test]
    fn exchange_vault_address_is_omitted_for_normal_hypercore_user() {
        assert_eq!(
            exchange_vault_address_for_user_role(
                "0xd5817ec2e2f09b577b143114d9bb991900a068c1",
                "user"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn exchange_vault_address_is_used_for_vault_or_subaccount_roles() {
        assert_eq!(
            exchange_vault_address_for_user_role(
                "0xd5817ec2e2f09b577b143114d9bb991900a068c1",
                "vault"
            )
            .unwrap()
            .as_deref(),
            Some("0xd5817ec2e2f09b577b143114d9bb991900a068c1")
        );
        assert_eq!(
            exchange_vault_address_for_user_role(
                "0xd5817ec2e2f09b577b143114d9bb991900a068c1",
                "subAccount"
            )
            .unwrap()
            .as_deref(),
            Some("0xd5817ec2e2f09b577b143114d9bb991900a068c1")
        );
    }

    #[tokio::test]
    async fn execution_ready_rejects_kill_switch() {
        let state = state();
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({ "hyperliquid_kill_switch": true }),
        );

        assert_eq!(
            require_hyperliquid_execution_ready(&state, &bot)
                .await
                .expect_err("kill switch should block")
                .0,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn execution_ready_requires_verified_api_wallet_approval_for_hyperevm_vault() {
        let state = state();
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_source": "hyperevm_vault_contract",
                "hyperliquid_api_wallet_approval_status": "pending_corewriter_approval"
            }),
        );

        assert_eq!(
            require_hyperliquid_execution_ready(&state, &bot)
                .await
                .expect_err("pending API wallet approval should block")
                .0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn client_registry_separates_signing_identity_and_network() {
        let key_one =
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80".to_string();
        let key_two =
            "0x59c6995e998f97a5a0044966f094538b292d11b7e6c370b55f6ec3b87cebf452".to_string();

        let mainnet_one = get_hl_client_for_config(HyperliquidClientConfig {
            private_key: key_one.clone(),
            network: HyperliquidNetwork::Mainnet,
        })
        .expect("mainnet key one client");
        let mainnet_one_again = get_hl_client_for_config(HyperliquidClientConfig {
            private_key: key_one.clone(),
            network: HyperliquidNetwork::Mainnet,
        })
        .expect("same key/network client");
        let mainnet_two = get_hl_client_for_config(HyperliquidClientConfig {
            private_key: key_two,
            network: HyperliquidNetwork::Mainnet,
        })
        .expect("mainnet key two client");
        let testnet_one = get_hl_client_for_config(HyperliquidClientConfig {
            private_key: key_one,
            network: HyperliquidNetwork::Testnet,
        })
        .expect("testnet key one client");

        assert!(std::ptr::addr_eq(mainnet_one, mainnet_one_again));
        assert!(!std::ptr::addr_eq(mainnet_one, mainnet_two));
        assert!(!std::ptr::addr_eq(mainnet_one, testnet_one));
        assert_ne!(mainnet_one.wallet_address(), mainnet_two.wallet_address());
    }

    #[test]
    fn api_wallet_name_normalization_trims_and_uses_safe_fallback() {
        assert_eq!(
            normalize_hyperliquid_api_wallet_name(Some("  hl_bot-01  "), "fallback").unwrap(),
            "hl_bot-01"
        );
        let fallback = normalize_hyperliquid_api_wallet_name(
            None,
            "trading-ac1d9cf1-61e0-4df8-a486-024aa2db1694",
        )
        .unwrap();
        assert!(fallback.starts_with("hl-"));
        assert_eq!(fallback.len(), HYPERLIQUID_API_WALLET_NAME_MAX_LEN);
        assert_ne!(fallback, "trading-ac1d9cf1-61e0-4-4787d52c");
    }

    #[test]
    fn api_wallet_name_validation_rejects_unsafe_or_overlong_names() {
        assert_eq!(
            normalize_hyperliquid_api_wallet_name(Some("abcdefghijklmnop"), "ok").unwrap(),
            "abcdefghijklmnop"
        );
        assert!(normalize_hyperliquid_api_wallet_name(Some("bad name"), "fallback").is_err());
        assert!(normalize_hyperliquid_api_wallet_name(Some("bad/name"), "fallback").is_err());
        assert!(normalize_hyperliquid_api_wallet_name(Some("abcdefghijklmnopq"), "ok").is_err());
    }

    #[tokio::test]
    async fn execution_ready_validates_api_wallet_name_before_approval_use() {
        let state = state();
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_source": "hyperevm_vault_contract",
                "hyperliquid_api_wallet_name": "bad name",
                "hyperliquid_api_wallet_approval_status": "verified_corewriter_approval"
            }),
        );

        assert_eq!(
            require_hyperliquid_execution_ready(&state, &bot)
                .await
                .expect_err("unsafe API wallet name should block")
                .0,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn hyperliquid_error_redaction_removes_raw_urls() {
        let redacted = redact_hyperliquid_error(
            "HL user_state: request to https://rpc.example.internal/evm?token=secret failed",
        );

        assert!(!redacted.contains("rpc.example.internal"));
        assert!(!redacted.contains("token=secret"));
        assert!(redacted.contains("<redacted-url>"));
    }

    #[test]
    fn hyperliquid_error_redaction_keeps_semicolon_and_comma_suffixes_inside_url_token() {
        let redacted = redact_hyperliquid_error(
            "upstream https://rpc.example.internal/evm?token=secret;api_key=abc,trace=def failed",
        );

        assert!(!redacted.contains("rpc.example.internal"));
        assert!(!redacted.contains("api_key=abc"));
        assert!(!redacted.contains("trace=def"));
        assert_eq!(redacted, "upstream <redacted-url> failed");
    }

    #[test]
    fn hyperliquid_key_requires_dedicated_env_without_escape_hatch() {
        let state = state();

        // SAFETY: this unit test does not spawn threads or depend on concurrent env access.
        unsafe {
            std::env::remove_var("HYPERLIQUID_API_WALLET_PRIVATE_KEY");
            std::env::remove_var("HYPERLIQUID_API_PRIVATE_KEY");
            std::env::remove_var("ALLOW_OPERATOR_KEY_FOR_HYPERLIQUID");
        }

        assert_eq!(
            hyperliquid_api_wallet_signing_config(&state)
                .expect_err("operator key reuse should be rejected")
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
