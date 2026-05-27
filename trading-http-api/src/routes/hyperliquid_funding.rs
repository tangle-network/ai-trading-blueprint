//! Hyperliquid funding readiness and Core spot-to-perp movement routes.
//!
//! The vault can submit validated Hyperliquid CoreWriter actions, but Core
//! balances and idle HyperEVM ERC20 balances are not the same thing. These
//! routes make that distinction explicit for trading agents.

use alloy::primitives::aliases::U24;
use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::{SolCall, SolValue};
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::{
    Json, Router,
    routing::{get, post},
};
use chrono::Utc;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{Duration, sleep};

use crate::routes::hyperliquid::{
    HYPERLIQUID_EXTRA_AGENT_TIMEOUT_MESSAGE, get_hl_client,
    hyperliquid_api_wallet_address_from_private_key, hyperliquid_extra_agents,
    hyperliquid_extra_agents_contains, hyperliquid_user_role,
    normalize_hyperliquid_api_wallet_name, require_hyperliquid_account_address,
    require_hyperliquid_api_wallet_signing_config_for_approval,
    wait_for_hyperliquid_api_wallet_extra_agent,
};
use crate::{BotContext, MultiBotTradingState};
use trading_runtime::execution_hash::{
    ACTION_EVM_USDC_TO_CORE, ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT, HyperliquidFundMovementPolicy,
    build_hyperliquid_evm_usdc_to_core_fund_movement_hashes,
    build_hyperliquid_usd_class_fund_movement_hashes,
};
use trading_runtime::hyperevm_corewriter::ACTION_USD_CLASS_TRANSFER;
use trading_runtime::intent::TradeIntentBuilder;
use trading_runtime::types::Action;
use trading_runtime::validator_client::{ValidationExecutionOptions, ValidatorClient};

sol! {
    interface IHyperliquidVaultFunding {
        struct FundMovementAuthorization {
            uint256 nonce;
            uint256 deadline;
            bytes[] signatures;
            uint256[] scores;
        }

        function leverageCap() external view returns (uint256);
        function maxTradesPerHour() external view returns (uint256);
        function maxSlippageBps() external view returns (uint256);
        function tradeValidator() external view returns (address);
        function computeFundMovementHashes(
            uint24 actionType,
            address destination,
            uint64 token,
            uint64 amount,
            bool direction,
            uint256 nonce,
            uint256 deadline,
            bytes action
        ) external view returns (bytes32 intentHash, bytes32 executionHash);
        function returnUsdClassLiquidity(uint64 ntl, bool toPerp, FundMovementAuthorization calldata authorization) external;
        function returnSpotLiquidity(address destination, uint64 token, uint64 weiAmount, FundMovementAuthorization calldata authorization) external;
        function approveHyperliquidApiWallet(address agentWallet, string calldata agentName) external;
    }

    interface ITradeValidatorFundingPreflight {
        function validateWithSignatures(
            bytes32 intentHash,
            bytes32 executionHash,
            address vault,
            bytes[] calldata signatures,
            uint256[] calldata scores,
            uint256 deadline,
            uint256 actionKind
        ) external view returns (bool approved, uint256 validCount);
    }
}

const CORE_USDC_WEI_PER_USDC: u64 = 100_000_000;
const EVM_USDC_WEI_PER_USDC: u64 = 1_000_000;
const HYPERLIQUID_USDC_SPOT_TOKEN: u64 = 0;
const HYPERLIQUID_CORE_DEPOSIT_WALLET_MAINNET: &str = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24";
const HYPERLIQUID_CORE_DEPOSIT_WALLET_TESTNET: &str = "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206";
const HYPERLIQUID_MAINNET_INFO_URL: &str = "https://api.hyperliquid.xyz/info";
const FUNDING_PROTOCOL: &str = "hyperliquid_funding";
const FUNDING_POLL_ATTEMPTS: usize = 10;
const FUNDING_POLL_DELAY_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HyperliquidChainAddresses {
    core_deposit_wallet: Address,
}

#[derive(Clone, Debug)]
struct CoreDepositRouteReadiness {
    available: bool,
    unavailable_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HyperliquidUserRoleResponse {
    role: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct HyperliquidFundingStatus {
    pub state: String,
    pub idle_evm_usdc: String,
    pub core_spot_usdc: String,
    pub perp_margin_usdc: String,
    pub core_total_usdc: String,
    pub requested_usdc: Option<String>,
    pub can_move_core_spot_to_perp: bool,
    pub can_move_idle_evm_to_core: bool,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct UsdClassTransferRequest {
    pub amount_usdc: String,
    #[serde(default = "default_to_perp")]
    pub to_perp: bool,
}

#[derive(Debug, Deserialize)]
pub struct EvmUsdcToCoreRequest {
    pub amount_usdc: String,
}

#[derive(Debug, Deserialize)]
pub struct PreparePerpMarginRequest {
    pub amount_usdc: String,
}

#[derive(Debug, Serialize)]
pub struct UsdClassTransferResponse {
    pub status: String,
    pub tx_hash: String,
    pub ntl: u64,
    pub to_perp: bool,
    pub funding_status_before: HyperliquidFundingStatus,
}

#[derive(Debug, Serialize)]
pub struct EvmUsdcToCoreResponse {
    pub status: String,
    pub tx_hash: String,
    pub amount_wei: u64,
    pub core_deposit_wallet: String,
    pub funding_status_before: HyperliquidFundingStatus,
}

#[derive(Debug, Serialize)]
pub struct PreparePerpMarginResponse {
    pub status: String,
    pub requested_usdc: String,
    pub moved_evm_to_core_usdc: Option<String>,
    pub moved_core_to_perp_usdc: Option<String>,
    pub evm_to_core_tx_hash: Option<String>,
    pub usd_class_tx_hash: Option<String>,
    pub funding_status_before: HyperliquidFundingStatus,
    pub funding_status_after_evm_to_core: Option<HyperliquidFundingStatus>,
    pub funding_status_after: HyperliquidFundingStatus,
}

#[derive(Debug, Serialize)]
pub struct ApiWalletApprovalResponse {
    pub status: String,
    pub vault_account: String,
    pub api_wallet_address: String,
    pub hyperliquid_user_role: String,
    pub tx_hash: Option<String>,
    pub verified_corewriter_approval: bool,
    pub extra_agents: Vec<crate::routes::hyperliquid::HyperliquidExtraAgent>,
    pub strategy_config_patch: serde_json::Value,
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/hyperliquid/funding/status", get(get_funding_status))
        .route(
            "/hyperliquid/funding/usd-class-transfer",
            post(post_usd_class_transfer),
        )
        .route(
            "/hyperliquid/funding/evm-usdc-to-core",
            post(post_evm_usdc_to_core),
        )
        .route(
            "/hyperliquid/funding/prepare-perp-margin",
            post(post_prepare_perp_margin),
        )
        .route(
            "/hyperliquid/funding/api-wallet-approval",
            post(post_api_wallet_approval),
        )
}

async fn get_funding_status(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<HyperliquidFundingStatus>, (StatusCode, String)> {
    funding_status(&state, &bot, None).await.map(Json)
}

async fn post_usd_class_transfer(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<UsdClassTransferRequest>,
) -> Result<Json<UsdClassTransferResponse>, (StatusCode, String)> {
    if bot.paper_trade {
        return Err((
            StatusCode::BAD_REQUEST,
            "Hyperliquid funding is only available for live vault bots".to_string(),
        ));
    }
    if !req.to_perp {
        return Err((
            StatusCode::BAD_REQUEST,
            "Only Core spot to perp funding is supported by this route".to_string(),
        ));
    }

    let amount = parse_positive_decimal(&req.amount_usdc, "amount_usdc")?;
    let status = funding_status(&state, &bot, Some(amount)).await?;
    if !status.can_move_core_spot_to_perp {
        return Err((StatusCode::CONFLICT, status.reason));
    }

    let transfer = submit_usd_class_transfer(&state, &bot, amount, req.to_perp).await?;

    Ok(Json(UsdClassTransferResponse {
        status: "submitted".to_string(),
        tx_hash: transfer.tx_hash,
        ntl: transfer.ntl,
        to_perp: req.to_perp,
        funding_status_before: status,
    }))
}

async fn post_evm_usdc_to_core(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<EvmUsdcToCoreRequest>,
) -> Result<Json<EvmUsdcToCoreResponse>, (StatusCode, String)> {
    if bot.paper_trade {
        return Err((
            StatusCode::BAD_REQUEST,
            "Hyperliquid funding is only available for live vault bots".to_string(),
        ));
    }

    let amount = parse_positive_decimal(&req.amount_usdc, "amount_usdc")?;
    let status = funding_status(&state, &bot, Some(amount)).await?;
    if !status.can_move_idle_evm_to_core {
        return Err((StatusCode::CONFLICT, status.reason));
    }

    let transfer = submit_evm_usdc_to_core(&state, &bot, amount).await?;

    Ok(Json(EvmUsdcToCoreResponse {
        status: "submitted".to_string(),
        tx_hash: transfer.tx_hash,
        amount_wei: transfer.amount_wei,
        core_deposit_wallet: transfer.core_deposit_wallet.to_string(),
        funding_status_before: status,
    }))
}

async fn post_prepare_perp_margin(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<PreparePerpMarginRequest>,
) -> Result<Json<PreparePerpMarginResponse>, (StatusCode, String)> {
    if bot.paper_trade {
        return Err((
            StatusCode::BAD_REQUEST,
            "Hyperliquid funding is only available for live vault bots".to_string(),
        ));
    }

    let requested = parse_positive_decimal(&req.amount_usdc, "amount_usdc")?;
    let before = funding_status(&state, &bot, Some(requested)).await?;
    let perp_margin = parse_decimal(&before.perp_margin_usdc, "perp_margin_usdc")?;
    if perp_margin >= requested {
        return Ok(Json(PreparePerpMarginResponse {
            status: "already_ready".to_string(),
            requested_usdc: requested.to_string(),
            moved_evm_to_core_usdc: None,
            moved_core_to_perp_usdc: None,
            evm_to_core_tx_hash: None,
            usd_class_tx_hash: None,
            funding_status_before: before.clone(),
            funding_status_after_evm_to_core: None,
            funding_status_after: before,
        }));
    }

    let required_margin = requested - perp_margin;
    let core_spot = parse_decimal(&before.core_spot_usdc, "core_spot_usdc")?;
    let idle_evm = parse_decimal(&before.idle_evm_usdc, "idle_evm_usdc")?;
    let mut evm_to_core_tx_hash = None;
    let mut moved_evm_to_core_usdc = None;
    let mut after_evm_to_core = None;
    let mut core_ready = before.clone();

    if core_spot < required_margin {
        let evm_needed = required_margin - core_spot;
        if idle_evm < evm_needed {
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "Insufficient funding for requested margin: need {requested} USDC total, have {} perp margin, {} Core spot, and {} idle EVM USDC",
                    before.perp_margin_usdc, before.core_spot_usdc, before.idle_evm_usdc
                ),
            ));
        }
        if !before.can_move_idle_evm_to_core {
            return Err((StatusCode::CONFLICT, before.reason.clone()));
        }

        let transfer = submit_evm_usdc_to_core(&state, &bot, evm_needed).await?;
        evm_to_core_tx_hash = Some(transfer.tx_hash);
        moved_evm_to_core_usdc = Some(evm_needed.to_string());
        core_ready = wait_for_funding_status(&state, &bot, Some(requested), |status| {
            let Ok(current_margin) = parse_decimal(&status.perp_margin_usdc, "perp_margin_usdc")
            else {
                return false;
            };
            if current_margin >= requested {
                return true;
            }

            let Ok(current_core) = parse_decimal(&status.core_spot_usdc, "core_spot_usdc") else {
                return false;
            };
            current_core >= requested - current_margin
        })
        .await?;
        after_evm_to_core = Some(core_ready.clone());
    }

    let latest_margin = parse_decimal(&core_ready.perp_margin_usdc, "perp_margin_usdc")?;
    if latest_margin >= requested {
        return Ok(Json(PreparePerpMarginResponse {
            status: "prepared".to_string(),
            requested_usdc: requested.to_string(),
            moved_evm_to_core_usdc,
            moved_core_to_perp_usdc: None,
            evm_to_core_tx_hash,
            usd_class_tx_hash: None,
            funding_status_before: before,
            funding_status_after_evm_to_core: after_evm_to_core,
            funding_status_after: core_ready,
        }));
    }

    let remaining_margin = requested - latest_margin;
    let latest_core = parse_decimal(&core_ready.core_spot_usdc, "core_spot_usdc")?;
    if latest_core < remaining_margin {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "Timed out waiting for fundable Hyperliquid USDC: need {remaining_margin} more perp margin, got {latest_margin} perp margin and {latest_core} Core spot"
            ),
        ));
    }

    let usd_transfer = submit_usd_class_transfer(&state, &bot, remaining_margin, true).await?;
    let after = wait_for_funding_status(&state, &bot, Some(requested), |status| {
        parse_decimal(&status.perp_margin_usdc, "perp_margin_usdc")
            .map(|margin| margin >= requested)
            .unwrap_or(false)
    })
    .await?;

    Ok(Json(PreparePerpMarginResponse {
        status: "prepared".to_string(),
        requested_usdc: requested.to_string(),
        moved_evm_to_core_usdc,
        moved_core_to_perp_usdc: Some(remaining_margin.to_string()),
        evm_to_core_tx_hash,
        usd_class_tx_hash: Some(usd_transfer.tx_hash),
        funding_status_before: before,
        funding_status_after_evm_to_core: after_evm_to_core,
        funding_status_after: after,
    }))
}

async fn post_api_wallet_approval(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<ApiWalletApprovalResponse>, (StatusCode, String)> {
    if bot.paper_trade {
        return Err((
            StatusCode::BAD_REQUEST,
            "Hyperliquid API wallet approval is only available for live vault bots".to_string(),
        ));
    }

    let account = require_hyperliquid_account_address(&bot)?;
    let vault = parse_address(&bot.vault_address, "vault address")?;
    let account_address = parse_address(&account, "Hyperliquid vault account")?;
    if account_address != vault {
        return Err((
            StatusCode::BAD_REQUEST,
            "Hyperliquid API wallet approval must target the authoritative bot vault account"
                .to_string(),
        ));
    }

    let signing = require_hyperliquid_api_wallet_signing_config_for_approval(
        &state,
        allow_local_operator_key_for_api_wallet_approval(&bot),
    )?;
    let api_wallet = hyperliquid_api_wallet_address_from_private_key(&signing.private_key)?;
    if let Some(expected) = config_string(&bot.strategy_config, "hyperliquid_api_wallet_address")
        && !expected.eq_ignore_ascii_case(&api_wallet)
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Configured Hyperliquid API wallet does not match HYPERLIQUID_API_WALLET_PRIVATE_KEY"
                .to_string(),
        ));
    }

    let user_role = hyperliquid_user_role(&account).await?;
    if user_role.eq_ignore_ascii_case("missing") {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "Hyperliquid vault account {account} is still missing on HyperCore; fund/activate it before API wallet approval"
            ),
        ));
    }

    let existing_agents = hyperliquid_extra_agents(&account).await?;
    if hyperliquid_extra_agents_contains(&existing_agents, &api_wallet) {
        return Ok(Json(api_wallet_approval_response(
            "already_verified",
            account,
            api_wallet,
            user_role,
            None,
            existing_agents,
            true,
        )));
    }

    let chain_client = matching_chain_client(&state, &bot)?;
    let agent_name = normalize_hyperliquid_api_wallet_name(
        bot.strategy_config
            .get("hyperliquid_api_wallet_name")
            .and_then(serde_json::Value::as_str),
        &bot.bot_id,
    )
    .map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid Hyperliquid API wallet name: {e}"),
        )
    })?;
    let calldata = IHyperliquidVaultFunding::approveHyperliquidApiWalletCall {
        agentWallet: parse_address(&api_wallet, "API wallet address")?,
        agentName: agent_name,
    }
    .abi_encode();
    let tx_hash = send_funding_tx(&chain_client, vault, calldata).await?;
    match wait_for_hyperliquid_api_wallet_extra_agent(&account, &api_wallet).await {
        Ok(verified_agents) => Ok(Json(api_wallet_approval_response(
            "verified_corewriter_approval",
            account,
            api_wallet,
            user_role,
            Some(tx_hash),
            verified_agents,
            true,
        ))),
        Err((StatusCode::BAD_GATEWAY, message))
            if message == HYPERLIQUID_EXTRA_AGENT_TIMEOUT_MESSAGE =>
        {
            Ok(Json(api_wallet_approval_response(
                "submitted_corewriter_approval",
                account,
                api_wallet,
                user_role,
                Some(tx_hash),
                Vec::new(),
                false,
            )))
        }
        Err(error) => Err(error),
    }
}

fn api_wallet_approval_response(
    status: &str,
    vault_account: String,
    api_wallet_address: String,
    hyperliquid_user_role: String,
    tx_hash: Option<String>,
    extra_agents: Vec<crate::routes::hyperliquid::HyperliquidExtraAgent>,
    verified_corewriter_approval: bool,
) -> ApiWalletApprovalResponse {
    let approval_status = if verified_corewriter_approval {
        "verified_corewriter_approval"
    } else {
        status
    };
    let mut patch = serde_json::json!({
        "hyperliquid_api_wallet_approval": "corewriter_after_funding",
        "hyperliquid_api_wallet_approval_status": approval_status,
        "hyperliquid_api_wallet_address": api_wallet_address,
    });
    if verified_corewriter_approval && let Some(map) = patch.as_object_mut() {
        map.insert(
            "hyperliquid_api_wallet_verified_at".to_string(),
            serde_json::Value::String(Utc::now().to_rfc3339()),
        );
    }
    if let Some(tx_hash) = tx_hash.as_ref()
        && let Some(map) = patch.as_object_mut()
    {
        map.insert(
            "hyperliquid_api_wallet_approval_tx".to_string(),
            serde_json::Value::String(tx_hash.clone()),
        );
    }

    ApiWalletApprovalResponse {
        status: status.to_string(),
        vault_account,
        api_wallet_address,
        hyperliquid_user_role,
        tx_hash,
        verified_corewriter_approval,
        extra_agents,
        strategy_config_patch: patch,
    }
}

fn allow_local_operator_key_for_api_wallet_approval(bot: &BotContext) -> bool {
    !matches!(bot.chain_id, 998 | 999)
        && std::env::var("ALLOW_OPERATOR_KEY_FOR_HYPERLIQUID")
            .is_ok_and(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
}

struct UsdClassTransferSubmission {
    tx_hash: String,
    ntl: u64,
}

struct EvmUsdcToCoreSubmission {
    tx_hash: String,
    amount_wei: u64,
    core_deposit_wallet: Address,
}

async fn submit_usd_class_transfer(
    state: &MultiBotTradingState,
    bot: &BotContext,
    amount: Decimal,
    to_perp: bool,
) -> Result<UsdClassTransferSubmission, (StatusCode, String)> {
    let chain_client = matching_chain_client(state, bot)?;
    let vault = parse_address(&bot.vault_address, "vault address")?;
    let ntl = decimal_usdc_to_core_wei(amount)?;
    let deadline = Utc::now().timestamp() as u64 + state.validation_deadline_secs;
    let nonce = next_nonce();
    let policy = read_fund_movement_policy(bot, vault).await?;
    let hashes = build_hyperliquid_usd_class_fund_movement_hashes(
        vault,
        bot.chain_id,
        ntl,
        to_perp,
        nonce,
        U256::from(deadline),
        policy,
    )
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let (intent_hash, execution_hash) = vault_fund_movement_hashes(
        &chain_client,
        vault,
        ACTION_USD_CLASS_TRANSFER,
        Address::ZERO,
        HYPERLIQUID_USDC_SPOT_TOKEN,
        ntl,
        to_perp,
        nonce,
        U256::from(deadline),
        hashes.action.clone(),
    )
    .await?;

    let validation = validate_fund_movement(
        state,
        bot,
        amount,
        serde_json::json!({
            "funding_action": "usd_class_transfer",
            "amount_ntl": ntl.to_string(),
            "to_perp": to_perp,
        }),
        nonce,
        deadline,
        policy,
        format!("0x{}", hex::encode(intent_hash.as_slice())),
        format!("0x{}", hex::encode(execution_hash.as_slice())),
    )
    .await?;
    if !validation.approved {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Hyperliquid fund movement was rejected by validators: aggregate_score={}",
                validation.aggregate_score
            ),
        ));
    }

    let signatures = validation_signatures(&validation)?;
    let scores = validation_scores(&validation);
    let authorization = IHyperliquidVaultFunding::FundMovementAuthorization {
        nonce,
        deadline: U256::from(deadline),
        signatures,
        scores,
    };
    preflight_fund_movement_authorization(
        &chain_client,
        vault,
        intent_hash,
        execution_hash,
        &authorization,
        &validation,
    )
    .await?;
    let calldata = IHyperliquidVaultFunding::returnUsdClassLiquidityCall {
        ntl,
        toPerp: to_perp,
        authorization,
    }
    .abi_encode();
    let tx_hash = send_funding_tx(&chain_client, vault, calldata).await?;

    Ok(UsdClassTransferSubmission { tx_hash, ntl })
}

async fn submit_evm_usdc_to_core(
    state: &MultiBotTradingState,
    bot: &BotContext,
    amount: Decimal,
) -> Result<EvmUsdcToCoreSubmission, (StatusCode, String)> {
    let chain_client = matching_chain_client(state, bot)?;
    let vault = parse_address(&bot.vault_address, "vault address")?;
    let amount_wei = decimal_usdc_to_evm_wei(amount)?;
    let core_deposit_wallet = require_core_deposit_wallet(&chain_client).await?;
    ensure_core_deposit_recipient_eligible(chain_client.chain_id, vault).await?;
    let deadline = Utc::now().timestamp() as u64 + state.validation_deadline_secs;
    let nonce = next_nonce();
    let policy = read_fund_movement_policy(bot, vault).await?;
    let hashes = build_hyperliquid_evm_usdc_to_core_fund_movement_hashes(
        vault,
        bot.chain_id,
        core_deposit_wallet,
        amount_wei,
        nonce,
        U256::from(deadline),
        policy,
    )
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let (intent_hash, execution_hash) = vault_fund_movement_hashes(
        &chain_client,
        vault,
        ACTION_EVM_USDC_TO_CORE,
        core_deposit_wallet,
        HYPERLIQUID_USDC_SPOT_TOKEN,
        amount_wei,
        true,
        nonce,
        U256::from(deadline),
        hashes.action.clone(),
    )
    .await?;

    let validation = validate_fund_movement(
        state,
        bot,
        amount,
        serde_json::json!({
            "funding_action": "evm_usdc_to_core",
            "amount_evm_wei": amount_wei.to_string(),
            "core_deposit_wallet": core_deposit_wallet.to_string(),
        }),
        nonce,
        deadline,
        policy,
        format!("0x{}", hex::encode(intent_hash.as_slice())),
        format!("0x{}", hex::encode(execution_hash.as_slice())),
    )
    .await?;
    if !validation.approved {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Hyperliquid EVM-to-Core transfer was rejected by validators: aggregate_score={}",
                validation.aggregate_score
            ),
        ));
    }

    let signatures = validation_signatures(&validation)?;
    let scores = validation_scores(&validation);
    let authorization = IHyperliquidVaultFunding::FundMovementAuthorization {
        nonce,
        deadline: U256::from(deadline),
        signatures,
        scores,
    };
    preflight_fund_movement_authorization(
        &chain_client,
        vault,
        intent_hash,
        execution_hash,
        &authorization,
        &validation,
    )
    .await?;
    let calldata = IHyperliquidVaultFunding::returnSpotLiquidityCall {
        destination: core_deposit_wallet,
        token: HYPERLIQUID_USDC_SPOT_TOKEN,
        weiAmount: amount_wei,
        authorization,
    }
    .abi_encode();
    let tx_hash = send_funding_tx(&chain_client, vault, calldata).await?;

    Ok(EvmUsdcToCoreSubmission {
        tx_hash,
        amount_wei,
        core_deposit_wallet,
    })
}

async fn send_funding_tx(
    chain_client: &trading_runtime::chain::ChainClient,
    vault: Address,
    calldata: Vec<u8>,
) -> Result<String, (StatusCode, String)> {
    let tx = TransactionRequest::default()
        .to(vault)
        .input(Bytes::from(calldata).into());
    let pending = chain_client
        .provider
        .send_transaction(tx)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid fund movement tx send failed: {e}"),
            )
        })?;
    let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));
    let receipt = pending.get_receipt().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid fund movement receipt failed: {e}"),
        )
    })?;
    if !receipt.status() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid fund movement reverted: {tx_hash}"),
        ));
    }
    Ok(tx_hash)
}

#[allow(clippy::too_many_arguments)]
async fn vault_fund_movement_hashes(
    chain_client: &trading_runtime::chain::ChainClient,
    vault: Address,
    action_type: u32,
    destination: Address,
    token: u64,
    amount: u64,
    direction: bool,
    nonce: U256,
    deadline: U256,
    action: Bytes,
) -> Result<(alloy::primitives::B256, alloy::primitives::B256), (StatusCode, String)> {
    let call = IHyperliquidVaultFunding::computeFundMovementHashesCall {
        actionType: U24::from(action_type),
        destination,
        token,
        amount,
        direction,
        nonce,
        deadline,
        action,
    };
    let tx = TransactionRequest::default()
        .to(vault)
        .input(Bytes::from(call.abi_encode()).into());
    let bytes = chain_client.provider.call(tx).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid fund movement hash eth_call failed: {e}"),
        )
    })?;
    let decoded =
        IHyperliquidVaultFunding::computeFundMovementHashesCall::abi_decode_returns(bytes.as_ref())
            .map_err(|e| {
                (
                    StatusCode::BAD_GATEWAY,
                    format!("Hyperliquid fund movement hash decode failed: {e}"),
                )
            })?;
    Ok((decoded.intentHash, decoded.executionHash))
}

async fn preflight_fund_movement_authorization(
    chain_client: &trading_runtime::chain::ChainClient,
    vault: Address,
    intent_hash: alloy::primitives::B256,
    execution_hash: alloy::primitives::B256,
    authorization: &IHyperliquidVaultFunding::FundMovementAuthorization,
    validation: &trading_runtime::types::ValidationResult,
) -> Result<(), (StatusCode, String)> {
    let provider = &chain_client.provider;
    let trade_validator = eth_call_address(
        provider,
        vault,
        IHyperliquidVaultFunding::tradeValidatorCall {}.abi_encode(),
    )
    .await?;
    let call = ITradeValidatorFundingPreflight::validateWithSignaturesCall {
        intentHash: intent_hash,
        executionHash: execution_hash,
        vault,
        signatures: authorization.signatures.clone(),
        scores: authorization.scores.clone(),
        deadline: authorization.deadline,
        actionKind: U256::from(ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT),
    };
    let tx = TransactionRequest::default()
        .to(trade_validator)
        .input(Bytes::from(call.abi_encode()).into());
    let bytes = provider.call(tx).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid fund movement validator preflight failed: {e}"),
        )
    })?;
    let decoded = ITradeValidatorFundingPreflight::validateWithSignaturesCall::abi_decode_returns(
        bytes.as_ref(),
    )
    .map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid fund movement validator preflight decode failed: {e}"),
        )
    })?;
    let validator_responses: Vec<_> = validation
        .validator_responses
        .iter()
        .map(|response| {
            serde_json::json!({
                "validator": response.validator,
                "score": response.score,
                "chain_id": response.chain_id,
                "verifying_contract": response.verifying_contract,
                "signature_prefix": response.signature.chars().take(12).collect::<String>(),
            })
        })
        .collect();
    tracing::info!(
        vault = %vault,
        trade_validator = %trade_validator,
        approved = decoded.approved,
        valid_count = %decoded.validCount,
        response_count = validation.validator_responses.len(),
        aggregate_score = validation.aggregate_score,
        validator_responses = %serde_json::Value::Array(validator_responses),
        "Hyperliquid fund movement validator preflight completed"
    );
    if decoded.approved {
        return Ok(());
    }
    Err((
        StatusCode::BAD_GATEWAY,
        format!(
            "Hyperliquid fund movement validator preflight rejected: valid_count={}, aggregate_score={}, responses={}",
            decoded.validCount,
            validation.aggregate_score,
            validation.validator_responses.len()
        ),
    ))
}

async fn wait_for_funding_status(
    state: &MultiBotTradingState,
    bot: &BotContext,
    requested: Option<Decimal>,
    ready: impl Fn(&HyperliquidFundingStatus) -> bool,
) -> Result<HyperliquidFundingStatus, (StatusCode, String)> {
    let mut last = funding_status(state, bot, requested).await?;
    if ready(&last) {
        return Ok(last);
    }
    for _ in 1..FUNDING_POLL_ATTEMPTS {
        sleep(Duration::from_millis(FUNDING_POLL_DELAY_MS)).await;
        last = funding_status(state, bot, requested).await?;
        if ready(&last) {
            return Ok(last);
        }
    }
    Ok(last)
}

async fn funding_status(
    state: &MultiBotTradingState,
    bot: &BotContext,
    requested: Option<Decimal>,
) -> Result<HyperliquidFundingStatus, (StatusCode, String)> {
    let nav = state
        .hyperliquid_nav_reconciler
        .reconcile(state, bot)
        .await?;
    let account_address = require_hyperliquid_account_address(bot)?;
    let account = get_hl_client(state)?
        .get_account_for(Some(&account_address))
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid account refresh failed for {account_address}: {e}"),
            )
        })?;

    let idle_evm_usdc = parse_decimal(&nav.idle_usdc, "idle_usdc")?;
    let core_total_usdc = parse_decimal(&nav.hyperliquid_equity, "hyperliquid_equity")?;
    let perp_margin_usdc = parse_decimal(&account.account_value, "account_value")?;
    let core_spot_usdc = (core_total_usdc - perp_margin_usdc).max(Decimal::ZERO);
    let core_deposit_readiness = core_deposit_route_readiness_for_bot(state, bot).await?;

    Ok(classify_funding_status(
        idle_evm_usdc,
        core_spot_usdc,
        perp_margin_usdc,
        core_total_usdc,
        requested,
        core_deposit_readiness.available,
        core_deposit_readiness.unavailable_reason,
    ))
}

fn classify_funding_status(
    idle_evm_usdc: Decimal,
    core_spot_usdc: Decimal,
    perp_margin_usdc: Decimal,
    core_total_usdc: Decimal,
    requested: Option<Decimal>,
    core_deposit_supported: bool,
    core_deposit_unavailable_reason: Option<String>,
) -> HyperliquidFundingStatus {
    let enough_core_spot = requested.is_none_or(|amount| core_spot_usdc >= amount);
    let enough_perp_margin = requested.is_none_or(|amount| perp_margin_usdc >= amount);
    let enough_idle_evm = requested.is_none_or(|amount| idle_evm_usdc >= amount);
    let enough_idle_evm_to_cover_gap =
        requested.is_none_or(|amount| core_spot_usdc + idle_evm_usdc >= amount);
    let (state, reason, can_move_core_spot_to_perp, can_move_idle_evm_to_core) = if core_spot_usdc
        > Decimal::ZERO
    {
        if enough_core_spot {
            (
                "core_spot_available",
                "Core spot USDC is available and can be moved to perp margin.",
                true,
                core_deposit_supported && idle_evm_usdc > Decimal::ZERO,
            )
        } else {
            (
                "insufficient_core_spot",
                "Core spot USDC exists, but not enough for the requested transfer. Idle EVM USDC can be bridged into Core if available.",
                false,
                core_deposit_supported
                    && idle_evm_usdc > Decimal::ZERO
                    && enough_idle_evm_to_cover_gap,
            )
        }
    } else if perp_margin_usdc > Decimal::ZERO && enough_perp_margin {
        (
            "perp_margin_available",
            "Perp margin is already available; no funding transfer is needed.",
            false,
            false,
        )
    } else if idle_evm_usdc > Decimal::ZERO {
        if !core_deposit_supported {
            (
                "evm_to_core_route_unavailable",
                core_deposit_unavailable_reason.as_deref().unwrap_or(
                    "Idle HyperEVM USDC is available, but this deployed vault does not support CoreDepositWallet deposits. Redeploy or migrate before funding HyperCore.",
                ),
                false,
                false,
            )
        } else if enough_idle_evm {
            (
                "idle_evm_usdc_available",
                "Idle HyperEVM USDC can be deposited through CoreDepositWallet, then moved to perp margin.",
                false,
                true,
            )
        } else {
            (
                "insufficient_idle_evm_usdc",
                "Idle HyperEVM USDC exists, but not enough for the requested transfer.",
                false,
                false,
            )
        }
    } else {
        (
            "no_funds_available",
            "No idle EVM USDC, Core spot USDC, or perp margin is available.",
            false,
            false,
        )
    };

    HyperliquidFundingStatus {
        state: state.to_string(),
        idle_evm_usdc: idle_evm_usdc.to_string(),
        core_spot_usdc: core_spot_usdc.to_string(),
        perp_margin_usdc: perp_margin_usdc.to_string(),
        core_total_usdc: core_total_usdc.to_string(),
        requested_usdc: requested.map(|amount| amount.to_string()),
        can_move_core_spot_to_perp,
        can_move_idle_evm_to_core,
        reason: reason.to_string(),
    }
}

async fn validate_fund_movement(
    state: &MultiBotTradingState,
    bot: &BotContext,
    amount: Decimal,
    mut metadata: serde_json::Value,
    nonce: U256,
    deadline: u64,
    policy: HyperliquidFundMovementPolicy,
    intent_hash: String,
    execution_hash: String,
) -> Result<trading_runtime::types::ValidationResult, (StatusCode, String)> {
    if bot.validator_endpoints.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid fund movement requires validator endpoints".to_string(),
        ));
    }
    let metadata_obj = metadata.as_object_mut().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Hyperliquid fund movement metadata must be an object".to_string(),
        )
    })?;
    metadata_obj.insert("nonce".to_string(), serde_json::json!(nonce.to_string()));
    metadata_obj.insert(
        "leverage_cap".to_string(),
        serde_json::json!(policy.leverage_cap.to_string()),
    );
    metadata_obj.insert(
        "max_trades_per_hour".to_string(),
        serde_json::json!(policy.max_trades_per_hour.to_string()),
    );
    metadata_obj.insert(
        "max_slippage_bps".to_string(),
        serde_json::json!(policy.max_slippage_bps.to_string()),
    );
    let intent = TradeIntentBuilder::new()
        .strategy_id(format!("hyperliquid-funding-{}", bot.bot_id))
        .action(Action::CollateralRelease)
        .token_in("USDC")
        .token_out("USDC")
        .amount_in(amount)
        .min_amount_out(Decimal::ZERO)
        .target_protocol(FUNDING_PROTOCOL)
        .chain_id(bot.chain_id)
        .metadata(metadata)
        .build()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let min_validators = crate::routes::validate::required_validator_signatures(
        &bot.vault_address,
        Some(&bot.rpc_url),
        bot.paper_trade,
    )
    .await?;
    let client = ValidatorClient::new(bot.validator_endpoints.clone(), state.min_validator_score)
        .with_min_validators(min_validators);
    client
        .validate_with_context(
            &intent,
            &bot.vault_address,
            deadline,
            ValidationExecutionOptions {
                intent_hash_override: Some(intent_hash),
                execution_hash_override: Some(execution_hash),
                action_kind: ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT,
                ..ValidationExecutionOptions::default()
            },
        )
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))
}

async fn read_fund_movement_policy(
    bot: &BotContext,
    vault: Address,
) -> Result<HyperliquidFundMovementPolicy, (StatusCode, String)> {
    let provider = ProviderBuilder::new().connect_http(bot.rpc_url.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid RPC URL for Hyperliquid funding: {e}"),
        )
    })?);
    Ok(HyperliquidFundMovementPolicy {
        leverage_cap: eth_call_u256(
            &provider,
            vault,
            IHyperliquidVaultFunding::leverageCapCall {}.abi_encode(),
            "leverageCap",
        )
        .await?,
        max_trades_per_hour: eth_call_u256(
            &provider,
            vault,
            IHyperliquidVaultFunding::maxTradesPerHourCall {}.abi_encode(),
            "maxTradesPerHour",
        )
        .await?,
        max_slippage_bps: eth_call_u256(
            &provider,
            vault,
            IHyperliquidVaultFunding::maxSlippageBpsCall {}.abi_encode(),
            "maxSlippageBps",
        )
        .await?,
    })
}

async fn eth_call_u256<P>(
    provider: &P,
    to: Address,
    calldata: Vec<u8>,
    field: &str,
) -> Result<U256, (StatusCode, String)>
where
    P: Provider,
{
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(calldata).into());
    let bytes = provider.call(tx).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid funding {field} eth_call failed: {e}"),
        )
    })?;
    U256::abi_decode(bytes.as_ref()).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid funding {field} decode failed: {e}"),
        )
    })
}

async fn eth_call_address<P>(
    provider: &P,
    to: Address,
    calldata: Vec<u8>,
) -> Result<Address, (StatusCode, String)>
where
    P: Provider,
{
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(calldata).into());
    let bytes = provider.call(tx).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid funding address eth_call failed: {e}"),
        )
    })?;
    Address::abi_decode(bytes.as_ref()).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid funding address decode failed: {e}"),
        )
    })
}

fn validation_signatures(
    validation: &trading_runtime::types::ValidationResult,
) -> Result<Vec<Bytes>, (StatusCode, String)> {
    validation
        .validator_responses
        .iter()
        .map(|response| {
            let signature = response
                .signature
                .strip_prefix("0x")
                .unwrap_or(&response.signature);
            let bytes = hex::decode(signature).map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    format!("Invalid signature hex from {}: {e}", response.validator),
                )
            })?;
            if bytes.len() != 65 {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "Signature from {} must be 65 bytes, got {}",
                        response.validator,
                        bytes.len()
                    ),
                ));
            }
            Ok(Bytes::from(bytes))
        })
        .collect()
}

fn validation_scores(validation: &trading_runtime::types::ValidationResult) -> Vec<U256> {
    validation
        .validator_responses
        .iter()
        .map(|response| U256::from(response.score))
        .collect()
}

async fn core_deposit_route_readiness_for_bot(
    state: &MultiBotTradingState,
    bot: &BotContext,
) -> Result<CoreDepositRouteReadiness, (StatusCode, String)> {
    let chain_client = matching_chain_client(state, bot)?;
    let Some(addresses) = hyperliquid_chain_addresses(chain_client.chain_id)? else {
        return Ok(CoreDepositRouteReadiness {
            available: false,
            unavailable_reason: Some(
                "Hyperliquid CoreDepositWallet deposits are only supported on HyperEVM mainnet (999) and testnet (998)."
                    .to_string(),
            ),
        });
    };
    ensure_core_deposit_wallet_contract(&chain_client, addresses.core_deposit_wallet).await?;
    let vault = parse_address(&bot.vault_address, "vault address")?;
    if let Err((_, reason)) =
        ensure_core_deposit_recipient_eligible(chain_client.chain_id, vault).await
    {
        return Ok(CoreDepositRouteReadiness {
            available: false,
            unavailable_reason: Some(reason),
        });
    }
    Ok(CoreDepositRouteReadiness {
        available: true,
        unavailable_reason: None,
    })
}

fn hyperliquid_chain_addresses(
    chain_id: u64,
) -> Result<Option<HyperliquidChainAddresses>, (StatusCode, String)> {
    let core_deposit_wallet = match chain_id {
        999 => HYPERLIQUID_CORE_DEPOSIT_WALLET_MAINNET,
        998 => HYPERLIQUID_CORE_DEPOSIT_WALLET_TESTNET,
        _ => return Ok(None),
    };
    let core_deposit_wallet = Address::from_str(core_deposit_wallet).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Configured Hyperliquid CoreDepositWallet address is invalid: {e}"),
        )
    })?;
    Ok(Some(HyperliquidChainAddresses {
        core_deposit_wallet,
    }))
}

async fn require_core_deposit_wallet(
    chain_client: &trading_runtime::chain::ChainClient,
) -> Result<Address, (StatusCode, String)> {
    let addresses = hyperliquid_chain_addresses(chain_client.chain_id)?.ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "Hyperliquid CoreDepositWallet deposits are only supported on HyperEVM mainnet (999) and testnet (998).".to_string(),
        )
    })?;
    ensure_core_deposit_wallet_contract(chain_client, addresses.core_deposit_wallet).await?;
    Ok(addresses.core_deposit_wallet)
}

async fn ensure_core_deposit_wallet_contract(
    chain_client: &trading_runtime::chain::ChainClient,
    core_deposit_wallet: Address,
) -> Result<(), (StatusCode, String)> {
    let code = chain_client
        .provider
        .get_code_at(core_deposit_wallet)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid CoreDepositWallet code check failed: {e}"),
            )
        })?;
    if code.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "Configured Hyperliquid CoreDepositWallet has no contract code on chain {}: {core_deposit_wallet}",
                chain_client.chain_id
            ),
        ));
    }
    Ok(())
}

async fn ensure_core_deposit_recipient_eligible(
    chain_id: u64,
    recipient: Address,
) -> Result<(), (StatusCode, String)> {
    if chain_id != 998 {
        return Ok(());
    }

    let role = hyperliquid_mainnet_user_role(recipient).await?;
    if let Some(reason) = testnet_recipient_unavailable_reason(recipient, &role) {
        return Err((StatusCode::CONFLICT, reason));
    }
    Ok(())
}

fn testnet_recipient_unavailable_reason(recipient: Address, mainnet_role: &str) -> Option<String> {
    if mainnet_role.eq_ignore_ascii_case("missing") {
        Some(format!(
            "Hyperliquid testnet CoreDepositWallet deposits require the recipient to already exist on HyperCore mainnet; recipient {recipient:#x} has mainnet userRole=missing"
        ))
    } else {
        None
    }
}

async fn hyperliquid_mainnet_user_role(user: Address) -> Result<String, (StatusCode, String)> {
    let response = reqwest::Client::new()
        .post(HYPERLIQUID_MAINNET_INFO_URL)
        .json(&serde_json::json!({
            "type": "userRole",
            "user": format!("{user:#x}"),
        }))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid mainnet userRole check failed: {e}"),
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid mainnet userRole check returned {status}: {body}"),
        ));
    }
    response
        .json::<HyperliquidUserRoleResponse>()
        .await
        .map(|body| body.role)
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid mainnet userRole decode failed: {e}"),
            )
        })
}

fn matching_chain_client(
    state: &MultiBotTradingState,
    bot: &BotContext,
) -> Result<trading_runtime::chain::ChainClient, (StatusCode, String)> {
    let Some(chain_client) = state.chain_client.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid funding requires a shared chain client".to_string(),
        ));
    };
    if state.chain_client_chain_id != Some(bot.chain_id)
        || state.chain_client_rpc_url.as_deref() != Some(bot.rpc_url.as_str())
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid funding chain client does not match this bot chain/RPC".to_string(),
        ));
    }
    Ok(chain_client.clone())
}

fn decimal_usdc_to_core_wei(amount: Decimal) -> Result<u64, (StatusCode, String)> {
    let scaled = amount * Decimal::from(CORE_USDC_WEI_PER_USDC);
    if scaled.fract() != Decimal::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "amount_usdc has more precision than Hyperliquid Core USDC wei".to_string(),
        ));
    }
    scaled.to_u64().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "amount_usdc exceeds uint64 CoreWriter amount".to_string(),
        )
    })
}

fn decimal_usdc_to_evm_wei(amount: Decimal) -> Result<u64, (StatusCode, String)> {
    let scaled = amount * Decimal::from(EVM_USDC_WEI_PER_USDC);
    if scaled.fract() != Decimal::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "amount_usdc has more precision than HyperEVM USDC base units".to_string(),
        ));
    }
    scaled.to_u64().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "amount_usdc exceeds uint64 EVM USDC amount".to_string(),
        )
    })
}

fn parse_positive_decimal(value: &str, field: &str) -> Result<Decimal, (StatusCode, String)> {
    let amount = parse_decimal(value, field)?;
    if amount <= Decimal::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("{field} must be greater than zero"),
        ));
    }
    Ok(amount)
}

fn parse_decimal(value: &str, field: &str) -> Result<Decimal, (StatusCode, String)> {
    Decimal::from_str(value).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Invalid Hyperliquid funding {field}: {e}"),
        )
    })
}

fn parse_address(value: &str, field: &str) -> Result<Address, (StatusCode, String)> {
    value.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid Hyperliquid funding {field}: {e}"),
        )
    })
}

fn config_string(config: &serde_json::Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn next_nonce() -> U256 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    U256::from(nanos)
}

fn default_to_perp() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_registry_uses_circle_core_deposit_wallets() {
        let mainnet = hyperliquid_chain_addresses(999)
            .unwrap()
            .expect("mainnet supported");
        let testnet = hyperliquid_chain_addresses(998)
            .unwrap()
            .expect("testnet supported");

        assert_eq!(
            mainnet.core_deposit_wallet,
            Address::from_str("0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24").unwrap()
        );
        assert_eq!(
            testnet.core_deposit_wallet,
            Address::from_str("0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206").unwrap()
        );
        assert_eq!(hyperliquid_chain_addresses(31337).unwrap(), None);
    }

    #[test]
    fn status_identifies_idle_evm_as_deployable_to_core() {
        let status = classify_funding_status(
            Decimal::new(5, 0),
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
            Some(Decimal::new(1, 0)),
            true,
            None,
        );

        assert_eq!(status.state, "idle_evm_usdc_available");
        assert!(!status.can_move_core_spot_to_perp);
        assert!(status.can_move_idle_evm_to_core);
        assert!(status.reason.contains("CoreDepositWallet"));
    }

    #[test]
    fn status_blocks_idle_evm_when_vault_lacks_core_deposit_support() {
        let status = classify_funding_status(
            Decimal::new(5, 0),
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
            Some(Decimal::new(1, 0)),
            false,
            None,
        );

        assert_eq!(status.state, "evm_to_core_route_unavailable");
        assert!(!status.can_move_idle_evm_to_core);
        assert!(status.reason.contains("Redeploy or migrate"));
    }

    #[test]
    fn status_allows_core_spot_to_perp_when_sufficient() {
        let status = classify_funding_status(
            Decimal::ZERO,
            Decimal::new(12, 0),
            Decimal::ZERO,
            Decimal::new(12, 0),
            Some(Decimal::new(10, 0)),
            true,
            None,
        );

        assert_eq!(status.state, "core_spot_available");
        assert!(status.can_move_core_spot_to_perp);
    }

    #[test]
    fn status_uses_specific_core_deposit_unavailable_reason() {
        let status = classify_funding_status(
            Decimal::new(5, 0),
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
            Some(Decimal::new(1, 0)),
            false,
            Some("recipient is not eligible for testnet HyperCore deposits".to_string()),
        );

        assert_eq!(status.state, "evm_to_core_route_unavailable");
        assert_eq!(
            status.reason,
            "recipient is not eligible for testnet HyperCore deposits"
        );
    }

    #[test]
    fn testnet_recipient_requires_mainnet_hypercore_state() {
        let recipient = Address::from([0xa6; 20]);
        let reason = testnet_recipient_unavailable_reason(recipient, "missing").unwrap();

        assert!(reason.contains("already exist on HyperCore mainnet"));
        assert!(reason.contains("userRole=missing"));
        assert!(testnet_recipient_unavailable_reason(recipient, "user").is_none());
    }

    #[test]
    fn usdc_amount_converts_to_core_wei() {
        assert_eq!(
            decimal_usdc_to_core_wei(Decimal::new(125, 1)).unwrap(),
            1_250_000_000
        );
    }

    #[test]
    fn usdc_amount_converts_to_evm_wei() {
        assert_eq!(
            decimal_usdc_to_evm_wei(Decimal::new(125, 1)).unwrap(),
            12_500_000
        );
    }
}
