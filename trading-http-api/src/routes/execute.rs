use crate::trade_store::{
    self, StoredSimulation, StoredValidation, StoredValidatorResponse, TradeRecord,
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
use trading_runtime::executor::TradeExecutor;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::polymarket_clob::{self, ClobClient};
use trading_runtime::{
    PortfolioState, Position, PositionType, TradeIntent, TradeIntentBuilder, ValidationResult,
    ValidatorResponse, ValuationStatus,
};

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
    /// Extra protocol-specific parameters (e.g., token_id and price for CLOB orders).
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ValidationPayload {
    pub approved: bool,
    pub aggregate_score: u32,
    pub intent_hash: String,
    #[serde(default)]
    pub deadline: Option<u64>,
    pub validator_responses: Vec<ValidatorResponsePayload>,
    #[serde(default)]
    pub simulation: Option<SimulationPayload>,
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

/// Build a `ValidationResult` (runtime type) from a `ValidationPayload`.
fn build_validation_result(v: &ValidationPayload) -> ValidationResult {
    ValidationResult {
        approved: v.approved,
        aggregate_score: v.aggregate_score,
        intent_hash: v.intent_hash.clone(),
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
/// Skipped when there are no validator responses (e.g. the validation was a dry-run
/// or the intent was pre-approved without validators).
fn verify_signatures_offchain(
    validation: &ValidationPayload,
    vault_address: &str,
) -> Result<(), (StatusCode, String)> {
    if validation.validator_responses.is_empty() {
        return Ok(());
    }

    let deadline = validation.deadline.unwrap_or(0);
    if deadline == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Validation deadline is required for signature verification".into(),
        ));
    }

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
        vault_address,
        deadline,
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

/// Parse and validate the common fields of an `ExecuteRequest`.
///
/// Returns the built `TradeIntent` or an HTTP error.
fn parse_execute_request(req: &ExecuteRequest) -> Result<TradeIntent, (StatusCode, String)> {
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

    let mut intent = TradeIntentBuilder::new()
        .strategy_id(&req.intent.strategy_id)
        .action(action)
        .token_in(&req.intent.token_in)
        .token_out(&req.intent.token_out)
        .amount_in(amount_in)
        .min_amount_out(min_amount_out)
        .target_protocol(&req.intent.target_protocol)
        .build()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    if let Some(deadline) = req.validation.deadline {
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
    intent: &IntentPayload,
) -> Result<(Decimal, Option<Decimal>), (StatusCode, String)> {
    let amount_in: Decimal = intent.amount_in.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid amount_in '{}': {e}", intent.amount_in),
        )
    })?;
    let amount_out: Decimal = intent.min_amount_out.parse().unwrap_or(Decimal::ZERO);
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
    let (position_size, amount_out) = resolve_position_size(intent)?;
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

fn resolve_clob_valuation(size: Decimal, price: Decimal) -> TradeValuationSnapshot {
    if size <= Decimal::ZERO || price <= Decimal::ZERO {
        return TradeValuationSnapshot::unpriced(size, None);
    }
    TradeValuationSnapshot::priced(size, None, price)
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
        amount_out: valuation.amount_out.map(|value| value.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|value| value.to_string()),
        notional_usd: valuation.notional_usd.map(|value| value.to_string()),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        slippage_bps: None,
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
        tx_hash: outcome.tx_hash.clone(),
        block_number: outcome.block_number,
        gas_used: outcome.gas_used.map(|g| g.to_string()),
        paper_trade: false,
        amount_out: valuation.amount_out.map(|value| value.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|value| value.to_string()),
        notional_usd: valuation.notional_usd.map(|value| value.to_string()),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        slippage_bps: None,
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
        amount_out: valuation.amount_out.map(|value| value.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|value| value.to_string()),
        notional_usd: valuation.notional_usd.map(|value| value.to_string()),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        slippage_bps: None,
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
) -> Result<Json<ExecuteResponse>, (StatusCode, String)> {
    use trading_runtime::hyperliquid::{AssetId, HlOrderType, PlaceOrderRequest};

    let hl_client = super::hyperliquid::get_hl_client(state)?;

    // Map intent action to HL order params
    let action = parse_action(&req.intent.action)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid action: {e}")))?;

    // Envelope check — replaces validator signatures for HL trades.
    // Cancels and closes always pass. Opens are checked against the envelope.
    let is_open = matches!(
        action,
        trading_runtime::types::Action::OpenLong
            | trading_runtime::types::Action::OpenShort
            | trading_runtime::types::Action::Buy
    );
    if is_open {
        let envelope = super::hyperliquid::get_envelope(state);
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
        // Approximate current exposure from HL account (best-effort)
        let current_exposure = 0.0; // TODO: pull from position ledger
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
        amount_out: valuation.amount_out.map(|v| v.to_string()),
        entry_price_usd: valuation.entry_price_usd.map(|v| v.to_string()),
        notional_usd: valuation.notional_usd.map(|v| v.to_string()),
        valuation_status: valuation.valuation_status,
        validation: stored_validation,
        signal_price: None,
        fill_price: None,
        slippage_bps: None,
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
    // Dedup check FIRST — before any validation or execution work.
    // Prevents race window where parallel requests both pass validation
    // before either inserts into the dedup store.
    if !request.validation.intent_hash.is_empty()
        && check_and_insert_intent(&request.validation.intent_hash)
    {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "Intent hash {} has already been executed",
                request.validation.intent_hash
            ),
        ));
    }

    let intent = parse_execute_request(&request)?;
    let stored_validation = build_stored_validation(&request.validation);

    // Off-chain signature verification — prevents fabricated validator signatures
    // from reaching any execution path. Paper trades are exempt (no real money).
    if !state.paper_trade {
        verify_signatures_offchain(&request.validation, &state.vault_address)?;
    }

    // Circuit breaker check before any execution.
    // Use max_drawdown_pct from risk_params if available, default 10%.
    let max_drawdown = Decimal::new(10, 0);
    check_circuit_breaker(&state.portfolio, max_drawdown).await?;

    let valuation =
        resolve_market_valuation(&state.market_client, state.chain_id, &request.intent).await?;

    if state.paper_trade {
        let result =
            execute_paper_trade(&state.bot_id, &request, stored_validation, &valuation).await?;
        update_portfolio_after_trade(&state.portfolio, &request, &valuation).await;
        return Ok(result);
    }

    // CLOB trades bypass the vault executor entirely.
    if request.intent.target_protocol == "polymarket_clob" {
        let clob = state.clob_client.as_ref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Polymarket CLOB client not configured".into(),
            )
        })?;
        let clob_params = polymarket_clob::extract_clob_params(
            &request.intent.action,
            &request.intent.amount_in,
            &request.intent.metadata,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.clone()))?;
        let clob_valuation = resolve_clob_valuation(clob_params.size, clob_params.price);
        let result = execute_clob_trade(
            &state.bot_id,
            clob,
            &request,
            stored_validation,
            &clob_valuation,
        )
        .await?;
        update_portfolio_after_trade(&state.portfolio, &request, &clob_valuation).await;
        return Ok(result);
    }

    let result = execute_real_trade(
        &state.bot_id,
        &state.executor,
        &intent,
        &request,
        stored_validation,
        &valuation,
    )
    .await?;

    update_portfolio_after_trade(&state.portfolio, &request, &valuation).await;
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

    // Dedup check FIRST — before any validation or execution work.
    if !req.validation.intent_hash.is_empty()
        && check_and_insert_intent(&req.validation.intent_hash)
    {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "Intent hash {} has already been executed",
                req.validation.intent_hash
            ),
        ));
    }

    let intent = parse_execute_request(&req)?;
    let stored_validation = build_stored_validation(&req.validation);

    // Validation trust level determines which authorization path fires:
    // - PerTrade: every trade needs validator EIP-712 signatures (5-30s)
    // - Envelope: trades within approved bounds skip validators (instant)
    // - SelfOperated: no external validation, local policy only (instant)
    use trading_runtime::ValidationTrust;
    if !bot.paper_trade {
        match bot.validation_trust {
            ValidationTrust::PerTrade => {
                verify_signatures_offchain(&req.validation, &bot.vault_address)?;
            }
            ValidationTrust::Envelope => {
                // Envelope check happens in execute_hyperliquid_trade or is
                // skipped for closes/cancels. No validator round-trip needed.
            }
            ValidationTrust::SelfOperated => {
                // Operator trusts themselves. No external validation.
                // Envelope bounds still enforced for risk management.
            }
        }
    }

    let market_client = MarketDataClient::new(state.market_data_base_url.clone());
    let valuation =
        resolve_market_valuation(&market_client, Some(bot.chain_id), &req.intent).await?;

    if bot.paper_trade {
        return execute_paper_trade(&bot.bot_id, &req, stored_validation, &valuation).await;
    }

    // CLOB trades bypass the vault executor entirely.
    if req.intent.target_protocol == "polymarket_clob" {
        let clob = state.clob_client.as_ref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Polymarket CLOB client not configured".into(),
            )
        })?;
        let clob_params = polymarket_clob::extract_clob_params(
            &req.intent.action,
            &req.intent.amount_in,
            &req.intent.metadata,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.clone()))?;
        let valuation = resolve_clob_valuation(clob_params.size, clob_params.price);
        return execute_clob_trade(&bot.bot_id, clob, &req, stored_validation, &valuation).await;
    }

    // Hyperliquid perps bypass the vault executor — trades go directly to HL L1 API.
    if req.intent.target_protocol == "hyperliquid" {
        return execute_hyperliquid_trade(&bot.bot_id, &state, &req, stored_validation, &valuation)
            .await;
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

    execute_real_trade(
        &bot.bot_id,
        &executor,
        &intent,
        &req,
        stored_validation,
        &valuation,
    )
    .await
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
            metadata: serde_json::Value::Null,
        }
    }

    #[test]
    fn resolve_position_size_prefers_output_amount_when_available() {
        let intent = make_intent("WETH", "USDC", "1.25", "3200");

        let (size, amount_out) = resolve_position_size(&intent).expect("size");
        assert_eq!(size, Decimal::new(3200, 0));
        assert_eq!(amount_out, Some(Decimal::new(3200, 0)));
    }

    #[test]
    fn resolve_position_size_falls_back_to_input_amount() {
        let intent = make_intent("WETH", "WBTC", "2", "0");

        let (size, amount_out) = resolve_position_size(&intent).expect("size");
        assert_eq!(size, Decimal::new(2, 0));
        assert_eq!(amount_out, None);
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
                metadata: serde_json::Value::Null,
            },
            validation: ValidationPayload {
                approved: true,
                aggregate_score: 100,
                intent_hash: "0xdeadbeef".to_string(),
                deadline,
                validator_responses: vec![],
                simulation: None,
            },
        }
    }

    #[test]
    fn parse_execute_request_uses_validation_deadline_when_present() {
        let req = make_execute_request(Some(1_777_777_777));
        let intent = parse_execute_request(&req).expect("intent");
        assert_eq!(intent.deadline.timestamp(), 1_777_777_777);
    }

    #[test]
    fn parse_execute_request_uses_default_deadline_when_missing() {
        let req = make_execute_request(None);
        let before = chrono::Utc::now().timestamp();
        let intent = parse_execute_request(&req).expect("intent");
        let after = chrono::Utc::now().timestamp();
        let ts = intent.deadline.timestamp();
        assert!(ts >= before + 290);
        assert!(ts <= after + 310);
    }
}
