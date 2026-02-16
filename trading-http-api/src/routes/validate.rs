use axum::{Router, routing::post, extract::State, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::TradingApiState;
use trading_runtime::{Action, TradeIntentBuilder};

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
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/validate", post(validate))
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
    }).collect();

    Ok(Json(ValidateResponse {
        approved: result.approved,
        aggregate_score: result.aggregate_score,
        intent_hash: result.intent_hash.clone(),
        deadline,
        validator_responses: responses,
    }))
}
