use crate::types::{PortfolioState, Position, PositionType, PriceData};
use chrono::Utc;
use rust_decimal::Decimal;

impl PortfolioState {
    /// Update portfolio with new price data
    pub fn update_prices(&mut self, prices: &[PriceData]) {
        for position in &mut self.positions {
            if let Some(price_data) = prices.iter().find(|p| p.token == position.token) {
                position.current_price = price_data.price_usd;
                position.unrealized_pnl = match position.position_type {
                    PositionType::ShortPerp => {
                        (position.entry_price - position.current_price) * position.amount
                    }
                    _ => (position.current_price - position.entry_price) * position.amount,
                };
            }
        }
        self.recalculate();
    }

    /// Add a new position
    pub fn add_position(&mut self, position: Position) {
        self.positions.push(position);
        self.recalculate();
    }

    /// Remove a position by token and protocol, realizing P&L
    pub fn close_position(&mut self, token: &str, protocol: &str) -> Option<Decimal> {
        if let Some(idx) = self
            .positions
            .iter()
            .position(|p| p.token == token && p.protocol == protocol)
        {
            let position = self.positions.remove(idx);
            self.realized_pnl += position.unrealized_pnl;
            self.recalculate();
            Some(position.unrealized_pnl)
        } else {
            None
        }
    }

    /// Recalculate portfolio aggregates
    fn recalculate(&mut self) {
        self.total_value_usd = self
            .positions
            .iter()
            .map(|p| p.current_price * p.amount)
            .sum();

        self.unrealized_pnl = self.positions.iter().map(|p| p.unrealized_pnl).sum();

        // Update high water mark
        let total_with_realized = self.total_value_usd + self.realized_pnl;
        if total_with_realized > self.high_water_mark {
            self.high_water_mark = total_with_realized;
        }

        // Calculate max drawdown
        if self.high_water_mark > Decimal::ZERO {
            let drawdown = (self.high_water_mark - total_with_realized) / self.high_water_mark
                * Decimal::new(100, 0);
            if drawdown > self.max_drawdown_pct {
                self.max_drawdown_pct = drawdown;
            }
        }

        self.last_updated = Some(Utc::now());
    }

    /// Check if circuit breaker should trigger
    pub fn should_circuit_break(&self, max_drawdown_pct: Decimal) -> bool {
        self.max_drawdown_pct >= max_drawdown_pct
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_position(token: &str, amount: i64, entry: i64, current: i64) -> Position {
        let amount = Decimal::new(amount, 0);
        let entry_price = Decimal::new(entry, 0);
        let current_price = Decimal::new(current, 0);
        Position {
            token: token.into(),
            amount,
            entry_price,
            current_price,
            unrealized_pnl: (current_price - entry_price) * amount,
            protocol: "test".into(),
            position_type: PositionType::Spot,
        }
    }

    #[test]
    fn test_add_position_and_recalculate() {
        let mut portfolio = PortfolioState::default();
        portfolio.add_position(make_position("ETH", 10, 2000, 2100));

        assert_eq!(portfolio.total_value_usd, Decimal::new(21000, 0));
        assert_eq!(portfolio.unrealized_pnl, Decimal::new(1000, 0));
    }

    #[test]
    fn test_close_position_realizes_pnl() {
        let mut portfolio = PortfolioState::default();
        portfolio.add_position(make_position("ETH", 10, 2000, 2100));

        let pnl = portfolio.close_position("ETH", "test");
        assert_eq!(pnl, Some(Decimal::new(1000, 0)));
        assert_eq!(portfolio.realized_pnl, Decimal::new(1000, 0));
        assert!(portfolio.positions.is_empty());
    }

    #[test]
    fn test_circuit_breaker() {
        let mut portfolio = PortfolioState::default();
        portfolio.add_position(make_position("ETH", 10, 2000, 2000));

        // Price drops
        portfolio.update_prices(&[PriceData {
            token: "ETH".into(),
            price_usd: Decimal::new(1600, 0),
            source: "test".into(),
            timestamp: Utc::now(),
        }]);

        assert!(portfolio.should_circuit_break(Decimal::new(15, 0)));
        assert!(!portfolio.should_circuit_break(Decimal::new(25, 0)));
    }

    #[test]
    fn test_high_water_mark() {
        let mut portfolio = PortfolioState::default();
        portfolio.add_position(make_position("ETH", 10, 2000, 2500));
        let hwm = portfolio.high_water_mark;
        assert_eq!(hwm, Decimal::new(25000, 0));

        // Price drops — HWM should NOT decrease
        portfolio.update_prices(&[PriceData {
            token: "ETH".into(),
            price_usd: Decimal::new(2200, 0),
            source: "test".into(),
            timestamp: Utc::now(),
        }]);
        assert_eq!(portfolio.high_water_mark, hwm);
    }
}
