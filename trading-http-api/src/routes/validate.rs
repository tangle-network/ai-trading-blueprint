use crate::{MultiBotTradingState, TradingApiState};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::{Json, Router, extract::State, routing::post};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use trading_runtime::adapters::ActionParams;
use trading_runtime::calldata_decoder;
use trading_runtime::execution_hash::{format_b256, hash_execution_payload};
use trading_runtime::executor::get_adapter;
use trading_runtime::intent::hash_intent;
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
    let yield_protocol = matches!(protocol, "aave_v3" | "morpho");

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

    let intent = TradeIntentBuilder::new()
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

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let deadline = now + req.deadline_secs;

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
    Json(request): Json<ValidateRequest>,
) -> Result<Json<ValidateResponse>, (StatusCode, String)> {
    let protocol_chain_id = state_protocol_chain_id(state.chain_id);
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

    if state.paper_trade && state.validator_endpoints.is_empty() {
        let intent_hash = hash_intent(&parsed.intent);
        let execution_hash = format!("0x{}", "00".repeat(32));
        return Ok(Json(paper_mode_bypass_response(
            intent_hash,
            execution_hash,
            parsed.deadline,
        )));
    }
    let intent_hash = hash_intent(&parsed.intent);

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
    )
    .await
    .ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Could not build execution context for validator signing".to_string(),
        )
    })?;

    let result = state
        .validator_client
        .validate_with_context(
            &parsed.intent,
            &state.vault_address,
            parsed.deadline,
            Some(execution_context),
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
/// Returns `None` if the adapter is unavailable or encoding fails
/// (non-fatal — validators will score without execution context).
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
) -> Option<ExecutionContext> {
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
        extra: serde_json::Value::Null,
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

    // Extract known addresses before the async boundary (adapter may not be Sync)
    let known_addresses = adapter.known_addresses();
    drop(adapter);

    let simulation_result = match rpc_url {
        Some(rpc) => {
            run_simulation(
                rpc,
                chain_id.unwrap_or(1),
                vault_addr,
                &encoded.calldata,
                encoded.target,
                token_in_addr,
                token_out_addr,
                amount,
                min_out,
                &known_addresses,
            )
            .await
        }
        None => None,
    };

    Some(ExecutionContext {
        execution_hash: format_b256(execution_hash),
        target: format!("{}", encoded.target),
        calldata: format!("0x{}", hex::encode(&encoded.calldata)),
        calldata_decoded,
        value: format!("{}", encoded.value),
        min_output: format!("{}", encoded.min_output),
        output_token: format!("{}", encoded.output_token),
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
        token_addresses: vec![token_in, token_out],
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
            tracing::warn!("Simulation failed (non-fatal): {e}");
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
    crate::validate_protocol_available(&bot.strategy_config, &req.target_protocol)
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;

    let protocol_chain_id =
        crate::protocol_chain_id_from_config(bot.chain_id, &bot.strategy_config);
    let parsed = parse_validate_request(&req, Some(protocol_chain_id))?;
    let token_in =
        normalize_protocol_token(&req.target_protocol, Some(protocol_chain_id), &req.token_in);
    let token_out = normalize_protocol_token(
        &req.target_protocol,
        Some(protocol_chain_id),
        &req.token_out,
    );
    validate_chain_tokens(Some(protocol_chain_id), &token_in, &token_out)?;

    // Use validator endpoints from the bot context
    let validator_endpoints = bot.validator_endpoints.clone();

    // Paper-trade bypass: if no validators configured and bot is in paper mode,
    // return synthetic approval so the trading loop can proceed.
    if bot.paper_trade && validator_endpoints.is_empty() {
        let intent_hash = hash_intent(&parsed.intent);
        let execution_hash = format!("0x{}", "00".repeat(32));
        return Ok(Json(paper_mode_bypass_response(
            intent_hash,
            execution_hash,
            parsed.deadline,
        )));
    }
    let intent_hash = hash_intent(&parsed.intent);

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
    )
    .await
    .ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Could not build execution context for validator signing".to_string(),
        )
    })?;

    // Real validation: fan out to validator endpoints
    let client = ValidatorClient::new(validator_endpoints, state.min_validator_score);
    let result = client
        .validate_with_context(
            &parsed.intent,
            &bot.vault_address,
            parsed.deadline,
            Some(execution_context),
        )
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(build_validate_response(
        &result,
        parsed.deadline,
        bot.paper_trade,
    )))
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
        )
        .await;
        assert!(result.is_none());
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
            normalize_protocol_token("morpho", Some(1), ZERO_ADDRESS),
            MAINNET_WETH_ADDRESS
        );
        assert_eq!(
            normalize_protocol_token("uniswap_v3", Some(31339), ZERO_ADDRESS),
            ZERO_ADDRESS
        );
    }
}
