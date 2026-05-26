//! Composite fitness for evolved strategies. Single scalar `score` drives
//! selection; the underlying components stay accessible so the report
//! layer can show *why* a config was promoted.
//!
//! Components, with weights tuned for crypto-hourly:
//!
//!   + Sharpe (lower bound of the 95% bootstrap CI — penalises noisy
//!     estimators, not just unlucky ones)             ×  weight 1.0
//!   + OOS Sharpe (in-sample re-run on 30% holdout)   ×  weight 0.5
//!   − Max drawdown % (cap loss, not just chase return) × weight 0.1
//!   − IS-OOS gap (overfit penalty)                   ×  weight 0.4
//!   + Trade count bonus (saturates at 30 trades —
//!     enough to be statistically meaningful, no
//!     extra credit beyond that)                       ×  weight 0.05
//!
//! A strategy that doesn't trade at least 5 times gets a flat -10 score —
//! we never promote a no-trade variant just because it has Sharpe 0.

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;

use crate::analytics::bootstrap;
use crate::backtest::{
    BacktestConfig, BacktestEngine, BacktestResult, Candle, HarnessConfig, SlippageModel,
};
use crate::protocol_fees;

/// All the fitness components for one strategy on one candle window.
#[derive(Debug, Clone)]
pub struct Fitness {
    pub composite_score: f64,
    pub sharpe: f64,
    pub sharpe_ci_lo: f64,
    pub sharpe_ci_hi: f64,
    pub oos_sharpe: f64,
    pub is_oos_gap: f64,
    pub max_drawdown_pct: f64,
    pub n_trades: usize,
    pub win_rate_pct: f64,
    pub total_return_pct: f64,
    pub total_fees_usd: f64,
}

impl Fitness {
    fn no_trade() -> Self {
        Self {
            composite_score: -10.0,
            sharpe: 0.0,
            sharpe_ci_lo: 0.0,
            sharpe_ci_hi: 0.0,
            oos_sharpe: 0.0,
            is_oos_gap: 0.0,
            max_drawdown_pct: 0.0,
            n_trades: 0,
            win_rate_pct: 0.0,
            total_return_pct: 0.0,
            total_fees_usd: 0.0,
        }
    }
}

const MIN_TRADES_FOR_FITNESS: usize = 5;

const W_SHARPE: f64 = 1.0;
const W_OOS_SHARPE: f64 = 0.5;
const W_DRAWDOWN: f64 = 0.1;
const W_OVERFIT: f64 = 0.4;
const W_TRADES: f64 = 0.05;
const TRADE_BONUS_SATURATION: usize = 30;

/// Evaluate `harness` on `candles` at the venue's calibrated fee schedule.
/// Returns the composite fitness + components. Cheap by design — we use
/// the point-estimate Sharpe for the CI lower bound on the hot path; the
/// caller can re-bootstrap the top-K for honest intervals at the end.
pub fn evaluate(
    harness: &HarnessConfig,
    candles: &[Candle],
    fee_protocol: &str,
    bootstrap_lo: bool,
) -> Fitness {
    let (taker_bps, gas_usd) = protocol_fees::schedule_for(fee_protocol)
        .map(|s| (s.taker_bps, s.typical_gas_usd))
        .unwrap_or((10, 2));
    let config = BacktestConfig {
        initial_capital: Decimal::new(10_000, 0),
        harness: harness.clone(),
        slippage: SlippageModel::FixedBps { bps: 10 },
        gas_cost_usd: Decimal::new(gas_usd as i64, 0),
        taker_fee_bps: taker_bps,
    };

    let main = run_or_empty(&config, candles);
    if main.trades.len() < MIN_TRADES_FOR_FITNESS {
        return Fitness::no_trade();
    }

    // Walk-forward IS/OOS on a 70/30 split — same scheme the fleet review
    // uses; this is the production-style validation, not the analytics-
    // module statistic-only walk-forward.
    let split = (candles.len() as f64 * 0.7) as usize;
    let oos = run_or_empty(&config, &candles[split..]);
    let oos_sharpe = oos.stats.sharpe_ratio;

    let sharpe = main.stats.sharpe_ratio;
    let returns: Vec<f64> = main.trades.iter().map(|t| t.pnl_pct / 100.0).collect();
    let (sharpe_lo, sharpe_hi) = if bootstrap_lo {
        bootstrap::sharpe_ci_95(&returns, deterministic_seed(harness))
    } else {
        (sharpe, sharpe)
    };

    let is_oos_gap = sharpe - oos_sharpe;
    let trade_bonus =
        (main.trades.len().min(TRADE_BONUS_SATURATION) as f64) / TRADE_BONUS_SATURATION as f64;

    let composite = W_SHARPE * sharpe_lo
        + W_OOS_SHARPE * oos_sharpe
        - W_DRAWDOWN * main.stats.max_drawdown_pct
        - W_OVERFIT * is_oos_gap.max(0.0) // only penalise positive overfit, not OOS-better-than-IS
        + W_TRADES * trade_bonus;

    Fitness {
        composite_score: composite,
        sharpe,
        sharpe_ci_lo: sharpe_lo,
        sharpe_ci_hi: sharpe_hi,
        oos_sharpe,
        is_oos_gap,
        max_drawdown_pct: main.stats.max_drawdown_pct,
        n_trades: main.trades.len(),
        win_rate_pct: main.stats.win_rate * 100.0,
        total_return_pct: main.stats.total_return_pct,
        total_fees_usd: main.total_fees.to_f64().unwrap_or(0.0),
    }
}

/// Deterministic seed derived from the harness's serialised form — same
/// config always bootstraps the same way, different configs differ. Useful
/// for the evolver's reproducibility property.
fn deterministic_seed(h: &HarnessConfig) -> u64 {
    let s = serde_json::to_string(h).unwrap_or_default();
    let mut acc: u64 = 1469598103934665603;
    for b in s.bytes() {
        acc ^= b as u64;
        acc = acc.wrapping_mul(1099511628211);
    }
    acc
}

fn run_or_empty(config: &BacktestConfig, candles: &[Candle]) -> BacktestResult {
    BacktestEngine::new(config.clone())
        .run(candles, &[])
        .unwrap_or_else(|_| BacktestResult {
            trades: vec![],
            equity_curve: vec![],
            stats: crate::leaderboard::LeaderboardStats {
                bot_id: String::new(),
                total_return_pct: 0.0,
                sharpe_ratio: 0.0,
                sortino_ratio: 0.0,
                max_drawdown_pct: 0.0,
                calmar_ratio: 0.0,
                win_rate: 0.0,
                total_trades: 0,
                profitable_trades: 0,
                days_active: 0.0,
            },
            total_fees: Decimal::ZERO,
            total_slippage: Decimal::ZERO,
            total_gas: Decimal::ZERO,
            candles_processed: 0,
            tokens_traded: vec![],
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backtest::types::Candle;
    use rust_decimal::Decimal;

    fn synth_trending_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let p = 100.0 + (i as f64) * 0.3 + ((i as f64 * 0.7).sin()) * 1.5;
                Candle {
                    timestamp: 1_700_000_000 + (i as i64) * 3600,
                    token: "TEST".into(),
                    open: Decimal::from_f64_retain(p).unwrap(),
                    high: Decimal::from_f64_retain(p * 1.01).unwrap(),
                    low: Decimal::from_f64_retain(p * 0.99).unwrap(),
                    close: Decimal::from_f64_retain(p).unwrap(),
                    volume: Decimal::from_f64_retain(100.0).unwrap(),
                }
            })
            .collect()
    }

    #[test]
    fn no_trade_strategy_returns_floor_score() {
        // An impossibly strict strategy that never enters.
        let mut harness = HarnessConfig::default();
        harness.entry_threshold = 0.99;
        let candles = synth_trending_candles(200);
        let f = evaluate(&harness, &candles, "binance", false);
        assert_eq!(f.composite_score, -10.0);
        assert_eq!(f.n_trades, 0);
    }

    #[test]
    fn fitness_is_deterministic_for_same_inputs() {
        let harness = HarnessConfig::default();
        let candles = synth_trending_candles(400);
        let a = evaluate(&harness, &candles, "hyperliquid_perp", true);
        let b = evaluate(&harness, &candles, "hyperliquid_perp", true);
        assert_eq!(a.composite_score, b.composite_score);
        assert_eq!(a.sharpe_ci_lo, b.sharpe_ci_lo);
    }

    #[test]
    fn deterministic_seed_changes_with_harness() {
        let mut h1 = HarnessConfig::default();
        let h2 = h1.clone();
        h1.entry_threshold = 0.42;
        assert_ne!(deterministic_seed(&h1), deterministic_seed(&h2));
    }
}
