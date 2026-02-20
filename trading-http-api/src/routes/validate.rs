use axum::{Router, routing::post, extract::State, Json};
use axum::extract::Request;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::{TradingApiState, MultiBotTradingState};
use trading_runtime::{Action, TradeIntentBuilder};
use trading_runtime::intent::hash_intent;
#[allow(unused_imports)]
use trading_runtime::validator_client::ValidatorClient;

#[derive(Deserialize)]
pub struct ValidateRequest {
    pub strategy_id: String,
    pub action: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub min_amount_out: String,
    pub target_protocol: String,
    #[serde(default = "default_deadline")]
    pub deadline_secs: u64,
}

fn default_deadline() -> u64 { 300 }

#[derive(Serialize)]
pub struct ValidateResponse {
    pub approved: bool,
    pub aggregate_score: u32,
    pub intent_hash: String,
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
        other => Err(format!("Unknown action: {other}")),
    }
}

async fn validate(
    State(state): State<Arc<TradingApiState>>,
    Json(request): Json<ValidateRequest>,
) -> Result<Json<ValidateResponse>, (axum::http::StatusCode, String)> {
    let action = parse_action(&request.action)
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;

    let amount_in: rust_decimal::Decimal = request.amount_in.parse()
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, format!("Invalid amount_in: {e}")))?;
    let min_amount_out: rust_decimal::Decimal = request.min_amount_out.parse()
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, format!("Invalid min_amount_out: {e}")))?;

    let intent = TradeIntentBuilder::new()
        .strategy_id(&request.strategy_id)
        .action(action)
        .token_in(&request.token_in)
        .token_out(&request.token_out)
        .amount_in(amount_in)
        .min_amount_out(min_amount_out)
        .target_protocol(&request.target_protocol)
        .build()
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e.to_string()))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let deadline = now + request.deadline_secs;

    let result = state.validator_client.validate(&intent, &state.vault_address, deadline).await
        .map_err(|e| (axum::http::StatusCode::BAD_GATEWAY, e.to_string()))?;

    let responses = result.validator_responses.iter().map(|r| ValidatorResponseEntry {
        validator: r.validator.clone(),
        score: r.score,
        reasoning: r.reasoning.clone(),
        signature: r.signature.clone(),
        chain_id: r.chain_id,
        verifying_contract: r.verifying_contract.clone(),
        validated_at: r.validated_at.clone(),
    }).collect();

    Ok(Json(ValidateResponse {
        approved: result.approved,
        aggregate_score: result.aggregate_score,
        intent_hash: result.intent_hash.clone(),
        deadline,
        validator_responses: responses,
    }))
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
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Bot not resolved".into()))?;

    let body = axum::body::to_bytes(request.into_body(), 1024 * 64)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Body read failed: {e}")))?;
    let req: ValidateRequest = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}")))?;

    let action = parse_action(&req.action)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let amount_in: rust_decimal::Decimal = req.amount_in.parse()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid amount_in: {e}")))?;
    let min_amount_out: rust_decimal::Decimal = req.min_amount_out.parse()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid min_amount_out: {e}")))?;

    let intent = TradeIntentBuilder::new()
        .strategy_id(&req.strategy_id)
        .action(action)
        .token_in(&req.token_in)
        .token_out(&req.token_out)
        .amount_in(amount_in)
        .min_amount_out(min_amount_out)
        .target_protocol(&req.target_protocol)
        .build()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let deadline = now + req.deadline_secs;

    // Use validator endpoints from the bot context
    let validator_endpoints = bot.validator_endpoints.clone();

    // Paper-trade bypass: if no validators configured and bot is in paper mode,
    // return synthetic approval so the trading loop can proceed.
    if bot.paper_trade && validator_endpoints.is_empty() {
        let intent_hash = hash_intent(&intent);
        return Ok(Json(ValidateResponse {
            approved: true,
            aggregate_score: 100,
            intent_hash,
            deadline,
            validator_responses: vec![ValidatorResponseEntry {
                validator: "paper-mode".into(),
                score: 100,
                reasoning: "Paper trade mode — validation bypassed".into(),
                signature: format!("0x{}", "00".repeat(65)),
                chain_id: None,
                verifying_contract: None,
                validated_at: Some(chrono::Utc::now().to_rfc3339()),
            }],
        }));
    }

    // Real validation: fan out to validator endpoints
    let client = ValidatorClient::new(validator_endpoints, state.min_validator_score);
    let result = client.validate(&intent, &bot.vault_address, deadline).await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let responses = result.validator_responses.iter().map(|r| ValidatorResponseEntry {
        validator: r.validator.clone(),
        score: r.score,
        reasoning: r.reasoning.clone(),
        signature: r.signature.clone(),
        chain_id: r.chain_id,
        verifying_contract: r.verifying_contract.clone(),
        validated_at: r.validated_at.clone(),
    }).collect();

    Ok(Json(ValidateResponse {
        approved: result.approved,
        aggregate_score: result.aggregate_score,
        intent_hash: result.intent_hash.clone(),
        deadline,
        validator_responses: responses,
    }))
}
