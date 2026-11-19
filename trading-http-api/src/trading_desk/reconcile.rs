//! GET-time reconciliation for uncertain desk orders.
//!
//! A submit that crashed before its outcome was persisted — or that the
//! executor answered ambiguously (dedup conflict, 5xx after the submission
//! boundary) — leaves the order `pending`. This module proves or refutes the
//! settlement on chain from the order's own staged identity
//! (`chain_id` + `vault_address` + `intent_hash`), never from the latest
//! transaction that happens to match: a receipt must name this vault and
//! carry a `TradeExecuted` event whose `intentHash` topic equals the staged
//! hash, and its output token must be the instrument's expected leg.
//!
//! All decisions are made by the pure `classify_*` functions (unit-tested
//! with synthetic receipts); the async path only gathers chain facts and is
//! best-effort — an RPC outage never takes the order read down.

use super::trading::{Settlement, order_json, settlement_from_observation};
use super::*;

use alloy::primitives::{Address, B256, U256, keccak256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::Filter;
use trading_runtime::contracts::ITradingVault;

/// Confirmations required on a settlement receipt before it is reported as
/// `filled` (default 1 = the receipt's own block). Overridable for tests and
/// higher-security deployments via `TRADING_DESK_ORDER_CONFIRMATIONS`.
pub(super) fn required_confirmations() -> u64 {
    std::env::var("TRADING_DESK_ORDER_CONFIRMATIONS")
        .ok()
        .and_then(|raw| raw.trim().parse().ok())
        .filter(|confirmations| *confirmations > 0)
        .unwrap_or(1)
}

/// `TradeExecuted(address indexed target, uint256 value, uint256
/// outputGained, address outputToken, bytes32 indexed intentHash)` — the
/// only settlement proof this desk accepts. Kept in sync with
/// `contracts/src/libraries/VaultTypes.sol` and the executor's decoder.
fn trade_executed_topic() -> B256 {
    keccak256("TradeExecuted(address,uint256,uint256,address,bytes32)".as_bytes())
}

// ── Pure classification ──────────────────────────────────────────────────────

/// Chain facts gathered from one receipt candidate for the staged intent.
pub(super) struct ReceiptFacts {
    pub tx_hash: String,
    pub status_success: bool,
    pub to: Option<Address>,
    pub block_number: u64,
    /// The receipt's `TradeExecuted` log for this intent, if present and
    /// structurally decodable.
    pub settlement: Option<SettlementLog>,
}

pub(super) struct SettlementLog {
    pub output_token: Address,
    pub output_gained_raw: String,
}

#[derive(Debug)]
pub(super) enum ReconcileOutcome {
    Filled {
        tx_hash: String,
        settlement: Settlement,
    },
    /// Nothing decisive yet; an optional human note replaces a stale one.
    StillPending {
        note: Option<String>,
    },
    Rejected {
        reason: String,
    },
    Unknown {
        note: String,
        tx_hash: Option<String>,
    },
}

/// Decide an outcome from one receipt's facts.
#[allow(clippy::too_many_arguments)]
pub(super) fn classify_receipt(
    facts: &ReceiptFacts,
    vault: Address,
    expected_output_token: Address,
    current_block: u64,
    confirmations: u64,
    spec: &InstrumentSpec,
    side: &str,
    quantity: &str,
    exact_spend: &str,
) -> ReconcileOutcome {
    let tx_hash = facts.tx_hash.clone();
    if !facts.status_success {
        return ReconcileOutcome::Rejected {
            reason: format!("transaction {tx_hash} reverted on chain"),
        };
    }
    if facts.to != Some(vault) {
        return ReconcileOutcome::Unknown {
            note: format!(
                "transaction {tx_hash} did not target this vault; refusing to claim its settlement"
            ),
            tx_hash: Some(tx_hash),
        };
    }
    let Some(log) = facts.settlement.as_ref() else {
        return ReconcileOutcome::Unknown {
            note: format!(
                "transaction {tx_hash} succeeded but carries no TradeExecuted event for this intent"
            ),
            tx_hash: Some(tx_hash),
        };
    };
    if log.output_token != expected_output_token {
        return ReconcileOutcome::Unknown {
            note: "settlement event paid an unexpected output token".to_string(),
            tx_hash: Some(tx_hash),
        };
    }
    if current_block.saturating_sub(facts.block_number) < confirmations {
        return ReconcileOutcome::StillPending {
            note: Some("settlement observed; awaiting confirmations".to_string()),
        };
    }
    match settlement_from_observation(spec, side, quantity, exact_spend, &log.output_gained_raw) {
        Some(settlement) => ReconcileOutcome::Filled {
            tx_hash,
            settlement,
        },
        None => ReconcileOutcome::Unknown {
            note: "settlement confirmed but its output could not be decoded".to_string(),
            tx_hash: Some(tx_hash),
        },
    }
}

/// The vault reports the intent unexecuted: it may still land before its
/// deadline; after that, it never can.
pub(super) fn classify_unexecuted(now: u64, deadline: u64) -> ReconcileOutcome {
    if now < deadline {
        ReconcileOutcome::StillPending { note: None }
    } else {
        ReconcileOutcome::Rejected {
            reason: "intent deadline expired without on-chain execution".to_string(),
        }
    }
}

pub(super) enum LogScanDecision {
    /// Exactly one settlement event matches the intent: fetch its receipt.
    Unique,
    Unknown(String),
}

/// The vault flags the intent executed but no tx hash is known: exactly one
/// matching settlement log is proof; zero or many is ambiguity.
pub(super) fn classify_log_scan(matching_logs: usize) -> LogScanDecision {
    match matching_logs {
        1 => LogScanDecision::Unique,
        0 => LogScanDecision::Unknown(
            "vault flags the intent executed but no TradeExecuted event was found".to_string(),
        ),
        many => LogScanDecision::Unknown(format!(
            "{many} settlements match this intent; refusing to pick one"
        )),
    }
}

// ── Chain probes ─────────────────────────────────────────────────────────────

impl ReceiptFacts {
    fn from_receipt(
        receipt: &alloy::rpc::types::TransactionReceipt,
        vault: Address,
        intent: B256,
        tx_hash: &str,
    ) -> Self {
        let topic0 = trade_executed_topic();
        let settlement = receipt.inner.logs().iter().find_map(|log| {
            let topics = log.topics();
            if log.address() != vault
                || topics.first() != Some(&topic0)
                || topics.get(2) != Some(&intent)
            {
                return None;
            }
            let data = log.data().data.as_ref();
            if data.len() < 96 {
                return None;
            }
            Some(SettlementLog {
                output_gained_raw: U256::from_be_slice(&data[32..64]).to_string(),
                output_token: Address::from_word(B256::from_slice(&data[64..96])),
            })
        });
        Self {
            tx_hash: tx_hash.to_string(),
            status_success: receipt.status(),
            to: receipt.to,
            block_number: receipt.block_number.unwrap_or(0),
            settlement,
        }
    }
}

/// Probe by a known tx hash: fetch the receipt and classify it.
#[allow(clippy::too_many_arguments)]
async fn probe_by_hash(
    provider: &impl Provider,
    vault: Address,
    expected_output_token: Address,
    intent: B256,
    tx_hash: B256,
    order: &DeskOrder,
    spec: &InstrumentSpec,
) -> Result<ReconcileOutcome, String> {
    let Some(receipt) = provider
        .get_transaction_receipt(tx_hash)
        .await
        .map_err(|err| format!("receipt fetch: {err}"))?
    else {
        return Ok(ReconcileOutcome::StillPending {
            note: Some("intent transaction broadcast but not yet on chain".to_string()),
        });
    };
    let current_block = provider
        .get_block_number()
        .await
        .map_err(|err| format!("block height: {err}"))?;
    let facts = ReceiptFacts::from_receipt(&receipt, vault, intent, &tx_hash.to_string());
    Ok(classify_receipt(
        &facts,
        vault,
        expected_output_token,
        current_block,
        required_confirmations(),
        spec,
        &order.side,
        &order.quantity,
        &order.amount_in,
    ))
}

/// Probe by the staged intent alone: ask the vault whether it executed this
/// exact intent, then scan for the settlement event if it says yes.
async fn probe_by_intent(
    provider: &impl Provider,
    vault: Address,
    expected_output_token: Address,
    intent: B256,
    order: &DeskOrder,
    spec: &InstrumentSpec,
) -> Result<ReconcileOutcome, String> {
    let executed = ITradingVault::new(vault, provider)
        .executedIntents(intent)
        .call()
        .await
        .map_err(|err| format!("executedIntents probe: {err}"))?;
    if !executed {
        return Ok(classify_unexecuted(now_secs(), order.deadline));
    }
    let logs = provider
        .get_logs(
            &Filter::new()
                .address(vault)
                .event_signature(trade_executed_topic())
                .topic2(intent)
                .from_block(0u64),
        )
        .await
        .map_err(|err| format!("settlement log scan: {err}"))?;
    match classify_log_scan(logs.len()) {
        LogScanDecision::Unique => {
            let tx_hash = logs[0]
                .transaction_hash
                .ok_or_else(|| "settlement log missing its transaction hash".to_string())?;
            probe_by_hash(
                provider,
                vault,
                expected_output_token,
                intent,
                tx_hash,
                order,
                spec,
            )
            .await
        }
        LogScanDecision::Unknown(note) => Ok(ReconcileOutcome::Unknown {
            note,
            tx_hash: None,
        }),
    }
}

async fn reconcile_chain(
    order: &DeskOrder,
    spec: &InstrumentSpec,
    rpc_url: &str,
) -> Result<ReconcileOutcome, String> {
    let vault: Address = order
        .vault_address
        .parse()
        .map_err(|err| format!("vault address: {err}"))?;
    let expected_output_token: Address = match order.side.as_str() {
        "buy" => &spec.base.address,
        _ => &spec.quote.address,
    }
    .parse()
    .map_err(|_| format!("instrument token address invalid for side {}", order.side))?;
    // Same shape as a tx hash: 0x + 64 hex chars for a 32-byte scalar.
    let intent: B256 = order
        .intent_hash
        .as_deref()
        .unwrap_or_default()
        .parse()
        .map_err(|err| format!("staged intent hash: {err}"))?;
    let provider = ProviderBuilder::new().connect_http(
        rpc_url
            .parse()
            .map_err(|err| format!("bot rpc url: {err}"))?,
    );
    match order
        .venue_order_id
        .as_deref()
        .filter(|hash| valid_tx_hash(hash))
    {
        Some(tx_hash) => {
            let tx_hash: B256 = tx_hash
                .parse()
                .map_err(|err| format!("stored tx hash: {err}"))?;
            probe_by_hash(
                &provider,
                vault,
                expected_output_token,
                intent,
                tx_hash,
                order,
                spec,
            )
            .await
        }
        None => probe_by_intent(&provider, vault, expected_output_token, intent, order, spec).await,
    }
}

// ── Outcome application ──────────────────────────────────────────────────────

fn apply(order: &mut DeskOrder, outcome: ReconcileOutcome) {
    match outcome {
        ReconcileOutcome::Filled {
            tx_hash,
            settlement,
        } => {
            order.status = DeskOrderStatus::Filled;
            order.venue_order_id = Some(tx_hash);
            order.filled_quantity = Some(settlement.filled_quantity);
            order.quote_amount = Some(settlement.quote_amount);
            order.average_fill_price = settlement.average_fill_price;
            order.error = None;
            order.updated_at = now_secs();
        }
        ReconcileOutcome::StillPending { note } => {
            if let Some(note) = note {
                order.error = Some(note);
                order.updated_at = now_secs();
            }
        }
        ReconcileOutcome::Rejected { reason } => {
            order.status = DeskOrderStatus::Rejected;
            order.error = Some(reason);
            order.updated_at = now_secs();
        }
        ReconcileOutcome::Unknown { note, tx_hash } => {
            order.status = DeskOrderStatus::Unknown;
            if let Some(hash) = tx_hash.filter(|hash| valid_tx_hash(hash)) {
                order.venue_order_id = Some(hash);
            }
            order.error = Some(note);
            order.updated_at = now_secs();
        }
    }
}

fn stored_response(order: &DeskOrder) -> Response {
    (StatusCode::OK, Json(order_json(order))).into_response()
}

/// `GET /api/trading-desk/orders/{clientOrderId}` body: the stored order,
/// reconciled against the chain when its outcome is still uncertain.
pub(super) async fn reconcile_get(state: &Arc<MultiBotTradingState>, order: DeskOrder) -> Response {
    // Only uncertain live orders can reconcile: paper outcomes can never be
    // confirmed on chain, terminal outcomes never change, and without a
    // staged intent hash there is nothing to prove against.
    if order.paper
        || order.status == DeskOrderStatus::Filled
        || order.status == DeskOrderStatus::Rejected
        || !order.intent_hash.as_deref().is_some_and(valid_tx_hash)
    {
        return stored_response(&order);
    }
    let Some(bot) = state
        .desk_resolve_bot
        .as_ref()
        .and_then(|resolve| resolve(&order.bot_id))
    else {
        return stored_response(&order);
    };
    // The staged identity is only trustworthy for the chain it was claimed
    // on; a bot moved to another chain must not inherit it.
    if bot.chain_id != order.chain_id {
        return stored_response(&order);
    }
    let Some(spec) = resolve_instrument(order.chain_id, &order.instrument) else {
        return stored_response(&order);
    };

    let outcome = match reconcile_chain(&order, &spec, &bot.rpc_url).await {
        Ok(outcome) => outcome,
        Err(note) => {
            // Best-effort: an RPC outage must not take the order read down.
            tracing::warn!(
                order = %order.client_order_id,
                note = %note,
                "trading-desk order reconciliation probe failed; returning stored state"
            );
            return stored_response(&order);
        }
    };
    if matches!(outcome, ReconcileOutcome::StillPending { note: None }) {
        return stored_response(&order);
    }

    let mut updated = order.clone();
    apply(&mut updated, outcome);
    let key = order_key(&updated.grant_id, &updated.client_order_id);
    {
        let _guard = ORDER_WRITE_LOCK.lock().expect("order write lock");
        // Never regress a record another writer already settled.
        if let Ok(Some(current)) = ORDERS.get(&key) {
            if current.status == DeskOrderStatus::Filled
                || current.status == DeskOrderStatus::Rejected
            {
                return stored_response(&current);
            }
        }
        let result = ORDERS
            .update(&key, |existing| *existing = updated.clone())
            .map(|_| ());
        if let Err(err) = result {
            tracing::error!(
                order = %updated.client_order_id,
                error = %err,
                "CRITICAL: trading-desk reconciled outcome could not be persisted; keeping stored state"
            );
            return stored_response(&order);
        }
    }
    stored_response(&updated)
}
