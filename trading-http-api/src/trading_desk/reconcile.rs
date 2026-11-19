//! A desk acknowledgment becomes a fill only after the enrolled vault records this order's intent.
use super::trading::{PlannedOrder, Settlement, order_json, settlement_from_observation};
use super::*;
use alloy::eips::BlockId;
use alloy::primitives::{Address, B256, U256, keccak256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::Filter;
use trading_runtime::contracts::ITradingVault;

fn rpc(url: &str) -> Result<impl Provider + use<>, String> {
    Ok(ProviderBuilder::new().connect_http(url.parse().map_err(|_| "invalid operator RPC")?))
}

/// Capture the earliest possible settlement block before handing an order to the executor.
pub(super) async fn stage(
    bot: &DeskBotRecord,
    order: &PlannedOrder,
    router: Address,
    spec: &InstrumentSpec,
) -> Result<ChainOrder, String> {
    let provider = rpc(&bot.rpc_url)?;
    let vault: Address = bot.vault_address.parse().map_err(|_| "invalid vault")?;
    let (chain, block, code) = tokio::try_join!(
        provider.get_chain_id(),
        provider.get_block_number(),
        provider.get_code_at(vault)
    )
    .map_err(|_| "chain unavailable")?;
    if chain != bot.chain_id || vault.is_zero() || code.is_empty() {
        return Err("chain or vault mismatch".into());
    }
    ITradingVault::new(vault, &provider)
        .executedIntents(B256::ZERO)
        .call()
        .await
        .map_err(|_| "vault does not expose intent receipts")?;
    Ok(ChainOrder {
        from_block: block,
        router,
        token_in: order
            .input
            .token
            .parse()
            .map_err(|_| "invalid input token")?,
        token_out: order
            .output
            .token
            .parse()
            .map_err(|_| "invalid output token")?,
        base_decimals: spec.base.decimals,
        quote_decimals: spec.quote.decimals,
    })
}

enum Observed {
    Pending,
    Expired,
    Settled(String, Settlement, DeskOrderStatus),
    Unmeasured(String),
}

async fn settlement(
    order: &DeskOrder,
    binding: &ChainOrder,
    spec: &InstrumentSpec,
    url: &str,
) -> Result<Observed, String> {
    let rpc = rpc(url)?;
    let vault: Address = order
        .vault_address
        .parse()
        .map_err(|_| "invalid staged vault")?;
    let intent: B256 = order
        .intent_hash
        .as_deref()
        .unwrap_or("")
        .parse()
        .map_err(|_| "invalid staged intent")?;
    let (chain, tip) = tokio::try_join!(rpc.get_chain_id(), rpc.get_block_number())
        .map_err(|_| "chain unavailable")?;
    if chain != order.chain_id {
        return Err("RPC chain changed".into());
    }
    let confirmations = std::env::var("TRADING_DESK_ORDER_CONFIRMATIONS")
        .ok()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(1)
        .max(1);
    let Some(height) = tip
        .checked_sub(confirmations - 1)
        .filter(|h| *h >= binding.from_block)
    else {
        return Ok(Observed::Pending);
    };
    let safe = rpc
        .get_block_by_number(height.into())
        .await
        .map_err(|_| "checkpoint unavailable")?
        .ok_or("checkpoint unavailable")?;
    let contract = ITradingVault::new(vault, &rpc);
    let executed = contract
        .executedIntents(intent)
        .block(BlockId::hash_canonical(safe.header.hash))
        .call()
        .await
        .map_err(|_| "cannot read this vault at its checkpoint")?;
    if !executed {
        return Ok(if safe.header.timestamp > order.deadline {
            Observed::Expired
        } else {
            Observed::Pending
        });
    }
    let signature = keccak256("TradeExecuted(address,uint256,uint256,address,bytes32)");
    let filter = Filter::new()
        .address(vault)
        .event_signature(signature)
        .topic1(binding.router.into_word())
        .topic2(intent);
    let hash: B256 = match order.venue_order_id.as_deref().and_then(|s| s.parse().ok()) {
        Some(hash) => hash,
        None => {
            // Search the actual submission window. Even after a long outage, only a small range of
            // event logs is normally needed. Ordinary RPC nodes need no historical contract state.
            let mut start = binding.from_block;
            let event = loop {
                let end = start.saturating_add(511).min(height);
                let logs = rpc
                    .get_logs(&filter.clone().from_block(start).to_block(end))
                    .await
                    .map_err(|_| "settlement log unavailable")?;
                match logs.as_slice() {
                    [event] if !event.removed => break event.clone(),
                    [] if end < height => {
                        let last = rpc
                            .get_block_by_number(end.into())
                            .await
                            .map_err(|_| "log range unavailable")?
                            .ok_or("log range unavailable")?;
                        if last.header.timestamp > order.deadline {
                            return Ok(Observed::Pending);
                        }
                        start = end + 1;
                    }
                    _ => return Ok(Observed::Pending),
                }
            };
            event
                .transaction_hash
                .ok_or("settlement event has no transaction")?
        }
    };
    let Some(receipt) = rpc
        .get_transaction_receipt(hash)
        .await
        .map_err(|_| "receipt unavailable")?
    else {
        return Ok(Observed::Pending);
    };
    let Some(block) = receipt
        .block_number
        .filter(|n| *n >= binding.from_block && *n <= height)
    else {
        return Ok(Observed::Pending);
    };
    if !receipt.status() || receipt.to != Some(vault) || receipt.transaction_hash != hash {
        return Ok(Observed::Pending);
    }
    let canonical = rpc
        .get_block_by_number(block.into())
        .await
        .map_err(|_| "receipt block unavailable")?
        .ok_or("receipt block unavailable")?;
    if receipt.block_hash != Some(canonical.header.hash) {
        return Ok(Observed::Pending);
    }
    let topics = [signature, binding.router.into_word(), intent];
    let mut matches = receipt
        .inner
        .logs()
        .iter()
        .filter(|log| !log.removed && log.address() == vault && log.topics() == topics);
    let Some(event) = matches.next() else {
        return Ok(Observed::Pending);
    };
    if matches.next().is_some() {
        return Ok(Observed::Pending);
    }
    let bytes = event.data().data.as_ref();
    if bytes.len() != 96 || Address::from_word(B256::from_slice(&bytes[64..])) != binding.token_out
    {
        return Ok(Observed::Pending);
    }
    let unmeasured = || Observed::Unmeasured(hash.to_string());
    let output = U256::from_be_slice(&bytes[32..64]).to_string();
    let transfer = keccak256("Transfer(address,address,uint256)");
    let vault_word = vault.into_word();
    let (mut sent, mut returned) = (U256::ZERO, U256::ZERO);
    for log in receipt
        .inner
        .logs()
        .iter()
        .filter(|log| !log.removed && log.address() == binding.token_in)
    {
        let [event, from, to] = log.topics() else {
            continue;
        };
        if *event != transfer || (*from != vault_word && *to != vault_word) {
            continue;
        }
        let data = log.data().data.as_ref();
        if data.len() != 32 {
            return Ok(unmeasured());
        }
        let value = U256::from_be_slice(data);
        if *from == vault_word {
            sent = sent.checked_add(value).ok_or("invalid input transfers")?;
        }
        if *to == vault_word {
            returned = returned.checked_add(value).ok_or("invalid input refunds")?;
        }
    }
    let Some(input) = sent.checked_sub(returned) else {
        return Ok(unmeasured());
    };
    let Some(result) = settlement_from_observation(spec, &order.side, &input.to_string(), &output)
    else {
        return Ok(unmeasured());
    };
    let (paid, received) = if order.side == "buy" {
        (&result.quote_amount, &result.filled_quantity)
    } else {
        (&result.filled_quantity, &result.quote_amount)
    };
    let paid: Decimal = paid.parse().map_err(|_| "input amount out of range")?;
    let ceiling: Decimal = order
        .amount_in
        .parse()
        .map_err(|_| "invalid staged input")?;
    let measured: Decimal = received
        .parse()
        .map_err(|_| "settlement quantity out of range")?;
    let floor: Decimal = order
        .min_amount_out
        .parse()
        .map_err(|_| "invalid staged minimum")?;
    if measured < floor || paid > ceiling {
        return Ok(unmeasured());
    }
    let status = if order.side == "sell" && paid < ceiling {
        DeskOrderStatus::Cancelled
    } else {
        DeskOrderStatus::Filled
    };
    Ok(Observed::Settled(hash.to_string(), result, status))
}

pub(super) async fn reconcile_get(state: &Arc<MultiBotTradingState>, order: DeskOrder) -> Response {
    let stored = |o: &DeskOrder| (StatusCode::OK, Json(order_json(o))).into_response();
    if order.paper || order.status.terminal() {
        return stored(&order);
    }
    let (Some(binding), Some(spec), Some(bot)) = (
        order.chain_order.as_ref(),
        resolve_instrument(order.chain_id, &order.instrument),
        state
            .desk_resolve_bot
            .as_ref()
            .and_then(|resolve| resolve(&order.bot_id)),
    ) else {
        return stored(&order);
    };
    let (input, output) = if order.side == "buy" {
        (&spec.quote, &spec.base)
    } else {
        (&spec.base, &spec.quote)
    };
    if bot.chain_id != order.chain_id
        || spec.base.decimals != binding.base_decimals
        || spec.quote.decimals != binding.quote_decimals
        || input.address.parse().ok() != Some(binding.token_in)
        || output.address.parse().ok() != Some(binding.token_out)
    {
        return stored(&order);
    }
    let observed = match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        settlement(&order, binding, &spec, &bot.rpc_url),
    )
    .await
    {
        Ok(Ok(Observed::Pending)) | Err(_) => return stored(&order),
        Ok(Ok(other)) => other,
        Ok(Err(note)) => {
            tracing::warn!(order = %order.client_order_id, %note, "desk settlement unavailable");
            return stored(&order);
        }
    };
    let _guard = ORDER_WRITE_LOCK.lock().expect("order write lock");
    let key = order_key(&order.grant_id, &order.client_order_id);
    let Ok(Some(mut current)) = ORDERS.get(&key) else {
        return desk_error(StatusCode::SERVICE_UNAVAILABLE, "order journal unavailable");
    };
    if current.status.terminal() {
        return stored(&current);
    }
    match observed {
        Observed::Settled(hash, fill, status) => {
            current.status = status;
            current.venue_order_id = Some(hash);
            current.filled_quantity = Some(fill.filled_quantity);
            current.quote_amount = Some(fill.quote_amount);
            current.average_fill_price = fill.average_fill_price;
            current.error = (status == DeskOrderStatus::Cancelled).then(|| {
                "The swap settled. The unspent remainder stayed in the vault.".to_string()
            });
        }
        Observed::Unmeasured(hash) => {
            current.status = DeskOrderStatus::Unknown;
            current.venue_order_id = Some(hash);
            current.error = Some("The vault executed this intent. Its receipt does not establish both token amounts within the approved limits.".into());
        }
        Observed::Expired => {
            current.status = DeskOrderStatus::Rejected;
            current.error = Some(
                "the confirmed chain passed the order deadline without executing this intent"
                    .into(),
            );
        }
        Observed::Pending => return stored(&current),
    }
    current.updated_at = now_secs();
    match ORDERS.update(&key, |record| *record = current.clone()) {
        Ok(_) => stored(&current),
        Err(_) => desk_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "order outcome could not be recorded; refresh the original order",
        ),
    }
}
