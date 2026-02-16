use axum::{Router, routing::post, extract::State, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::TradingApiState;
use crate::trade_store::{self, TradeRecord, StoredValidation, StoredValidatorResponse};
use trading_runtime::{TradeIntentBuilder, ValidationResult, ValidatorResponse};

use super::validate::parse_action;

#[derive(Deserialize, Serialize, Clone)]
pub struct ExecuteRequest {
    pub intent: IntentPayload,
    pub validation: ValidationPayload,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct IntentPayload {
    pub strategy_id: String,
    pub action: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub min_amount_out: String,
    pub target_protocol: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ValidationPayload {
    pub approved: bool,
    pub aggregate_score: u32,
    pub intent_hash: String,
    pub validator_responses: Vec<ValidatorResponsePayload>,
}

#[derive(Deserialize, Serialize, Clone)]
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
    pub paper_trade: bool,
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

    // Build intent to validate encoding works regardless of paper mode
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
        intent_hash: request.validation.intent_hash.clone(),
        validator_responses: request.validation.validator_responses.iter().map(|r| {
            ValidatorResponse {
                validator: r.validator.clone(),
                score: r.score,
                reasoning: r.reasoning.clone(),
                signature: r.signature.clone(),
            }
        }).collect(),
    };

    let stored_validation = StoredValidation {
        approved: request.validation.approved,
        aggregate_score: request.validation.aggregate_score,
        intent_hash: request.validation.intent_hash.clone(),
        responses: request.validation.validator_responses.iter().map(|r| {
            StoredValidatorResponse {
                validator: r.validator.clone(),
                score: r.score,
                reasoning: r.reasoning.clone(),
                signature: r.signature.clone(),
            }
        }).collect(),
    };

    // Paper trade mode: log the trade without on-chain execution
    if state.paper_trade {
        let mock_tx_hash = format!("0xpaper_{}", uuid::Uuid::new_v4());
        let trade_id = uuid::Uuid::new_v4().to_string();

        tracing::info!(
            bot_id = %state.bot_id,
            tx_hash = %mock_tx_hash,
            action = %request.intent.action,
            token_in = %request.intent.token_in,
            amount_in = %request.intent.amount_in,
            "paper trade executed"
        );

        let record = TradeRecord {
            id: trade_id,
            bot_id: state.bot_id.clone(),
            timestamp: Utc::now(),
            action: request.intent.action.clone(),
            token_in: request.intent.token_in.clone(),
            token_out: request.intent.token_out.clone(),
            amount_in: request.intent.amount_in.clone(),
            min_amount_out: request.intent.min_amount_out.clone(),
            target_protocol: request.intent.target_protocol.clone(),
            tx_hash: mock_tx_hash.clone(),
            block_number: Some(0),
            gas_used: Some("0".to_string()),
            paper_trade: true,
            validation: stored_validation,
        };
        if let Err(e) = trade_store::record_trade(record) {
            tracing::warn!("Failed to persist trade record: {e}");
        }

        return Ok(Json(ExecuteResponse {
            tx_hash: mock_tx_hash,
            block_number: Some(0),
            gas_used: Some("0".to_string()),
            paper_trade: true,
        }));
    }

    let outcome = state.executor.execute_validated_trade(&intent, &validation).await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let trade_id = uuid::Uuid::new_v4().to_string();
    let record = TradeRecord {
        id: trade_id,
        bot_id: state.bot_id.clone(),
        timestamp: Utc::now(),
        action: request.intent.action.clone(),
        token_in: request.intent.token_in.clone(),
        token_out: request.intent.token_out.clone(),
        amount_in: request.intent.amount_in.clone(),
        min_amount_out: request.intent.min_amount_out.clone(),
        target_protocol: request.intent.target_protocol.clone(),
        tx_hash: outcome.tx_hash.clone(),
        block_number: outcome.block_number,
        gas_used: outcome.gas_used.map(|g| g.to_string()),
        paper_trade: false,
        validation: stored_validation,
    };
    if let Err(e) = trade_store::record_trade(record) {
        tracing::warn!("Failed to persist trade record: {e}");
    }

    Ok(Json(ExecuteResponse {
        tx_hash: outcome.tx_hash,
        block_number: outcome.block_number,
        gas_used: outcome.gas_used.map(|g| g.to_string()),
        paper_trade: false,
    }))
}
