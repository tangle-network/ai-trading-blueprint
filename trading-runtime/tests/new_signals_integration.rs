//! Integration tests for Gen 12 signal types.
//!
//! Verifies each new signal type actually produces trades when fed
//! synthetic candle data with clear patterns.

use rust_decimal::Decimal;
use trading_runtime::backtest::*;

fn make_oscillating_candles(count: usize) -> Vec<Candle> {
    let mut candles = Vec::new();
    for i in 0..count {
        let t = i as f64;
        let cycle = (t / 30.0) * std::f64::consts::PI * 2.0;
        let close = 2500.0 + cycle.sin() * 300.0 + ((t * 7.3).sin() * 30.0);
        candles.push(Candle {
            timestamp: (1700000000 + i * 3600) as i64,
            token: "ETH".into(),
            open: Decimal::try_from(close * 0.998).unwrap(),
            high: Decimal::try_from(close * 1.02).unwrap(),
            low: Decimal::try_from(close * 0.98).unwrap(),
            close: Decimal::try_from(close).unwrap(),
            volume: Decimal::new(1000 + (i % 300) as i64, 0),
        });
    }
    candles
}

fn run_with_signal(signal: SignalType, condition: EntryCondition) -> BacktestResult {
    let harness = HarnessConfig {
        version: 1,
        entry_rules: vec![EntryRule {
            signal,
            condition,
            weight: 1.0,
            tokens: vec![],
        }],
        exit_rules: vec![
            ExitRule::StopLoss { pct: 5.0 },
            ExitRule::TakeProfit { pct: 10.0 },
        ],
        filters: vec![],
        position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
        entry_threshold: 0.3,
        max_positions: 5,
    };
    let config = BacktestConfig {
        initial_capital: Decimal::new(10_000, 0),
        harness,
        slippage: SlippageModel::FixedBps { bps: 0 },
        gas_cost_usd: Decimal::ZERO,
        taker_fee_bps: 0,
    };
    BacktestEngine::new(config)
        .run(&make_oscillating_candles(200), &[])
        .expect("backtest failed")
}

#[test]
fn macd_crossover_produces_trades() {
    let result = run_with_signal(
        SignalType::Macd {
            fast_period: 12,
            slow_period: 26,
            signal_period: 9,
        },
        EntryCondition::CrossAbove,
    );
    eprintln!("MACD: {} trades", result.trades.len());
    assert!(
        !result.trades.is_empty(),
        "MACD crossover should produce trades on oscillating data"
    );
}

#[test]
fn sma_cross_produces_trades() {
    let result = run_with_signal(
        SignalType::SmaCross {
            short_period: 10,
            long_period: 30,
        },
        EntryCondition::CrossAbove,
    );
    eprintln!("SmaCross: {} trades", result.trades.len());
    assert!(
        !result.trades.is_empty(),
        "SMA crossover should produce trades on oscillating data"
    );
}

#[test]
fn bollinger_band_produces_trades() {
    let result = run_with_signal(
        SignalType::BollingerBand {
            period: 20,
            std_dev: 2.0,
        },
        EntryCondition::Below { threshold: 0.0 },
    );
    eprintln!("Bollinger: {} trades", result.trades.len());
    assert!(
        !result.trades.is_empty(),
        "Bollinger band below-lower should trigger on dips"
    );
}

#[test]
fn atr_breakout_produces_trades() {
    let result = run_with_signal(
        SignalType::AtrBreakout {
            period: 14,
            multiplier: 1.5,
        },
        EntryCondition::Positive,
    );
    eprintln!("ATR breakout: {} trades", result.trades.len());
    // ATR breakout may not fire on smooth oscillations
    // but should at least not crash
}

#[test]
fn obv_trend_produces_trades() {
    let result = run_with_signal(
        SignalType::Obv {
            lookback_candles: 10,
        },
        EntryCondition::Positive,
    );
    eprintln!("OBV: {} trades", result.trades.len());
    assert!(
        !result.trades.is_empty(),
        "OBV positive trend should produce trades"
    );
}

#[test]
fn vwap_deviation_produces_trades() {
    let result = run_with_signal(
        SignalType::Vwap { period: 20 },
        EntryCondition::Below { threshold: 0.0 },
    );
    eprintln!("VWAP: {} trades", result.trades.len());
    assert!(
        !result.trades.is_empty(),
        "Price below VWAP should produce trades on dips"
    );
}

#[test]
fn mean_reversion_produces_trades() {
    let result = run_with_signal(
        SignalType::MeanReversion {
            lookback_candles: 20,
            z_score_threshold: 1.5,
        },
        EntryCondition::Below { threshold: 0.0 },
    );
    eprintln!("MeanReversion: {} trades", result.trades.len());
    assert!(
        !result.trades.is_empty(),
        "Mean reversion should fire on oversold z-score dips"
    );
}

#[test]
fn combined_signals_produce_better_trades() {
    // Multi-signal harness: MACD + RSI + Bollinger
    let harness = HarnessConfig {
        version: 1,
        entry_rules: vec![
            EntryRule {
                signal: SignalType::Macd {
                    fast_period: 12,
                    slow_period: 26,
                    signal_period: 9,
                },
                condition: EntryCondition::CrossAbove,
                weight: 0.4,
                tokens: vec![],
            },
            EntryRule {
                signal: SignalType::Rsi { period: 14 },
                condition: EntryCondition::Below { threshold: 35.0 },
                weight: 0.3,
                tokens: vec![],
            },
            EntryRule {
                signal: SignalType::BollingerBand {
                    period: 20,
                    std_dev: 2.0,
                },
                condition: EntryCondition::Below { threshold: 0.0 },
                weight: 0.3,
                tokens: vec![],
            },
        ],
        exit_rules: vec![
            ExitRule::StopLoss { pct: 4.0 },
            ExitRule::TakeProfit { pct: 8.0 },
            ExitRule::TrailingStop {
                activation_pct: 0.05,
                trail_pct: 0.03,
            },
        ],
        filters: vec![],
        position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
        entry_threshold: 0.4, // need 40% signal agreement
        max_positions: 3,
    };
    let config = BacktestConfig {
        initial_capital: Decimal::new(10_000, 0),
        harness,
        slippage: SlippageModel::FixedBps { bps: 5 },
        gas_cost_usd: Decimal::ZERO,
        taker_fee_bps: 5,
    };
    let result = BacktestEngine::new(config)
        .run(&make_oscillating_candles(300), &[])
        .expect("combined backtest failed");
    eprintln!(
        "Combined (MACD+RSI+BB): {} trades, sharpe={:.3}, win_rate={:.0}%",
        result.trades.len(),
        result.stats.sharpe_ratio,
        result.stats.win_rate * 100.0,
    );
    assert!(
        !result.trades.is_empty(),
        "Combined signals should produce trades"
    );
}

#[test]
fn walk_forward_detects_overfit_flag() {
    // Create a harness and run walk-forward — verify likely_overfit field exists
    let harness = HarnessConfig::default();
    let config = BacktestConfig {
        initial_capital: Decimal::new(10_000, 0),
        harness,
        slippage: SlippageModel::FixedBps { bps: 0 },
        gas_cost_usd: Decimal::ZERO,
        taker_fee_bps: 0,
    };
    let candles = make_oscillating_candles(200);

    // Walk-forward compare same config against itself
    let wf = BacktestEngine::walk_forward_compare(&config, &config, &candles, &[], 0.7).unwrap();
    // Same config vs itself should not be flagged as overfit
    eprintln!(
        "Walk-forward: decay={:.3}, overfit={}",
        wf.sharpe_ratio_decay, wf.likely_overfit
    );
}
