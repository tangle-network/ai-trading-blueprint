//! Periodic fee settlement logic.
//!
//! Iterates over active trading bots and calls `FeeDistributor.settleFees()`
//! for each one that has a configured vault and fee distributor address.

use alloy::primitives::Address;

/// Settle fees for all active trading bots.
///
/// Requires a valid private key and FeeDistributor address.  Skips bots
/// where the vault address is zero or the chain client can't be created.
///
/// Called periodically from the main binary's background task loop.
pub async fn settle_all_fees() {
    let fee_distributor_address = match crate::context::operator_context() {
        Some(ctx) if !ctx.fee_distributor_address.is_empty() => {
            match ctx.fee_distributor_address.parse::<Address>() {
                Ok(addr) => addr,
                Err(_) => return,
            }
        }
        _ => return,
    };

    let ctx = match crate::context::operator_context() {
        Some(c) => c,
        None => return,
    };

    if ctx.private_key.is_empty() {
        return;
    }

    let bots = match crate::state::bots() {
        Ok(store) => match store.values() {
            Ok(list) => list,
            Err(_) => return,
        },
        Err(_) => return,
    };

    for bot in &bots {
        if !bot.trading_active {
            continue;
        }

        let vault_addr: Address = match bot.vault_address.parse() {
            Ok(a) if a != Address::ZERO => a,
            _ => continue,
        };

        let rpc_url = if bot.rpc_url.is_empty() {
            std::env::var("RPC_URL").unwrap_or_else(|_| "http://localhost:8545".to_string())
        } else {
            bot.rpc_url.clone()
        };

        let chain = match trading_runtime::chain::ChainClient::new(
            &rpc_url,
            &ctx.private_key,
            bot.chain_id,
        ) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Fee settlement skipped for {}: ChainClient error: {e}", bot.id);
                continue;
            }
        };

        // Use the vault's asset token as the fee token
        // In production, we'd query vault.asset() — for now, read from env or skip
        let fee_token: Address = std::env::var("FEE_TOKEN_ADDRESS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(Address::ZERO);

        if fee_token == Address::ZERO {
            continue;
        }

        match crate::on_chain::settle_fees(&chain, fee_distributor_address, vault_addr, fee_token)
            .await
        {
            Ok((perf, mgmt)) => {
                tracing::info!(
                    "Fee settlement for {}: perf={perf}, mgmt={mgmt}",
                    bot.id
                );
            }
            Err(e) => {
                tracing::warn!("Fee settlement failed for {}: {e}", bot.id);
            }
        }
    }
}
