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
use trading_runtime::token_metadata::known_token_decimals;

const NORMALIZE_THRESHOLD: i64 = 100_000;

pub fn normalize_trade_amount(chain_id: Option<u64>, token: &str, amount: Decimal) -> Decimal {
    if amount <= Decimal::ZERO
        || !amount.fract().is_zero()
        || amount < Decimal::new(NORMALIZE_THRESHOLD, 0)
        || !token.trim().starts_with("0x")
    {
        return amount;
    }
    let Some(decimals) = known_token_decimals(chain_id, token) else {
        return amount;
    };
    amount / Decimal::from(10u64.pow(decimals as u32))
}
