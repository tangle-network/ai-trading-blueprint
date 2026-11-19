//! Desk-credential surface: account, order submission/replay, and connection
//! management, plus the order math they share.

use super::*;

// ── Order math ───────────────────────────────────────────────────────────────

pub(super) struct PlannedOrder {
    pub(super) token_in: String,
    pub(super) token_out: String,
    pub(super) amount_in: String,
    pub(super) min_amount_out: String,
}

/// Convert a human quantity + limit price into exact executor inputs.
///
/// buy:  spend ≤ quantity × limitPrice quote; receive exactly `quantity`
///       base → `min_amount_out` is `quantity` verbatim (no rounding).
/// sell: spend exactly `quantity` base; receive ≥ quantity × limitPrice
///       quote, floored to the quote token's decimals.
///
/// Rejects any order whose legs cannot be represented exactly in the
/// tokens' decimals (precision loss = rejection, never silent rounding).
pub(super) fn plan_order(
    spec: &InstrumentSpec,
    side: &str,
    quantity: Decimal,
    limit_price: Decimal,
) -> Result<PlannedOrder, String> {
    if quantity <= Decimal::ZERO || limit_price <= Decimal::ZERO {
        return Err("quantity and limitPrice must be positive".to_string());
    }

    match side {
        "buy" => {
            if quantity.scale() > spec.base.decimals as u32 {
                return Err(format!(
                    "quantity has more decimals than {} supports ({})",
                    spec.base.symbol, spec.base.decimals
                ));
            }
            let spend = quantity * limit_price;
            if spend.scale() > spec.quote.decimals as u32 {
                return Err(format!(
                    "quantity × limitPrice has more decimals than {} supports ({})",
                    spec.quote.symbol, spec.quote.decimals
                ));
            }
            Ok(PlannedOrder {
                token_in: spec.quote.address.clone(),
                token_out: spec.base.address.clone(),
                amount_in: spend.normalize().to_string(),
                min_amount_out: quantity.normalize().to_string(),
            })
        }
        "sell" => {
            if quantity.scale() > spec.base.decimals as u32 {
                return Err(format!(
                    "quantity has more decimals than {} supports ({})",
                    spec.base.symbol, spec.base.decimals
                ));
            }
            let proceeds = quantity * limit_price;
            if proceeds.scale() > spec.quote.decimals as u32 {
                return Err(format!(
                    "quantity × limitPrice has more decimals than {} supports ({})",
                    spec.quote.symbol, spec.quote.decimals
                ));
            }
            Ok(PlannedOrder {
                token_in: spec.base.address.clone(),
                token_out: spec.quote.address.clone(),
                amount_in: quantity.normalize().to_string(),
                min_amount_out: proceeds.normalize().to_string(),
            })
        }
        _ => Err("side must be buy or sell".to_string()),
    }
}

/// Canonical intent hash for a desk order: identifies the order uniquely
/// for the executor's dedup while remaining the standard intent hash of
/// what will actually execute.
fn desk_intent_hash(
    bot: &DeskBotRecord,
    planned: &PlannedOrder,
    deadline: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let intent = trading_runtime::TradeIntentBuilder::new()
        .strategy_id(DESK_STRATEGY_ID)
        .action(trading_runtime::Action::Swap)
        .token_in(&planned.token_in)
        .token_out(&planned.token_out)
        .amount_in(planned.amount_in.parse().ok()?)
        .min_amount_out(planned.min_amount_out.parse().ok()?)
        .target_protocol(DESK_PROTOCOL)
        .chain_id(bot.chain_id)
        .metadata(serde_json::Value::Null)
        .build()
        .ok()?;
    let mut intent = intent;
    intent.deadline = deadline;
    Some(trading_runtime::intent::hash_intent(&intent))
}

/// Settlement amounts derived from an observed on-chain output, in canonical
/// decimal strings the consumer can bound-check.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Settlement {
    pub(super) filled_quantity: String,
    pub(super) quote_amount: String,
    pub(super) average_fill_price: Option<String>,
}

pub(super) fn settlement_from_observation(
    spec: &InstrumentSpec,
    side: &str,
    quantity: &str,
    exact_spend: &str,
    raw_output: &str,
) -> Option<Settlement> {
    let average = |quote: &str, filled: &str| -> Option<String> {
        let quote = quote.parse::<Decimal>().ok()?;
        let filled = filled.parse::<Decimal>().ok()?;
        if filled <= Decimal::ZERO {
            return None;
        }
        Some((quote / filled).round_dp(18).normalize().to_string())
    };
    match side {
        // buy: exact quote spend in, observed base out.
        "buy" => {
            let filled = raw_units_to_decimal(raw_output, spec.base.decimals)?;
            let quote = exact_spend.to_string();
            if filled == "0" || quote == "0" {
                return None;
            }
            Some(Settlement {
                average_fill_price: average(&quote, &filled),
                filled_quantity: filled,
                quote_amount: quote,
            })
        }
        // sell: exact base spend in (the full quantity), observed quote out.
        "sell" => {
            let filled = quantity.to_string();
            let quote = raw_units_to_decimal(raw_output, spec.quote.decimals)?;
            if filled == "0" || quote == "0" {
                return None;
            }
            Some(Settlement {
                average_fill_price: average(&quote, &filled),
                filled_quantity: filled,
                quote_amount: quote,
            })
        }
        _ => None,
    }
}

// ── Handlers: desk credential surface ────────────────────────────────────────

/// `GET /api/trading-desk/account`
///
/// Shape follows the Trading consumer contract: `accountId` is the vault
/// address (lowercase), `instruments` is an array of canonical symbol
/// strings, `expiresAt` is RFC 3339.
pub(super) async fn account(
    State(state): State<Arc<MultiBotTradingState>>,
    headers: HeaderMap,
) -> Response {
    let (grant, bot) = match desk_grant(&state, &headers) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let eligibility = check_eligibility(&state, &grant.bot_id, &grant.owner_address);
    if let Err(response) = eligibility.require() {
        return response;
    }

    (
        StatusCode::OK,
        Json(json!({
            "accountId": bot.vault_address.to_lowercase(),
            "botId": bot.bot_id,
            "connectionId": grant.grant_id,
            "chainId": grant.chain_id,
            "network": grant.network,
            "execution": "atomic-spot-swap",
            "quoteCurrency": QUOTE_CURRENCY,
            "instruments": instrument_names_for_chain(grant.chain_id),
            "instrumentDetails": instrument_details_for_chain(grant.chain_id),
            "expiresAt": rfc3339(grant.expires_at),
            "issuedAt": rfc3339(grant.issued_at),
            "paper": bot.paper_trade,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OrderRequest {
    client_order_id: String,
    instrument: String,
    side: String,
    quantity: Decimal,
    limit_price: Decimal,
}

/// `POST /api/trading-desk/orders`
///
/// Atomic spot swap limited by the envelope policy. The order is claimed
/// durably before execution; identical replays return the stored result and
/// never re-execute.
pub(super) async fn submit_order(
    State(state): State<Arc<MultiBotTradingState>>,
    headers: HeaderMap,
    Json(body): Json<OrderRequest>,
) -> Response {
    let (grant, bot) = match desk_grant(&state, &headers) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let eligibility = check_eligibility(&state, &grant.bot_id, &grant.owner_address);
    if let Err(response) = eligibility.require() {
        return response;
    }

    let client_order_id = match uuid::Uuid::parse_str(&body.client_order_id) {
        Ok(parsed) => parsed.to_string(),
        Err(_) => return desk_error(StatusCode::BAD_REQUEST, "clientOrderId must be a UUID"),
    };
    let spec = match resolve_instrument(grant.chain_id, &body.instrument) {
        Some(spec) if spec.name.eq_ignore_ascii_case(&body.instrument) => spec,
        Some(_) => {
            return desk_error(
                StatusCode::BAD_REQUEST,
                &format!(
                    "unknown instrument {} for chain {}",
                    body.instrument, grant.chain_id
                ),
            );
        }
        None => {
            return desk_error(
                StatusCode::BAD_REQUEST,
                &format!(
                    "unknown instrument {} for chain {}",
                    body.instrument, grant.chain_id
                ),
            );
        }
    };
    let planned = match plan_order(&spec, &body.side, body.quantity, body.limit_price) {
        Ok(planned) => planned,
        Err(message) => return desk_error(StatusCode::BAD_REQUEST, &message),
    };

    // Stage the execution identity before the durable claim: reconciliation
    // must be able to prove or refute this exact intent on chain even if the
    // process dies between claim and outcome persistence.
    let deadline =
        chrono::Utc::now() + chrono::Duration::seconds(state.validation_deadline_secs as i64);
    let deadline_ts = deadline.timestamp() as u64;
    let intent_hash = match desk_intent_hash(&bot, &planned, deadline) {
        Some(hash) => hash,
        None => return desk_error(StatusCode::INTERNAL_SERVER_ERROR, "intent hashing failed"),
    };

    let key = order_key(&grant.grant_id, &client_order_id);
    let now = now_secs();

    // Durable claim: insert only if absent, under the write lock. A
    // concurrent duplicate or a post-crash replay resolves to the stored
    // record below instead of executing twice.
    let claim = {
        let _guard = ORDER_WRITE_LOCK.lock().expect("order write lock");
        match ORDERS.get(&key) {
            Ok(Some(stored)) => Ok(Some(stored)),
            Ok(None) => {
                let record = DeskOrder {
                    grant_id: grant.grant_id.clone(),
                    bot_id: grant.bot_id.clone(),
                    network: grant.network.clone(),
                    chain_id: grant.chain_id,
                    vault_address: bot.vault_address.clone(),
                    client_order_id: client_order_id.clone(),
                    instrument: spec.name.clone(),
                    side: body.side.clone(),
                    quantity: body.quantity.normalize().to_string(),
                    limit_price: body.limit_price.normalize().to_string(),
                    amount_in: planned.amount_in.clone(),
                    min_amount_out: planned.min_amount_out.clone(),
                    intent_hash: Some(intent_hash.clone()),
                    deadline: deadline_ts,
                    status: DeskOrderStatus::Pending,
                    venue_order_id: None,
                    filled_quantity: None,
                    quote_amount: None,
                    average_fill_price: None,
                    paper: bot.paper_trade,
                    error: None,
                    created_at: now,
                    updated_at: now,
                };
                match ORDERS.insert(key.clone(), record) {
                    Ok(()) => Ok(None),
                    Err(err) => Err(desk_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &format!("order store: {err}"),
                    )),
                }
            }
            Err(err) => Err(desk_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("order store: {err}"),
            )),
        }
    };
    let (stored, claimed) = match claim {
        Err(response) => return response,
        Ok(Some(stored)) => (stored, false),
        Ok(None) => (
            ORDERS
                .get(&key)
                .ok()
                .flatten()
                .expect("just-inserted order"),
            true,
        ),
    };

    if !claimed {
        // Idempotent replay: same payload returns the stored result; a
        // different payload under the same id is a client bug.
        let same = stored.side == body.side
            && stored.instrument.eq_ignore_ascii_case(&body.instrument)
            && stored.quantity == body.quantity.normalize().to_string()
            && stored.limit_price == body.limit_price.normalize().to_string();
        if !same {
            return desk_error(
                StatusCode::CONFLICT,
                "clientOrderId already used with a different order",
            );
        }
        return (StatusCode::OK, Json(order_json(&stored))).into_response();
    }

    // Build the executor request and run it through the same path as the
    // per-bot /execute route (envelope checks, policy limits, paper/live).
    let validation = ValidationPayload {
        // The desk's authority is the verified wallet envelope, not validator
        // consensus; `approved` is required by the executor's request gate.
        approved: true,
        aggregate_score: 100,
        intent_hash,
        execution_hash: format!("0x{}", "00".repeat(32)),
        deadline: Some(deadline_ts),
        // Paper bots need the explicit paper-mode bypass (no validator
        // signatures exist for a desk order); live bots rely on the envelope.
        validator_responses: if bot.paper_trade {
            vec![crate::routes::execute::ValidatorResponsePayload {
                validator: crate::routes::validate::PAPER_MODE_VALIDATOR.to_string(),
                score: 100,
                reasoning: "trading-desk order".to_string(),
                signature: String::new(),
                chain_id: None,
                verifying_contract: None,
                validated_at: None,
            }]
        } else {
            Vec::new()
        },
        simulation: None,
    };
    let execute_request = ExecuteRequest {
        intent: IntentPayload {
            strategy_id: DESK_STRATEGY_ID.to_string(),
            action: "swap".to_string(),
            token_in: planned.token_in.clone(),
            token_out: planned.token_out.clone(),
            amount_in: planned.amount_in.clone(),
            min_amount_out: planned.min_amount_out.clone(),
            target_protocol: DESK_PROTOCOL.to_string(),
            amount_format: Some(AmountFormat::Human),
            metadata: serde_json::Value::Null,
        },
        validation,
    };

    let http_request = axum::http::Request::builder()
        .method(axum::http::Method::POST)
        .uri("/execute")
        .header("content-type", "application/json")
        .extension(bot.bot_context())
        .body(axum::body::Body::from(
            serde_json::to_vec(&execute_request).expect("serialize execute request"),
        ))
        .expect("build execute request");

    let outcome =
        crate::routes::execute::execute_multi_bot(State(Arc::clone(&state)), http_request).await;

    let mut record = ORDERS
        .get(&key)
        .ok()
        .flatten()
        .expect("claimed order exists");
    record.updated_at = now_secs();
    match outcome {
        Ok(axum::Json(response)) => {
            record.paper = response.paper_trade;
            let tx_hash = if valid_tx_hash(&response.tx_hash) {
                Some(response.tx_hash.clone())
            } else {
                None
            };
            if response.paper_trade {
                // A paper result is not chain settlement: the outcome exists
                // but can never be confirmed on chain.
                record.status = DeskOrderStatus::Unknown;
                record.venue_order_id = None;
                record.error = Some(
                    "paper swap recorded; paper results are never reported as filled".to_string(),
                );
            } else if tx_hash.is_some()
                && response.block_number.is_some()
                && response.amount_out_raw.is_some()
            {
                // Confirmed settlement identified by a valid tx hash: derive
                // the fill amounts from the observed output, never from the
                // order terms alone. A settlement without a usable tx hash
                // stays pending for GET reconciliation to prove.
                match settlement_from_observation(
                    &spec,
                    &body.side,
                    &record.quantity,
                    &planned.amount_in,
                    response.amount_out_raw.as_deref().unwrap_or_default(),
                ) {
                    Some(settlement) => {
                        record.status = DeskOrderStatus::Filled;
                        record.venue_order_id = tx_hash;
                        record.filled_quantity = Some(settlement.filled_quantity);
                        record.quote_amount = Some(settlement.quote_amount);
                        record.average_fill_price = settlement.average_fill_price;
                    }
                    None => {
                        record.status = DeskOrderStatus::Unknown;
                        record.venue_order_id = tx_hash;
                        record.error = Some(
                            "settlement confirmed but its output could not be decoded".to_string(),
                        );
                    }
                }
            } else {
                // Submitted without an observed settlement yet.
                record.status = DeskOrderStatus::Pending;
                record.venue_order_id = tx_hash;
            }
        }
        Err((status, message)) => {
            // Submission-boundary classification. Only a definitive
            // executor refusal (4xx other than 409) proves no transaction
            // was ever built or sent: that is a rejection. A 409 is the
            // executor's dedup replay of this exact intent (a prior attempt
            // may have landed), and a 5xx failed after the submission
            // boundary where a transaction may already be on chain — both
            // stay pending for GET reconciliation, never reported rejected.
            match classify_executor_error(status) {
                ExecutorErrorClass::DefinitiveRejection => {
                    record.status = DeskOrderStatus::Rejected;
                    record.error = Some(format!("{status}: {message}"));
                }
                ExecutorErrorClass::SubmissionUncertain => {
                    record.status = DeskOrderStatus::Pending;
                    record.venue_order_id = None;
                    record.error = Some(format!(
                        "{status}: {message}; outcome uncertain, reconciliation pending"
                    ));
                }
            }
        }
    }
    if let Err(err) = persist_order(&key, &record) {
        // The staged claim is still `pending` in the store; never report a
        // terminal outcome that is not durable. The client polls GET, which
        // reconciles from the chain by the staged intent hash.
        tracing::error!(
            order = %key,
            error = %err,
            "CRITICAL: trading-desk order outcome could not be persisted; staged record left pending"
        );
        return desk_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "order outcome could not be persisted; poll the order to reconcile",
        );
    }

    let status = if record.status == DeskOrderStatus::Rejected {
        StatusCode::UNPROCESSABLE_ENTITY
    } else {
        StatusCode::OK
    };
    (status, Json(order_json(&record))).into_response()
}

/// Classify an executor error by whether a transaction could exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExecutorErrorClass {
    /// The executor definitively refused before any transaction was built
    /// or sent (4xx other than 409).
    DefinitiveRejection,
    /// The request crossed the submission boundary: the executor's dedup
    /// saw this exact intent before (409), or execution failed after
    /// submission (5xx) where a transaction may already be on chain.
    SubmissionUncertain,
}

pub(super) fn classify_executor_error(status: StatusCode) -> ExecutorErrorClass {
    if status == StatusCode::CONFLICT || status.is_server_error() {
        ExecutorErrorClass::SubmissionUncertain
    } else {
        ExecutorErrorClass::DefinitiveRejection
    }
}

/// Persist an order outcome, retrying once: a terminal status reported to
/// the client must be durable.
fn persist_order(key: &str, record: &DeskOrder) -> Result<(), String> {
    let mut last_err = None;
    for _ in 0..2 {
        match ORDERS
            .update(key, |existing| *existing = record.clone())
            .map(|_| ())
        {
            Ok(()) => return Ok(()),
            Err(err) => last_err = Some(err.to_string()),
        }
    }
    Err(last_err.unwrap_or_else(|| "order store update failed".to_string()))
}

/// Order wire shape per the Trading consumer contract: immutable
/// `clientOrderId`/`instrument`/`side`/canonical `quantity`+`limitPrice`,
/// `status` ∈ pending/filled/rejected/unknown, `venueOrderId` a tx hash when
/// present, and settlement amounts only when actually observed on chain.
pub(super) fn order_json(order: &DeskOrder) -> serde_json::Value {
    json!({
        "accountId": order.vault_address.to_lowercase(),
        "botId": order.bot_id,
        "connectionId": order.grant_id,
        "network": order.network,
        "clientOrderId": order.client_order_id,
        "instrument": order.instrument,
        "side": order.side,
        "quantity": order.quantity,
        "limitPrice": order.limit_price,
        "status": order.status.as_str(),
        "venueOrderId": order.venue_order_id,
        "filledQuantity": order.filled_quantity,
        "quoteAmount": order.quote_amount,
        "averageFillPrice": order.average_fill_price,
        "paper": order.paper,
        "reason": order.error,
        "createdAt": rfc3339(order.created_at),
        "updatedAt": rfc3339(order.updated_at),
    })
}

/// `GET /api/trading-desk/orders/{clientOrderId}`
///
/// Returns the durable order state. `filled` is reported only from observed
/// on-chain settlement; `pending` means submitted but not yet confirmed, and
/// `unknown` marks outcomes that cannot be confirmed on chain (paper swaps,
/// undecodable settlements).
pub(super) async fn get_order(
    State(state): State<Arc<MultiBotTradingState>>,
    Path(client_order_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (grant, _) = match desk_grant(&state, &headers) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let client_order_id = match uuid::Uuid::parse_str(&client_order_id) {
        Ok(parsed) => parsed.to_string(),
        Err(_) => return desk_error(StatusCode::BAD_REQUEST, "clientOrderId must be a UUID"),
    };
    match ORDERS.get(&order_key(&grant.grant_id, &client_order_id)) {
        Ok(Some(order)) => reconcile::reconcile_get(&state, order).await,
        Ok(None) => desk_error(StatusCode::NOT_FOUND, "no such order for this connection"),
        Err(err) => desk_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("order store: {err}"),
        ),
    }
}

// ── Handlers: connection management ──────────────────────────────────────────

/// `DELETE /api/trading-desk/connection` (desk credential) — Trading
/// revoking its own connection.
pub(super) async fn delete_connection(
    State(state): State<Arc<MultiBotTradingState>>,
    headers: HeaderMap,
) -> Response {
    let (grant, _) = match desk_grant(&state, &headers) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    if let Err(err) = revoke_grant(&grant.grant_id) {
        return desk_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("grant store: {err}"),
        );
    }
    StatusCode::NO_CONTENT.into_response()
}

fn revoke_grant(grant_id: &str) -> Result<(), String> {
    let _guard = GRANT_WRITE_LOCK.lock().expect("grant write lock");
    GRANTS
        .update(&format!("grant:{grant_id}"), |grant| {
            grant.revoked_at = Some(now_secs());
        })
        .map(|_| ())
        .map_err(|err| err.to_string())
}

/// `GET /api/trading-desk/connections` (wallet session) — list this wallet's
/// desk grants so the owner can audit and revoke from Arena.
pub(super) async fn list_connections(
    State(state): State<Arc<MultiBotTradingState>>,
    headers: HeaderMap,
) -> Response {
    let address = match wallet_session_address(&headers) {
        Ok(address) => address,
        Err(response) => return response,
    };
    let grants = GRANTS.values().unwrap_or_default();
    let connections: Vec<serde_json::Value> = grants
        .iter()
        .filter(|grant| grant.owner_address.eq_ignore_ascii_case(&address))
        .map(|grant| connection_json(&state, grant))
        .collect();
    (StatusCode::OK, Json(json!({ "connections": connections }))).into_response()
}

fn connection_json(state: &MultiBotTradingState, grant: &DeskGrant) -> serde_json::Value {
    let bot_name = state
        .desk_resolve_bot
        .as_ref()
        .and_then(|resolve| resolve(&grant.bot_id))
        .map(|bot| bot.name)
        .unwrap_or_else(|| grant.bot_id.clone());
    json!({
        "connectionId": grant.grant_id,
        "botId": grant.bot_id,
        "botName": bot_name,
        "network": grant.network,
        "chainId": grant.chain_id,
        "createdAt": grant.issued_at,
        "expiresAt": grant.expires_at,
        "revokedAt": grant.revoked_at,
        "active": grant.is_active(),
        "phase": match &grant.phase {
            GrantPhase::Pending { .. } => "pending",
            GrantPhase::Active { .. } => "active",
        },
    })
}

/// `DELETE /api/trading-desk/connections/{grant_id}` (wallet session) — the
/// owner revoking any grant for their bots.
pub(super) async fn revoke_connection(
    State(_state): State<Arc<MultiBotTradingState>>,
    Path(grant_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let address = match wallet_session_address(&headers) {
        Ok(address) => address,
        Err(response) => return response,
    };
    let grant = GRANTS.get(&format!("grant:{grant_id}")).ok().flatten();
    let Some(grant) = grant else {
        return desk_error(StatusCode::NOT_FOUND, "no such connection");
    };
    if !grant.owner_address.eq_ignore_ascii_case(&address) {
        return desk_error(
            StatusCode::FORBIDDEN,
            "connection belongs to another wallet",
        );
    }
    if let Err(err) = revoke_grant(&grant.grant_id) {
        return desk_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("grant store: {err}"),
        );
    }
    StatusCode::NO_CONTENT.into_response()
}
