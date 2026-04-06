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
use trading_runtime::polymarket_clob::{self, ClobClient};
use trading_runtime::{
    PortfolioState, Position, PositionType, TradeIntent, TradeIntentBuilder, ValidationResult,
    ValidatorResponse,
};

use super::validate::parse_action;

const KNOWN_STABLECOINS: &[&str] = &[
    "usdc",
    "usdc.e",
    "usdt",
    "dai",
    "fdusd",
    "usde",
    "usdbc",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f",
    "0x2791bcaf2de4661ed88a30c99a7a9449aa84174",
];

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

fn is_known_stablecoin(token: &str) -> bool {
    let normalized = token.trim().to_ascii_lowercase();
    KNOWN_STABLECOINS.contains(&normalized.as_str())
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
fn check_and_insert_intent(intent_hash: &str) -> bool {
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

    TradeIntentBuilder::new()
        .strategy_id(&req.intent.strategy_id)
        .action(action)
        .token_in(&req.intent.token_in)
        .token_out(&req.intent.token_out)
        .amount_in(amount_in)
        .min_amount_out(min_amount_out)
        .target_protocol(&req.intent.target_protocol)
        .build()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))
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
    entry_price: Decimal,
    size: Decimal,
) {
    let action_str = req.intent.action.to_lowercase();
    let is_close = matches!(
        action_str.as_str(),
        "sell" | "close_long" | "close_short" | "withdraw" | "repay" | "redeem"
    );

    let mut state = portfolio.write().await;

    if is_close {
        // Try to close an existing position.
        if let Some(pnl) = state.close_position(&req.intent.token_out, &req.intent.target_protocol)
        {
            tracing::info!(
                token = %req.intent.token_out,
                protocol = %req.intent.target_protocol,
                realized_pnl = %pnl,
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
            amount: size,
            entry_price,
            current_price: entry_price,
            unrealized_pnl: Decimal::ZERO,
            protocol: req.intent.target_protocol.clone(),
            position_type,
        });

        tracing::info!(
            token = %req.intent.token_out,
            protocol = %req.intent.target_protocol,
            size = %size,
            entry_price = %entry_price,
            "Position added to portfolio"
        );
    }
}

/// Execute a paper trade: log it without on-chain execution.
async fn execute_paper_trade(
    bot_id: &str,
    req: &ExecuteRequest,
    stored_validation: StoredValidation,
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
        validation: stored_validation,
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
        validation: stored_validation,
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
        validation: stored_validation,
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

    // Circuit breaker check before any execution.
    // Use max_drawdown_pct from risk_params if available, default 10%.
    let max_drawdown = Decimal::new(10, 0);
    check_circuit_breaker(&state.portfolio, max_drawdown).await?;

    if state.paper_trade {
        let result = execute_paper_trade(&state.bot_id, &request, stored_validation).await?;
        let (price, size) = estimate_trade_price_size(&request.intent)?;
        update_portfolio_after_trade(&state.portfolio, &request, price, size).await;
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
        let result = execute_clob_trade(&state.bot_id, clob, &request, stored_validation).await?;
        update_portfolio_after_trade(
            &state.portfolio,
            &request,
            clob_params.price,
            clob_params.size,
        )
        .await;
        return Ok(result);
    }

    let result = execute_real_trade(
        &state.bot_id,
        &state.executor,
        &intent,
        &request,
        stored_validation,
    )
    .await?;

    let (price, size) = estimate_trade_price_size(&request.intent)?;
    update_portfolio_after_trade(&state.portfolio, &request, price, size).await;
    Ok(result)
}

/// Derive a coherent output position from the trade intent.
///
/// For swaps, the portfolio should track the output asset (`token_out`) using
/// the output amount. If either side is a stablecoin we can anchor the entry
/// price in USD; otherwise we preserve the output amount and use the trade
/// ratio as a best-effort placeholder.
fn estimate_trade_price_size(
    intent: &IntentPayload,
) -> Result<(Decimal, Decimal), (StatusCode, String)> {
    let amount_in: Decimal = intent.amount_in.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid amount_in '{}': {e}", intent.amount_in),
        )
    })?;

    let amount_out: Decimal = intent.min_amount_out.parse().unwrap_or(Decimal::ZERO);

    if amount_out > Decimal::ZERO {
        let price = if is_known_stablecoin(&intent.token_out) {
            Decimal::ONE
        } else if amount_in > Decimal::ZERO {
            amount_in / amount_out
        } else {
            Decimal::ZERO
        };

        return Ok((price, amount_out));
    }

    let price = if is_known_stablecoin(&intent.token_out) || is_known_stablecoin(&intent.token_in) {
        Decimal::ONE
    } else {
        Decimal::ZERO
    };

    Ok((price, amount_in))
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

    if bot.paper_trade {
        return execute_paper_trade(&bot.bot_id, &req, stored_validation).await;
    }

    // CLOB trades bypass the vault executor entirely.
    if req.intent.target_protocol == "polymarket_clob" {
        let clob = state.clob_client.as_ref().ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Polymarket CLOB client not configured".into(),
            )
        })?;
        return execute_clob_trade(&bot.bot_id, clob, &req, stored_validation).await;
    }

    // Use shared ChainClient for nonce serialization (prevents nonce collisions
    // from concurrent requests). Falls back to creating a fresh one if not configured.
    let executor = if let Some(shared_client) = &state.chain_client {
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

    execute_real_trade(&bot.bot_id, &executor, &intent, &req, stored_validation).await
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
    fn estimate_trade_price_size_uses_output_amount_for_stablecoin_outputs() {
        let intent = make_intent(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "1.25",
            "3200",
        );

        let (price, size) = estimate_trade_price_size(&intent).expect("valuation");
        assert_eq!(size, Decimal::new(3200, 0));
        assert_eq!(price, Decimal::ONE);
    }

    #[test]
    fn estimate_trade_price_size_anchors_output_assets_bought_with_stablecoins() {
        let intent = make_intent("USDC", "WETH", "1000", "0.5");

        let (price, size) = estimate_trade_price_size(&intent).expect("valuation");
        assert_eq!(size, Decimal::new(5, 1));
        assert_eq!(price, Decimal::new(2000, 0));
    }
}
