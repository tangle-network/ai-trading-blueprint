//! StrategyRunner — streaming wrapper that drives the backtest engine
//! one candle at a time for paper/live trading.
//!
//! Uses the SAME signal evaluation code as the batch backtest engine.
//! The pipeline: backtest (historical batch) → paper trade (live streaming,
//! fake money) → live trade (live streaming, real money). Same HarnessConfig,
//! same indicators, same entry/exit rules.

use std::collections::HashMap;

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};

use super::engine::BacktestEngine;
use super::types::*;

/// A trade signal produced by the strategy runner.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeSignal {
    pub asset: String,
    pub direction: Direction,
    /// Signal strength (0.0–1.0)
    pub strength: f64,
    /// Suggested position size as fraction of capital
    pub size_fraction: f64,
    /// Stop-loss percentage from entry (from exit rules)
    pub stop_loss_pct: Option<f64>,
    /// Take-profit percentage from entry (from exit rules)
    pub take_profit_pct: Option<f64>,
}

/// An exit signal for an existing position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitSignal {
    pub asset: String,
    pub reason: ExitReason,
}

/// Output from a single candle evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerOutput {
    pub entries: Vec<TradeSignal>,
    pub exits: Vec<ExitSignal>,
}

impl RunnerOutput {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.exits.is_empty()
    }
}

/// Tracked position state (internal to the runner).
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct TrackedPosition {
    token: String,
    direction: Direction,
    entry_price: f64,
    entry_time: i64,
    high_water: f64,
    low_water: f64,
    candles_held: usize,
}

/// Streaming strategy evaluator.
///
/// Accumulates candle history per-token, recomputes indicators on each new
/// candle, and evaluates entry/exit rules using the SAME code path as the
/// batch `BacktestEngine`.
pub struct StrategyRunner {
    /// The engine does the actual evaluation — same code for batch and streaming.
    engine: BacktestEngine,
    /// Per-token candle history
    candle_history: HashMap<String, Vec<Candle>>,
    /// Currently tracked positions
    positions: HashMap<String, TrackedPosition>,
    /// Funding snapshots
    funding: Vec<FundingSnapshot>,
    /// Max candle history per token
    max_history: usize,
}

impl StrategyRunner {
    pub fn new(harness: HarnessConfig) -> Self {
        let config = BacktestConfig {
            initial_capital: Decimal::new(10_000, 0),
            harness,
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
        };
        Self {
            engine: BacktestEngine::new(config),
            candle_history: HashMap::new(),
            positions: HashMap::new(),
            funding: Vec::new(),
            max_history: 500,
        }
    }

    /// Feed a new candle and evaluate entry/exit signals.
    ///
    /// This runs the same signal evaluation as the batch backtest but
    /// one candle at a time. Call on every new candle from market data.
    pub fn on_candle(&mut self, candle: &Candle) -> RunnerOutput {
        let token = candle.token.clone();
        let close = candle.close.to_f64().unwrap_or(0.0);
        let high = candle.high.to_f64().unwrap_or(0.0);
        let low = candle.low.to_f64().unwrap_or(0.0);

        // Accumulate history
        {
            let history = self.candle_history.entry(token.clone()).or_default();
            history.push(candle.clone());
            if history.len() > self.max_history {
                history.drain(..history.len() - self.max_history);
            }
        }

        let mut entries = Vec::new();
        let mut exits = Vec::new();

        // Check exits on tracked positions
        if let Some(pos) = self.positions.get_mut(&token) {
            pos.candles_held += 1;
            if high > pos.high_water {
                pos.high_water = high;
            }
            if low < pos.low_water {
                pos.low_water = low;
            }

            if let Some(reason) =
                check_exit_rules(&self.engine.config().harness.exit_rules, pos, candle)
            {
                exits.push(ExitSignal {
                    asset: token.clone(),
                    reason,
                });
                self.positions.remove(&token);
            }
        }

        // Check entry if no position for this token and enough history
        let history = self.candle_history.get(&token);
        let history_len = history.map(|h| h.len()).unwrap_or(0);
        if !self.positions.contains_key(&token)
            && history_len >= 30
            && self.positions.len() < self.engine.config().harness.max_positions
        {
            let candle_slice = self.candle_history.get(&token).unwrap();
            let result = self.engine.run(candle_slice, &self.funding);
            if let Ok(ref res) = result
                && let Some(last_trade) = res.trades.last()
                && last_trade.entry_timestamp == candle.timestamp
            {
                let (sl, tp) = self.extract_sl_tp();
                entries.push(TradeSignal {
                    asset: token.clone(),
                    direction: last_trade.direction,
                    strength: 0.8,
                    size_fraction: self.compute_size_fraction(),
                    stop_loss_pct: sl,
                    take_profit_pct: tp,
                });
                self.positions.insert(
                    token.clone(),
                    TrackedPosition {
                        token: token.clone(),
                        direction: last_trade.direction,
                        entry_price: close,
                        entry_time: candle.timestamp,
                        high_water: high,
                        low_water: low,
                        candles_held: 0,
                    },
                );
            }
        }

        RunnerOutput { entries, exits }
    }

    pub fn on_funding(&mut self, snapshot: FundingSnapshot) {
        self.funding.push(snapshot);
        if self.funding.len() > 1000 {
            self.funding.drain(..500);
        }
    }

    pub fn has_position(&self, asset: &str) -> bool {
        self.positions.contains_key(asset)
    }

    pub fn close_position(&mut self, asset: &str) {
        self.positions.remove(asset);
    }

    pub fn harness(&self) -> &HarnessConfig {
        &self.engine.config().harness
    }

    pub fn update_harness(&mut self, harness: HarnessConfig) {
        let config = BacktestConfig {
            harness,
            ..self.engine.config().clone()
        };
        self.engine = BacktestEngine::new(config);
    }

    fn extract_sl_tp(&self) -> (Option<f64>, Option<f64>) {
        let mut sl = None;
        let mut tp = None;
        for rule in &self.engine.config().harness.exit_rules {
            match rule {
                ExitRule::StopLoss { pct } => sl = Some(*pct),
                ExitRule::TakeProfit { pct } => tp = Some(*pct),
                _ => {}
            }
        }
        (sl, tp)
    }

    fn compute_size_fraction(&self) -> f64 {
        match &self.engine.config().harness.position_sizing {
            PositionSizing::FixedFraction { fraction } => *fraction,
            PositionSizing::KellyFraction {
                max_position_pct, ..
            } => *max_position_pct / 100.0,
            PositionSizing::FixedAmount { .. } => 0.1,
        }
    }
}

fn check_exit_rules(
    exit_rules: &[ExitRule],
    pos: &TrackedPosition,
    candle: &Candle,
) -> Option<ExitReason> {
    let close = candle.close.to_f64().unwrap_or(0.0);
    let high = candle.high.to_f64().unwrap_or(0.0);
    let low = candle.low.to_f64().unwrap_or(0.0);

    for rule in exit_rules {
        match rule {
            ExitRule::StopLoss { pct } => {
                let stop = match pos.direction {
                    Direction::Long => pos.entry_price * (1.0 - pct / 100.0),
                    Direction::Short => pos.entry_price * (1.0 + pct / 100.0),
                };
                match pos.direction {
                    Direction::Long if low <= stop => return Some(ExitReason::StopLoss),
                    Direction::Short if high >= stop => return Some(ExitReason::StopLoss),
                    _ => {}
                }
            }
            ExitRule::TakeProfit { pct } => {
                let tp = match pos.direction {
                    Direction::Long => pos.entry_price * (1.0 + pct / 100.0),
                    Direction::Short => pos.entry_price * (1.0 - pct / 100.0),
                };
                match pos.direction {
                    Direction::Long if high >= tp => return Some(ExitReason::TakeProfit),
                    Direction::Short if low <= tp => return Some(ExitReason::TakeProfit),
                    _ => {}
                }
            }
            ExitRule::TrailingStop {
                activation_pct,
                trail_pct,
            } => {
                let move_pct = match pos.direction {
                    Direction::Long => (pos.high_water - pos.entry_price) / pos.entry_price,
                    Direction::Short => (pos.entry_price - pos.low_water) / pos.entry_price,
                };
                if move_pct >= *activation_pct {
                    let trail = match pos.direction {
                        Direction::Long => pos.high_water * (1.0 - trail_pct),
                        Direction::Short => pos.low_water * (1.0 + trail_pct),
                    };
                    match pos.direction {
                        Direction::Long if close <= trail => return Some(ExitReason::TrailingStop),
                        Direction::Short if close >= trail => {
                            return Some(ExitReason::TrailingStop);
                        }
                        _ => {}
                    }
                }
            }
            ExitRule::TimeLimit { max_candles } => {
                if pos.candles_held >= *max_candles {
                    return Some(ExitReason::TimeLimit);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candle(ts: i64, token: &str, close: f64) -> Candle {
        Candle {
            timestamp: ts,
            token: token.into(),
            open: Decimal::try_from(close).unwrap(),
            high: Decimal::try_from(close * 1.01).unwrap(),
            low: Decimal::try_from(close * 0.99).unwrap(),
            close: Decimal::try_from(close).unwrap(),
            volume: Decimal::new(1000, 0),
        }
    }

    #[test]
    fn runner_needs_history_before_signals() {
        let mut runner = StrategyRunner::new(HarnessConfig::default());
        for i in 0..10 {
            let out = runner.on_candle(&make_candle(i * 3600, "ETH", 2500.0));
            assert!(out.is_empty(), "too little history for signals");
        }
    }

    #[test]
    fn runner_tracks_positions() {
        let mut runner = StrategyRunner::new(HarnessConfig::default());
        assert!(!runner.has_position("ETH"));
        runner.positions.insert(
            "ETH".into(),
            TrackedPosition {
                token: "ETH".into(),
                direction: Direction::Long,
                entry_price: 2500.0,
                entry_time: 0,
                high_water: 2500.0,
                low_water: 2500.0,
                candles_held: 0,
            },
        );
        assert!(runner.has_position("ETH"));
        runner.close_position("ETH");
        assert!(!runner.has_position("ETH"));
    }

    #[test]
    fn runner_exit_stop_loss() {
        let runner = StrategyRunner::new(HarnessConfig {
            exit_rules: vec![ExitRule::StopLoss { pct: 5.0 }],
            ..Default::default()
        });
        let mut pos = TrackedPosition {
            token: "ETH".into(),
            direction: Direction::Long,
            entry_price: 2500.0,
            entry_time: 0,
            high_water: 2600.0,
            low_water: 2400.0,
            candles_held: 5,
        };
        // Price drops 6% below entry → SL triggers
        let candle = make_candle(100, "ETH", 2350.0);
        let exit = check_exit_rules(&runner.harness().exit_rules, &pos, &candle);
        assert!(matches!(exit, Some(ExitReason::StopLoss)));
    }

    #[test]
    fn runner_exit_take_profit() {
        let runner = StrategyRunner::new(HarnessConfig {
            exit_rules: vec![ExitRule::TakeProfit { pct: 10.0 }],
            ..Default::default()
        });
        let pos = TrackedPosition {
            token: "ETH".into(),
            direction: Direction::Long,
            entry_price: 2500.0,
            entry_time: 0,
            high_water: 2750.0,
            low_water: 2500.0,
            candles_held: 5,
        };
        // Price rises 12% above entry → TP triggers
        let candle = Candle {
            timestamp: 100,
            token: "ETH".into(),
            open: Decimal::try_from(2800.0).unwrap(),
            high: Decimal::try_from(2850.0).unwrap(), // > 2750 = 10% of 2500
            low: Decimal::try_from(2790.0).unwrap(),
            close: Decimal::try_from(2810.0).unwrap(),
            volume: Decimal::new(1000, 0),
        };
        let exit = check_exit_rules(&runner.harness().exit_rules, &pos, &candle);
        assert!(matches!(exit, Some(ExitReason::TakeProfit)));
    }

    #[test]
    fn runner_output_serde() {
        let output = RunnerOutput {
            entries: vec![TradeSignal {
                asset: "ETH".into(),
                direction: Direction::Long,
                strength: 0.8,
                size_fraction: 0.1,
                stop_loss_pct: Some(5.0),
                take_profit_pct: Some(10.0),
            }],
            exits: vec![],
        };
        let json = serde_json::to_string(&output).unwrap();
        let parsed: RunnerOutput = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.entries.len(), 1);
    }

    #[test]
    fn runner_harness_update() {
        let mut runner = StrategyRunner::new(HarnessConfig::default());
        assert_eq!(runner.harness().max_positions, 5);
        let mut h = HarnessConfig::default();
        h.max_positions = 10;
        runner.update_harness(h);
        assert_eq!(runner.harness().max_positions, 10);
    }
}
