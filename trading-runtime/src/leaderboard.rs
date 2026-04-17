//! Leaderboard computation from metric snapshots and trade records.
//!
//! Computes performance statistics for bot ranking:
//! - Total return %
//! - Sharpe ratio (annualized, risk-free rate = 0)
//! - Sortino ratio (downside deviation only)
//! - Max drawdown %
//! - Win rate
//! - Calmar ratio (CAGR / max drawdown)
//! - Trade count

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};

/// A single snapshot in a time-series used for leaderboard computation.
/// Values are pre-parsed Decimals (not strings) for arithmetic safety.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EquityPoint {
    pub timestamp_secs: i64,
    pub account_value: Decimal,
}

/// Computed leaderboard stats for a single bot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderboardStats {
    pub bot_id: String,
    pub total_return_pct: f64,
    pub sharpe_ratio: f64,
    pub sortino_ratio: f64,
    pub max_drawdown_pct: f64,
    pub calmar_ratio: f64,
    pub win_rate: f64,
    pub total_trades: u64,
    pub profitable_trades: u64,
    pub days_active: f64,
}

/// Compute leaderboard stats from an equity curve and trade outcomes.
///
/// `equity_points` must be sorted chronologically (oldest first).
/// `trade_pnls` is a list of per-trade profit/loss values (positive = profit).
pub fn compute_stats(
    bot_id: &str,
    equity_points: &[EquityPoint],
    trade_pnls: &[Decimal],
) -> LeaderboardStats {
    let total_trades = trade_pnls.len() as u64;
    let profitable_trades = trade_pnls.iter().filter(|p| **p > Decimal::ZERO).count() as u64;
    let win_rate = if total_trades > 0 {
        profitable_trades as f64 / total_trades as f64
    } else {
        0.0
    };

    if equity_points.len() < 2 {
        return LeaderboardStats {
            bot_id: bot_id.to_string(),
            total_return_pct: 0.0,
            sharpe_ratio: 0.0,
            sortino_ratio: 0.0,
            max_drawdown_pct: 0.0,
            calmar_ratio: 0.0,
            win_rate,
            total_trades,
            profitable_trades,
            days_active: 0.0,
        };
    }

    let first_value = equity_points.first().unwrap().account_value;
    let last_value = equity_points.last().unwrap().account_value;
    let first_ts = equity_points.first().unwrap().timestamp_secs;
    let last_ts = equity_points.last().unwrap().timestamp_secs;

    let days_active = (last_ts - first_ts) as f64 / 86400.0;

    // Total return %
    let total_return_pct = if first_value > Decimal::ZERO {
        ((last_value - first_value) / first_value * Decimal::new(100, 0))
            .to_f64()
            .unwrap_or(0.0)
    } else {
        0.0
    };

    // Daily returns for Sharpe/Sortino
    let daily_returns = compute_period_returns(equity_points);

    let sharpe_ratio = compute_sharpe(&daily_returns);
    let sortino_ratio = compute_sortino(&daily_returns);
    let max_drawdown_pct = compute_max_drawdown(equity_points);

    // Calmar = annualized return / max drawdown
    let annualized_return = if days_active > 0.0 {
        total_return_pct / 100.0 * (365.0 / days_active)
    } else {
        0.0
    };
    let calmar_ratio = if max_drawdown_pct > 0.001 {
        annualized_return / (max_drawdown_pct / 100.0)
    } else {
        0.0
    };

    LeaderboardStats {
        bot_id: bot_id.to_string(),
        total_return_pct,
        sharpe_ratio,
        sortino_ratio,
        max_drawdown_pct,
        calmar_ratio,
        win_rate,
        total_trades,
        profitable_trades,
        days_active,
    }
}

/// Compute period-over-period returns from equity points.
fn compute_period_returns(points: &[EquityPoint]) -> Vec<f64> {
    points
        .windows(2)
        .filter_map(|w| {
            let prev = w[0].account_value.to_f64()?;
            let curr = w[1].account_value.to_f64()?;
            if prev > 0.0 {
                Some((curr - prev) / prev)
            } else {
                None
            }
        })
        .collect()
}

/// Annualized Sharpe ratio (assuming risk-free rate = 0).
/// Sharpe = mean(returns) / std(returns) * sqrt(252)
fn compute_sharpe(returns: &[f64]) -> f64 {
    if returns.len() < 2 {
        return 0.0;
    }
    let n = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let variance = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (n - 1.0);
    let std_dev = variance.sqrt();
    if std_dev < 1e-12 {
        return 0.0;
    }
    (mean / std_dev) * 252.0_f64.sqrt()
}

/// Annualized Sortino ratio (downside deviation only).
/// Sortino = mean(returns) / downside_std * sqrt(252)
fn compute_sortino(returns: &[f64]) -> f64 {
    if returns.len() < 2 {
        return 0.0;
    }
    let n = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let downside_variance = returns
        .iter()
        .filter(|r| **r < 0.0)
        .map(|r| r.powi(2))
        .sum::<f64>()
        / n;
    let downside_std = downside_variance.sqrt();
    if downside_std < 1e-12 {
        return 0.0;
    }
    (mean / downside_std) * 252.0_f64.sqrt()
}

/// Max drawdown % from peak equity.
fn compute_max_drawdown(points: &[EquityPoint]) -> f64 {
    let mut peak = 0.0_f64;
    let mut max_dd = 0.0_f64;

    for p in points {
        let val = p.account_value.to_f64().unwrap_or(0.0);
        if val > peak {
            peak = val;
        }
        if peak > 0.0 {
            let dd = (peak - val) / peak * 100.0;
            if dd > max_dd {
                max_dd = dd;
            }
        }
    }
    max_dd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(values: &[(i64, f64)]) -> Vec<EquityPoint> {
        values
            .iter()
            .map(|(ts, val)| EquityPoint {
                timestamp_secs: *ts,
                account_value: Decimal::try_from(*val).unwrap(),
            })
            .collect()
    }

    #[test]
    fn test_compute_stats_basic() {
        // 10 days, $1000 → $1100 (10% return)
        let eq = points(&[
            (0, 1000.0),
            (86400, 1020.0),
            (172800, 1010.0),
            (259200, 1050.0),
            (345600, 1030.0),
            (432000, 1060.0),
            (518400, 1080.0),
            (604800, 1070.0),
            (691200, 1090.0),
            (777600, 1100.0),
        ]);
        let pnls: Vec<Decimal> = vec![
            Decimal::new(20, 0),
            Decimal::new(-10, 0),
            Decimal::new(40, 0),
            Decimal::new(-20, 0),
            Decimal::new(30, 0),
            Decimal::new(20, 0),
            Decimal::new(-10, 0),
            Decimal::new(20, 0),
            Decimal::new(10, 0),
        ];

        let stats = compute_stats("test-bot", &eq, &pnls);
        assert_eq!(stats.bot_id, "test-bot");
        assert!((stats.total_return_pct - 10.0).abs() < 0.01);
        assert_eq!(stats.total_trades, 9);
        assert_eq!(stats.profitable_trades, 6);
        assert!((stats.win_rate - 6.0 / 9.0).abs() < 0.01);
        assert!(stats.sharpe_ratio > 0.0);
        assert!(stats.max_drawdown_pct > 0.0);
        assert!(stats.days_active > 8.0);
    }

    #[test]
    fn test_compute_stats_empty() {
        let stats = compute_stats("empty", &[], &[]);
        assert_eq!(stats.total_return_pct, 0.0);
        assert_eq!(stats.sharpe_ratio, 0.0);
        assert_eq!(stats.total_trades, 0);
    }

    #[test]
    fn test_compute_stats_single_point() {
        let eq = points(&[(0, 1000.0)]);
        let stats = compute_stats("single", &eq, &[]);
        assert_eq!(stats.total_return_pct, 0.0);
    }

    #[test]
    fn test_max_drawdown() {
        // Peak at 1200, trough at 900 → 25% drawdown
        let eq = points(&[
            (0, 1000.0),
            (86400, 1200.0),
            (172800, 900.0),
            (259200, 1100.0),
        ]);
        let stats = compute_stats("dd-test", &eq, &[]);
        assert!((stats.max_drawdown_pct - 25.0).abs() < 0.01);
    }

    #[test]
    fn test_sharpe_positive_for_uptrend() {
        let eq = points(&[
            (0, 1000.0),
            (86400, 1010.0),
            (172800, 1020.0),
            (259200, 1030.0),
            (345600, 1040.0),
            (432000, 1050.0),
        ]);
        let stats = compute_stats("uptrend", &eq, &[]);
        assert!(
            stats.sharpe_ratio > 0.0,
            "Sharpe should be positive for uptrend"
        );
    }

    #[test]
    fn test_sortino_ignores_upside() {
        // All positive returns → downside deviation is ~0 → Sortino is 0 (no downside)
        let eq = points(&[
            (0, 1000.0),
            (86400, 1010.0),
            (172800, 1020.0),
            (259200, 1030.0),
        ]);
        let stats = compute_stats("no-downside", &eq, &[]);
        // With no negative returns, Sortino is 0 (division by ~0 downside dev)
        assert_eq!(stats.sortino_ratio, 0.0);
    }

    #[test]
    fn test_win_rate_all_winners() {
        let pnls = vec![Decimal::new(10, 0), Decimal::new(20, 0), Decimal::new(5, 0)];
        let eq = points(&[(0, 1000.0), (86400, 1035.0)]);
        let stats = compute_stats("winners", &eq, &pnls);
        assert!((stats.win_rate - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_win_rate_all_losers() {
        let pnls = vec![
            Decimal::new(-10, 0),
            Decimal::new(-20, 0),
            Decimal::new(-5, 0),
        ];
        let eq = points(&[(0, 1000.0), (86400, 965.0)]);
        let stats = compute_stats("losers", &eq, &pnls);
        assert_eq!(stats.win_rate, 0.0);
    }
}
