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

use trading_runtime::hyperliquid::{
    AccountInfo, CancelOrderRequest, PlaceOrderRequest, SetLeverageRequest,
};

use crate::{BotContext, MultiBotTradingState};

// ── Lazy-initialized client registry ────────────────────────────────────────

use trading_runtime::hyperliquid::HyperliquidClient;

static HL_CLIENTS: LazyLock<Mutex<HashMap<HyperliquidClientKey, &'static HyperliquidClient>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const HYPERLIQUID_API_WALLET_NAME_MAX_LEN: usize = 32;

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

pub(crate) fn get_hl_client(
    state: &MultiBotTradingState,
) -> Result<&'static HyperliquidClient, (StatusCode, String)> {
    let config = hyperliquid_client_config(state)?;
    get_hl_client_for_config(config)
}

/// Public, well-known anvil dev key #1. Holds no funds; never used to SIGN a
/// submitted order. Used ONLY to construct the read client when no real
/// signing key is configured — Hyperliquid info queries (get_mids,
/// get_account) are public and don't sign, so paper bots can read prices +
/// account state without a real key. Paper order execution simulates fills
/// (see execute.rs / portfolio.rs `paper_trade: true`) and never reaches the
/// signing path, so a dummy key cannot place a real order.
const HL_READ_DUMMY_KEY: &str =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/// Read-only HL client for public info queries. Falls back to the dummy key
/// when no signing key is configured — this is what lets PAPER bots read
/// prices/account/NAV without provisioning a real Hyperliquid signing key
/// (paper trading is pure simulation; it should never need a key — that was
/// the Gen-3 blocker where the bot safe-skipped every trade). Strict signing
/// paths still go through `get_hl_client`.
pub(crate) fn get_hl_read_client(
    state: &MultiBotTradingState,
) -> Result<&'static HyperliquidClient, (StatusCode, String)> {
    let network = hyperliquid_network_from_env();
    let private_key = hyperliquid_api_wallet_private_key(state)
        .ok()
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| HL_READ_DUMMY_KEY.to_string());
    get_hl_client_for_config(HyperliquidClientConfig {
        private_key,
        network,
    })
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
    Ok(HyperliquidClientConfig {
        private_key: hyperliquid_api_wallet_private_key(state)?,
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

fn hyperliquid_api_wallet_private_key(
    state: &MultiBotTradingState,
) -> Result<String, (StatusCode, String)> {
    if let Ok(key) = std::env::var("HYPERLIQUID_API_WALLET_PRIVATE_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Ok(key);
        }
    }
    if let Ok(key) = std::env::var("HYPERLIQUID_API_PRIVATE_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Ok(key);
        }
    }
    if std::env::var("ALLOW_OPERATOR_KEY_FOR_HYPERLIQUID")
        .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    {
        return Ok(state.operator_private_key.trim().to_string());
    }
    Err((
        StatusCode::SERVICE_UNAVAILABLE,
        "Hyperliquid signing requires HYPERLIQUID_API_WALLET_PRIVATE_KEY; refusing to reuse the operator key"
            .to_string(),
    ))
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

pub(crate) fn require_hyperliquid_execution_ready(
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
        let status = config_string(
            &bot.strategy_config,
            "hyperliquid_api_wallet_approval_status",
        )
        .unwrap_or_default();
        if !status.eq_ignore_ascii_case("submitted_corewriter_approval") {
            return Err((
                StatusCode::FORBIDDEN,
                "Hyperliquid API wallet approval is not submitted for this vault".to_string(),
            ));
        }
    }

    if let Some(expected) = config_string(&bot.strategy_config, "hyperliquid_api_wallet_address") {
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
    // Read-only public query — use the read client so paper bots without a
    // signing key can still fetch account state (dummy-key fallback).
    let client = get_hl_read_client(&state)?;
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
    // allMids is fully public — never needs a signing key. Read client with
    // dummy-key fallback so prices work even on a key-less paper devnet.
    let client = get_hl_read_client(&state)?;
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
    let mut safe = bot_id
        .trim()
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
                char::from(byte)
            } else {
                '-'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        safe = "bot".to_string();
    }
    if safe.len() <= HYPERLIQUID_API_WALLET_NAME_MAX_LEN {
        return safe;
    }

    let mut hasher = Sha256::new();
    hasher.update(bot_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let prefix_len = HYPERLIQUID_API_WALLET_NAME_MAX_LEN - 9;
    format!("{}-{}", &safe[..prefix_len], &digest[..8])
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
    fn execution_ready_rejects_kill_switch() {
        let state = state();
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({ "hyperliquid_kill_switch": true }),
        );

        assert_eq!(
            require_hyperliquid_execution_ready(&state, &bot)
                .expect_err("kill switch should block")
                .0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn execution_ready_requires_submitted_api_wallet_approval_for_hyperevm_vault() {
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
        assert_eq!(
            normalize_hyperliquid_api_wallet_name(None, "bot-default").unwrap(),
            "bot-default"
        );
        assert_eq!(
            normalize_hyperliquid_api_wallet_name(
                None,
                "trading-027084ef-4e69-4c9b-a018-e35f9645086f"
            )
            .unwrap()
            .len(),
            HYPERLIQUID_API_WALLET_NAME_MAX_LEN
        );
    }

    #[test]
    fn api_wallet_name_validation_rejects_unsafe_or_overlong_names() {
        assert!(normalize_hyperliquid_api_wallet_name(Some("bad name"), "fallback").is_err());
        assert!(normalize_hyperliquid_api_wallet_name(Some("bad/name"), "fallback").is_err());
        assert!(
            normalize_hyperliquid_api_wallet_name(Some("abcdefghijklmnopqrstuvwxyz1234567"), "ok")
                .is_err()
        );
    }

    #[test]
    fn execution_ready_validates_api_wallet_name_before_approval_use() {
        let state = state();
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_source": "hyperevm_vault_contract",
                "hyperliquid_api_wallet_name": "bad name",
                "hyperliquid_api_wallet_approval_status": "submitted_corewriter_approval"
            }),
        );

        assert_eq!(
            require_hyperliquid_execution_ready(&state, &bot)
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
            hyperliquid_api_wallet_private_key(&state)
                .expect_err("operator key reuse should be rejected")
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
