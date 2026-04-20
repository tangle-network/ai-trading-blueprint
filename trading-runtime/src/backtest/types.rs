use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::leaderboard::{EquityPoint, LeaderboardStats};

/// OHLCV candle — the atomic unit of historical price data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candle {
    pub timestamp: i64,
    /// Token identifier (address, symbol, or pair name). Defaults to "default".
    #[serde(default = "default_token")]
    pub token: String,
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
    pub close: Decimal,
    pub volume: Decimal,
}

fn default_token() -> String {
    "default".into()
}

/// Funding rate snapshot for perp markets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FundingSnapshot {
    pub timestamp: i64,
    #[serde(default = "default_token")]
    pub token: String,
    pub rate: Decimal,
}

/// Backtest run configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestConfig {
    pub initial_capital: Decimal,
    pub harness: HarnessConfig,
    pub slippage: SlippageModel,
    pub gas_cost_usd: Decimal,
    pub taker_fee_bps: u32,
}

impl Default for BacktestConfig {
    fn default() -> Self {
        Self {
            initial_capital: Decimal::new(10_000, 0),
            harness: HarnessConfig::default(),
            slippage: SlippageModel::FixedBps { bps: 10 },
            gas_cost_usd: Decimal::new(2, 0),
            taker_fee_bps: 10,
        }
    }
}

/// Slippage model for trade cost simulation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum SlippageModel {
    /// Constant basis points regardless of size.
    FixedBps { bps: u32 },
    /// Square-root impact: effective_bps = base_bps * sqrt(size_usd / depth_usd).
    /// Models AMM/order-book impact where large trades move price more.
    SqrtImpact { base_bps: u32, depth_usd: Decimal },
}

impl SlippageModel {
    /// Compute effective slippage in bps for a given trade size.
    pub fn effective_bps(&self, size_usd: Decimal) -> u32 {
        match self {
            Self::FixedBps { bps } => *bps,
            Self::SqrtImpact {
                base_bps,
                depth_usd,
            } => {
                if *depth_usd <= Decimal::ZERO {
                    return *base_bps;
                }
                let ratio = size_usd / *depth_usd;
                let ratio_f64 = ratio.to_string().parse::<f64>().unwrap_or(0.0);
                let impact = (*base_bps as f64) * ratio_f64.sqrt();
                // Cap at 500 bps (5%) to avoid degenerate results
                (impact as u32).min(500)
            }
        }
    }
}

/// The harness — structured strategy config that the AI agent produces
/// and meta-harness evolves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessConfig {
    pub version: u32,
    pub entry_rules: Vec<EntryRule>,
    pub exit_rules: Vec<ExitRule>,
    pub filters: Vec<Filter>,
    pub position_sizing: PositionSizing,
    /// Minimum weighted signal agreement to enter (0.0–1.0).
    #[serde(default = "default_entry_threshold")]
    pub entry_threshold: f64,
    /// Maximum concurrent positions across all tokens.
    #[serde(default = "default_max_positions")]
    pub max_positions: usize,
}

fn default_entry_threshold() -> f64 {
    0.3
}

fn default_max_positions() -> usize {
    5
}

impl Default for HarnessConfig {
    fn default() -> Self {
        Self {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::Rsi { period: 14 },
                    condition: EntryCondition::Below { threshold: 30.0 },
                    weight: 0.5,
                    tokens: vec![],
                },
                EntryRule {
                    signal: SignalType::EmaCross {
                        short_period: 12,
                        long_period: 26,
                    },
                    condition: EntryCondition::CrossAbove,
                    weight: 0.5,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![
                ExitRule::StopLoss { pct: 5.0 },
                ExitRule::TakeProfit { pct: 10.0 },
            ],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
            entry_threshold: 0.3,
            max_positions: 5,
        }
    }
}

impl HarnessConfig {
    /// Validate the config before using it. Returns all errors found.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.entry_rules.is_empty() {
            errors.push("entry_rules is empty".into());
        }
        if self.exit_rules.is_empty() {
            errors.push("exit_rules is empty".into());
        }

        // Resource limits
        if self.entry_rules.len() > 100 {
            errors.push(format!(
                "entry_rules count {} exceeds 100 limit",
                self.entry_rules.len()
            ));
        }
        if self.exit_rules.len() > 50 {
            errors.push(format!(
                "exit_rules count {} exceeds 50 limit",
                self.exit_rules.len()
            ));
        }
        if self.filters.len() > 20 {
            errors.push(format!(
                "filters count {} exceeds 20 limit",
                self.filters.len()
            ));
        }

        let total_weight: f64 = self.entry_rules.iter().map(|r| r.weight).sum();
        if total_weight <= 0.0 || total_weight.is_nan() || total_weight.is_infinite() {
            errors.push("entry rule weights sum is zero, negative, NaN, or infinite".into());
        }

        for (i, rule) in self.entry_rules.iter().enumerate() {
            if rule.weight < 0.0 || rule.weight.is_nan() || rule.weight.is_infinite() {
                errors.push(format!("entry_rules[{i}]: invalid weight"));
            }
            match &rule.signal {
                SignalType::Rsi { period } if *period == 0 => {
                    errors.push(format!("entry_rules[{i}]: RSI period is 0"));
                }
                SignalType::EmaCross {
                    short_period,
                    long_period,
                } if *short_period == 0 || *long_period == 0 || *short_period >= *long_period => {
                    errors.push(format!(
                        "entry_rules[{i}]: EMA cross periods invalid (short={short_period}, long={long_period})"
                    ));
                }
                _ => {}
            }
        }

        if self.entry_threshold < 0.0 || self.entry_threshold > 1.0 || self.entry_threshold.is_nan()
        {
            errors.push(format!(
                "entry_threshold {} out of [0, 1] range or NaN",
                self.entry_threshold
            ));
        }

        if self.max_positions == 0 {
            errors.push("max_positions is 0".into());
        }

        // Validate position sizing f64 fields
        match &self.position_sizing {
            PositionSizing::FixedFraction { fraction } => {
                if *fraction <= 0.0 || *fraction > 1.0 || fraction.is_nan() {
                    errors.push(format!("fixed_fraction {fraction} must be in (0, 1]"));
                }
            }
            PositionSizing::KellyFraction {
                kelly_multiplier,
                max_position_pct,
            } => {
                if *kelly_multiplier <= 0.0 || kelly_multiplier.is_nan() {
                    errors.push(format!(
                        "kelly_multiplier {kelly_multiplier} must be positive"
                    ));
                }
                if *max_position_pct <= 0.0
                    || *max_position_pct > 100.0
                    || max_position_pct.is_nan()
                {
                    errors.push(format!(
                        "max_position_pct {max_position_pct} must be in (0, 100]"
                    ));
                }
            }
            PositionSizing::FixedAmount { amount_usd } => {
                if *amount_usd <= Decimal::ZERO {
                    errors.push("fixed_amount must be positive".into());
                }
            }
        }

        // Validate filter f64 fields
        for (i, filter) in self.filters.iter().enumerate() {
            if let Filter::VolatilityGate {
                min_atr_pct,
                max_atr_pct,
                period,
            } = filter
            {
                if min_atr_pct > max_atr_pct {
                    errors.push(format!(
                        "filters[{i}]: min_atr_pct ({min_atr_pct}) > max_atr_pct ({max_atr_pct})"
                    ));
                }
                if *period == 0 {
                    errors.push(format!("filters[{i}]: volatility gate period is 0"));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

/// A single entry rule: signal + condition + weight.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryRule {
    pub signal: SignalType,
    pub condition: EntryCondition,
    pub weight: f64,
    /// Token filter: empty = applies to all tokens.
    #[serde(default)]
    pub tokens: Vec<String>,
}

/// Technical signal types computed from candle data.
///
/// The meta-harness evolves which signals are used and their parameters.
/// Add new signal types here to expand the agent's vocabulary — the
/// evolve-strategy.js loop will discover which combinations work.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalType {
    // ── Momentum ────────────────────────────────────────────
    Rsi {
        period: usize,
    },
    PriceMomentum {
        lookback_candles: usize,
    },
    Macd {
        fast_period: usize,
        slow_period: usize,
        signal_period: usize,
    },

    // ── Trend ───────────────────────────────────────────────
    EmaCross {
        short_period: usize,
        long_period: usize,
    },
    SmaCross {
        short_period: usize,
        long_period: usize,
    },

    // ── Volatility ──────────────────────────────────────────
    BollingerBand {
        period: usize,
        std_dev: f64,
    },
    AtrBreakout {
        period: usize,
        multiplier: f64,
    },

    // ── Volume ──────────────────────────────────────────────
    VolumeSurge {
        lookback_candles: usize,
        multiplier: f64,
    },
    Obv {
        lookback_candles: usize,
    },
    Vwap {
        period: usize,
    },

    // ── Market structure ────────────────────────────────────
    FundingRate,
    FundingRateSpread {
        /// Threshold in bps — signal fires when spread exceeds this
        threshold_bps: f64,
    },
    MeanReversion {
        lookback_candles: usize,
        z_score_threshold: f64,
    },
}

/// Conditions evaluated against signal values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EntryCondition {
    Below { threshold: f64 },
    Above { threshold: f64 },
    CrossAbove,
    CrossBelow,
    Negative,
    Positive,
}

/// Exit rules checked on every candle while a position is open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExitRule {
    StopLoss { pct: f64 },
    TakeProfit { pct: f64 },
    TrailingStop { activation_pct: f64, trail_pct: f64 },
    TimeLimit { max_candles: usize },
}

/// Pre-entry filters that gate whether signals are evaluated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Filter {
    VolatilityGate {
        min_atr_pct: f64,
        max_atr_pct: f64,
        period: usize,
    },
    TimeFilter {
        skip_hours: Vec<u32>,
    },
    MinVolume {
        threshold: Decimal,
    },
}

/// Position sizing methods.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum PositionSizing {
    FixedFraction {
        fraction: f64,
    },
    KellyFraction {
        kelly_multiplier: f64,
        max_position_pct: f64,
    },
    FixedAmount {
        amount_usd: Decimal,
    },
}

/// Trade direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Long,
    Short,
}

/// Why a position was closed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    StopLoss,
    TakeProfit,
    TrailingStop,
    TimeLimit,
    SignalExit,
    EndOfData,
}

/// A completed simulated trade.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulatedTrade {
    pub token: String,
    pub entry_timestamp: i64,
    pub exit_timestamp: i64,
    pub direction: Direction,
    pub entry_price: Decimal,
    pub exit_price: Decimal,
    pub size_usd: Decimal,
    pub pnl: Decimal,
    pub pnl_pct: f64,
    pub slippage_cost: Decimal,
    pub gas_cost: Decimal,
    pub fee_cost: Decimal,
    pub exit_reason: ExitReason,
}

/// Open position tracked during simulation (not serialized).
#[derive(Debug, Clone)]
pub(crate) struct OpenPosition {
    pub token: String,
    pub entry_timestamp: i64,
    pub direction: Direction,
    pub entry_fill: Decimal,
    pub size_usd: Decimal,
    pub high_water: Decimal,
    pub low_water: Decimal,
    pub trailing_active: bool,
    pub candles_held: usize,
}

/// Result of a backtest run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestResult {
    pub trades: Vec<SimulatedTrade>,
    pub equity_curve: Vec<EquityPoint>,
    pub stats: LeaderboardStats,
    pub total_fees: Decimal,
    pub total_slippage: Decimal,
    pub total_gas: Decimal,
    pub candles_processed: usize,
    pub tokens_traded: Vec<String>,
}

/// Side-by-side comparison of two strategy backtests on the same data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestComparison {
    pub current: BacktestResult,
    pub candidate: BacktestResult,
    pub sharpe_delta: f64,
    pub drawdown_delta: f64,
    pub win_rate_delta: f64,
}

impl BacktestComparison {
    /// Meta-harness promotion criteria:
    /// - Sharpe improvement > 10%
    /// - No drawdown regression > 5%
    pub fn should_promote(&self) -> bool {
        let base_sharpe = self.current.stats.sharpe_ratio.abs().max(0.01);
        let sharpe_improved = self.sharpe_delta / base_sharpe > 0.10;

        let base_dd = self.current.stats.max_drawdown_pct.abs().max(0.01);
        let no_dd_regression = self.drawdown_delta / base_dd < 0.05;

        sharpe_improved && no_dd_regression
    }
}

/// Walk-forward validation result: train/test split comparison.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalkForwardResult {
    pub train: BacktestComparison,
    pub test: BacktestComparison,
    /// Only true if candidate beats current on BOTH train and test.
    pub should_promote: bool,
    pub train_candles: usize,
    pub test_candles: usize,
    /// Ratio of out-of-sample Sharpe to in-sample Sharpe.
    /// > 0.5 = likely generalizes. < 0.3 = likely overfit.
    #[serde(default)]
    pub sharpe_ratio_decay: f64,
    /// Whether the config is likely overfit (sharpe_ratio_decay < 0.3)
    #[serde(default)]
    pub likely_overfit: bool,
}

/// Precomputed indicator arrays per token, keyed by their parameters.
#[derive(Debug, Default)]
pub(crate) struct TokenIndicators {
    pub rsi: std::collections::HashMap<usize, Vec<f64>>,
    pub ema: std::collections::HashMap<usize, Vec<f64>>,
    pub atr: std::collections::HashMap<usize, Vec<f64>>,
    pub ema_cross: std::collections::HashMap<(usize, usize), Vec<i8>>,
}

/// Running trade statistics for Kelly sizing.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunningTradeStats {
    pub wins: u64,
    pub losses: u64,
    pub total_win_pnl: f64,
    pub total_loss_pnl: f64,
}

impl RunningTradeStats {
    pub fn record(&mut self, pnl: f64) {
        if pnl > 0.0 {
            self.wins += 1;
            self.total_win_pnl += pnl;
        } else if pnl < 0.0 {
            self.losses += 1;
            self.total_loss_pnl += pnl.abs();
        }
    }

    /// Kelly fraction: (p * b - q) / b where p=win_rate, q=1-p, b=avg_win/avg_loss.
    /// Returns 0.0 if insufficient data or negative edge.
    pub fn kelly_fraction(&self) -> f64 {
        let total = self.wins + self.losses;
        if total < 5 {
            return 0.0;
        }
        let p = self.wins as f64 / total as f64;
        let q = 1.0 - p;
        let avg_win = self.total_win_pnl / self.wins.max(1) as f64;
        let avg_loss = self.total_loss_pnl / self.losses.max(1) as f64;
        if avg_loss < 1e-10 {
            return 0.0;
        }
        let b = avg_win / avg_loss;
        if b < 1e-10 || b.is_nan() || b.is_infinite() {
            return 0.0;
        }
        let kelly = (p * b - q) / b;
        let result = kelly.max(0.0);
        if result.is_nan() || result.is_infinite() {
            0.0
        } else {
            result
        }
    }
}
