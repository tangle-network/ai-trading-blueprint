//! Baseline-on-deploy backtest helpers.
//!
//! Runs a self-contained backtest against the last N days of public klines
//! using a strategy's `HarnessConfig`. The summary is intended to be persisted
//! alongside the bot record so operators can compare live performance against
//! a deterministic offline baseline.

use crate::error::TradingError;
use crate::supported_assets::normalize_strategy_type;

use super::engine::BacktestEngine;
use super::history::{Interval, fetch_candles};
use super::types::{BacktestConfig, BacktestSummary, FundingSnapshot, HarnessConfig};

/// Default lookback window for baseline backtests when none is specified.
pub const DEFAULT_BASELINE_LOOKBACK_DAYS: u32 = 30;

/// Tokens used for the baseline backtest, depending on strategy family.
///
/// Every price-driven family resolves to one or more Binance spot symbols the
/// engine can backtest. The engine is family-agnostic — it runs any
/// `HarnessConfig` over any candle series — so the only per-family decision
/// here is *which* reference series to denominate the baseline in. Families
/// that trade a single ETH/USDC-style book (dex, yield, mm) use ETH; the
/// multi-asset families (perp, hyperliquid_perp, multi) use the canonical
/// ETH+BTC pair so the run exercises portfolio-level position management.
///
/// Only `prediction` returns no tokens: its outcomes settle to $0/$1 at
/// resolution rather than tracking a continuous price, so a kline backtest is
/// not the right model. Prediction strategies are scored by the deterministic
/// resolution-settled benchmark in [`super::prediction`] instead.
fn baseline_tokens(strategy_type: &str) -> Vec<&'static str> {
    match normalize_strategy_type(strategy_type).as_str() {
        // Single-book spot/AMM families — denominate in ETH (Binance ETHUSD).
        "dex" | "yield" | "mm" => vec!["ETH"],
        // Multi-asset / perp families exercise portfolio management across the
        // canonical ETH+BTC pair.
        "perp" | "hyperliquid_perp" | "multi" => vec!["ETH", "BTC"],
        _ => vec![],
    }
}

/// Returns true when this strategy family has historical kline data and a
/// baseline backtest is meaningful.
pub fn strategy_supports_baseline(strategy_type: &str) -> bool {
    !baseline_tokens(strategy_type).is_empty()
}

/// Run a baseline backtest for `strategy_type` using the supplied harness.
///
/// Fetches `lookback_days * 24` hourly candles per token from the public
/// kline source and runs them through the engine with `BacktestConfig::default()`.
/// Returns `Err` if the kline source is unreachable or returned no data.
pub async fn run_baseline_backtest(
    strategy_type: &str,
    harness: HarnessConfig,
    lookback_days: u32,
) -> Result<BacktestSummary, TradingError> {
    let tokens = baseline_tokens(strategy_type);
    if tokens.is_empty() {
        return Err(TradingError::ConfigError(format!(
            "Strategy '{strategy_type}' has no baseline-compatible kline source"
        )));
    }

    let lookback = lookback_days.max(1);
    let limit = lookback.saturating_mul(24).max(48);

    let mut all_candles = Vec::new();
    let mut last_err: Option<TradingError> = None;
    for token in &tokens {
        match fetch_candles(token, Interval::Hour1, limit).await {
            Ok(mut c) if !c.is_empty() => all_candles.append(&mut c),
            Ok(_) => {
                last_err = Some(TradingError::MarketDataUnavailable(format!(
                    "no candles returned for {token}"
                )));
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
    }
    if all_candles.is_empty() {
        return Err(last_err.unwrap_or_else(|| {
            TradingError::MarketDataUnavailable(
                "no historical candle data available for baseline backtest".into(),
            )
        }));
    }

    let harness_version = harness.version;
    let config = BacktestConfig {
        harness,
        ..Default::default()
    };
    let engine = BacktestEngine::new(config);
    let funding: Vec<FundingSnapshot> = Vec::new();
    let result = engine.run(&all_candles, &funding)?;
    Ok(BacktestSummary::from_result(
        &result,
        lookback,
        harness_version,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backtest::types::{BacktestResult, Direction, ExitReason, SimulatedTrade};
    use crate::leaderboard::{EquityPoint, LeaderboardStats};
    use rust_decimal::Decimal;

    fn synthetic_result() -> BacktestResult {
        BacktestResult {
            trades: vec![SimulatedTrade {
                token: "ETH".into(),
                entry_timestamp: 0,
                exit_timestamp: 100,
                direction: Direction::Long,
                entry_price: Decimal::new(100, 0),
                exit_price: Decimal::new(110, 0),
                size_usd: Decimal::new(1000, 0),
                pnl: Decimal::new(100, 0),
                pnl_pct: 10.0,
                slippage_cost: Decimal::ZERO,
                gas_cost: Decimal::ZERO,
                fee_cost: Decimal::ZERO,
                exit_reason: ExitReason::TakeProfit,
            }],
            equity_curve: vec![EquityPoint {
                timestamp_secs: 0,
                account_value: Decimal::new(10_000, 0),
            }],
            stats: LeaderboardStats {
                bot_id: String::new(),
                total_return_pct: 1.0,
                sharpe_ratio: 0.5,
                sortino_ratio: 0.6,
                max_drawdown_pct: 0.2,
                calmar_ratio: 1.5,
                win_rate: 1.0,
                total_trades: 1,
                profitable_trades: 1,
                days_active: 30.0,
            },
            total_fees: Decimal::ZERO,
            total_slippage: Decimal::ZERO,
            total_gas: Decimal::ZERO,
            candles_processed: 720,
            tokens_traded: vec!["ETH".into()],
        }
    }

    #[test]
    fn summary_captures_pnl_and_metrics() {
        let summary = BacktestSummary::from_result(&synthetic_result(), 30, 1);
        assert_eq!(summary.lookback_days, 30);
        assert_eq!(summary.harness_version, 1);
        assert_eq!(summary.total_trades, 1);
        assert_eq!(summary.profitable_trades, 1);
        assert_eq!(summary.candles_processed, 720);
        assert_eq!(summary.realized_pnl, "100");
        assert_eq!(summary.tokens_traded, vec!["ETH"]);
        assert!((summary.win_rate - 1.0).abs() < 1e-9);
        assert!((summary.total_return_pct - 1.0).abs() < 1e-9);
    }

    #[test]
    fn all_price_driven_families_have_baseline_tokens() {
        // Single-book families
        assert!(strategy_supports_baseline("dex"));
        assert!(strategy_supports_baseline("dex_trading"));
        assert!(strategy_supports_baseline("yield"));
        assert!(strategy_supports_baseline("defi_yield"));
        assert!(strategy_supports_baseline("mm"));
        // Multi-asset / perp families
        assert!(strategy_supports_baseline("perp"));
        assert!(strategy_supports_baseline("perp_trading"));
        assert!(strategy_supports_baseline("hyperliquid_perp"));
        assert!(strategy_supports_baseline("hyperliquid-perp"));
        assert!(strategy_supports_baseline("multi"));
    }

    #[test]
    fn multi_asset_families_backtest_eth_and_btc() {
        assert_eq!(baseline_tokens("perp"), vec!["ETH", "BTC"]);
        assert_eq!(baseline_tokens("hyperliquid_perp"), vec!["ETH", "BTC"]);
        assert_eq!(baseline_tokens("multi"), vec!["ETH", "BTC"]);
        assert_eq!(baseline_tokens("mm"), vec!["ETH"]);
    }

    #[test]
    fn prediction_strategy_has_no_kline_source() {
        // Prediction settles to $0/$1 at resolution — it is scored by the
        // deterministic resolution-settled benchmark (super::prediction), not
        // by a continuous-price kline backtest.
        assert!(!strategy_supports_baseline("prediction"));
        assert!(!strategy_supports_baseline("prediction_market"));
    }

    #[test]
    fn empty_strategy_unsupported() {
        assert!(!strategy_supports_baseline(""));
    }
}
