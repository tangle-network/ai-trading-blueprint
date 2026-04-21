//! Token-amount heuristics shared by the execute + portfolio-synthesis paths.
//!
//! Callers generally pass trade amounts in the ERC-20 raw unit (10^decimals),
//! which is what on-chain contracts expect. For display and portfolio value,
//! we want human-scale amounts. This module applies a conservative heuristic:
//! if `amount` is a whole number ≥ 100k and the token is one we recognize,
//! divide by 10^decimals.
//!
//! Assumption: strategy runners never pass "100k" meaning "100k human units"
//! for known ERC-20 tokens — they pass raw units. The heuristic breaks only
//! if a caller passes human-scale amounts above 100k for a known token; if
//! that becomes a real use case, add an explicit `amount_unit` field on the
//! intent instead of tuning this heuristic further.

use rust_decimal::Decimal;

const NORMALIZE_THRESHOLD: i64 = 100_000;

pub fn normalize_trade_amount(chain_id: Option<u64>, token: &str, amount: Decimal) -> Decimal {
    if amount <= Decimal::ZERO
        || !amount.fract().is_zero()
        || amount < Decimal::new(NORMALIZE_THRESHOLD, 0)
    {
        return amount;
    }
    let Some(decimals) = known_token_decimals(chain_id, token) else {
        return amount;
    };
    amount / Decimal::from(10u64.pow(decimals as u32))
}

pub fn known_token_decimals(chain_id: Option<u64>, token: &str) -> Option<u8> {
    let token = token.trim().to_ascii_lowercase();
    match chain_id {
        // Base (8453) + Base Sepolia (84532): WETH has 18, USDC/USDbC has 6.
        Some(8453) | Some(84532) => match token.as_str() {
            "0x4200000000000000000000000000000000000006" => Some(18), // WETH
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" => Some(6),  // Base USDC
            "0x036cbd53842c5426634e7929541ec2318f3dcf7e" => Some(6),  // Base Sepolia USDC
            "0x7f5c764cbc14f9669b88837ca1490cca17c31607" => Some(6),  // USDbC
            _ => None,
        },
        // Ethereum mainnet (1) + local anvil (31337, 31339).
        Some(1) | Some(31337) | Some(31339) => match token.as_str() {
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" => Some(18), // WETH
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" => Some(6),  // USDC
            "0xdac17f958d2ee523a2206206994597c13d831ec7" => Some(6),  // USDT
            _ => None,
        },
        _ => None,
    }
}
