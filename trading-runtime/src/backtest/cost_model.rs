use rust_decimal::Decimal;

use super::types::{Direction, SlippageModel};

/// Apply slippage to a fill price given trade size and slippage model.
///
/// Long entries and short exits get a worse (higher) price.
/// Short entries and long exits get a worse (lower) price.
pub fn apply_entry_slippage(
    price: Decimal,
    direction: Direction,
    size_usd: Decimal,
    model: &SlippageModel,
) -> Decimal {
    let bps = model.effective_bps(size_usd);
    let slip = Decimal::new(bps as i64, 4);
    match direction {
        Direction::Long => price * (Decimal::ONE + slip),
        Direction::Short => price * (Decimal::ONE - slip),
    }
}

pub fn apply_exit_slippage(
    price: Decimal,
    direction: Direction,
    size_usd: Decimal,
    model: &SlippageModel,
) -> Decimal {
    let bps = model.effective_bps(size_usd);
    let slip = Decimal::new(bps as i64, 4);
    match direction {
        Direction::Long => price * (Decimal::ONE - slip),
        Direction::Short => price * (Decimal::ONE + slip),
    }
}

/// Compute slippage cost as the price difference caused by slippage * units traded.
pub fn slippage_cost(mid_price: Decimal, fill_price: Decimal, size_usd: Decimal) -> Decimal {
    if mid_price <= Decimal::ZERO {
        return Decimal::ZERO;
    }
    let units = size_usd / mid_price;
    (fill_price - mid_price).abs() * units
}

/// Compute the fee on a trade of `size_usd` at `fee_bps`.
pub fn trade_fee(size_usd: Decimal, fee_bps: u32) -> Decimal {
    size_usd * Decimal::new(fee_bps as i64, 4)
}

/// Compute the fee on a trade using the canonical per-protocol schedule
/// (`crate::protocol_fees::SCHEDULES`). This is the single source of truth
/// shared with the live execute path — backtests use the same numbers the
/// runtime gates on, so a strategy that's profitable in backtest cannot be
/// unprofitable live solely because of fee-model drift. Returns `None` when
/// the protocol has no schedule entry (caller should treat that as
/// "do not trade" — same as the live gate).
pub fn trade_fee_for_protocol(size_usd: Decimal, protocol: &str) -> Option<Decimal> {
    let schedule = crate::protocol_fees::schedule_for(protocol)?;
    Some(crate::protocol_fees::estimate_fee_usd(schedule, size_usd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_bps_long_entry_increases_price() {
        let model = SlippageModel::FixedBps { bps: 10 };
        let price = Decimal::new(1000, 0);
        let fill = apply_entry_slippage(price, Direction::Long, Decimal::new(1000, 0), &model);
        assert!(fill > price);
        assert_eq!(fill, Decimal::new(10010, 1));
    }

    #[test]
    fn fixed_bps_short_entry_decreases_price() {
        let model = SlippageModel::FixedBps { bps: 10 };
        let price = Decimal::new(1000, 0);
        let fill = apply_entry_slippage(price, Direction::Short, Decimal::new(1000, 0), &model);
        assert!(fill < price);
    }

    #[test]
    fn sqrt_impact_larger_trade_more_slippage() {
        let model = SlippageModel::SqrtImpact {
            base_bps: 10,
            depth_usd: Decimal::new(100_000, 0),
        };
        let price = Decimal::new(1000, 0);
        let small = apply_entry_slippage(price, Direction::Long, Decimal::new(1000, 0), &model);
        let large = apply_entry_slippage(price, Direction::Long, Decimal::new(50_000, 0), &model);
        assert!(
            large > small,
            "Larger trade should have more slippage: small={small} large={large}"
        );
    }

    #[test]
    fn sqrt_impact_scales_sublinearly() {
        let model = SlippageModel::SqrtImpact {
            base_bps: 10,
            depth_usd: Decimal::new(100_000, 0),
        };
        // 4x the size should give 2x the bps (sqrt scaling)
        let bps_1k = model.effective_bps(Decimal::new(1000, 0));
        let bps_4k = model.effective_bps(Decimal::new(4000, 0));
        // bps_4k / bps_1k should be ~2.0
        if bps_1k > 0 {
            let ratio = bps_4k as f64 / bps_1k as f64;
            assert!(
                (ratio - 2.0).abs() < 0.5,
                "4x size should give ~2x bps: ratio={ratio}"
            );
        }
    }

    #[test]
    fn slippage_cost_computed_correctly() {
        let mid = Decimal::new(100, 0);
        let fill = Decimal::new(101, 0); // 1% slippage
        let size = Decimal::new(1000, 0);
        let cost = slippage_cost(mid, fill, size);
        // units = 1000/100 = 10, cost = |101-100| * 10 = 10
        assert_eq!(cost, Decimal::new(10, 0));
    }

    #[test]
    fn trade_fee_10bps_on_1000() {
        let fee = trade_fee(Decimal::new(1000, 0), 10);
        assert_eq!(fee, Decimal::ONE);
    }
}
