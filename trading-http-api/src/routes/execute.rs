use axum::{Router, routing::post, extract::State, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::TradingApiState;
use trading_runtime::{TradeIntentBuilder, ValidationResult, ValidatorResponse};

use super::validate::parse_action;

#[derive(Deserialize)]
pub struct ExecuteRequest {
    pub intent: IntentPayload,
    pub validation: ValidationPayload,
}

#[derive(Deserialize)]
pub struct IntentPayload {
    pub strategy_id: String,
    pub action: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub min_amount_out: String,
    pub target_protocol: String,
}

#[derive(Deserialize)]
pub struct ValidationPayload {
    pub approved: bool,
    pub aggregate_score: u32,
    pub intent_hash: String,
    pub validator_responses: Vec<ValidatorResponsePayload>,
}

#[derive(Deserialize)]
pub struct ValidatorResponsePayload {
    pub validator: String,
    pub score: u32,
    pub reasoning: String,
    pub signature: String,
}

#[derive(Serialize)]
pub struct ExecuteResponse {
    pub tx_hash: String,
    pub block_number: Option<u64>,
    pub gas_used: Option<String>,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/execute", post(execute))
}

async fn execute(
    State(state): State<Arc<TradingApiState>>,
    Json(request): Json<ExecuteRequest>,
) -> Result<Json<ExecuteResponse>, (axum::http::StatusCode, String)> {
    if !request.validation.approved {
        return Err((axum::http::StatusCode::BAD_REQUEST, "Validation not approved".into()));
    }

    let action = parse_action(&request.intent.action)
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;

    let amount_in: rust_decimal::Decimal = request.intent.amount_in.parse()
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, format!("Invalid amount_in: {e}")))?;
    let min_amount_out: rust_decimal::Decimal = request.intent.min_amount_out.parse()
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, format!("Invalid min_amount_out: {e}")))?;

    let intent = TradeIntentBuilder::new()
        .strategy_id(&request.intent.strategy_id)
        .action(action)
        .token_in(&request.intent.token_in)
        .token_out(&request.intent.token_out)
        .amount_in(amount_in)
        .min_amount_out(min_amount_out)
        .target_protocol(&request.intent.target_protocol)
        .build()
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e.to_string()))?;

    let validation = ValidationResult {
        approved: request.validation.approved,
        aggregate_score: request.validation.aggregate_score,
        intent_hash: request.validation.intent_hash,
        validator_responses: request.validation.validator_responses.into_iter().map(|r| {
            ValidatorResponse {
                validator: r.validator,
                score: r.score,
                reasoning: r.reasoning,
                signature: r.signature,
            }
        }).collect(),
    };

    let outcome = state.executor.execute_validated_trade(&intent, &validation).await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ExecuteResponse {
        tx_hash: outcome.tx_hash,
        block_number: outcome.block_number,
        gas_used: outcome.gas_used.map(|g| g.to_string()),
    }))
}
