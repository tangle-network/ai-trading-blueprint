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
    Ok(ChainOrder {
        from_block: block,
        router,
        token_in: order.token_in.parse().map_err(|_| "invalid input token")?,
        token_out: order
            .token_out
            .parse()
            .map_err(|_| "invalid output token")?,
        base_decimals: spec.base.decimals,
        quote_decimals: spec.quote.decimals,
    })
}

enum Observed {
    Pending,
    Expired,
    Filled(String, Settlement),
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
        .block(BlockId::hash(safe.header.hash))
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
            // Immutable once executed. Locate the transition in logarithmic reads, even if the desk spent weeks offline.
            let (mut lo, mut hi) = (binding.from_block, height);
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                let seen = contract
                    .executedIntents(intent)
                    .block(BlockId::number(mid))
                    .call()
                    .await
                    .map_err(|_| "historical vault state unavailable")?;
                if seen {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            let logs = rpc
                .get_logs(&filter.from_block(lo).to_block(lo))
                .await
                .map_err(|_| "settlement log unavailable")?;
            let [event] = logs.as_slice() else {
                return Ok(Observed::Pending);
            };
            if event.removed {
                return Ok(Observed::Pending);
            }
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
    let output = U256::from_be_slice(&bytes[32..64]).to_string();
    let Some(result) = settlement_from_observation(
        spec,
        &order.side,
        &order.quantity,
        &order.amount_in,
        &output,
    ) else {
        return Ok(Observed::Pending);
    };
    let received = if order.side == "buy" {
        &result.filled_quantity
    } else {
        &result.quote_amount
    };
    let measured: Decimal = received
        .parse()
        .map_err(|_| "settlement quantity out of range")?;
    let floor: Decimal = order
        .min_amount_out
        .parse()
        .map_err(|_| "invalid staged minimum")?;
    if measured < floor {
        return Ok(Observed::Pending);
    }
    Ok(Observed::Filled(hash.to_string(), result))
}

pub(super) async fn reconcile_get(state: &Arc<MultiBotTradingState>, order: DeskOrder) -> Response {
    let stored = |o: &DeskOrder| (StatusCode::OK, Json(order_json(o))).into_response();
    let terminal = |o: &DeskOrder| {
        matches!(
            o.status,
            DeskOrderStatus::Filled | DeskOrderStatus::Rejected
        )
    };
    if order.paper || terminal(&order) {
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
    if terminal(&current) {
        return stored(&current);
    }
    match observed {
        Observed::Filled(hash, fill) => {
            current.status = DeskOrderStatus::Filled;
            current.venue_order_id = Some(hash);
            current.filled_quantity = Some(fill.filled_quantity);
            current.quote_amount = Some(fill.quote_amount);
            current.average_fill_price = fill.average_fill_price;
            current.error = None;
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
