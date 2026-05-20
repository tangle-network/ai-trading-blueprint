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
use std::sync::Arc;

use trading_runtime::hyperliquid::{
    AccountInfo, CancelOrderRequest, PlaceOrderRequest, SetLeverageRequest,
};

use crate::{BotContext, MultiBotTradingState};

// ── Lazy-initialized client ─────────────────────────────────────────────────

use std::sync::OnceLock;
use trading_runtime::hyperliquid::HyperliquidClient;

static HL_CLIENT: OnceLock<HyperliquidClient> = OnceLock::new();

pub(crate) fn get_hl_client(
    state: &MultiBotTradingState,
) -> Result<&'static HyperliquidClient, (StatusCode, String)> {
    if let Some(client) = HL_CLIENT.get() {
        return Ok(client);
    }
    let key = hyperliquid_api_wallet_private_key(state)?;
    if key.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "HYPERLIQUID_API_WALLET_PRIVATE_KEY is required for Hyperliquid signing".into(),
        ));
    }
    let is_testnet = std::env::var("HYPERLIQUID_TESTNET").is_ok_and(|v| v == "1" || v == "true");
    let client = if is_testnet {
        HyperliquidClient::testnet(&key)
    } else {
        HyperliquidClient::new(&key)
    }
    .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, format!("HL init: {e}")))?;
    let _ = HL_CLIENT.set(client);
    HL_CLIENT
        .get()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "HL client race".into()))
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

pub(crate) fn hyperliquid_account_address(bot: &BotContext) -> Option<String> {
    hyperliquid_account_address_from_config(&bot.strategy_config, &bot.vault_address)
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
    hyperliquid_account_address(bot).ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid live execution requires strategy_config.hyperliquid_account_address or a concrete bot vault address".to_string(),
        )
    })
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

fn config_bool(config: &serde_json::Value, key: &str) -> bool {
    config
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn hyperliquid_requires_api_wallet_approval(config: &serde_json::Value) -> bool {
    config_string(config, "hyperliquid_account_source")
        .is_some_and(|source| source.eq_ignore_ascii_case("hyperevm_vault_contract"))
        || config.get("hyperliquid_api_wallet_approval").is_some()
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
    let account_address = hyperliquid_account_address(&bot);
    let resp = client
        .place_order_for_account(&req, account_address.as_deref())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
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
    let account_address = hyperliquid_account_address(&bot);
    let resp = client
        .place_bracket_for_account(
            &req.entry,
            req.stop_loss.as_ref(),
            req.take_profit.as_ref(),
            account_address.as_deref(),
        )
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
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
    let account_address = hyperliquid_account_address(&bot);
    let resp = client
        .cancel_order_for_account(req.asset, req.order_id, account_address.as_deref())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
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
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
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
    let account_address = hyperliquid_account_address(&bot);
    let account = client
        .get_account_for(account_address.as_deref())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(account))
}

async fn get_prices(
    State(state): State<Arc<MultiBotTradingState>>,
) -> Result<Json<std::collections::HashMap<String, String>>, (StatusCode, String)> {
    let client = get_hl_client(&state)?;
    let mids = client
        .get_mids()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(mids))
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
    fn account_address_prefers_hyperliquid_config() {
        let bot = bot(
            "0x1111111111111111111111111111111111111111",
            serde_json::json!({
                "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
            }),
        );

        assert_eq!(
            hyperliquid_account_address(&bot).as_deref(),
            Some("0x2222222222222222222222222222222222222222")
        );
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
