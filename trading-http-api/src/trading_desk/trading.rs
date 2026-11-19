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
            let spend = quantity
                .checked_mul(limit_price)
                .ok_or("order notional is too large")?
                .normalize();
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
            let proceeds = quantity
                .checked_mul(limit_price)
                .ok_or("order notional is too large")?
                .normalize();
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

/// Bind the desk's approved swap to the request that the executor will verify.
fn bind_swap_request(
    request: &mut ExecuteRequest,
    bot: &crate::BotContext,
) -> Result<(), (StatusCode, String)> {
    let protocol_chain_id = crate::protocol_chain_id_for_protocol_from_config(
        bot.chain_id,
        &bot.strategy_config,
        &request.intent.target_protocol,
    );
    let intent = crate::routes::execute::parse_execute_request(request, Some(protocol_chain_id))?;
    (
        request.validation.intent_hash,
        request.validation.execution_hash,
    ) = crate::routes::execute::expected_validation_hashes(
        &intent,
        &bot.vault_address,
        Some(protocol_chain_id),
        bot.chain_id,
        !bot.paper_trade,
    )?;
    Ok(())
}

/// Both legs are measured in the same vault transaction.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Settlement {
    pub(super) filled_quantity: String,
    pub(super) quote_amount: String,
    pub(super) average_fill_price: Option<String>,
}

pub(super) fn settlement_from_observation(
    spec: &InstrumentSpec,
    side: &str,
    raw_input: &str,
    raw_output: &str,
) -> Option<Settlement> {
    let (base, quote) = match side {
        "buy" => (raw_output, raw_input),
        "sell" => (raw_input, raw_output),
        _ => return None,
    };
    let filled_quantity = raw_units_to_decimal(base, spec.base.decimals)?;
    let quote_amount = raw_units_to_decimal(quote, spec.quote.decimals)?;
    let base: Decimal = filled_quantity.parse().ok()?;
    let quote: Decimal = quote_amount.parse().ok()?;
    if base <= Decimal::ZERO || quote <= Decimal::ZERO {
        return None;
    }
    let average_fill_price = quote
        .checked_div(base)
        .map(|v| v.round_dp(18))
        .filter(|v| *v > Decimal::ZERO)
        .map(|v| v.normalize().to_string());
    Some(Settlement {
        filled_quantity,
        quote_amount,
        average_fill_price,
    })
}

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

    let key = order_key(&grant.grant_id, &client_order_id);
    let replay = |stored: &DeskOrder| {
        if stored.side != body.side
            || stored.instrument != spec.name
            || stored.quantity != body.quantity.normalize().to_string()
            || stored.limit_price != body.limit_price.normalize().to_string()
        {
            return desk_error(
                StatusCode::CONFLICT,
                "clientOrderId already used with a different order",
            );
        }
        (StatusCode::OK, Json(order_json(stored))).into_response()
    };
    match ORDERS.get(&key) {
        Ok(Some(stored)) => return replay(&stored),
        Ok(None) => (),
        Err(_) => return desk_error(StatusCode::SERVICE_UNAVAILABLE, "order journal unavailable"),
    }
    let now = now_secs();
    let mut deadline_ts = now
        .saturating_add(state.validation_deadline_secs)
        .min(grant.expires_at);
    let chain_order = if bot.paper_trade {
        None
    } else {
        let Some((swap, expires_at)) = &eligibility.verified_swap else {
            return desk_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "signed swap enforcement required",
            );
        };
        if planned.token_in.parse().ok() != Some(swap.token_in)
            || planned.token_out.parse().ok() != Some(swap.token_out)
        {
            return desk_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "the envelope does not authorize these swap legs",
            );
        }
        deadline_ts = deadline_ts.min(*expires_at);
        let check = super::reconcile::stage(&bot, &planned, swap.router, &spec);
        let start = match tokio::time::timeout(std::time::Duration::from_secs(5), check).await {
            Ok(Ok(snapshot)) => snapshot,
            _ => {
                return desk_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cannot verify the enrolled chain and vault",
                );
            }
        };
        Some(start)
    };
    if now_secs() >= deadline_ts {
        return desk_error(StatusCode::FORBIDDEN, "the trading authority has expired");
    }
    // Bind before reserving the order so an invalid swap never enters the journal.
    let validation = ValidationPayload {
        // The desk's authority is the verified wallet envelope, not validator
        // consensus; `approved` is required by the executor's request gate.
        approved: true,
        aggregate_score: 100,
        intent_hash: String::new(),
        execution_hash: String::new(),
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
    let mut execute_request = ExecuteRequest {
        intent: IntentPayload {
            strategy_id: DESK_STRATEGY_ID.to_string(),
            action: "swap".to_string(),
            token_in: planned.token_in,
            token_out: planned.token_out,
            amount_in: planned.amount_in.clone(),
            min_amount_out: planned.min_amount_out.clone(),
            target_protocol: DESK_PROTOCOL.to_string(),
            amount_format: Some(AmountFormat::Human),
            metadata: json!({"deskGrantId": grant.grant_id, "deskClientOrderId": client_order_id}),
        },
        validation,
    };

    let execution_context = bot.bot_context();
    if let Err((status, message)) = bind_swap_request(&mut execute_request, &execution_context) {
        return desk_error(status, &message);
    }
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
        amount_in: planned.amount_in,
        min_amount_out: planned.min_amount_out,
        intent_hash: Some(execute_request.validation.intent_hash.clone()),
        chain_order,
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
    {
        // The order reservation and wallet revocation share a boundary. Once reserved,
        // a submitted order remains reconcilable even when the owner stops the desk.
        let _grant_guard = GRANT_WRITE_LOCK.lock().expect("grant write lock");
        let current = match GRANTS.get(&format!("grant:{}", grant.grant_id)) {
            Ok(Some(current)) => current,
            _ => {
                return desk_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cannot confirm current trading authority",
                );
            }
        };
        match bound_grant_bot(&state, &current) {
            Ok(latest)
                if latest.trading_active
                    && latest.service_id == bot.service_id
                    && latest.rpc_url == bot.rpc_url =>
            {
                ()
            }
            Ok(_) => {
                return desk_error(
                    StatusCode::CONFLICT,
                    "operator changed during order preflight; review the desk",
                );
            }
            Err(response) => return response,
        }
        let _guard = ORDER_WRITE_LOCK.lock().expect("order write lock");
        match ORDERS.get(&key) {
            Ok(Some(stored)) => return replay(&stored),
            Ok(None) if ORDERS.insert(key.clone(), record.clone()).is_ok() => (),
            _ => {
                return desk_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cannot reserve this order in the journal",
                );
            }
        }
    }

    let http_request = axum::http::Request::builder()
        .method(axum::http::Method::POST)
        .uri("/execute")
        .header("content-type", "application/json")
        .extension(execution_context)
        .body(axum::body::Body::from(
            serde_json::to_vec(&execute_request).expect("serialize execute request"),
        ))
        .expect("build execute request");

    let outcome =
        crate::routes::execute::execute_multi_bot(State(Arc::clone(&state)), http_request).await;

    let stored = {
        let _guard = ORDER_WRITE_LOCK.lock().expect("order write lock");
        let mut latest = match ORDERS.get(&key) {
            Ok(Some(order)) => order,
            _ => {
                return desk_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "order journal unavailable; look up the original client order ID",
                );
            }
        };
        if latest.status.terminal() {
            return (StatusCode::OK, Json(order_json(&latest))).into_response();
        }
        match outcome {
            Ok(Json(reply)) if reply.paper_trade => {
                latest.paper = true;
                latest.status = DeskOrderStatus::Unknown;
                latest.error = Some("paper execution has no on-chain settlement".into());
            }
            Ok(Json(reply)) if valid_tx_hash(&reply.tx_hash) => {
                latest.venue_order_id = Some(reply.tx_hash)
            }
            Ok(_) => (),
            Err((status, _)) => {
                if latest.paper {
                    latest.status = DeskOrderStatus::Rejected;
                }
                latest.error = Some(format!("executor returned {status}"));
            }
        }
        latest.updated_at = now_secs();
        if ORDERS
            .update(&key, |existing| *existing = latest.clone())
            .is_err()
        {
            return desk_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "order outcome unavailable; look up the original client order ID",
            );
        }
        latest
    };
    super::reconcile::reconcile_get(&state, stored).await
}

/// Order wire shape per the Trading consumer contract: immutable
/// `clientOrderId`/`instrument`/`side`/canonical `quantity`+`limitPrice`,
/// `status` ∈ pending/filled/cancelled/rejected/unknown, `venueOrderId` a tx hash when
/// present, and settlement amounts only when actually observed on chain.
pub(super) fn order_json(order: &DeskOrder) -> serde_json::Value {
    json!({
        "accountId": order.vault_address.to_lowercase(),
        "botId": order.bot_id,
        "connectionId": order.grant_id,
        "network": order.network,
        "clientOrderId": order.client_order_id,
        "intentHash": order.intent_hash,
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
