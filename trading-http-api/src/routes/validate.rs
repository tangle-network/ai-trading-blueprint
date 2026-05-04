use crate::{MultiBotTradingState, TradingApiState};
use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::{SolCall, SolValue};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::{Json, Router, extract::State, routing::post};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use trading_runtime::aave_v3_registry::market_for_chain;
use trading_runtime::adapters::ActionParams;
use trading_runtime::calldata_decoder;
use trading_runtime::contracts::{ITradeValidator, ITradingVault};
use trading_runtime::execution_hash::{
    ACTION_KIND_CLOB_ORDER, ACTION_KIND_HYPERLIQUID_ORDER, ACTION_KIND_VAULT_EXECUTE, format_b256,
    hash_clob_order, hash_execution_payload, hash_hyperliquid_order,
};
use trading_runtime::executor::get_adapter;
use trading_runtime::hyperliquid::{AssetId, HlOrderType, PlaceOrderRequest};
use trading_runtime::intent::hash_intent;
use trading_runtime::polymarket_clob;
use trading_runtime::token_metadata::{address_chain_mismatch, chain_display_name};
use trading_runtime::types::ValidationResult;
use trading_runtime::validator_client::ValidatorClient;
use trading_runtime::validator_client::{
    BalanceChangeSummary, ExecutionApproval, ExecutionContext, SimulationSummary,
};
use trading_runtime::{Action, TradeIntent, TradeIntentBuilder};

const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";
const MAINNET_WETH_ADDRESS: &str = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
pub(crate) const PAPER_MODE_VALIDATOR: &str = "paper-mode";

sol! {
    interface IAavePoolHealth {
        function getUserAccountData(address user) external view returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
    }
}

#[derive(Deserialize)]
pub struct ValidateRequest {
    pub strategy_id: String,
    pub action: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub min_amount_out: String,
    pub target_protocol: String,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default = "default_deadline")]
    pub deadline_secs: u64,
}

fn default_deadline() -> u64 {
    300
}

pub(crate) fn normalize_protocol_token(
    protocol: &str,
    chain_id: Option<u64>,
    token: &str,
) -> String {
    let zero = token.trim().eq_ignore_ascii_case(ZERO_ADDRESS);
    let ethereum_like = matches!(chain_id, Some(1 | 31338 | 31339));
    let yield_protocol = matches!(protocol, "aave_v3" | "morpho_vault");

    if zero && ethereum_like && yield_protocol {
        MAINNET_WETH_ADDRESS.to_string()
    } else {
        token.to_string()
    }
}

fn state_protocol_chain_id(chain_id: Option<u64>) -> Option<u64> {
    chain_id.map(crate::protocol_chain_id_from_env)
}

#[derive(Serialize)]
pub struct ValidateResponse {
    pub approved: bool,
    pub aggregate_score: u32,
    pub intent_hash: String,
    pub execution_hash: String,
    /// The exact Unix timestamp deadline that validators signed over (needed for on-chain verification)
    pub deadline: u64,
    pub validator_responses: Vec<ValidatorResponseEntry>,
}

#[derive(Serialize)]
pub struct ValidatorResponseEntry {
    pub validator: String,
    pub score: u32,
    pub reasoning: String,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verifying_contract: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validated_at: Option<String>,
}

pub(crate) fn zero_signature() -> String {
    format!("0x{}", "00".repeat(65))
}

pub(crate) fn has_usable_validator_signature(signature: &str) -> bool {
    let Some(body) = signature.strip_prefix("0x") else {
        return false;
    };

    body.len() == 130
        && body.as_bytes().iter().any(|byte| *byte != b'0')
        && body.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn effective_validation_approval(result: &ValidationResult, paper_trade: bool) -> bool {
    if !paper_trade || !result.approved || result.validator_responses.is_empty() {
        return result.approved;
    }

    result
        .validator_responses
        .iter()
        .any(|response| has_usable_validator_signature(&response.signature))
}

fn paper_mode_bypass_response(
    intent_hash: String,
    execution_hash: String,
    deadline: u64,
) -> ValidateResponse {
    ValidateResponse {
        approved: true,
        aggregate_score: 100,
        intent_hash,
        execution_hash,
        deadline,
        validator_responses: vec![ValidatorResponseEntry {
            validator: PAPER_MODE_VALIDATOR.into(),
            score: 100,
            reasoning: "Paper trade mode — validation bypassed".into(),
            signature: zero_signature(),
            chain_id: None,
            verifying_contract: None,
            validated_at: Some(chrono::Utc::now().to_rfc3339()),
        }],
    }
}

fn zero_hash() -> String {
    format!("0x{}", "00".repeat(32))
}

fn uses_direct_non_vault_execution(protocol: &str) -> bool {
    matches!(protocol, "polymarket_clob" | "hyperliquid")
}

fn action_kind_for_protocol(protocol: &str) -> u64 {
    match protocol {
        "polymarket_clob" => ACTION_KIND_CLOB_ORDER,
        "hyperliquid" => ACTION_KIND_HYPERLIQUID_ORDER,
        _ => ACTION_KIND_VAULT_EXECUTE,
    }
}

fn requires_execution_context(protocol: &str) -> bool {
    !uses_direct_non_vault_execution(protocol)
}

fn requires_production_simulation(protocol: &str, paper_trade: bool) -> bool {
    !paper_trade && requires_execution_context(protocol)
}

fn requires_prevalidation_simulation(
    protocol: &str,
    paper_trade: bool,
    execution_context: Option<&ExecutionContext>,
) -> bool {
    requires_production_simulation(protocol, paper_trade)
        && execution_context.is_none_or(|ctx| ctx.approvals.is_empty())
}

fn requires_aave_health_check(protocol: &str, action: &str) -> bool {
    protocol == "aave_v3" && matches!(action, "borrow" | "withdraw")
}

async fn require_current_aave_health(
    rpc_url: &str,
    protocol_chain_id: u64,
    vault_address: &str,
    metadata: &serde_json::Value,
) -> Result<(), (StatusCode, String)> {
    let min_health_factor_raw = metadata
        .get("min_aave_health_factor_wad")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Aave borrow/withdraw requires min_aave_health_factor_wad metadata".to_string(),
            )
        })?;
    let min_health_factor = alloy::primitives::U256::from_str_radix(min_health_factor_raw, 10)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid min_aave_health_factor_wad: {e}"),
            )
        })?;
    let market = market_for_chain(protocol_chain_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("Unsupported Aave V3 chain for health check: {protocol_chain_id}"),
        )
    })?;
    let pool: alloy::primitives::Address = market.pool.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid Aave V3 pool address for health check: {e}"),
        )
    })?;
    let account: alloy::primitives::Address = vault_address.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid vault address for Aave health check: {e}"),
        )
    })?;
    let provider = ProviderBuilder::new().connect_http(rpc_url.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid RPC URL for Aave health check: {e}"),
        )
    })?);
    let result = provider
        .call(
            TransactionRequest::default().to(pool).input(
                alloy::primitives::Bytes::from(
                    IAavePoolHealth::getUserAccountDataCall { user: account }.abi_encode(),
                )
                .into(),
            ),
        )
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Aave health check failed: {e}"),
            )
        })?;
    let account_data = IAavePoolHealth::getUserAccountDataCall::abi_decode_returns(&result)
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Aave health check returned invalid data: {e}"),
            )
        })?;
    if account_data.healthFactor < min_health_factor {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Aave health factor {} is below required {}",
                account_data.healthFactor, min_health_factor
            ),
        ));
    }
    Ok(())
}

fn require_successful_simulation(
    execution_context: Option<&ExecutionContext>,
    require_simulation: bool,
) -> Result<(), (StatusCode, String)> {
    if !require_simulation {
        return Ok(());
    }

    let ctx = execution_context.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Could not build execution context for validator signing".to_string(),
        )
    })?;
    let sim = ctx.simulation_result.as_ref().ok_or_else(|| {
        (
            StatusCode::BAD_GATEWAY,
            "Simulation is required for live production validation but did not complete"
                .to_string(),
        )
    })?;

    if !sim.success {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Simulation is required for live production validation but the transaction reverted"
                .to_string(),
        ));
    }
    if sim.risk_score > 0 || !sim.warnings.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "Simulation rejected live production validation: risk_score={}, warnings={}",
                sim.risk_score,
                sim.warnings.join("; ")
            ),
        ));
    }

    Ok(())
}

fn build_direct_execution_hash(
    protocol: &str,
    intent: &TradeIntent,
    intent_hash: &str,
    deadline: u64,
    chain_id: u64,
) -> Result<Option<String>, (StatusCode, String)> {
    let intent_hash = parse_b256(intent_hash).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Could not parse intent hash for direct execution binding".to_string(),
        )
    })?;
    let deadline = alloy::primitives::U256::from(deadline);

    match protocol {
        "polymarket_clob" => {
            let params = polymarket_clob::extract_clob_params(
                &format_action(&intent.action),
                &intent.amount_in.to_string(),
                &intent.metadata,
            )
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            Ok(Some(format_b256(hash_clob_order(
                &params,
                intent_hash,
                deadline,
                chain_id,
            ))))
        }
        "hyperliquid" => {
            let order = hyperliquid_order_from_intent(intent);
            Ok(Some(format_b256(hash_hyperliquid_order(
                &order,
                intent_hash,
                deadline,
                chain_id,
            ))))
        }
        _ => Ok(None),
    }
}

fn format_action(action: &Action) -> String {
    match action {
        Action::Swap => "swap",
        Action::Supply => "supply",
        Action::Withdraw => "withdraw",
        Action::Borrow => "borrow",
        Action::Repay => "repay",
        Action::OpenLong => "open_long",
        Action::OpenShort => "open_short",
        Action::CloseLong => "close_long",
        Action::CloseShort => "close_short",
        Action::Buy => "buy",
        Action::Sell => "sell",
        Action::Redeem => "redeem",
        Action::CollateralRelease => "collateral_release",
    }
    .to_string()
}

fn hyperliquid_order_from_intent(intent: &TradeIntent) -> PlaceOrderRequest {
    let is_buy = matches!(
        intent.action,
        Action::OpenLong | Action::Buy | Action::CloseShort
    );
    let reduce_only = matches!(intent.action, Action::CloseLong | Action::CloseShort);

    let order_type = if let Some(trigger_px) = intent
        .metadata
        .get("trigger_price")
        .and_then(|v| v.as_str())
    {
        let is_market = intent
            .metadata
            .get("is_market")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let tpsl = intent
            .metadata
            .get("tpsl")
            .and_then(|v| v.as_str())
            .unwrap_or("sl");
        if tpsl == "tp" {
            HlOrderType::TakeProfit {
                trigger_price: trigger_px.to_string(),
                is_market,
            }
        } else {
            HlOrderType::StopLoss {
                trigger_price: trigger_px.to_string(),
                is_market,
            }
        }
    } else if let Some(price) = intent.metadata.get("limit_price").and_then(|v| v.as_str()) {
        HlOrderType::Limit {
            price: price.to_string(),
        }
    } else {
        HlOrderType::Market
    };

    let asset = if let Some(asset_str) = intent.metadata.get("asset").and_then(|v| v.as_str()) {
        AssetId::Symbol(asset_str.to_string())
    } else {
        AssetId::Symbol(intent.token_out.clone())
    };

    PlaceOrderRequest {
        asset,
        is_buy,
        size: intent.amount_in.to_string(),
        order_type,
        reduce_only,
        cloid: None,
    }
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/validate", post(validate))
}

/// Router for multi-bot mode (state = MultiBotTradingState, bot resolved from extensions).
pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/validate", post(validate_multi_bot))
}

pub fn parse_action(s: &str) -> Result<Action, String> {
    match s {
        "swap" => Ok(Action::Swap),
        "supply" => Ok(Action::Supply),
        "borrow" => Ok(Action::Borrow),
        "withdraw" => Ok(Action::Withdraw),
        "repay" => Ok(Action::Repay),
        "open_long" => Ok(Action::OpenLong),
        "open_short" => Ok(Action::OpenShort),
        "close_long" => Ok(Action::CloseLong),
        "close_short" => Ok(Action::CloseShort),
        "buy" => Ok(Action::Buy),
        "sell" => Ok(Action::Sell),
        "redeem" => Ok(Action::Redeem),
        "collateral_release" => Ok(Action::CollateralRelease),
        other => Err(format!("Unknown action: {other}")),
    }
}

/// Parsed and validated fields from a ValidateRequest.
#[derive(Debug)]
struct ParsedValidateRequest {
    action: Action,
    amount_in: rust_decimal::Decimal,
    min_amount_out: rust_decimal::Decimal,
    intent: TradeIntent,
    deadline: u64,
}

/// Parse and validate a ValidateRequest into typed fields.
fn parse_validate_request(
    req: &ValidateRequest,
    chain_id: Option<u64>,
) -> Result<ParsedValidateRequest, (StatusCode, String)> {
    let action = parse_action(&req.action).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let amount_in: rust_decimal::Decimal = req
        .amount_in
        .parse()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid amount_in: {e}")))?;
    let min_amount_out: rust_decimal::Decimal = req.min_amount_out.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid min_amount_out: {e}"),
        )
    })?;

    let token_in = normalize_protocol_token(&req.target_protocol, chain_id, &req.token_in);
    let token_out = normalize_protocol_token(&req.target_protocol, chain_id, &req.token_out);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let deadline = now.checked_add(req.deadline_secs).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Validation deadline overflow".to_string(),
        )
    })?;
    if deadline > i64::MAX as u64 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Invalid validation deadline: {deadline}"),
        ));
    }

    let mut intent = TradeIntentBuilder::new()
        .strategy_id(&req.strategy_id)
        .action(action.clone())
        .token_in(&token_in)
        .token_out(&token_out)
        .amount_in(amount_in)
        .min_amount_out(min_amount_out)
        .target_protocol(&req.target_protocol)
        .chain_id(chain_id.unwrap_or(42161))
        .metadata(req.metadata.clone())
        .build()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    intent.deadline = chrono::DateTime::<chrono::Utc>::from_timestamp(deadline as i64, 0)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid validation deadline: {deadline}"),
            )
        })?;

    Ok(ParsedValidateRequest {
        action,
        amount_in,
        min_amount_out,
        intent,
        deadline,
    })
}

/// Build a ValidateResponse from a ValidationResult.
fn build_validate_response(
    result: &ValidationResult,
    deadline: u64,
    paper_trade: bool,
) -> ValidateResponse {
    let responses = result
        .validator_responses
        .iter()
        .map(|r| ValidatorResponseEntry {
            validator: r.validator.clone(),
            score: r.score,
            reasoning: r.reasoning.clone(),
            signature: r.signature.clone(),
            chain_id: r.chain_id,
            verifying_contract: r.verifying_contract.clone(),
            validated_at: r.validated_at.clone(),
        })
        .collect();

    ValidateResponse {
        approved: effective_validation_approval(result, paper_trade),
        aggregate_score: result.aggregate_score,
        intent_hash: result.intent_hash.clone(),
        execution_hash: result.execution_hash.clone(),
        deadline,
        validator_responses: responses,
    }
}

async fn validate(
    State(state): State<Arc<TradingApiState>>,
    Json(mut request): Json<ValidateRequest>,
) -> Result<Json<ValidateResponse>, (StatusCode, String)> {
    let protocol_chain_id = state_protocol_chain_id(state.chain_id);
    request.metadata = crate::enrich_yield_safety_metadata(
        &request.target_protocol,
        &request.action,
        &serde_json::Value::Null,
        &request.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let parsed = parse_validate_request(&request, protocol_chain_id)?;
    let token_in = normalize_protocol_token(
        &request.target_protocol,
        protocol_chain_id,
        &request.token_in,
    );
    let token_out = normalize_protocol_token(
        &request.target_protocol,
        protocol_chain_id,
        &request.token_out,
    );
    validate_chain_tokens(protocol_chain_id, &token_in, &token_out)?;
    crate::validate_morpho_protocol_request(
        &serde_json::Value::Null,
        protocol_chain_id.unwrap_or(parsed.intent.chain_id),
        &request.target_protocol,
        &request.action,
        &token_in,
        &token_out,
        &request.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    if !state.paper_trade && requires_aave_health_check(&request.target_protocol, &request.action) {
        let rpc_url = state.rpc_url.as_deref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Aave health checks require an RPC URL".to_string(),
            )
        })?;
        require_current_aave_health(
            rpc_url,
            protocol_chain_id.unwrap_or(parsed.intent.chain_id),
            &state.vault_address,
            &request.metadata,
        )
        .await?;
    }

    let intent_hash = hash_intent(&parsed.intent);
    if !state.paper_trade
        && requires_execution_context(&request.target_protocol)
        && parsed.min_amount_out <= rust_decimal::Decimal::ZERO
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Live vault-backed validation requires min_amount_out > 0".to_string(),
        ));
    }
    if state.paper_trade && state.validator_endpoints.is_empty() {
        return Ok(Json(paper_mode_bypass_response(
            intent_hash,
            zero_hash(),
            parsed.deadline,
        )));
    }

    let execution_context = build_execution_context(
        &request.target_protocol,
        parsed.action,
        parsed.amount_in,
        parsed.min_amount_out,
        &token_in,
        &token_out,
        &state.vault_address,
        state.rpc_url.as_deref(),
        protocol_chain_id,
        state.chain_id.unwrap_or(parsed.intent.chain_id),
        &intent_hash,
        parsed.deadline,
        &request.metadata,
    )
    .await;

    if requires_execution_context(&request.target_protocol) && execution_context.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Could not build execution context for validator signing".to_string(),
        ));
    }
    let require_simulation = requires_prevalidation_simulation(
        &request.target_protocol,
        state.paper_trade,
        execution_context.as_ref(),
    );
    require_successful_simulation(execution_context.as_ref(), require_simulation)?;
    let execution_hash_override = build_direct_execution_hash(
        &request.target_protocol,
        &parsed.intent,
        &intent_hash,
        parsed.deadline,
        state.chain_id.unwrap_or(parsed.intent.chain_id),
    )?;
    let action_kind = action_kind_for_protocol(&request.target_protocol);

    let min_validators = required_validator_signatures(
        &state.vault_address,
        state.rpc_url.as_deref(),
        state.paper_trade,
    )
    .await?;
    let validator_client = state
        .validator_client
        .clone()
        .with_min_validators(min_validators);
    let result = validator_client
        .validate_with_context(
            &parsed.intent,
            &state.vault_address,
            parsed.deadline,
            execution_context,
            require_simulation,
            execution_hash_override,
            action_kind,
        )
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(build_validate_response(
        &result,
        parsed.deadline,
        state.paper_trade,
    )))
}

/// Build execution context by encoding the action via the protocol adapter.
///
/// When `rpc_url` is available, runs a transaction simulation and populates
/// the `SimulationSummary` for validators to verify.
///
/// Returns `None` if the adapter is unavailable or encoding fails. A missing
/// simulation result is fatal for live vault-executed protocols and allowed for
/// paper/direct protocols.
#[allow(clippy::too_many_arguments)]
async fn build_execution_context(
    protocol: &str,
    action: Action,
    amount_in: rust_decimal::Decimal,
    min_amount_out: rust_decimal::Decimal,
    token_in: &str,
    token_out: &str,
    vault_address: &str,
    rpc_url: Option<&str>,
    chain_id: Option<u64>,
    execution_chain_id: u64,
    intent_hash: &str,
    deadline: u64,
    metadata: &serde_json::Value,
) -> Option<ExecutionContext> {
    if uses_direct_non_vault_execution(protocol) {
        return None;
    }

    let adapter = get_adapter(protocol, chain_id).ok()?;

    let token_in_addr: alloy::primitives::Address = token_in.parse().ok()?;
    let token_out_addr: alloy::primitives::Address = token_out.parse().ok()?;
    let vault_addr: alloy::primitives::Address = vault_address.parse().ok()?;

    let amount = decimal_to_u256_safe(&amount_in)?;
    let min_out = decimal_to_u256_safe(&min_amount_out)?;

    let params = ActionParams {
        action,
        token_in: token_in_addr,
        token_out: token_out_addr,
        amount,
        min_output: min_out,
        extra: metadata_with_execution_deadline(metadata, deadline),
        vault_address: vault_addr,
    };

    let encoded = adapter.encode_action(&params).ok()?;
    let intent_hash_bytes = parse_b256(intent_hash)?;
    let execution_hash = hash_execution_payload(
        &encoded,
        intent_hash_bytes,
        alloy::primitives::U256::from(deadline),
        execution_chain_id,
    );

    let calldata_decoded = calldata_decoder::decode_encoded_action(&encoded.calldata, protocol);
    let (
        postcondition_kind,
        input_token,
        max_input,
        debt_token,
        min_debt_decrease,
        health_pool,
        health_account,
        min_health_factor,
    ) = match (&encoded.debt_reduction, &encoded.health_factor) {
        (Some(debt_reduction), _) => (
            "debt_decrease".to_string(),
            format!("{}", debt_reduction.input_token),
            format!("{}", debt_reduction.max_input),
            format!("{}", debt_reduction.debt_token),
            format!("{}", debt_reduction.min_debt_decrease),
            String::new(),
            String::new(),
            String::new(),
        ),
        (_, Some(health_factor)) => (
            "health_factor".to_string(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            format!("{}", health_factor.pool),
            format!("{}", health_factor.account),
            format!("{}", health_factor.min_health_factor),
        ),
        (None, None) => (
            "output_increase".to_string(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ),
    };

    // Extract known addresses before the async boundary (adapter may not be Sync)
    let mut known_addresses = adapter.known_addresses();
    if protocol == "morpho_vault" {
        known_addresses.push(encoded.target);
    }
    drop(adapter);

    let simulation_result = match rpc_url {
        Some(rpc) if encoded.approvals.is_empty() => {
            let mut simulation_tokens = vec![token_in_addr, token_out_addr, encoded.output_token];
            for approval in &encoded.approvals {
                simulation_tokens.push(approval.token);
            }
            if let Some(debt_reduction) = &encoded.debt_reduction {
                simulation_tokens.push(debt_reduction.input_token);
                simulation_tokens.push(debt_reduction.debt_token);
            }
            simulation_tokens.sort();
            simulation_tokens.dedup();
            run_simulation(
                rpc,
                chain_id.unwrap_or(1),
                vault_addr,
                &encoded.calldata,
                encoded.target,
                token_in_addr,
                encoded.output_token,
                amount,
                encoded.min_output,
                simulation_tokens,
                &known_addresses,
            )
            .await
        }
        Some(_) => {
            tracing::info!(
                protocol,
                approvals = encoded.approvals.len(),
                "Skipping raw pre-validation simulation for atomically approved vault execution"
            );
            None
        }
        None => None,
    };

    Some(ExecutionContext {
        execution_hash: format_b256(execution_hash),
        chain_id: execution_chain_id,
        target: format!("{}", encoded.target),
        calldata: format!("0x{}", hex::encode(&encoded.calldata)),
        calldata_decoded,
        value: format!("{}", encoded.value),
        min_output: format!("{}", encoded.min_output),
        output_token: format!("{}", encoded.output_token),
        postcondition_kind,
        input_token,
        max_input,
        debt_token,
        min_debt_decrease,
        health_pool,
        health_account,
        min_health_factor,
        approvals: encoded
            .approvals
            .iter()
            .map(|approval| ExecutionApproval {
                token: format!("{}", approval.token),
                spender: format!("{}", approval.spender),
                amount: format!("{}", approval.amount),
            })
            .collect(),
        simulation_result,
    })
}

fn parse_b256(hash: &str) -> Option<alloy::primitives::B256> {
    let bytes = hex::decode(hash.trim_start_matches("0x")).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    Some(alloy::primitives::B256::from_slice(&bytes))
}

fn metadata_with_execution_deadline(
    metadata: &serde_json::Value,
    deadline: u64,
) -> serde_json::Value {
    let mut extra = metadata.clone();
    match extra {
        serde_json::Value::Object(ref mut map) => {
            map.entry("execution_deadline".to_string())
                .or_insert_with(|| serde_json::json!(deadline));
            extra
        }
        _ => serde_json::json!({ "execution_deadline": deadline }),
    }
}

/// Run a transaction simulation and return a SimulationSummary.
#[allow(clippy::too_many_arguments)]
async fn run_simulation(
    rpc_url: &str,
    chain_id: u64,
    vault_address: alloy::primitives::Address,
    calldata: &alloy::primitives::Bytes,
    target: alloy::primitives::Address,
    token_in: alloy::primitives::Address,
    token_out: alloy::primitives::Address,
    amount_in: alloy::primitives::U256,
    min_output: alloy::primitives::U256,
    token_addresses: Vec<alloy::primitives::Address>,
    known_protocol_addresses: &[alloy::primitives::Address],
) -> Option<SimulationSummary> {
    use trading_runtime::simulator::{
        SimulationRequest, SimulatorConfig, create_simulator,
        risk_analyzer::{TradeContext, analyze_simulation},
    };

    let mut config = SimulatorConfig::from_env();
    config.chain_id = Some(chain_id);
    let simulator = create_simulator(rpc_url.to_string(), &config);

    let sim_request = SimulationRequest {
        from: vault_address,
        to: target,
        data: calldata.clone(),
        value: alloy::primitives::U256::ZERO,
        block_number: None,
        token_addresses,
        balance_check_account: Some(vault_address),
    };

    match simulator.simulate(sim_request).await {
        Ok(sim_result) => {
            let risk = analyze_simulation(
                &sim_result,
                &TradeContext {
                    vault_address,
                    token_in,
                    token_out,
                    amount_in,
                    min_output,
                    known_protocol_addresses: known_protocol_addresses.to_vec(),
                },
            );

            let balance_changes = sim_result
                .balance_changes
                .iter()
                .map(|bc| BalanceChangeSummary {
                    token: format!("{}", bc.token),
                    account: format!("{}", bc.account),
                    before: format!("{}", bc.before),
                    after: format!("{}", bc.after),
                })
                .collect();

            let warnings: Vec<String> = risk.warnings.iter().map(|w| w.to_string()).collect();

            Some(SimulationSummary {
                success: sim_result.success,
                gas_used: sim_result.gas_used,
                output_amount: "0".into(), // Would need transfer event analysis for exact output
                balance_changes,
                warnings,
                risk_score: risk.risk_score,
            })
        }
        Err(e) => {
            tracing::warn!("Simulation failed: {e}");
            None
        }
    }
}

/// Convert Decimal to U256 (safe — returns None on failure).
fn decimal_to_u256_safe(d: &rust_decimal::Decimal) -> Option<alloy::primitives::U256> {
    let truncated = d.trunc();
    let s = truncated.to_string();
    if s.starts_with('-') {
        return None;
    }
    alloy::primitives::U256::from_str_radix(&s, 10).ok()
}

/// Multi-bot validate handler — resolves bot from request extensions (set by auth middleware).
async fn validate_multi_bot(
    State(state): State<Arc<MultiBotTradingState>>,
    request: Request,
) -> Result<Json<ValidateResponse>, (StatusCode, String)> {
    let bot = request
        .extensions()
        .get::<crate::BotContext>()
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Bot context not resolved — check auth middleware".into(),
            )
        })?;

    let body = axum::body::to_bytes(request.into_body(), 1024 * 64)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Body read failed: {e}")))?;
    let req: ValidateRequest = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}")))?;
    let mut req = req;
    crate::validate_protocol_available(&bot.strategy_config, &req.target_protocol)
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;

    let protocol_chain_id =
        crate::protocol_chain_id_from_config(bot.chain_id, &bot.strategy_config);
    req.metadata = crate::enrich_yield_safety_metadata(
        &req.target_protocol,
        &req.action,
        &bot.risk_params,
        &req.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let parsed = parse_validate_request(&req, Some(protocol_chain_id))?;
    let token_in =
        normalize_protocol_token(&req.target_protocol, Some(protocol_chain_id), &req.token_in);
    let token_out = normalize_protocol_token(
        &req.target_protocol,
        Some(protocol_chain_id),
        &req.token_out,
    );
    validate_chain_tokens(Some(protocol_chain_id), &token_in, &token_out)?;
    crate::validate_morpho_protocol_request(
        &bot.strategy_config,
        protocol_chain_id,
        &req.target_protocol,
        &req.action,
        &token_in,
        &token_out,
        &req.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    if !bot.paper_trade && requires_aave_health_check(&req.target_protocol, &req.action) {
        require_current_aave_health(
            &bot.rpc_url,
            protocol_chain_id,
            &bot.vault_address,
            &req.metadata,
        )
        .await?;
    }

    // Use validator endpoints from the bot context
    let validator_endpoints = bot.validator_endpoints.clone();

    // Paper-trade bypass: if no validators configured and bot is in paper mode,
    // return synthetic approval so the trading loop can proceed.
    let intent_hash = hash_intent(&parsed.intent);
    if !bot.paper_trade
        && requires_execution_context(&req.target_protocol)
        && parsed.min_amount_out <= rust_decimal::Decimal::ZERO
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Live vault-backed validation requires min_amount_out > 0".to_string(),
        ));
    }
    if bot.paper_trade && validator_endpoints.is_empty() {
        return Ok(Json(paper_mode_bypass_response(
            intent_hash,
            zero_hash(),
            parsed.deadline,
        )));
    }

    // Build execution context for validators (with simulation if RPC available)
    let execution_context = build_execution_context(
        &req.target_protocol,
        parsed.action,
        parsed.amount_in,
        parsed.min_amount_out,
        &token_in,
        &token_out,
        &bot.vault_address,
        Some(&bot.rpc_url),
        Some(protocol_chain_id),
        bot.chain_id,
        &intent_hash,
        parsed.deadline,
        &req.metadata,
    )
    .await;

    if requires_execution_context(&req.target_protocol) && execution_context.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Could not build execution context for validator signing".to_string(),
        ));
    }
    let require_simulation = requires_prevalidation_simulation(
        &req.target_protocol,
        bot.paper_trade,
        execution_context.as_ref(),
    );
    require_successful_simulation(execution_context.as_ref(), require_simulation)?;
    let execution_hash_override = build_direct_execution_hash(
        &req.target_protocol,
        &parsed.intent,
        &intent_hash,
        parsed.deadline,
        bot.chain_id,
    )?;
    let action_kind = action_kind_for_protocol(&req.target_protocol);

    // Real validation: fan out to validator endpoints. Match the off-chain
    // quorum to the vault's on-chain TradeValidator requirement.
    let min_validators =
        required_validator_signatures(&bot.vault_address, Some(&bot.rpc_url), bot.paper_trade)
            .await?;
    let client = ValidatorClient::new(validator_endpoints, state.min_validator_score)
        .with_min_validators(min_validators);
    let result = client
        .validate_with_context(
            &parsed.intent,
            &bot.vault_address,
            parsed.deadline,
            execution_context,
            require_simulation,
            execution_hash_override,
            action_kind,
        )
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(build_validate_response(
        &result,
        parsed.deadline,
        bot.paper_trade,
    )))
}

async fn required_validator_signatures(
    vault_address: &str,
    rpc_url: Option<&str>,
    paper_trade: bool,
) -> Result<usize, (StatusCode, String)> {
    if paper_trade {
        return Ok(1);
    }

    let Some(rpc_url) = rpc_url else {
        return Ok(1);
    };

    let vault: Address = vault_address.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid vault address '{vault_address}': {e}"),
        )
    })?;
    let provider = ProviderBuilder::new().connect_http(rpc_url.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid RPC URL '{rpc_url}': {e}"),
        )
    })?);

    let validator_addr = eth_call_address(
        &provider,
        vault,
        ITradingVault::tradeValidatorCall {}.abi_encode(),
    )
    .await
    .map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read vault TradeValidator: {e}"),
        )
    })?;
    if validator_addr == Address::ZERO {
        return Ok(1);
    }

    let required = eth_call_u256(
        &provider,
        validator_addr,
        ITradeValidator::getRequiredSignaturesCall { vault }.abi_encode(),
    )
    .await
    .map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read validator quorum: {e}"),
        )
    })?;

    Ok(required.to::<usize>().max(1))
}

async fn eth_call_address(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<Address, String> {
    let result = eth_call(provider, to, data).await?;
    Address::abi_decode(&result).map_err(|e| format!("ABI decode address failed: {e}"))
}

async fn eth_call_u256(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<U256, String> {
    let result = eth_call(provider, to, data).await?;
    U256::abi_decode(&result).map_err(|e| format!("ABI decode uint256 failed: {e}"))
}

async fn eth_call(provider: &impl Provider, to: Address, data: Vec<u8>) -> Result<Bytes, String> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());
    provider.call(tx).await.map_err(|e| format!("{e}"))
}

fn validate_chain_tokens(
    chain_id: Option<u64>,
    token_in: &str,
    token_out: &str,
) -> Result<(), (StatusCode, String)> {
    let Some(chain_id) = chain_id else {
        return Ok(());
    };

    for token in [token_in, token_out] {
        if let Some(other_chain_id) = address_chain_mismatch(chain_id, token) {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "Token {token} belongs to {}, but this bot is configured for {}. Use the correct token address for the configured chain.",
                    chain_display_name(other_chain_id),
                    chain_display_name(chain_id),
                ),
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_chain_tokens_rejects_mainnet_address_on_base_sepolia() {
        let err = validate_chain_tokens(
            Some(84532),
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        )
        .expect_err("should reject mainnet token on base sepolia");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("Ethereum mainnet"));
        assert!(err.1.contains("Base Sepolia"));
    }

    #[test]
    fn test_decimal_to_u256_safe_positive() {
        let d = rust_decimal::Decimal::new(1000, 0);
        let u = decimal_to_u256_safe(&d).unwrap();
        assert_eq!(u, alloy::primitives::U256::from(1000u64));
    }

    #[test]
    fn test_decimal_to_u256_safe_negative() {
        let d = rust_decimal::Decimal::new(-100, 0);
        assert!(decimal_to_u256_safe(&d).is_none());
    }

    #[test]
    fn test_decimal_to_u256_safe_fractional() {
        let d = rust_decimal::Decimal::new(12345, 2); // 123.45
        let u = decimal_to_u256_safe(&d).unwrap();
        assert_eq!(u, alloy::primitives::U256::from(123u64));
    }

    #[test]
    fn test_decimal_to_u256_safe_zero() {
        let d = rust_decimal::Decimal::ZERO;
        let u = decimal_to_u256_safe(&d).unwrap();
        assert_eq!(u, alloy::primitives::U256::ZERO);
    }

    #[test]
    fn test_parse_action_valid() {
        assert!(matches!(parse_action("swap"), Ok(Action::Swap)));
        assert!(matches!(parse_action("supply"), Ok(Action::Supply)));
        assert!(matches!(parse_action("borrow"), Ok(Action::Borrow)));
        assert!(matches!(parse_action("withdraw"), Ok(Action::Withdraw)));
        assert!(matches!(parse_action("open_long"), Ok(Action::OpenLong)));
    }

    #[test]
    fn test_parse_action_unknown() {
        assert!(parse_action("invalid_action").is_err());
    }

    #[tokio::test]
    async fn test_build_execution_context_unknown_protocol() {
        let result = build_execution_context(
            "unknown_protocol",
            Action::Swap,
            rust_decimal::Decimal::new(100, 0),
            rust_decimal::Decimal::new(95, 0),
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "0x0000000000000000000000000000000000000001",
            None,
            None,
            31337,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            9999999999,
            &serde_json::Value::Null,
        )
        .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_build_execution_context_uniswap_swap() {
        let result = build_execution_context(
            "uniswap_v3",
            Action::Swap,
            rust_decimal::Decimal::new(1_000_000_000_000_000_000, 0),
            rust_decimal::Decimal::new(2_500_000_000, 0),
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "0x0000000000000000000000000000000000000001",
            None,
            None,
            31337,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            9999999999,
            &serde_json::Value::Null,
        )
        .await;
        let ctx = result.expect("should build context for uniswap_v3 swap");
        assert!(ctx.calldata.starts_with("0x"));
        assert!(ctx.calldata_decoded.contains("exactInputSingle"));
        assert!(ctx.simulation_result.is_none()); // no RPC provided
    }

    #[tokio::test]
    async fn test_build_execution_context_aave_local_eth_fork_uses_ethereum_pool() {
        let result = build_execution_context(
            "aave_v3",
            Action::Supply,
            rust_decimal::Decimal::new(1_000_000, 0),
            rust_decimal::Decimal::new(1_000_000, 0),
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "0x0000000000000000000000000000000000000001",
            None,
            Some(31339),
            31339,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            9999999999,
            &serde_json::Value::Null,
        )
        .await;

        let ctx = result.expect("should build Aave context on local ethereum fork");
        assert_eq!(
            ctx.target.parse::<alloy::primitives::Address>().unwrap(),
            "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
                .parse::<alloy::primitives::Address>()
                .unwrap()
        );
        assert!(ctx.simulation_result.is_none());
    }

    #[tokio::test]
    async fn test_build_execution_context_invalid_addresses() {
        let result = build_execution_context(
            "uniswap_v3",
            Action::Swap,
            rust_decimal::Decimal::new(100, 0),
            rust_decimal::Decimal::new(95, 0),
            "not-an-address",
            "also-not-an-address",
            "0x0000000000000000000000000000000000000001",
            None,
            None,
            31337,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            9999999999,
            &serde_json::Value::Null,
        )
        .await;
        assert!(result.is_none());
    }

    #[test]
    fn test_live_vault_protocol_requires_simulation() {
        assert!(requires_production_simulation("uniswap_v3", false));
        assert!(requires_production_simulation("aave_v3", false));
        assert!(!requires_production_simulation("uniswap_v3", true));
        assert!(!requires_production_simulation("hyperliquid", false));
    }

    #[test]
    fn test_atomic_vault_approvals_do_not_require_raw_prevalidation_simulation() {
        let ctx = ExecutionContext {
            execution_hash: zero_hash(),
            chain_id: 31337,
            target: ZERO_ADDRESS.into(),
            calldata: "0x".into(),
            calldata_decoded: "noop()".into(),
            value: "0".into(),
            min_output: "0".into(),
            output_token: ZERO_ADDRESS.into(),
            postcondition_kind: "output_increase".into(),
            input_token: String::new(),
            max_input: String::new(),
            debt_token: String::new(),
            min_debt_decrease: String::new(),
            health_pool: String::new(),
            health_account: String::new(),
            min_health_factor: String::new(),
            approvals: vec![ExecutionApproval {
                token: ZERO_ADDRESS.into(),
                spender: "0x0000000000000000000000000000000000000001".into(),
                amount: "100".into(),
            }],
            simulation_result: None,
        };

        assert!(!requires_prevalidation_simulation(
            "uniswap_v3",
            false,
            Some(&ctx)
        ));
        assert!(requires_prevalidation_simulation("uniswap_v3", false, None));
    }

    #[test]
    fn test_require_successful_simulation_rejects_missing_result() {
        let ctx = ExecutionContext {
            execution_hash: zero_hash(),
            chain_id: 31337,
            target: ZERO_ADDRESS.into(),
            calldata: "0x".into(),
            calldata_decoded: "noop()".into(),
            value: "0".into(),
            min_output: "0".into(),
            output_token: ZERO_ADDRESS.into(),
            postcondition_kind: "output_increase".into(),
            input_token: String::new(),
            max_input: String::new(),
            debt_token: String::new(),
            min_debt_decrease: String::new(),
            health_pool: String::new(),
            health_account: String::new(),
            min_health_factor: String::new(),
            approvals: Vec::new(),
            simulation_result: None,
        };

        let err = require_successful_simulation(Some(&ctx), true).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_GATEWAY);
        assert!(err.1.contains("Simulation is required"));
    }

    #[test]
    fn test_require_successful_simulation_rejects_warnings() {
        let ctx = ExecutionContext {
            execution_hash: zero_hash(),
            chain_id: 31337,
            target: ZERO_ADDRESS.into(),
            calldata: "0x".into(),
            calldata_decoded: "noop()".into(),
            value: "0".into(),
            min_output: "0".into(),
            output_token: ZERO_ADDRESS.into(),
            postcondition_kind: "output_increase".into(),
            input_token: String::new(),
            max_input: String::new(),
            debt_token: String::new(),
            min_debt_decrease: String::new(),
            health_pool: String::new(),
            health_account: String::new(),
            min_health_factor: String::new(),
            approvals: Vec::new(),
            simulation_result: Some(SimulationSummary {
                success: true,
                gas_used: 21_000,
                output_amount: "0".into(),
                balance_changes: Vec::new(),
                warnings: vec!["UnexpectedApproval: token=0x1 spender=0x2 amount=3".into()],
                risk_score: 0,
            }),
        };

        let err = require_successful_simulation(Some(&ctx), true).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_GATEWAY);
        assert!(err.1.contains("Simulation rejected"));
    }

    #[test]
    fn test_require_successful_simulation_allows_clean_result() {
        let ctx = ExecutionContext {
            execution_hash: zero_hash(),
            chain_id: 31337,
            target: ZERO_ADDRESS.into(),
            calldata: "0x".into(),
            calldata_decoded: "noop()".into(),
            value: "0".into(),
            min_output: "0".into(),
            output_token: ZERO_ADDRESS.into(),
            postcondition_kind: "output_increase".into(),
            input_token: String::new(),
            max_input: String::new(),
            debt_token: String::new(),
            min_debt_decrease: String::new(),
            health_pool: String::new(),
            health_account: String::new(),
            min_health_factor: String::new(),
            approvals: Vec::new(),
            simulation_result: Some(SimulationSummary {
                success: true,
                gas_used: 21_000,
                output_amount: "0".into(),
                balance_changes: Vec::new(),
                warnings: Vec::new(),
                risk_score: 0,
            }),
        };

        require_successful_simulation(Some(&ctx), true).unwrap();
    }

    #[test]
    fn test_parse_validate_request_valid() {
        let req = ValidateRequest {
            strategy_id: "test".into(),
            action: "swap".into(),
            token_in: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".into(),
            token_out: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".into(),
            amount_in: "1000000000000000000".into(),
            min_amount_out: "2500000000".into(),
            target_protocol: "uniswap_v3".into(),
            metadata: serde_json::Value::Null,
            deadline_secs: 300,
        };
        let parsed = parse_validate_request(&req, Some(1)).unwrap();
        assert!(matches!(parsed.action, Action::Swap));
        assert!(parsed.deadline > 0);
        assert_eq!(parsed.intent.deadline.timestamp(), parsed.deadline as i64);
    }

    #[test]
    fn test_parse_validate_request_bad_action() {
        let req = ValidateRequest {
            strategy_id: "test".into(),
            action: "invalid".into(),
            token_in: "0xA".into(),
            token_out: "0xB".into(),
            amount_in: "100".into(),
            min_amount_out: "95".into(),
            target_protocol: "uniswap_v3".into(),
            metadata: serde_json::Value::Null,
            deadline_secs: 300,
        };
        let err = parse_validate_request(&req, Some(1)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_parse_validate_request_bad_decimal() {
        let req = ValidateRequest {
            strategy_id: "test".into(),
            action: "swap".into(),
            token_in: "0xA".into(),
            token_out: "0xB".into(),
            amount_in: "not-a-number".into(),
            min_amount_out: "95".into(),
            target_protocol: "uniswap_v3".into(),
            metadata: serde_json::Value::Null,
            deadline_secs: 300,
        };
        let err = parse_validate_request(&req, Some(1)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn normalize_protocol_token_maps_zero_address_to_weth_for_ethereum_yield() {
        assert_eq!(
            normalize_protocol_token("aave_v3", Some(31339), ZERO_ADDRESS),
            MAINNET_WETH_ADDRESS
        );
        assert_eq!(
            normalize_protocol_token("morpho_vault", Some(1), ZERO_ADDRESS),
            MAINNET_WETH_ADDRESS
        );
        assert_eq!(
            normalize_protocol_token("uniswap_v3", Some(31339), ZERO_ADDRESS),
            ZERO_ADDRESS
        );
    }
}
