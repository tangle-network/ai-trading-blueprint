use crate::live_portfolio::{LiveRiskInput, enforce_live_risk, max_drawdown_from_strategy_config};
use crate::routes::metrics::capture_metrics_snapshot_for_bot;
use crate::trade_store::{
    self, PredictionTradeMetadata, StoredSimulation, StoredValidation, StoredValidatorResponse,
    TradeExecutionStatus, TradeRecord,
};
use crate::{MultiBotTradingState, TradingApiState};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::{Json, Router, extract::State, routing::post};
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use rust_decimal::Decimal;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;
use trading_runtime::adapters::ActionParams;
use trading_runtime::execution_hash::{
    ACTION_KIND_CLOB_ORDER, ACTION_KIND_HYPERLIQUID_ORDER, ACTION_KIND_VAULT_EXECUTE, format_b256,
    hash_clob_order, hash_execution_payload, hash_hyperliquid_order,
};
use trading_runtime::executor::{TradeExecutor, get_adapter};
use trading_runtime::hyperliquid::{AssetId, HlOrderType, PlaceOrderRequest};
use trading_runtime::intent::hash_intent;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::polymarket_clob::{self, ClobClient, OrderBook, PriceLevel, Side};
use trading_runtime::signed_envelope::{EnvelopeBinding, SignedTradingEnvelope};
use trading_runtime::token_metadata::{
    address_chain_mismatch, chain_display_name, known_token_decimals,
};
use trading_runtime::{
    PortfolioState, Position, PositionType, TradeIntent, TradeIntentBuilder, ValidationResult,
    ValidatorResponse, ValuationStatus,
};

use super::validate::{
    PAPER_MODE_VALIDATOR, has_usable_validator_signature, normalize_protocol_token, parse_action,
    strategy_type_from_config, validate_supported_trade_assets,
};

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
    /// Explicitly marks DEX amounts as raw token base units instead of
    /// human-readable decimals. When omitted, the server falls back to a
    /// conservative address-only heuristic for backward compatibility.
    #[serde(default)]
    pub amount_format: Option<AmountFormat>,
    /// Extra protocol-specific parameters (e.g., token_id and price for CLOB orders).
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AmountFormat {
    Human,
    BaseUnits,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ValidationPayload {
    pub approved: bool,
    pub aggregate_score: u32,
    pub intent_hash: String,
    #[serde(default = "default_zero_hash")]
    pub execution_hash: String,
    #[serde(default)]
    pub deadline: Option<u64>,
    pub validator_responses: Vec<ValidatorResponsePayload>,
    #[serde(default)]
    pub simulation: Option<SimulationPayload>,
}

fn default_zero_hash() -> String {
    format!("0x{}", "00".repeat(32))
}

#[derive(Deserialize, Serialize, Clone, Default)]
pub struct SimulationPayload {
    pub success: bool,
    pub gas_used: u64,
    pub risk_score: u32,
    pub warnings: Vec<String>,
    pub output_amount: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ValidatorResponsePayload {
    pub validator: String,
    pub score: u32,
    pub reasoning: String,
    pub signature: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    #[serde(default)]
    pub verifying_contract: Option<String>,
    #[serde(default)]
    pub validated_at: Option<String>,
}

#[derive(Serialize)]
pub struct ExecuteResponse {
    pub tx_hash: String,
    pub block_number: Option<u64>,
    pub gas_used: Option<String>,
    pub paper_trade: bool,
    /// CLOB order ID (set only for polymarket_clob trades).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clob_order_id: Option<String>,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/execute", post(execute))
}

/// Router for multi-bot mode (state = MultiBotTradingState, bot resolved from extensions).
pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/execute", post(execute_multi_bot))
}

// ── Intent hash deduplication ────────────────────────────────────────────────

/// Time-to-live for dedup entries: 24 hours.
const DEDUP_TTL_SECS: i64 = 24 * 3600;

/// In-memory + disk-backed intent dedup store. Entries expire after 24h.
///
/// Fail-closed: if the mutex is poisoned, treat as duplicate (block execution)
/// rather than allowing unlimited replay.
struct IntentDedupStore {
    /// In-memory cache: hash → execution timestamp. Authority for current process.
    memory: HashMap<String, DateTime<Utc>>,
    /// Disk-backed store for crash recovery.
    disk: Option<PersistentStore<DedupEntry>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DedupEntry {
    intent_hash: String,
    executed_at: DateTime<Utc>,
}

static EXECUTED_INTENTS: Lazy<Mutex<IntentDedupStore>> = Lazy::new(|| {
    let mut memory = HashMap::new();

    // Load from disk on startup.
    let disk = (|| {
        let path = sandbox_runtime::store::state_dir().join("intent-dedup.json");
        let store = PersistentStore::<DedupEntry>::open(path).ok()?;
        let now = Utc::now();

        // Populate memory from disk, skipping expired entries.
        if let Ok(values) = store.values() {
            for entry in values {
                let age = (now - entry.executed_at).num_seconds();
                if age < DEDUP_TTL_SECS {
                    memory.insert(entry.intent_hash.clone(), entry.executed_at);
                }
            }
        }

        tracing::info!(loaded = memory.len(), "Intent dedup store loaded from disk");
        Some(store)
    })();

    Mutex::new(IntentDedupStore { memory, disk })
});

/// Check if an intent hash has already been executed. If not, insert it.
/// Returns `true` if the intent was already present (duplicate).
///
/// Fail-closed: mutex poison → returns `true` (blocks execution).
pub(crate) fn check_and_insert_intent(intent_hash: &str) -> bool {
    let Ok(mut guard) = EXECUTED_INTENTS.lock() else {
        // Fail-closed: poisoned mutex → treat as duplicate to prevent replay.
        tracing::error!("Intent dedup mutex poisoned — blocking execution for safety");
        return true;
    };

    let now = Utc::now();

    // Expire old entries (lazy cleanup on each check).
    guard
        .memory
        .retain(|_, ts| (now - *ts).num_seconds() < DEDUP_TTL_SECS);

    if guard.memory.contains_key(intent_hash) {
        return true;
    }

    // Insert into memory.
    guard.memory.insert(intent_hash.to_string(), now);

    // Persist to disk (best-effort — memory is the authority).
    if let Some(ref store) = guard.disk {
        let entry = DedupEntry {
            intent_hash: intent_hash.to_string(),
            executed_at: now,
        };
        if let Err(e) = store.insert(format!("dedup:{intent_hash}"), entry) {
            tracing::warn!("Failed to persist dedup entry to disk: {e}");
        }
    }

    false
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/// Build a `StoredValidation` from a `ValidationPayload`.
fn build_stored_validation(v: &ValidationPayload) -> StoredValidation {
    StoredValidation {
        approved: v.approved,
        aggregate_score: v.aggregate_score,
        intent_hash: v.intent_hash.clone(),
        responses: v
            .validator_responses
            .iter()
            .map(|r| StoredValidatorResponse {
                validator: r.validator.clone(),
                score: r.score,
                reasoning: r.reasoning.clone(),
                signature: r.signature.clone(),
                chain_id: r.chain_id,
                verifying_contract: r.verifying_contract.clone(),
                validated_at: r.validated_at.clone(),
            })
            .collect(),
        simulation: v.simulation.as_ref().map(|s| StoredSimulation {
            success: s.success,
            gas_used: s.gas_used,
            risk_score: s.risk_score,
            warnings: s.warnings.clone(),
            output_amount: s.output_amount.clone(),
        }),
    }
}

fn is_explicit_paper_validation_bypass(validation: &ValidationPayload) -> bool {
    matches!(
        validation.validator_responses.as_slice(),
        [response] if response.validator == PAPER_MODE_VALIDATOR
    )
}

fn ensure_paper_validation_consistency(
    validation: &ValidationPayload,
) -> Result<(), (StatusCode, String)> {
    if !validation.approved || is_explicit_paper_validation_bypass(validation) {
        return Ok(());
    }

    let has_usable_signature = validation
        .validator_responses
        .iter()
        .any(|response| has_usable_validator_signature(&response.signature));

    if has_usable_signature {
        return Ok(());
    }

    Err((
        StatusCode::BAD_REQUEST,
        "Paper trade approval requires at least one usable validator signature or explicit paper-mode bypass".into(),
    ))
}

/// Build a `ValidationResult` (runtime type) from a `ValidationPayload`.
fn build_validation_result(v: &ValidationPayload) -> ValidationResult {
    ValidationResult {
        approved: v.approved,
        aggregate_score: v.aggregate_score,
        intent_hash: v.intent_hash.clone(),
        execution_hash: v.execution_hash.clone(),
        validator_responses: v
            .validator_responses
            .iter()
            .map(|r| ValidatorResponse {
                validator: r.validator.clone(),
                score: r.score,
                reasoning: r.reasoning.clone(),
                signature: r.signature.clone(),
                chain_id: r.chain_id,
                verifying_contract: r.verifying_contract.clone(),
                validated_at: r.validated_at.clone(),
            })
            .collect(),
    }
}

/// Verify all validator signatures off-chain before executing a trade.
///
/// This is the **critical security gate** that prevents a compromised sidecar from
/// submitting fabricated validator signatures. On-chain verification only happens
/// for vault trades — paper trades and CLOB trades have no on-chain check, so this
/// off-chain verification is their only defense.
///
fn verify_signatures_offchain(
    validation: &ValidationPayload,
    vault_address: &str,
    action_kind: u64,
    min_aggregate_score: Option<u32>,
) -> Result<(), (StatusCode, String)> {
    if validation.validator_responses.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Live execution requires validator signatures unless signed Envelope authorization is active".into(),
        ));
    }

    let deadline = validation.deadline.unwrap_or(0);
    if deadline == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Validation deadline is required for signature verification".into(),
        ));
    }
    ensure_validation_score_binding(validation, min_aggregate_score)?;

    // Convert to runtime types for the verifier
    let responses: Vec<ValidatorResponse> = validation
        .validator_responses
        .iter()
        .map(|r| ValidatorResponse {
            validator: r.validator.clone(),
            score: r.score,
            reasoning: r.reasoning.clone(),
            signature: r.signature.clone(),
            chain_id: r.chain_id,
            verifying_contract: r.verifying_contract.clone(),
            validated_at: r.validated_at.clone(),
        })
        .collect();

    trading_runtime::signature_verify::verify_all_signatures(
        &responses,
        &validation.intent_hash,
        &validation.execution_hash,
        vault_address,
        deadline,
        action_kind,
    )
    .map_err(|e| {
        tracing::warn!(
            intent_hash = %validation.intent_hash,
            error = %e,
            "Off-chain signature verification FAILED — rejecting trade"
        );
        (
            StatusCode::UNAUTHORIZED,
            format!("Signature verification failed: {e}"),
        )
    })?;

    Ok(())
}

fn ensure_validation_score_binding(
    validation: &ValidationPayload,
    min_aggregate_score: Option<u32>,
) -> Result<(), (StatusCode, String)> {
    let mut total_score = 0u32;
    for response in &validation.validator_responses {
        if response.score > 100 {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "Validator score from {} is out of range: {}",
                    response.validator, response.score
                ),
            ));
        }
        total_score = total_score.saturating_add(response.score);
    }

    let computed = total_score
        .checked_div(validation.validator_responses.len() as u32)
        .unwrap_or(0);
    if validation.aggregate_score != computed {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Validation aggregate_score does not match signed validator scores: got {}, expected {}",
                validation.aggregate_score, computed
            ),
        ));
    }

    if let Some(min_score) = min_aggregate_score
        && computed < min_score
    {
        return Err((
            StatusCode::UNAUTHORIZED,
            format!(
                "Validation aggregate_score {} is below required {}",
                computed, min_score
            ),
        ));
    }

    Ok(())
}

/// Parse and validate the common fields of an `ExecuteRequest`.
///
/// Returns the built `TradeIntent` or an HTTP error.
fn parse_execute_request(
    req: &ExecuteRequest,
    chain_id: Option<u64>,
) -> Result<TradeIntent, (StatusCode, String)> {
    if !req.validation.approved {
        return Err((StatusCode::BAD_REQUEST, "Validation not approved".into()));
    }

    let action = parse_action(&req.intent.action).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let amount_in: rust_decimal::Decimal = req
        .intent
        .amount_in
        .parse()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid amount_in: {e}")))?;
    let min_amount_out: rust_decimal::Decimal = req.intent.min_amount_out.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid min_amount_out: {e}"),
        )
    })?;

    let token_in =
        normalize_protocol_token(&req.intent.target_protocol, chain_id, &req.intent.token_in);
    let token_out =
        normalize_protocol_token(&req.intent.target_protocol, chain_id, &req.intent.token_out);

    let mut intent = TradeIntentBuilder::new()
        .strategy_id(&req.intent.strategy_id)
        .action(action)
        .token_in(&token_in)
        .token_out(&token_out)
        .amount_in(amount_in)
        .min_amount_out(min_amount_out)
        .target_protocol(&req.intent.target_protocol)
        .chain_id(chain_id.unwrap_or(42161))
        .metadata(req.intent.metadata.clone())
        .build()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    if let Some(deadline) = req.validation.deadline {
        if deadline > i64::MAX as u64 {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("Invalid validation deadline: {deadline}"),
            ));
        }
        intent.deadline =
            chrono::DateTime::<Utc>::from_timestamp(deadline as i64, 0).ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    format!("Invalid validation deadline: {deadline}"),
                )
            })?;
    }

    Ok(intent)
}

fn normalize_intent_payload(mut intent: IntentPayload, chain_id: Option<u64>) -> IntentPayload {
    intent.token_in = normalize_protocol_token(&intent.target_protocol, chain_id, &intent.token_in);
    intent.token_out =
        normalize_protocol_token(&intent.target_protocol, chain_id, &intent.token_out);
    intent
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

fn parse_hash_hex(
    hash: &str,
    field_name: &str,
) -> Result<alloy::primitives::B256, (StatusCode, String)> {
    let bytes = hex::decode(hash.trim_start_matches("0x")).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid {field_name} hex: {e}"),
        )
    })?;
    if bytes.len() != 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("{field_name} must be 32 bytes, got {}", bytes.len()),
        ));
    }
    Ok(alloy::primitives::B256::from_slice(&bytes))
}

fn decimal_to_u256_for_hash(
    amount: &rust_decimal::Decimal,
) -> Result<alloy::primitives::U256, (StatusCode, String)> {
    let truncated = amount.trunc();
    if truncated.is_sign_negative() {
        return Err((StatusCode::BAD_REQUEST, "Amount cannot be negative".into()));
    }
    alloy::primitives::U256::from_str_radix(&truncated.to_string(), 10).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Amount is too large for execution hash: {e}"),
        )
    })
}

fn format_action(action: &trading_runtime::types::Action) -> String {
    match action {
        trading_runtime::types::Action::Swap => "swap",
        trading_runtime::types::Action::Supply => "supply",
        trading_runtime::types::Action::Withdraw => "withdraw",
        trading_runtime::types::Action::Borrow => "borrow",
        trading_runtime::types::Action::Repay => "repay",
        trading_runtime::types::Action::OpenLong => "open_long",
        trading_runtime::types::Action::OpenShort => "open_short",
        trading_runtime::types::Action::CloseLong => "close_long",
        trading_runtime::types::Action::CloseShort => "close_short",
        trading_runtime::types::Action::Buy => "buy",
        trading_runtime::types::Action::Sell => "sell",
        trading_runtime::types::Action::Redeem => "redeem",
        trading_runtime::types::Action::CollateralRelease => "collateral_release",
    }
    .to_string()
}

fn hyperliquid_order_from_intent(intent: &TradeIntent) -> PlaceOrderRequest {
    let is_buy = matches!(
        intent.action,
        trading_runtime::types::Action::OpenLong
            | trading_runtime::types::Action::Buy
            | trading_runtime::types::Action::CloseShort
    );
    let reduce_only = matches!(
        intent.action,
        trading_runtime::types::Action::CloseLong | trading_runtime::types::Action::CloseShort
    );

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

fn expected_validation_hashes(
    intent: &TradeIntent,
    vault_address: &str,
    adapter_chain_id: Option<u64>,
    execution_chain_id: u64,
    bind_execution_payload: bool,
) -> Result<(String, String), (StatusCode, String)> {
    let expected_intent_hash = hash_intent(intent);

    if !bind_execution_payload {
        return Ok((expected_intent_hash, zero_hash()));
    }

    let intent_hash = parse_hash_hex(&expected_intent_hash, "intent_hash")?;
    let deadline = alloy::primitives::U256::from(intent.deadline.timestamp().max(0) as u64);

    if intent.target_protocol == "polymarket_clob" {
        let params = polymarket_clob::extract_clob_params(
            &format_action(&intent.action),
            &intent.amount_in.to_string(),
            &intent.metadata,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        let execution_hash = hash_clob_order(&params, intent_hash, deadline, execution_chain_id);
        return Ok((expected_intent_hash, format_b256(execution_hash)));
    }

    if intent.target_protocol == "hyperliquid" {
        let order = hyperliquid_order_from_intent(intent);
        let execution_hash =
            hash_hyperliquid_order(&order, intent_hash, deadline, execution_chain_id);
        return Ok((expected_intent_hash, format_b256(execution_hash)));
    }

    let adapter = get_adapter(&intent.target_protocol, adapter_chain_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let token_in = intent.token_in.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid token_in address for execution hash: {e}"),
        )
    })?;
    let token_out = intent.token_out.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid token_out address for execution hash: {e}"),
        )
    })?;
    let vault_address = vault_address.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid vault address for execution hash: {e}"),
        )
    })?;

    let params = ActionParams {
        action: intent.action.clone(),
        token_in,
        token_out,
        amount: decimal_to_u256_for_hash(&intent.amount_in)?,
        min_output: decimal_to_u256_for_hash(&intent.min_amount_out)?,
        extra: metadata_with_execution_deadline(
            &intent.metadata,
            intent.deadline.timestamp().max(0) as u64,
        ),
        vault_address,
    };
    let encoded = adapter
        .encode_action(&params)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let execution_hash =
        hash_execution_payload(&encoded, intent_hash, deadline, execution_chain_id);

    Ok((expected_intent_hash, format_b256(execution_hash)))
}

fn ensure_validation_hash_binding(
    validation: &ValidationPayload,
    intent: &TradeIntent,
    vault_address: &str,
    adapter_chain_id: Option<u64>,
    execution_chain_id: u64,
    bind_execution_payload: bool,
) -> Result<String, (StatusCode, String)> {
    parse_hash_hex(&validation.intent_hash, "intent_hash")?;
    parse_hash_hex(&validation.execution_hash, "execution_hash")?;

    let (expected_intent_hash, expected_execution_hash) = expected_validation_hashes(
        intent,
        vault_address,
        adapter_chain_id,
        execution_chain_id,
        bind_execution_payload,
    )?;

    if !validation
        .intent_hash
        .eq_ignore_ascii_case(&expected_intent_hash)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Validation intent_hash does not match execute request: got {}, expected {}",
                validation.intent_hash, expected_intent_hash
            ),
        ));
    }

    if !validation
        .execution_hash
        .eq_ignore_ascii_case(&expected_execution_hash)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Validation execution_hash does not match execute request: got {}, expected {}",
                validation.execution_hash, expected_execution_hash
            ),
        ));
    }

    Ok(expected_intent_hash)
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

#[derive(Clone, Debug)]
struct TradeValuationSnapshot {
    amount_out: Option<Decimal>,
    position_size: Decimal,
    entry_price_usd: Option<Decimal>,
    notional_usd: Option<Decimal>,
    valuation_status: trade_store::TradeValuationStatus,
}

impl TradeValuationSnapshot {
    fn unpriced(position_size: Decimal, amount_out: Option<Decimal>) -> Self {
        Self {
            amount_out,
            position_size,
            entry_price_usd: None,
            notional_usd: None,
            valuation_status: trade_store::TradeValuationStatus::Unpriced,
        }
    }

    fn priced(
        position_size: Decimal,
        amount_out: Option<Decimal>,
        entry_price_usd: Decimal,
    ) -> Self {
        Self {
            amount_out,
            position_size,
            entry_price_usd: Some(entry_price_usd),
            notional_usd: Some(position_size * entry_price_usd),
            valuation_status: trade_store::TradeValuationStatus::Priced,
        }
    }

    fn position_valuation_status(&self) -> ValuationStatus {
        match self.valuation_status {
            trade_store::TradeValuationStatus::Priced => ValuationStatus::Priced,
            trade_store::TradeValuationStatus::Unpriced => ValuationStatus::Unpriced,
        }
    }
}

fn resolve_position_size(
    chain_id: Option<u64>,
    intent: &IntentPayload,
) -> Result<(Decimal, Option<Decimal>), (StatusCode, String)> {
    let raw_amount_in: Decimal = intent.amount_in.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid amount_in '{}': {e}", intent.amount_in),
        )
    })?;
    let raw_amount_out: Decimal = intent.min_amount_out.parse().unwrap_or(Decimal::ZERO);
    let amount_in = normalize_trade_amount(
        chain_id,
        &intent.token_in,
        raw_amount_in,
        intent.amount_format,
    );
    let amount_out = normalize_trade_amount(
        chain_id,
        &intent.token_out,
        raw_amount_out,
        intent.amount_format,
    );
    let size = if amount_out > Decimal::ZERO {
        amount_out
    } else {
        amount_in
    };
    Ok((size, (amount_out > Decimal::ZERO).then_some(amount_out)))
}

async fn resolve_market_valuation(
    market_client: &MarketDataClient,
    chain_id: Option<u64>,
    intent: &IntentPayload,
) -> Result<TradeValuationSnapshot, (StatusCode, String)> {
    if intent.action.eq_ignore_ascii_case("swap") && intent.token_in != intent.token_out {
        return resolve_swap_valuation(market_client, chain_id, intent).await;
    }

    let (position_size, amount_out) = resolve_position_size(chain_id, intent)?;
    if position_size <= Decimal::ZERO {
        return Ok(TradeValuationSnapshot::unpriced(position_size, amount_out));
    }

    match market_client
        .get_price_for_chain(chain_id, &intent.token_out)
        .await
    {
        Ok(price) => Ok(TradeValuationSnapshot::priced(
            position_size,
            amount_out,
            price.price_usd,
        )),
        Err(error) => {
            tracing::warn!(
                token = %intent.token_out,
                error = %error,
                "Trade valuation unavailable; recording unpriced trade"
            );
            Ok(TradeValuationSnapshot::unpriced(position_size, amount_out))
        }
    }
}

async fn resolve_swap_valuation(
    market_client: &MarketDataClient,
    chain_id: Option<u64>,
    intent: &IntentPayload,
) -> Result<TradeValuationSnapshot, (StatusCode, String)> {
    let raw_amount_in: Decimal = intent.amount_in.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid amount_in '{}': {e}", intent.amount_in),
        )
    })?;
    let raw_amount_out: Decimal = intent.min_amount_out.parse().unwrap_or(Decimal::ZERO);
    let amount_in = normalize_trade_amount(
        chain_id,
        &intent.token_in,
        raw_amount_in,
        intent.amount_format,
    );
    let min_amount_out = normalize_trade_amount(
        chain_id,
        &intent.token_out,
        raw_amount_out,
        intent.amount_format,
    );

    let token_out_price = market_client
        .get_price_for_chain(chain_id, &intent.token_out)
        .await
        .ok();
    let estimated_amount_out = match (
        market_client
            .get_price_for_chain(chain_id, &intent.token_in)
            .await
            .ok(),
        token_out_price.as_ref(),
    ) {
        (Some(token_in_price), Some(token_out_price))
            if amount_in > Decimal::ZERO && token_out_price.price_usd > Decimal::ZERO =>
        {
            Some((amount_in * token_in_price.price_usd) / token_out_price.price_usd)
        }
        _ => None,
    };

    let amount_out =
        estimated_amount_out.or_else(|| (min_amount_out > Decimal::ZERO).then_some(min_amount_out));
    let position_size = amount_out.unwrap_or_else(|| amount_in.max(Decimal::ZERO));
    if position_size <= Decimal::ZERO {
        return Ok(TradeValuationSnapshot::unpriced(position_size, amount_out));
    }

    match token_out_price {
        Some(token_out_price) => Ok(TradeValuationSnapshot::priced(
            position_size,
            amount_out,
            token_out_price.price_usd,
        )),
        None => {
            tracing::warn!(
                token = %intent.token_out,
                "Trade valuation unavailable; recording unpriced swap"
            );
            Ok(TradeValuationSnapshot::unpriced(position_size, amount_out))
        }
    }
}

fn normalize_trade_amount(
    chain_id: Option<u64>,
    token: &str,
    amount: Decimal,
    amount_format: Option<AmountFormat>,
) -> Decimal {
    match amount_format {
        Some(AmountFormat::Human) => return amount,
        Some(AmountFormat::BaseUnits) => {}
        None => return crate::amounts::normalize_trade_amount(chain_id, token, amount),
    };

    if amount <= Decimal::ZERO || !amount.fract().is_zero() {
        return amount;
    }

    let Some(decimals) = known_token_decimals(chain_id, token) else {
        return amount;
    };
    let scale = Decimal::from(10u64.pow(decimals as u32));
    amount / scale
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

fn resolve_clob_valuation(size: Decimal, price: Decimal) -> TradeValuationSnapshot {
    if size <= Decimal::ZERO || price <= Decimal::ZERO {
        return TradeValuationSnapshot::unpriced(size, None);
    }
    TradeValuationSnapshot::priced(size, None, price)
}

fn extract_stop_loss_distance(metadata: &serde_json::Value) -> Option<f64> {
    metadata
        .get("stop_loss_distance")
        .and_then(serde_json::Value::as_f64)
        .or_else(|| {
            metadata
                .get("stop_loss_distance_pct")
                .and_then(serde_json::Value::as_f64)
                .map(|value| value / 100.0)
        })
        .or_else(|| {
            metadata
                .get("stop_loss_pct")
                .and_then(serde_json::Value::as_f64)
                .map(|value| value / 100.0)
        })
}

fn current_hyperliquid_exposure_usd(
    account: &trading_runtime::hyperliquid::AccountInfo,
) -> Result<f64, (StatusCode, String)> {
    let total = account.total_ntl_pos.trim().parse::<f64>().map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!(
                "HL account total_ntl_pos '{}' is not numeric: {e}",
                account.total_ntl_pos
            ),
        )
    })?;
    Ok(total.abs())
}

#[derive(Clone, Debug)]
struct PaperClobFill {
    filled_size: Decimal,
    average_price: Option<Decimal>,
    status: TradeExecutionStatus,
}

impl PaperClobFill {
    fn valuation(&self) -> Option<TradeValuationSnapshot> {
        match (self.filled_size > Decimal::ZERO, self.average_price) {
            (true, Some(price)) => Some(resolve_clob_valuation(self.filled_size, price)),
            _ => None,
        }
    }

    fn fill_reason(&self) -> String {
        match self.status {
            TradeExecutionStatus::Filled => {
                "Paper CLOB trade fully filled against live Polymarket book".to_string()
            }
            TradeExecutionStatus::Partial => {
                "Paper CLOB trade partially filled against live Polymarket book".to_string()
            }
            TradeExecutionStatus::NoFill => {
                "Paper CLOB trade did not cross available live Polymarket book liquidity"
                    .to_string()
            }
            _ => "Paper CLOB trade simulated against live Polymarket book".to_string(),
        }
    }
}

struct PaperClobExecution {
    response: Json<ExecuteResponse>,
    fill_valuation: Option<TradeValuationSnapshot>,
}

fn clob_inventory_trade_size(trade: &TradeRecord) -> Option<Decimal> {
    match trade.execution_status {
        Some(TradeExecutionStatus::Filled)
        | Some(TradeExecutionStatus::Partial)
        | Some(TradeExecutionStatus::Paper)
        | Some(TradeExecutionStatus::Confirmed)
        | None => {}
        Some(TradeExecutionStatus::Submitted) | Some(TradeExecutionStatus::NoFill) => {
            return None;
        }
    }

    trade
        .filled_amount
        .as_deref()
        .or(trade.amount_out.as_deref())
        .and_then(|value| value.parse::<Decimal>().ok())
}

fn clob_trade_matches_token(trade: &TradeRecord, token_id: &str) -> bool {
    let target = token_id.trim().to_ascii_lowercase();
    let token_out = trade.token_out.trim().to_ascii_lowercase();
    let metadata_token = trade
        .prediction_metadata
        .as_ref()
        .and_then(|metadata| metadata.token_id.as_deref())
        .map(|value| value.trim().to_ascii_lowercase());

    token_out == target || metadata_token.as_deref() == Some(target.as_str())
}

fn clob_outcome_inventory(bot_id: &str, token_id: &str) -> Result<Decimal, String> {
    let trades = trade_store::trades_for_bot(bot_id, 10_000, 0)?.trades;
    let mut inventory = Decimal::ZERO;

    for trade in trades {
        if !matches!(
            trade.target_protocol.trim().to_ascii_lowercase().as_str(),
            "polymarket_clob" | "polymarket"
        ) || !clob_trade_matches_token(&trade, token_id)
        {
            continue;
        }

        let Some(size) = clob_inventory_trade_size(&trade) else {
            continue;
        };

        match trade.action.trim().to_ascii_lowercase().as_str() {
            "buy" => inventory += size,
            "sell" => inventory -= size,
            _ => {}
        }
    }

    Ok(inventory.max(Decimal::ZERO))
}

fn ensure_clob_sell_inventory(
    bot_id: &str,
    params: &polymarket_clob::ClobOrderParams,
) -> Result<(), (StatusCode, String)> {
    if params.side != Side::Sell {
        return Ok(());
    }

    let held = clob_outcome_inventory(bot_id, &params.token_id).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not verify CLOB outcome inventory before sell: {error}"),
        )
    })?;

    if held < params.size {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Cannot sell {} shares of outcome token {}: only {} held. Sell only reduces an existing outcome position; buy the opposite side or skip when you hold none.",
                params.size, params.token_id, held
            ),
        ));
    }

    Ok(())
}

fn parse_book_level(level: &PriceLevel) -> Option<(Decimal, Decimal)> {
    let price = level.price.parse::<Decimal>().ok()?;
    let size = level.size.parse::<Decimal>().ok()?;
    (price > Decimal::ZERO && size > Decimal::ZERO).then_some((price, size))
}

fn simulate_clob_fill(
    params: &polymarket_clob::ClobOrderParams,
    book: &OrderBook,
) -> PaperClobFill {
    let mut levels: Vec<(Decimal, Decimal)> = match params.side {
        Side::Buy => book.asks.iter().filter_map(parse_book_level).collect(),
        Side::Sell => book.bids.iter().filter_map(parse_book_level).collect(),
    };

    match params.side {
        Side::Buy => levels.sort_by(|a, b| a.0.cmp(&b.0)),
        Side::Sell => levels.sort_by(|a, b| b.0.cmp(&a.0)),
    }

    let mut remaining = params.size;
    let mut filled_size = Decimal::ZERO;
    let mut notional = Decimal::ZERO;

    for (price, available) in levels {
        let crosses = match params.side {
            Side::Buy => price <= params.price,
            Side::Sell => price >= params.price,
        };
        if !crosses || remaining <= Decimal::ZERO {
            break;
        }

        let fill_size = available.min(remaining);
        filled_size += fill_size;
        notional += fill_size * price;
        remaining -= fill_size;
    }

    if params.order_type == polymarket_clob::OrderType::Fok && filled_size < params.size {
        filled_size = Decimal::ZERO;
        notional = Decimal::ZERO;
    }

    let average_price = (filled_size > Decimal::ZERO).then(|| notional / filled_size);
    let status = if filled_size >= params.size && params.size > Decimal::ZERO {
        TradeExecutionStatus::Filled
    } else if filled_size > Decimal::ZERO {
        TradeExecutionStatus::Partial
    } else {
        TradeExecutionStatus::NoFill
    };

    PaperClobFill {
        filled_size,
        average_price,
        status,
    }
}

fn clob_slippage_bps(limit_price: Decimal, average_price: Option<Decimal>) -> Option<String> {
    if limit_price <= Decimal::ZERO {
        return None;
    }
    let average_price = average_price?;
    Some(
        (((average_price - limit_price).abs() / limit_price) * Decimal::from(10_000u64))
            .to_string(),
    )
}

fn metadata_decimal_string(metadata: &serde_json::Value, key: &str) -> Option<String> {
    match metadata.get(key) {
        Some(serde_json::Value::Number(value)) => Some(value.to_string()),
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        _ => None,
    }
}

fn metadata_string(metadata: &serde_json::Value, key: &str) -> Option<String> {
    match metadata.get(key) {
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        _ => None,
    }
}

fn metadata_u8(metadata: &serde_json::Value, key: &str) -> Option<u8> {
    match metadata.get(key) {
        Some(serde_json::Value::Number(value)) => {
            value.as_u64().and_then(|value| u8::try_from(value).ok())
        }
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => {
            value.parse::<u8>().ok()
        }
        _ => None,
    }
}

fn extract_prediction_metadata(intent: &IntentPayload) -> Option<PredictionTradeMetadata> {
    if intent.target_protocol != "polymarket_clob" {
        return None;
    }

    let condition_id = metadata_string(&intent.metadata, "condition_id");
    let token_id = metadata_string(&intent.metadata, "token_id")
        .or_else(|| (!intent.token_out.trim().is_empty()).then_some(intent.token_out.clone()));
    let market_question = metadata_string(&intent.metadata, "market_question");
    let outcome_label = metadata_string(&intent.metadata, "outcome_label")
        .or_else(|| metadata_string(&intent.metadata, "outcome"));
    let outcome_index = metadata_u8(&intent.metadata, "outcome_index");
    let market_slug = metadata_string(&intent.metadata, "market_slug");

    if condition_id.is_none()
        && token_id.is_none()
        && market_question.is_none()
        && outcome_label.is_none()
        && outcome_index.is_none()
        && market_slug.is_none()
    {
        return None;
    }

    Some(PredictionTradeMetadata {
        condition_id,
        token_id,
        market_question,
        outcome_label,
        outcome_index,
        market_slug,
    })
}

/// Check if the portfolio circuit breaker should block this trade.
///
/// Reads the current portfolio state and checks max drawdown against the
/// configured threshold. Returns an error if the circuit breaker is tripped.
async fn check_circuit_breaker(
    portfolio: &RwLock<PortfolioState>,
    max_drawdown_pct: Decimal,
) -> Result<(), (StatusCode, String)> {
    let state = portfolio.read().await;
    if state.should_circuit_break(max_drawdown_pct) {
        tracing::warn!(
            max_drawdown_pct = %state.max_drawdown_pct,
            threshold = %max_drawdown_pct,
            "Circuit breaker triggered — blocking trade execution"
        );
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Circuit breaker: drawdown {:.1}% exceeds {:.1}% threshold",
                state.max_drawdown_pct, max_drawdown_pct
            ),
        ));
    }
    Ok(())
}

async fn enforce_hyperliquid_live_risk(
    state: &MultiBotTradingState,
    bot: &crate::BotContext,
    max_drawdown_pct: Decimal,
) -> Result<(), (StatusCode, String)> {
    let client = super::hyperliquid::get_hl_client(state)?;
    let account = client.get_account().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid account refresh failed: {e}"),
        )
    })?;
    let account_value = account.account_value.parse::<Decimal>().map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid account value is invalid: {e}"),
        )
    })?;
    let previous = crate::metrics_store::latest_snapshot_for_bot(&bot.bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let baseline = decimal_strategy_value(&bot.strategy_config, "initial_capital_usd")
        .or_else(|| decimal_strategy_value(&bot.strategy_config, "initial_capital"))
        .or_else(|| decimal_strategy_value(&bot.strategy_config, "cash_balance"))
        .unwrap_or(account_value);
    let previous_hwm = previous
        .as_ref()
        .and_then(|snapshot| snapshot.high_water_mark.parse::<Decimal>().ok())
        .unwrap_or(baseline.max(account_value));
    let high_water_mark = previous_hwm.max(account_value).max(baseline);
    let drawdown_pct = if high_water_mark > Decimal::ZERO {
        ((high_water_mark - account_value) / high_water_mark) * Decimal::new(100, 0)
    } else {
        Decimal::ZERO
    };
    if drawdown_pct >= max_drawdown_pct {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Circuit breaker: live Hyperliquid drawdown {drawdown_pct}% exceeds {max_drawdown_pct}% threshold"
            ),
        ));
    }
    Ok(())
}

async fn enforce_clob_live_reconciliation(clob: &ClobClient) -> Result<(), (StatusCode, String)> {
    clob.get_open_orders(None, None).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Polymarket CLOB state refresh failed: {e}"),
        )
    })?;
    Ok(())
}

fn decimal_strategy_value(strategy_config: &serde_json::Value, key: &str) -> Option<Decimal> {
    strategy_config.get(key).and_then(|value| match value {
        serde_json::Value::Number(number) => number.to_string().parse().ok(),
        serde_json::Value::String(raw) => raw.parse().ok(),
        _ => None,
    })
}

/// Update portfolio state after a successful trade.
///
/// For buy/open actions: adds a position.
/// For sell/close actions: closes the position and realizes P&L.
async fn update_portfolio_after_trade(
    portfolio: &RwLock<PortfolioState>,
    req: &ExecuteRequest,
    valuation: &TradeValuationSnapshot,
) {
    let action_str = req.intent.action.to_lowercase();
    let is_close = matches!(
        action_str.as_str(),
        "sell" | "close_long" | "close_short" | "withdraw" | "repay" | "redeem"
    );

    let mut state = portfolio.write().await;

    if is_close {
        // Try to close an existing position.
        if let Some(result) =
            state.close_position(&req.intent.token_out, &req.intent.target_protocol)
        {
            tracing::info!(
                token = %req.intent.token_out,
                protocol = %req.intent.target_protocol,
                realized_pnl = ?result.realized_pnl,
                "Position closed in portfolio"
            );
        }
    } else {
        // Determine position type from protocol + action.
        let position_type = match (req.intent.target_protocol.as_str(), action_str.as_str()) {
            ("polymarket_clob", _) | ("polymarket", _) => PositionType::ConditionalToken,
            (_, "open_long") => PositionType::LongPerp,
            (_, "open_short") => PositionType::ShortPerp,
            (_, "supply") => PositionType::Lending,
            (_, "borrow") => PositionType::Borrowing,
            _ => PositionType::Spot,
        };

        state.add_position(Position {
            token: req.intent.token_out.clone(),
            amount: valuation.position_size,
            entry_price: valuation.entry_price_usd,
            current_price: valuation.entry_price_usd,
            unrealized_pnl: valuation.entry_price_usd.map(|_| Decimal::ZERO),
            protocol: req.intent.target_protocol.clone(),
            position_type,
            valuation_status: valuation.position_valuation_status(),
        });

        tracing::info!(
            token = %req.intent.token_out,
            protocol = %req.intent.target_protocol,
            size = %valuation.position_size,
            entry_price = ?valuation.entry_price_usd,
            valuation_status = ?valuation.valuation_status,
            "Position added to portfolio"
        );
    }
}

/// Execute a paper trade: log it without on-chain execution.
async fn execute_paper_trade(
    bot_id: &str,
    req: &ExecuteRequest,
    stored_validation: StoredValidation,
    valuation: &TradeValuationSnapshot,
) -> Result<Json<ExecuteResponse>, (StatusCode, String)> {
    let mock_tx_hash = format!("0xpaper_{}", uuid::Uuid::new_v4());
    let trade_id = uuid::Uuid::new_v4().to_string();

    tracing::info!(
        bot_id = %bot_id,
        tx_hash = %mock_tx_hash,
        action = %req.intent.action,
        token_in = %req.intent.token_in,
        amount_in = %req.intent.amount_in,
        "paper trade executed"
    );

    let record = TradeRecord {
        id: trade_id,
        bot_id: bot_id.to_string(),
        timestamp: Utc::now(),
        action: req.intent.action.clone(),
        token_in: req.intent.token_in.clone(),
        token_out: req.intent.token_out.clone(),
        amount_in: req.intent.amount_in.clone(),
        min_amount_out: req.intent.min_amount_out.clone(),
        target_protocol: req.intent.target_protocol.clone(),
        tx_hash: mock_tx_hash.clone(),
        block_number: Some(0),
        gas_used: Some("0".to_string()),
        paper_trade: true,
        execution_status: Some(TradeExecutionStatus::Paper),
        clob_order_id: None,
        amount_out: valuation.amount_out.map(|value| value.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|value| value.to_string()),
        notional_usd: valuation.notional_usd.map(|value| value.to_string()),
        requested_price_usd: metadata_decimal_string(&req.intent.metadata, "price"),
        filled_price_usd: None,
        filled_amount: None,
        slippage_bps: None,
        execution_reason: Some(
            "Paper trade recorded without live execution reconciliation".to_string(),
        ),
        prediction_metadata: extract_prediction_metadata(&req.intent),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    };
    trade_store::record_trade(record).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Paper trade logged but persistence failed: {e}"),
        )
    })?;

    Ok(Json(ExecuteResponse {
        tx_hash: mock_tx_hash,
        block_number: Some(0),
        gas_used: Some("0".to_string()),
        paper_trade: true,
        clob_order_id: None,
    }))
}

/// Execute a paper Polymarket CLOB trade by simulating the order against the
/// current live book instead of posting a signed order.
async fn execute_paper_clob_trade(
    bot_id: &str,
    clob: &ClobClient,
    req: &ExecuteRequest,
    stored_validation: StoredValidation,
) -> Result<PaperClobExecution, (StatusCode, String)> {
    let params = polymarket_clob::extract_clob_params(
        &req.intent.action,
        &req.intent.amount_in,
        &req.intent.metadata,
    )
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let book = clob
        .get_book(&params.token_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    let fill = simulate_clob_fill(&params, &book);
    let fill_valuation = fill.valuation();
    let valuation = fill_valuation
        .clone()
        .unwrap_or_else(|| resolve_clob_valuation(params.size, params.price));
    let mock_tx_hash = format!("paper-clob:{}", uuid::Uuid::new_v4());
    let trade_id = uuid::Uuid::new_v4().to_string();

    tracing::info!(
        bot_id = %bot_id,
        tx_hash = %mock_tx_hash,
        token_id = %params.token_id,
        side = ?params.side,
        limit_price = %params.price,
        requested_size = %params.size,
        filled_size = %fill.filled_size,
        fill_status = ?fill.status,
        "paper CLOB trade simulated"
    );

    let record = TradeRecord {
        id: trade_id,
        bot_id: bot_id.to_string(),
        timestamp: Utc::now(),
        action: req.intent.action.clone(),
        token_in: req.intent.token_in.clone(),
        token_out: req.intent.token_out.clone(),
        amount_in: req.intent.amount_in.clone(),
        min_amount_out: req.intent.min_amount_out.clone(),
        target_protocol: req.intent.target_protocol.clone(),
        tx_hash: mock_tx_hash.clone(),
        block_number: Some(0),
        gas_used: Some("0".to_string()),
        paper_trade: true,
        execution_status: Some(fill.status),
        clob_order_id: None,
        amount_out: (fill.filled_size > Decimal::ZERO).then(|| fill.filled_size.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|value| value.to_string()),
        notional_usd: valuation.notional_usd.map(|value| value.to_string()),
        requested_price_usd: Some(params.price.to_string()),
        filled_price_usd: fill.average_price.map(|value| value.to_string()),
        filled_amount: (fill.filled_size > Decimal::ZERO).then(|| fill.filled_size.to_string()),
        slippage_bps: clob_slippage_bps(params.price, fill.average_price),
        execution_reason: Some(fill.fill_reason()),
        prediction_metadata: extract_prediction_metadata(&req.intent),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: fill.average_price.map(|value| value.to_string()),
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    };
    trade_store::record_trade(record).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Paper CLOB trade logged but persistence failed: {e}"),
        )
    })?;

    Ok(PaperClobExecution {
        response: Json(ExecuteResponse {
            tx_hash: mock_tx_hash,
            block_number: Some(0),
            gas_used: Some("0".to_string()),
            paper_trade: true,
            clob_order_id: None,
        }),
        fill_valuation,
    })
}

/// Execute a real (non-paper) trade on-chain and record the result.
///
/// This is the shared core for real trade execution used by both single-bot
/// and multi-bot handlers. Includes intent hash deduplication (409 Conflict
/// for replayed intents).
async fn execute_real_trade(
    bot_id: &str,
    executor: &TradeExecutor,
    intent: &TradeIntent,
    req: &ExecuteRequest,
    stored_validation: StoredValidation,
    valuation: &TradeValuationSnapshot,
) -> Result<Json<ExecuteResponse>, (StatusCode, String)> {
    let validation = build_validation_result(&req.validation);

    let outcome = executor
        .execute_validated_trade(intent, &validation)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let trade_id = uuid::Uuid::new_v4().to_string();
    let confirmed_output_token = outcome
        .output_token
        .map(|token| format!("{token}"))
        .unwrap_or_else(|| req.intent.token_out.clone());
    let confirmed_amount_out = outcome.output_gained.map(|value| value.to_string());
    let record = TradeRecord {
        id: trade_id,
        bot_id: bot_id.to_string(),
        timestamp: Utc::now(),
        action: req.intent.action.clone(),
        token_in: req.intent.token_in.clone(),
        token_out: confirmed_output_token,
        amount_in: req.intent.amount_in.clone(),
        min_amount_out: req.intent.min_amount_out.clone(),
        target_protocol: req.intent.target_protocol.clone(),
        tx_hash: outcome.tx_hash.clone(),
        block_number: outcome.block_number,
        gas_used: outcome.gas_used.map(|g| g.to_string()),
        paper_trade: false,
        execution_status: Some(TradeExecutionStatus::Confirmed),
        clob_order_id: None,
        amount_out: confirmed_amount_out
            .clone()
            .or_else(|| valuation.amount_out.map(|value| value.to_string())),
        entry_price_usd: valuation.entry_price_usd.map(|value| value.to_string()),
        notional_usd: valuation.notional_usd.map(|value| value.to_string()),
        requested_price_usd: None,
        filled_price_usd: None,
        filled_amount: confirmed_amount_out,
        slippage_bps: None,
        execution_reason: outcome
            .output_gained
            .map(|_| "Confirmed from TradingVault execution event".to_string()),
        prediction_metadata: extract_prediction_metadata(&req.intent),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    };
    // On-chain tx already succeeded — persistence failure must NOT return 500
    // (agent would retry and potentially double-spend). Log error but return 200.
    if let Err(e) = trade_store::record_trade(record).await {
        tracing::error!(
            tx_hash = %outcome.tx_hash,
            error = %e,
            "CRITICAL: Trade executed on-chain but persistence failed — manual reconciliation needed"
        );
    }

    Ok(Json(ExecuteResponse {
        tx_hash: outcome.tx_hash,
        block_number: outcome.block_number,
        gas_used: outcome.gas_used.map(|g| g.to_string()),
        paper_trade: false,
        clob_order_id: None,
    }))
}

// ── CLOB execution (Polymarket off-chain order book) ─────────────────────────

/// Execute a trade via Polymarket's CLOB API.
///
/// This is an **operator-custodied** flow: the operator's EOA holds funds and
/// signs CLOB orders directly. Validator scoring (POST /validate) still happens
/// upstream — the validation result is stored for audit trail.
///
/// For vault-backed CLOB trading, use the collateral management endpoints:
/// `POST /collateral/release` to move vault funds to the operator EOA before
/// trading, and `POST /collateral/return` to return funds after.
async fn execute_clob_trade(
    bot_id: &str,
    clob: &ClobClient,
    req: &ExecuteRequest,
    stored_validation: StoredValidation,
    valuation: &TradeValuationSnapshot,
) -> Result<Json<ExecuteResponse>, (StatusCode, String)> {
    // Extract CLOB-specific params from intent metadata.
    let clob_params = polymarket_clob::extract_clob_params(
        &req.intent.action,
        &req.intent.amount_in,
        &req.intent.metadata,
    )
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    // Submit the order to the CLOB.
    let response = clob
        .submit_order(&clob_params)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    // Record the trade with clob: prefix on tx_hash.
    let tx_hash = format!("clob:{}", response.order_id);
    let trade_id = uuid::Uuid::new_v4().to_string();

    let record = TradeRecord {
        id: trade_id,
        bot_id: bot_id.to_string(),
        timestamp: Utc::now(),
        action: req.intent.action.clone(),
        token_in: req.intent.token_in.clone(),
        token_out: req.intent.token_out.clone(),
        amount_in: req.intent.amount_in.clone(),
        min_amount_out: req.intent.min_amount_out.clone(),
        target_protocol: req.intent.target_protocol.clone(),
        tx_hash: tx_hash.clone(),
        block_number: None,
        gas_used: None,
        paper_trade: false,
        execution_status: Some(TradeExecutionStatus::Submitted),
        clob_order_id: Some(response.order_id.clone()),
        amount_out: valuation.amount_out.map(|value| value.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|value| value.to_string()),
        notional_usd: valuation.notional_usd.map(|value| value.to_string()),
        requested_price_usd: Some(clob_params.price.to_string()),
        filled_price_usd: None,
        filled_amount: None,
        slippage_bps: None,
        execution_reason: Some(
            "Order submitted to Polymarket CLOB; fill details pending reconciliation".to_string(),
        ),
        prediction_metadata: extract_prediction_metadata(&req.intent),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    };
    // CLOB order already submitted — persistence failure must NOT return 500
    // (agent would retry and submit a duplicate order). Log and return 200.
    if let Err(e) = trade_store::record_trade(record).await {
        tracing::error!(
            order_id = %response.order_id,
            error = %e,
            "CRITICAL: CLOB order submitted but persistence failed — manual reconciliation needed"
        );
    }

    Ok(Json(ExecuteResponse {
        tx_hash,
        block_number: None,
        gas_used: None,
        paper_trade: false,
        clob_order_id: Some(response.order_id),
    }))
}

/// Execute a trade on Hyperliquid via the native L1 API.
///
/// Maps the standard `ExecuteRequest` intent fields to an `HlOrderType` and
/// dispatches through the shared `HyperliquidClient`. Trade records are stored
/// with `hl:` prefix on the tx_hash.
async fn execute_hyperliquid_trade(
    bot_id: &str,
    state: &MultiBotTradingState,
    req: &ExecuteRequest,
    stored_validation: StoredValidation,
    valuation: &TradeValuationSnapshot,
    signed_envelope: Option<&SignedTradingEnvelope>,
) -> Result<Json<ExecuteResponse>, (StatusCode, String)> {
    use trading_runtime::hyperliquid::{AssetId, HlOrderType, PlaceOrderRequest};

    let hl_client = super::hyperliquid::get_hl_client(state)?;

    // Map intent action to HL order params
    let action = parse_action(&req.intent.action)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid action: {e}")))?;

    // Signed Envelope mode replaces validator signatures for HL opens.
    let is_open = matches!(
        action,
        trading_runtime::types::Action::OpenLong
            | trading_runtime::types::Action::OpenShort
            | trading_runtime::types::Action::Buy
    );
    if is_open && let Some(signed_envelope) = signed_envelope {
        let envelope = &signed_envelope.envelope;
        let asset = req
            .intent
            .metadata
            .get("asset")
            .and_then(|v| v.as_str())
            .unwrap_or(&req.intent.token_out);
        let size_usd = valuation
            .notional_usd
            .unwrap_or(rust_decimal::Decimal::ZERO);
        let leverage: u32 = req
            .intent
            .metadata
            .get("leverage")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as u32;
        let stop_loss_distance = extract_stop_loss_distance(&req.intent.metadata).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Signed Envelope execution requires stop_loss_distance or stop_loss_pct metadata".to_string(),
            )
        })?;
        let stop_loss_check = envelope.check_stop_loss(stop_loss_distance);
        if !stop_loss_check.allowed {
            return Err((
                StatusCode::FORBIDDEN,
                format!(
                    "Trade rejected by envelope stop-loss bounds: {}",
                    stop_loss_check.reason.unwrap_or_default()
                ),
            ));
        }
        let account = hl_client.get_account().await.map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("HL account lookup failed: {e}"),
            )
        })?;
        let current_exposure = current_hyperliquid_exposure_usd(&account)?;
        let check = envelope.check_trade(
            asset,
            size_usd.try_into().unwrap_or(0.0),
            leverage,
            true,
            current_exposure,
        );
        if !check.allowed {
            return Err((
                StatusCode::FORBIDDEN,
                format!(
                    "Trade rejected by envelope: {}",
                    check.reason.unwrap_or_default()
                ),
            ));
        }
    }
    let is_buy = matches!(
        action,
        trading_runtime::types::Action::OpenLong
            | trading_runtime::types::Action::Buy
            | trading_runtime::types::Action::CloseShort
    );
    let reduce_only = matches!(
        action,
        trading_runtime::types::Action::CloseLong | trading_runtime::types::Action::CloseShort
    );

    // Determine order type from intent metadata
    let order_type = if let Some(trigger_px) = req
        .intent
        .metadata
        .get("trigger_price")
        .and_then(|v| v.as_str())
    {
        let is_market = req
            .intent
            .metadata
            .get("is_market")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let tpsl = req
            .intent
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
    } else if let Some(price) = req
        .intent
        .metadata
        .get("limit_price")
        .and_then(|v| v.as_str())
    {
        HlOrderType::Limit {
            price: price.to_string(),
        }
    } else {
        HlOrderType::Market
    };

    // Resolve asset — prefer metadata.asset, fall back to token_out symbol
    let asset = if let Some(asset_str) = req.intent.metadata.get("asset").and_then(|v| v.as_str()) {
        AssetId::Symbol(asset_str.to_string())
    } else {
        AssetId::Symbol(req.intent.token_out.clone())
    };

    let hl_req = PlaceOrderRequest {
        asset,
        is_buy,
        size: req.intent.amount_in.clone(),
        order_type,
        reduce_only,
        cloid: None,
    };

    let resp = hl_client
        .place_order(&hl_req)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    let resp_json = serde_json::to_value(&resp).unwrap_or_default();
    let tx_hash = format!(
        "hl:{}",
        resp_json
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("ok")
    );
    let trade_id = uuid::Uuid::new_v4().to_string();

    let record = TradeRecord {
        id: trade_id,
        bot_id: bot_id.to_string(),
        timestamp: Utc::now(),
        action: req.intent.action.clone(),
        token_in: req.intent.token_in.clone(),
        token_out: req.intent.token_out.clone(),
        amount_in: req.intent.amount_in.clone(),
        min_amount_out: req.intent.min_amount_out.clone(),
        target_protocol: "hyperliquid".to_string(),
        tx_hash: tx_hash.clone(),
        block_number: None,
        gas_used: None,
        paper_trade: false,
        execution_status: Some(TradeExecutionStatus::Submitted),
        clob_order_id: None,
        amount_out: valuation.amount_out.map(|v| v.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|v| v.to_string()),
        notional_usd: valuation.notional_usd.map(|v| v.to_string()),
        requested_price_usd: None,
        filled_price_usd: None,
        filled_amount: None,
        slippage_bps: None,
        execution_reason: None,
        prediction_metadata: extract_prediction_metadata(&req.intent),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    };
    if let Err(e) = trade_store::record_trade(record).await {
        tracing::error!(
            error = %e,
            "CRITICAL: HL order submitted but persistence failed"
        );
    }

    Ok(Json(ExecuteResponse {
        tx_hash,
        block_number: None,
        gas_used: None,
        paper_trade: false,
        clob_order_id: None,
    }))
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn execute(
    State(state): State<Arc<TradingApiState>>,
    Json(request): Json<ExecuteRequest>,
) -> Result<Json<ExecuteResponse>, (StatusCode, String)> {
    let protocol_chain_id = state.chain_id.map(crate::protocol_chain_id_from_env);
    validate_chain_tokens(
        protocol_chain_id,
        &request.intent.token_in,
        &request.intent.token_out,
    )?;

    let normalized_intent = normalize_intent_payload(request.intent.clone(), protocol_chain_id);
    let mut normalized_request = request.clone();
    normalized_request.intent = normalized_intent;
    validate_supported_trade_assets(
        None,
        protocol_chain_id,
        &normalized_request.intent.target_protocol,
        &normalized_request.intent.token_in,
        &normalized_request.intent.token_out,
        Some(&state.vault_address),
        state.rpc_url.as_deref(),
        !state.paper_trade
            && !uses_direct_non_vault_execution(&normalized_request.intent.target_protocol),
    )
    .await?;
    normalized_request.intent.metadata = crate::enrich_yield_safety_metadata(
        &normalized_request.intent.target_protocol,
        &normalized_request.intent.action,
        &serde_json::Value::Null,
        &normalized_request.intent.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    crate::validate_morpho_protocol_request(
        &serde_json::Value::Null,
        protocol_chain_id.unwrap_or(state.chain_id.unwrap_or(42161)),
        &normalized_request.intent.target_protocol,
        &normalized_request.intent.action,
        &normalized_request.intent.token_in,
        &normalized_request.intent.token_out,
        &normalized_request.intent.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;

    if state.paper_trade {
        ensure_paper_validation_consistency(&request.validation)?;
    }

    let intent = parse_execute_request(&normalized_request, protocol_chain_id)?;
    if !state.paper_trade
        && !uses_direct_non_vault_execution(&normalized_request.intent.target_protocol)
        && intent.min_amount_out <= Decimal::ZERO
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Live vault-backed execution requires min_amount_out > 0".to_string(),
        ));
    }
    let canonical_intent_hash = ensure_validation_hash_binding(
        &request.validation,
        &intent,
        &state.vault_address,
        protocol_chain_id,
        state.chain_id.unwrap_or(intent.chain_id),
        !state.paper_trade,
    )?;

    if check_and_insert_intent(&canonical_intent_hash) {
        return Err((
            StatusCode::CONFLICT,
            format!("Intent hash {canonical_intent_hash} has already been executed"),
        ));
    }

    let stored_validation = build_stored_validation(&request.validation);

    let is_clob_trade = normalized_request.intent.target_protocol == "polymarket_clob";
    let action_kind = action_kind_for_protocol(&normalized_request.intent.target_protocol);

    // Off-chain signature verification prevents fabricated validator signatures
    // from reaching direct exchange paths and fails early before vault execution.
    if !state.paper_trade {
        verify_signatures_offchain(&request.validation, &state.vault_address, action_kind, None)?;
    }

    // Circuit breaker check before any execution.
    // Live production trades must refresh source-of-truth chain state; paper
    // trades keep the in-memory portfolio path.
    let max_drawdown = Decimal::new(10, 0);
    if state.paper_trade {
        check_circuit_breaker(&state.portfolio, max_drawdown).await?;
    } else {
        let input = LiveRiskInput::from_state(&state)?;
        enforce_live_risk(&input, max_drawdown).await?;
    }

    let valuation = resolve_market_valuation(
        &state.market_client,
        protocol_chain_id,
        &normalized_request.intent,
    )
    .await?;

    if state.paper_trade && is_clob_trade {
        let clob = state.clob_client.as_ref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Polymarket CLOB client not configured".into(),
            )
        })?;
        let clob_params = polymarket_clob::extract_clob_params(
            &normalized_request.intent.action,
            &normalized_request.intent.amount_in,
            &normalized_request.intent.metadata,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.clone()))?;
        ensure_clob_sell_inventory(&state.bot_id, &clob_params)?;
        let result =
            execute_paper_clob_trade(&state.bot_id, clob, &normalized_request, stored_validation)
                .await?;
        if let Some(fill_valuation) = result.fill_valuation.as_ref() {
            update_portfolio_after_trade(&state.portfolio, &normalized_request, fill_valuation)
                .await;
        }
        return Ok(result.response);
    }

    if state.paper_trade {
        let result = execute_paper_trade(
            &state.bot_id,
            &normalized_request,
            stored_validation,
            &valuation,
        )
        .await?;
        update_portfolio_after_trade(&state.portfolio, &normalized_request, &valuation).await;
        return Ok(result);
    }

    // CLOB trades bypass the vault executor entirely.
    if is_clob_trade {
        let clob = state.clob_client.as_ref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Polymarket CLOB client not configured".into(),
            )
        })?;
        let clob_params = polymarket_clob::extract_clob_params(
            &normalized_request.intent.action,
            &normalized_request.intent.amount_in,
            &normalized_request.intent.metadata,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.clone()))?;
        let clob_valuation = resolve_clob_valuation(clob_params.size, clob_params.price);
        let result = execute_clob_trade(
            &state.bot_id,
            clob,
            &normalized_request,
            stored_validation,
            &clob_valuation,
        )
        .await?;
        update_portfolio_after_trade(&state.portfolio, &normalized_request, &clob_valuation).await;
        return Ok(result);
    }

    let result = execute_real_trade(
        &state.bot_id,
        &state.executor,
        &intent,
        &normalized_request,
        stored_validation,
        &valuation,
    )
    .await?;

    update_portfolio_after_trade(&state.portfolio, &normalized_request, &valuation).await;
    Ok(result)
}

/// Multi-bot execute handler -- resolves bot from request extensions (set by auth middleware).
async fn execute_multi_bot(
    State(state): State<Arc<MultiBotTradingState>>,
    request: Request,
) -> Result<Json<ExecuteResponse>, (StatusCode, String)> {
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
    let req: ExecuteRequest = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}")))?;
    crate::validate_protocol_available(&bot.strategy_config, &req.intent.target_protocol)
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let protocol_chain_id =
        crate::protocol_chain_id_from_config(bot.chain_id, &bot.strategy_config);
    validate_chain_tokens(
        Some(protocol_chain_id),
        &req.intent.token_in,
        &req.intent.token_out,
    )?;

    let normalized_intent = normalize_intent_payload(req.intent.clone(), Some(protocol_chain_id));
    let mut normalized_req = req.clone();
    normalized_req.intent = normalized_intent;
    validate_supported_trade_assets(
        strategy_type_from_config(&bot.strategy_config),
        Some(protocol_chain_id),
        &normalized_req.intent.target_protocol,
        &normalized_req.intent.token_in,
        &normalized_req.intent.token_out,
        Some(&bot.vault_address),
        Some(&bot.rpc_url),
        !bot.paper_trade
            && !uses_direct_non_vault_execution(&normalized_req.intent.target_protocol),
    )
    .await?;
    normalized_req.intent.metadata = crate::enrich_yield_safety_metadata(
        &normalized_req.intent.target_protocol,
        &normalized_req.intent.action,
        &bot.risk_params,
        &normalized_req.intent.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    crate::validate_morpho_protocol_request(
        &bot.strategy_config,
        protocol_chain_id,
        &normalized_req.intent.target_protocol,
        &normalized_req.intent.action,
        &normalized_req.intent.token_in,
        &normalized_req.intent.token_out,
        &normalized_req.intent.metadata,
    )
    .map_err(|message| (StatusCode::BAD_REQUEST, message))?;

    if bot.paper_trade {
        ensure_paper_validation_consistency(&req.validation)?;
    }

    let intent = parse_execute_request(&normalized_req, Some(protocol_chain_id))?;
    if !bot.paper_trade
        && !uses_direct_non_vault_execution(&normalized_req.intent.target_protocol)
        && intent.min_amount_out <= Decimal::ZERO
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Live vault-backed execution requires min_amount_out > 0".to_string(),
        ));
    }
    let canonical_intent_hash = ensure_validation_hash_binding(
        &req.validation,
        &intent,
        &bot.vault_address,
        Some(protocol_chain_id),
        bot.chain_id,
        !bot.paper_trade,
    )?;

    if check_and_insert_intent(&canonical_intent_hash) {
        return Err((
            StatusCode::CONFLICT,
            format!("Intent hash {canonical_intent_hash} has already been executed"),
        ));
    }

    let stored_validation = build_stored_validation(&req.validation);

    let is_clob_trade = normalized_req.intent.target_protocol == "polymarket_clob";
    let action_kind = action_kind_for_protocol(&normalized_req.intent.target_protocol);

    // Validation trust level determines which authorization path fires:
    // - PerTrade: every trade needs validator EIP-712 signatures (5-30s)
    // - Envelope: trades within approved bounds skip validators (instant)
    // - SelfOperated: no external validation, local policy only (instant)
    use trading_runtime::ValidationTrust;
    let mut signed_envelope = None;
    if !bot.paper_trade {
        match bot.validation_trust {
            ValidationTrust::PerTrade => {
                verify_signatures_offchain(
                    &req.validation,
                    &bot.vault_address,
                    action_kind,
                    Some(state.min_validator_score),
                )?;
            }
            ValidationTrust::Envelope => {
                if normalized_req.intent.target_protocol != "hyperliquid" {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "Live Envelope trust mode is only implemented for Hyperliquid; non-Hyperliquid live trades require PerTrade validation".into(),
                    ));
                }
                let envelope =
                    super::hyperliquid::get_signed_envelope(&bot.bot_id).ok_or_else(|| {
                        (
                            StatusCode::FORBIDDEN,
                            "Live Envelope trust mode requires a signed per-bot envelope approval"
                                .to_string(),
                        )
                    })?;
                let binding = EnvelopeBinding {
                    bot_id: &bot.bot_id,
                    vault_address: &bot.vault_address,
                    chain_id: bot.chain_id,
                    protocol: "hyperliquid",
                };
                envelope
                    .verify(&binding, &state.trusted_envelope_signers())
                    .map_err(|e| (StatusCode::FORBIDDEN, e.to_string()))?;
                signed_envelope = Some(envelope);
            }
            ValidationTrust::SelfOperated => {
                return Err((
                    StatusCode::FORBIDDEN,
                    "Live SelfOperated trust mode is disabled until exact-action production authorization is implemented".into(),
                ));
            }
        }

        let max_drawdown = max_drawdown_from_strategy_config(&bot.strategy_config);
        if normalized_req.intent.target_protocol == "hyperliquid" {
            enforce_hyperliquid_live_risk(&state, &bot, max_drawdown).await?;
        } else if is_clob_trade {
            let clob = state.clob_client.as_ref().ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Polymarket CLOB client not configured".to_string(),
                )
            })?;
            enforce_clob_live_reconciliation(clob).await?;
        } else {
            let live_input = LiveRiskInput::from_bot(&bot, &state.market_data_base_url);
            enforce_live_risk(&live_input, max_drawdown).await?;
        }
    }

    let market_client = MarketDataClient::new(state.market_data_base_url.clone());
    let valuation = resolve_market_valuation(
        &market_client,
        Some(protocol_chain_id),
        &normalized_req.intent,
    )
    .await?;

    if bot.paper_trade && is_clob_trade {
        let clob = state.clob_client.as_ref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Polymarket CLOB client not configured".into(),
            )
        })?;
        let clob_params = polymarket_clob::extract_clob_params(
            &normalized_req.intent.action,
            &normalized_req.intent.amount_in,
            &normalized_req.intent.metadata,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.clone()))?;
        ensure_clob_sell_inventory(&bot.bot_id, &clob_params)?;
        let result =
            execute_paper_clob_trade(&bot.bot_id, clob, &normalized_req, stored_validation).await?;
        if let Err(error) =
            capture_metrics_snapshot_for_bot(&bot, &state.market_data_base_url).await
        {
            tracing::warn!(
                bot_id = %bot.bot_id,
                %error,
                "failed to capture metrics snapshot after paper CLOB trade"
            );
        }
        return Ok(result.response);
    }

    if bot.paper_trade {
        let response =
            execute_paper_trade(&bot.bot_id, &normalized_req, stored_validation, &valuation)
                .await?;
        if let Err(error) =
            capture_metrics_snapshot_for_bot(&bot, &state.market_data_base_url).await
        {
            tracing::warn!(
                bot_id = %bot.bot_id,
                %error,
                "failed to capture metrics snapshot after paper trade"
            );
        }
        return Ok(response);
    }

    // CLOB trades bypass the vault executor entirely.
    if is_clob_trade {
        let clob = state.clob_client.as_ref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Polymarket CLOB client not configured".into(),
            )
        })?;
        let clob_params = polymarket_clob::extract_clob_params(
            &normalized_req.intent.action,
            &normalized_req.intent.amount_in,
            &normalized_req.intent.metadata,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.clone()))?;
        let valuation = resolve_clob_valuation(clob_params.size, clob_params.price);
        let response = execute_clob_trade(
            &bot.bot_id,
            clob,
            &normalized_req,
            stored_validation,
            &valuation,
        )
        .await?;
        if let Err(error) =
            capture_metrics_snapshot_for_bot(&bot, &state.market_data_base_url).await
        {
            tracing::warn!(
                bot_id = %bot.bot_id,
                %error,
                "failed to capture metrics snapshot after CLOB trade"
            );
        }
        return Ok(response);
    }

    // Hyperliquid perps bypass the vault executor — trades go directly to HL L1 API.
    if normalized_req.intent.target_protocol == "hyperliquid" {
        let response = execute_hyperliquid_trade(
            &bot.bot_id,
            &state,
            &normalized_req,
            stored_validation,
            &valuation,
            signed_envelope.as_ref(),
        )
        .await?;
        if let Err(error) =
            capture_metrics_snapshot_for_bot(&bot, &state.market_data_base_url).await
        {
            tracing::warn!(
                bot_id = %bot.bot_id,
                %error,
                "failed to capture metrics snapshot after Hyperliquid trade"
            );
        }
        return Ok(response);
    }

    // Use shared ChainClient for nonce serialization (prevents nonce collisions
    // from concurrent requests). Falls back to creating a fresh one if not configured.
    let can_use_shared_chain_client = state.chain_client.is_some()
        && state.chain_client_chain_id == Some(bot.chain_id)
        && state.chain_client_rpc_url.as_deref() == Some(bot.rpc_url.as_str());

    let executor = if can_use_shared_chain_client {
        let shared_client = state
            .chain_client
            .as_ref()
            .expect("shared chain client checked above");
        TradeExecutor::with_shared_chain_client(
            &bot.vault_address,
            &bot.rpc_url,
            bot.chain_id,
            shared_client.clone(),
        )
    } else {
        TradeExecutor::new(
            &bot.vault_address,
            &bot.rpc_url,
            &state.operator_private_key,
            bot.chain_id,
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Executor init failed: {e}"),
            )
        })?
    };

    let response = execute_real_trade(
        &bot.bot_id,
        &executor,
        &intent,
        &normalized_req,
        stored_validation,
        &valuation,
    )
    .await?;
    if let Err(error) = capture_metrics_snapshot_for_bot(&bot, &state.market_data_base_url).await {
        tracing::warn!(
            bot_id = %bot.bot_id,
            %error,
            "failed to capture metrics snapshot after trade"
        );
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_intent(
        token_in: &str,
        token_out: &str,
        amount_in: &str,
        min_amount_out: &str,
    ) -> IntentPayload {
        IntentPayload {
            strategy_id: "test".to_string(),
            action: "swap".to_string(),
            token_in: token_in.to_string(),
            token_out: token_out.to_string(),
            amount_in: amount_in.to_string(),
            min_amount_out: min_amount_out.to_string(),
            target_protocol: "uniswap_v3".to_string(),
            amount_format: None,
            metadata: serde_json::Value::Null,
        }
    }

    #[test]
    fn resolve_position_size_prefers_output_amount_when_available() {
        let intent = make_intent("WETH", "USDC", "1.25", "3200");

        let (size, amount_out) = resolve_position_size(None, &intent).expect("size");
        assert_eq!(size, Decimal::new(3200, 0));
        assert_eq!(amount_out, Some(Decimal::new(3200, 0)));
    }

    #[test]
    fn resolve_position_size_falls_back_to_input_amount() {
        let intent = make_intent("WETH", "WBTC", "2", "0");

        let (size, amount_out) = resolve_position_size(None, &intent).expect("size");
        assert_eq!(size, Decimal::new(2, 0));
        assert_eq!(amount_out, None);
    }

    #[test]
    fn resolve_position_size_normalizes_known_base_raw_units() {
        // Raw ERC-20 units: 1000 USDC in (1e9) + 0.429 WETH out (4.29e17).
        let intent = make_intent(
            "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
            "0x4200000000000000000000000000000000000006",
            "1000000000",
            "429000000000000000",
        );

        let (size, amount_out) = resolve_position_size(Some(84532), &intent).expect("size");
        assert_eq!(size.to_string(), "0.429");
        assert_eq!(
            amount_out.map(|value| value.to_string()),
            Some("0.429".to_string())
        );
    }

    #[test]
    fn resolve_position_size_normalizes_base_sepolia_usdc_raw_units() {
        let intent = make_intent(
            "0x4200000000000000000000000000000000000006",
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "1500000000000000000",
            "3575000000",
        );

        let (size, amount_out) = resolve_position_size(Some(84532), &intent).expect("size");
        assert_eq!(size.to_string(), "3575");
        assert_eq!(
            amount_out.map(|value| value.to_string()),
            Some("3575".to_string())
        );
    }

    #[test]
    fn validate_chain_tokens_rejects_mainnet_address_on_base_sepolia() {
        let err = validate_chain_tokens(
            Some(84532),
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        )
        .expect_err("should reject mainnet token");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("Ethereum mainnet"));
        assert!(err.1.contains("Base Sepolia"));
    }

    #[test]
    fn normalize_trade_amount_keeps_large_human_readable_symbol_amounts() {
        let amount = normalize_trade_amount(Some(84532), "USDC", Decimal::new(200_000, 0), None);
        assert_eq!(amount.to_string(), "200000");
    }

    #[test]
    fn normalize_trade_amount_respects_explicit_base_units() {
        let amount = normalize_trade_amount(
            Some(84532),
            "USDC",
            Decimal::new(2_000_000_000, 0),
            Some(AmountFormat::BaseUnits),
        );
        assert_eq!(amount.to_string(), "2000");
    }

    fn make_execute_request(deadline: Option<u64>) -> ExecuteRequest {
        ExecuteRequest {
            intent: IntentPayload {
                strategy_id: "deadline-test".to_string(),
                action: "swap".to_string(),
                token_in: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
                token_out: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
                amount_in: "10000000000000000".to_string(),
                min_amount_out: "1000000".to_string(),
                target_protocol: "uniswap_v3".to_string(),
                amount_format: None,
                metadata: serde_json::Value::Null,
            },
            validation: ValidationPayload {
                approved: true,
                aggregate_score: 100,
                intent_hash: "0xdeadbeef".to_string(),
                execution_hash: format!("0x{}", "00".repeat(32)),
                deadline,
                validator_responses: vec![],
                simulation: None,
            },
        }
    }

    fn attach_expected_hashes(
        req: &mut ExecuteRequest,
        adapter_chain_id: Option<u64>,
        execution_chain_id: u64,
    ) {
        let intent = parse_execute_request(req, adapter_chain_id).expect("intent");
        let (intent_hash, execution_hash) = expected_validation_hashes(
            &intent,
            "0x0000000000000000000000000000000000000001",
            adapter_chain_id,
            execution_chain_id,
            true,
        )
        .expect("hashes");
        req.validation.intent_hash = intent_hash;
        req.validation.execution_hash = execution_hash;
    }

    fn validator_response(score: u32) -> ValidatorResponsePayload {
        ValidatorResponsePayload {
            validator: "0x0000000000000000000000000000000000000001".to_string(),
            score,
            reasoning: "test".to_string(),
            signature: format!("0x{}", "11".repeat(65)),
            chain_id: Some(1),
            verifying_contract: Some("0x0000000000000000000000000000000000000002".to_string()),
            validated_at: None,
        }
    }

    #[test]
    fn validation_score_binding_rejects_tampered_aggregate() {
        let mut req = make_execute_request(Some(1_999_999_999));
        req.validation.aggregate_score = 100;
        req.validation.validator_responses = vec![validator_response(40), validator_response(60)];

        let err = ensure_validation_score_binding(&req.validation, Some(50))
            .expect_err("tampered aggregate should be rejected");

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("aggregate_score"));
    }

    #[test]
    fn validation_score_binding_rejects_below_threshold() {
        let mut req = make_execute_request(Some(1_999_999_999));
        req.validation.aggregate_score = 49;
        req.validation.validator_responses = vec![validator_response(49)];

        let err = ensure_validation_score_binding(&req.validation, Some(50))
            .expect_err("low signed score should be rejected");

        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        assert!(err.1.contains("below required"));
    }

    #[test]
    fn parse_execute_request_uses_validation_deadline_when_present() {
        let req = make_execute_request(Some(1_777_777_777));
        let intent = parse_execute_request(&req, Some(1)).expect("intent");
        assert_eq!(intent.deadline.timestamp(), 1_777_777_777);
    }

    #[test]
    fn parse_execute_request_uses_default_deadline_when_missing() {
        let req = make_execute_request(None);
        let before = chrono::Utc::now().timestamp();
        let intent = parse_execute_request(&req, Some(1)).expect("intent");
        let after = chrono::Utc::now().timestamp();
        let ts = intent.deadline.timestamp();
        assert!(ts >= before + 290);
        assert!(ts <= after + 310);
    }

    #[test]
    fn parse_execute_request_normalizes_zero_address_for_aave_on_local_eth_fork() {
        let mut req = make_execute_request(Some(1_777_777_777));
        req.intent.action = "supply".to_string();
        req.intent.target_protocol = "aave_v3".to_string();
        req.intent.token_in = "0x0000000000000000000000000000000000000000".to_string();
        req.intent.token_out = "0x0000000000000000000000000000000000000000".to_string();

        let intent = parse_execute_request(&req, Some(31339)).expect("intent");
        assert_eq!(
            intent.token_in,
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        );
        assert_eq!(
            intent.token_out,
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        );
    }

    #[test]
    fn validation_hash_binding_accepts_matching_request() {
        let mut req = make_execute_request(Some(1_999_999_999));
        attach_expected_hashes(&mut req, Some(1), 1);
        let intent = parse_execute_request(&req, Some(1)).expect("intent");

        let result = ensure_validation_hash_binding(
            &req.validation,
            &intent,
            "0x0000000000000000000000000000000000000001",
            Some(1),
            1,
            true,
        );

        assert!(result.is_ok());
    }

    #[test]
    fn validation_hash_binding_rejects_mutated_min_output() {
        let mut req = make_execute_request(Some(1_999_999_999));
        attach_expected_hashes(&mut req, Some(1), 1);
        req.intent.min_amount_out = "2000000".to_string();
        let intent = parse_execute_request(&req, Some(1)).expect("intent");

        let err = ensure_validation_hash_binding(
            &req.validation,
            &intent,
            "0x0000000000000000000000000000000000000001",
            Some(1),
            1,
            true,
        )
        .expect_err("mutated request should be rejected");

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("intent_hash") || err.1.contains("execution_hash"));
    }

    #[test]
    fn validation_hash_binding_rejects_mutated_metadata() {
        let mut req = make_execute_request(Some(1_999_999_999));
        req.intent.metadata = serde_json::json!({"pool_fee": 3000, "route": ["weth", "usdc"]});
        attach_expected_hashes(&mut req, Some(1), 1);
        req.intent.metadata = serde_json::json!({"pool_fee": 500, "route": ["weth", "usdc"]});
        let intent = parse_execute_request(&req, Some(1)).expect("intent");

        let err = ensure_validation_hash_binding(
            &req.validation,
            &intent,
            "0x0000000000000000000000000000000000000001",
            Some(1),
            1,
            true,
        )
        .expect_err("mutated metadata should be rejected");

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("intent_hash") || err.1.contains("execution_hash"));
    }

    #[test]
    fn validation_hash_binding_rejects_mutated_deadline() {
        let mut req = make_execute_request(Some(1_999_999_999));
        attach_expected_hashes(&mut req, Some(1), 1);
        req.validation.deadline = Some(2_000_000_000);
        let intent = parse_execute_request(&req, Some(1)).expect("intent");

        let err = ensure_validation_hash_binding(
            &req.validation,
            &intent,
            "0x0000000000000000000000000000000000000001",
            Some(1),
            1,
            true,
        )
        .expect_err("mutated deadline should be rejected");

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("intent_hash") || err.1.contains("execution_hash"));
    }

    #[test]
    fn validation_hash_binding_rejects_mutated_clob_order() {
        let mut req = make_execute_request(Some(1_999_999_999));
        req.intent.action = "buy".to_string();
        req.intent.target_protocol = "polymarket_clob".to_string();
        req.intent.token_in = "USDC".to_string();
        req.intent.token_out = "YES".to_string();
        req.intent.amount_in = "10".to_string();
        req.intent.min_amount_out = "0".to_string();
        req.intent.metadata = serde_json::json!({
            "token_id": "123",
            "price": "0.65",
            "order_type": "GTC"
        });
        attach_expected_hashes(&mut req, Some(137), 137);

        req.intent.metadata = serde_json::json!({
            "token_id": "123",
            "price": "0.66",
            "order_type": "GTC"
        });
        let intent = parse_execute_request(&req, Some(137)).expect("intent");

        let err = ensure_validation_hash_binding(
            &req.validation,
            &intent,
            "0x0000000000000000000000000000000000000001",
            Some(137),
            137,
            true,
        )
        .expect_err("mutated CLOB order should be rejected");

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("intent_hash") || err.1.contains("execution_hash"));
    }

    #[test]
    fn validation_hash_binding_rejects_mutated_hyperliquid_order() {
        let mut req = make_execute_request(Some(1_999_999_999));
        req.intent.action = "open_long".to_string();
        req.intent.target_protocol = "hyperliquid".to_string();
        req.intent.token_in = "USDC".to_string();
        req.intent.token_out = "ETH".to_string();
        req.intent.amount_in = "100".to_string();
        req.intent.min_amount_out = "0".to_string();
        req.intent.metadata = serde_json::json!({
            "asset": "ETH",
            "limit_price": "3000"
        });
        attach_expected_hashes(&mut req, Some(42161), 42161);

        req.intent.metadata = serde_json::json!({
            "asset": "ETH",
            "limit_price": "3100"
        });
        let intent = parse_execute_request(&req, Some(42161)).expect("intent");

        let err = ensure_validation_hash_binding(
            &req.validation,
            &intent,
            "0x0000000000000000000000000000000000000001",
            Some(42161),
            42161,
            true,
        )
        .expect_err("mutated Hyperliquid order should be rejected");

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("intent_hash") || err.1.contains("execution_hash"));
    }
}
