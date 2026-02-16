use crate::types::FeeBreakdown;
use rust_decimal::Decimal;

/// Calculate performance fee based on gains above high water mark
pub fn calculate_performance_fee(
    current_value: Decimal,
    high_water_mark: Decimal,
    fee_bps: u32,
) -> Decimal {
    if current_value <= high_water_mark {
        return Decimal::ZERO;
    }
    let gains = current_value - high_water_mark;
    gains * Decimal::new(fee_bps as i64, 4)
}

/// Calculate annualized management fee pro-rata
pub fn calculate_management_fee(
    aum: Decimal,
    annual_fee_bps: u32,
    seconds_elapsed: u64,
) -> Decimal {
    let seconds_per_year: u64 = 365 * 24 * 3600;
    let fraction =
        Decimal::new(seconds_elapsed as i64, 0) / Decimal::new(seconds_per_year as i64, 0);
    aum * Decimal::new(annual_fee_bps as i64, 4) * fraction
}

/// Calculate full fee breakdown
pub fn calculate_fees(
    current_value: Decimal,
    high_water_mark: Decimal,
    aum: Decimal,
    perf_fee_bps: u32,
    mgmt_fee_bps: u32,
    validator_share_bps: u32,
    seconds_elapsed: u64,
) -> FeeBreakdown {
    let performance_fee = calculate_performance_fee(current_value, high_water_mark, perf_fee_bps);
    let management_fee = calculate_management_fee(aum, mgmt_fee_bps, seconds_elapsed);
    let validator_share = performance_fee * Decimal::new(validator_share_bps as i64, 4);
    let total = performance_fee + management_fee;

    FeeBreakdown {
        performance_fee,
        management_fee,
        validator_share,
        total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_performance_fee_above_hwm() {
        let fee = calculate_performance_fee(
            Decimal::new(110000, 0),
            Decimal::new(100000, 0),
            2000,
        );
        assert_eq!(fee, Decimal::new(2000, 0));
    }

    #[test]
    fn test_performance_fee_below_hwm() {
        let fee = calculate_performance_fee(
            Decimal::new(90000, 0),
            Decimal::new(100000, 0),
            2000,
        );
        assert_eq!(fee, Decimal::ZERO);
    }

    #[test]
    fn test_management_fee_one_year() {
        let fee = calculate_management_fee(
            Decimal::new(1000000, 0),
            200,
            365 * 24 * 3600,
        );
        assert_eq!(fee, Decimal::new(20000, 0));
    }

    #[test]
    fn test_management_fee_half_year() {
        let fee = calculate_management_fee(
            Decimal::new(1000000, 0),
            200,
            365 * 24 * 3600 / 2,
        );
        assert_eq!(fee, Decimal::new(10000, 0));
    }

    #[test]
    fn test_full_fee_breakdown() {
        let breakdown = calculate_fees(
            Decimal::new(110000, 0),
            Decimal::new(100000, 0),
            Decimal::new(110000, 0),
            2000,
            200,
            3000,
            365 * 24 * 3600,
        );

        assert_eq!(breakdown.performance_fee, Decimal::new(2000, 0));
        assert_eq!(breakdown.validator_share, Decimal::new(600, 0));
        assert!(breakdown.total > Decimal::ZERO);
    }
}
