//! Deterministic prediction-market benchmark.
//!
//! Prediction markets (Polymarket-style binary outcomes) don't track a
//! continuous price the way a spot/perp book does — each market resolves to
//! `$1` (the YES holders win) or `$0` (the NO holders win) at a fixed
//! resolution time. A continuous-price kline backtest is therefore the wrong
//! model: the only P&L event that matters is settlement.
//!
//! Real Polymarket historical odds require live network access (see the
//! `polymarket_*` examples), which makes them unreproducible in CI. This
//! module instead provides a **synthetic, fully deterministic** benchmark:
//! a fixture of markets, each with a time-series of implied YES probabilities
//! and a *known* final resolution. A [`PredictionStrategy`] reads the implied
//! probability at each step, may open one position per market (buy YES or buy
//! NO shares at the implied price), and the benchmark settles every open
//! position at resolution. The resulting per-market P&L feeds the same
//! [`crate::leaderboard::compute_stats`] used everywhere else, so prediction
//! candidates get a reproducible Sharpe / drawdown / win-rate / return fitness
//! signal with no external data.
//!
//! Share mechanics (standard binary-market accounting): a `stake_usd` bet at
//! implied price `p` (= the cost of one YES share, `0 < p < 1`) buys
//! `stake_usd / p` shares of the chosen side. At resolution the winning side's
//! shares pay `$1` each and the losing side's pay `$0`:
//!   - correct side: `pnl = stake * (1 - p) / p`   (price `p` for the side held)
//!   - wrong side:   `pnl = -stake`
//! A taker fee in bps is charged on the entry notional (`stake_usd`).

use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde::{Deserialize, Serialize};

use crate::leaderboard::{self, EquityPoint, LeaderboardStats};

use super::engine::BacktestEngine;
use super::types::{BacktestConfig, BacktestResult, Candle, Direction, HarnessConfig, SlippageModel};

/// Final settlement of a binary prediction market.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    Yes,
    No,
}

/// Which side of a market a strategy takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Yes,
    No,
}

impl Side {
    /// True if this side wins under `resolution`.
    pub fn wins(self, resolution: Resolution) -> bool {
        matches!(
            (self, resolution),
            (Side::Yes, Resolution::Yes) | (Side::No, Resolution::No)
        )
    }
}

/// One implied-probability observation in a market's history.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ProbabilityPoint {
    pub timestamp: i64,
    /// Implied probability that the market resolves YES, in `[0, 1]`.
    pub yes_prob: f64,
}

/// A synthetic prediction market: an implied-probability time-series plus the
/// known final resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionMarket {
    pub market_id: String,
    /// Chronologically sorted YES-probability observations. The benchmark sorts
    /// defensively, so callers don't have to.
    pub history: Vec<ProbabilityPoint>,
    /// The known final outcome the market settled to.
    pub resolution: Resolution,
}

/// A decision a strategy makes at one observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredictionSignal {
    /// Open a position on `side` (ignored if already in a position for this
    /// market — one position per market).
    Enter(Side),
    /// Do nothing this step.
    Hold,
}

/// A prediction strategy: given the market and the index of the current
/// observation (with `history[..=idx]` visible — no lookahead), decide whether
/// to enter and on which side.
///
/// Implementations must be deterministic: the same fixture + strategy always
/// produces the same score.
pub trait PredictionStrategy {
    /// Human-readable id for reporting.
    fn name(&self) -> &str;

    /// Decide at observation `idx`. Only `market.history[..=idx]` may be read —
    /// the resolution and future points are NOT available (no lookahead).
    fn decide(&self, market: &PredictionMarket, idx: usize) -> PredictionSignal;

    /// Return the `(side, observation_index)` of the FIRST entry the strategy
    /// makes on `market`, scanning observations in time order. `None` if the
    /// strategy never enters.
    ///
    /// The default walks `decide` per observation (no lookahead by
    /// construction). Stateful strategies (e.g. ones driving a streaming
    /// engine) override this to evaluate the market in a single pass.
    fn first_entry(&self, market: &PredictionMarket) -> Option<(Side, usize)> {
        for idx in 0..market.history.len() {
            if let PredictionSignal::Enter(side) = self.decide(market, idx) {
                return Some((side, idx));
            }
        }
        None
    }
}

/// Benchmark configuration: stake per market and entry fee.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionBenchmarkConfig {
    /// USD staked per market entry.
    pub stake_usd: f64,
    /// Taker fee charged on entry notional, in basis points.
    pub fee_bps: u32,
}

impl Default for PredictionBenchmarkConfig {
    fn default() -> Self {
        Self {
            stake_usd: 100.0,
            fee_bps: 0,
        }
    }
}

/// One settled prediction trade.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionTrade {
    pub market_id: String,
    pub side: Side,
    pub resolution: Resolution,
    /// Implied price (probability of the chosen side) paid at entry.
    pub entry_price: f64,
    pub entry_timestamp: i64,
    pub resolution_timestamp: i64,
    pub stake_usd: f64,
    pub fee_usd: f64,
    /// Net P&L in USD after fee.
    pub pnl_usd: f64,
    pub won: bool,
}

impl Default for PredictionBenchmarkResult {
    fn default() -> Self {
        Self {
            trades: Vec::new(),
            result: empty_backtest_result(),
            markets_evaluated: 0,
            markets_entered: 0,
            total_fees_usd: 0.0,
        }
    }
}

/// Result of scoring a strategy over a prediction fixture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionBenchmarkResult {
    pub trades: Vec<PredictionTrade>,
    /// Standard metrics (Sharpe / Sortino / drawdown / win-rate / return),
    /// computed by [`crate::leaderboard::compute_stats`] over the per-market
    /// settlement equity curve, wrapped in the shared [`BacktestResult`] so
    /// the existing promotion pipeline / fitness scorers can consume it.
    pub result: BacktestResult,
    pub markets_evaluated: usize,
    pub markets_entered: usize,
    pub total_fees_usd: f64,
}

/// Run `strategy` over `markets` and settle every open position at resolution.
///
/// Deterministic: identical `markets` + `strategy` + `config` always produce
/// the same result. The equity curve advances one point per *entered* market
/// (in fixture order), starting from `stake_usd * markets.len()` notional bank
/// so drawdown is meaningful across the run.
pub fn run_prediction_benchmark(
    markets: &[PredictionMarket],
    strategy: &dyn PredictionStrategy,
    config: &PredictionBenchmarkConfig,
) -> PredictionBenchmarkResult {
    let stake = config.stake_usd.max(0.0);
    let fee_rate = config.fee_bps as f64 / 10_000.0;

    let mut trades: Vec<PredictionTrade> = Vec::new();
    let mut total_fees = 0.0_f64;

    // Bank starts large enough to fund one stake per market so equity never
    // goes negative and drawdown is well-defined.
    let starting_bank = (stake * markets.len().max(1) as f64).max(1.0);
    let mut equity = starting_bank;
    let mut equity_curve: Vec<EquityPoint> = Vec::with_capacity(markets.len() + 1);
    let mut markets_entered = 0usize;

    // Seed the curve at t=0 so a single trade still yields >=2 points and
    // compute_stats produces real metrics.
    equity_curve.push(EquityPoint {
        timestamp_secs: 0,
        account_value: dec(equity),
    });

    for market in markets {
        if market.history.is_empty() {
            continue;
        }
        let mut sorted = market.history.clone();
        sorted.sort_by_key(|p| p.timestamp);
        let sorted_market = PredictionMarket {
            market_id: market.market_id.clone(),
            history: sorted.clone(),
            resolution: market.resolution,
        };
        let history = &sorted;

        // The strategy may enter once; reject degenerate (unfillable) prices.
        let entry = strategy.first_entry(&sorted_market).and_then(|(side, idx)| {
            let point = history[idx];
            let price = side_price(side, point.yes_prob);
            (price > 0.0 && price < 1.0).then_some((side, point))
        });

        let Some((side, point)) = entry else {
            continue;
        };
        markets_entered += 1;

        let price = side_price(side, point.yes_prob);
        let fee = stake * fee_rate;
        total_fees += fee;
        let won = side.wins(market.resolution);
        // Settlement P&L on the stake, net of entry fee.
        let gross = if won {
            stake * (1.0 - price) / price
        } else {
            -stake
        };
        let pnl = gross - fee;
        equity += pnl;

        let resolution_ts = history.last().map(|p| p.timestamp).unwrap_or(point.timestamp);
        trades.push(PredictionTrade {
            market_id: market.market_id.clone(),
            side,
            resolution: market.resolution,
            entry_price: price,
            entry_timestamp: point.timestamp,
            resolution_timestamp: resolution_ts,
            stake_usd: stake,
            fee_usd: fee,
            pnl_usd: pnl,
            won,
        });

        equity_curve.push(EquityPoint {
            // Monotonic timeline keyed by entry order so the curve is strictly
            // increasing in time even when markets share timestamps.
            timestamp_secs: markets_entered as i64 * 86_400,
            account_value: dec(equity),
        });
    }

    let trade_pnls: Vec<Decimal> = trades.iter().map(|t| dec(t.pnl_usd)).collect();
    let stats = leaderboard::compute_stats("prediction-benchmark", &equity_curve, &trade_pnls);
    let total_pnl: Decimal = trade_pnls.iter().copied().sum();

    let result = BacktestResult {
        trades: Vec::new(),
        equity_curve,
        stats,
        total_fees: dec(total_fees),
        total_slippage: Decimal::ZERO,
        total_gas: Decimal::ZERO,
        candles_processed: markets.iter().map(|m| m.history.len()).sum(),
        tokens_traded: trades.iter().map(|t| t.market_id.clone()).collect(),
    };
    let _ = total_pnl; // total realised P&L is recoverable from trades; kept explicit for clarity.

    PredictionBenchmarkResult {
        trades,
        result,
        markets_evaluated: markets.iter().filter(|m| !m.history.is_empty()).count(),
        markets_entered,
        total_fees_usd: total_fees,
    }
}

/// Cost of one share of `side` given the YES probability.
fn side_price(side: Side, yes_prob: f64) -> f64 {
    let p = yes_prob.clamp(0.0, 1.0);
    match side {
        Side::Yes => p,
        Side::No => 1.0 - p,
    }
}

fn dec(v: f64) -> Decimal {
    Decimal::from_f64(v).unwrap_or(Decimal::ZERO)
}

fn empty_backtest_result() -> BacktestResult {
    BacktestResult {
        trades: Vec::new(),
        equity_curve: Vec::new(),
        stats: LeaderboardStats {
            bot_id: "prediction-benchmark".into(),
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
        tokens_traded: Vec::new(),
    }
}

// ───────────────────────── Reference strategies ─────────────────────────────
//
// Concrete deterministic strategies. These double as (a) the promotion-gate
// reference baselines and (b) the test oracles. Product/agent strategies can
// implement `PredictionStrategy` directly; the harness-driven families plug in
// via `HarnessPredictionStrategy` below.

/// Threshold strategy: buy YES when the implied probability is high enough to
/// be a confident YES, buy NO when it's low enough to be a confident NO,
/// otherwise hold. This is a real edge-extracting strategy — given a fixture
/// where prices track the eventual outcome, it bets the resolved side.
#[derive(Debug, Clone)]
pub struct ThresholdStrategy {
    pub buy_yes_above: f64,
    pub buy_no_below: f64,
}

impl Default for ThresholdStrategy {
    fn default() -> Self {
        Self {
            buy_yes_above: 0.6,
            buy_no_below: 0.4,
        }
    }
}

impl PredictionStrategy for ThresholdStrategy {
    fn name(&self) -> &str {
        "threshold"
    }

    fn decide(&self, market: &PredictionMarket, idx: usize) -> PredictionSignal {
        let p = market.history[idx].yes_prob;
        if p >= self.buy_yes_above {
            PredictionSignal::Enter(Side::Yes)
        } else if p <= self.buy_no_below {
            PredictionSignal::Enter(Side::No)
        } else {
            PredictionSignal::Hold
        }
    }
}

/// Deterministic coin-flip baseline: picks a side from a hash of the market id
/// (reproducible, ~50/50 across a fixture) without reading the price. Used as
/// the "no edge" control — it should score roughly breakeven minus fees.
#[derive(Debug, Clone, Default)]
pub struct CoinFlipStrategy;

impl PredictionStrategy for CoinFlipStrategy {
    fn name(&self) -> &str {
        "coin-flip"
    }

    fn decide(&self, market: &PredictionMarket, _idx: usize) -> PredictionSignal {
        // FNV-1a over the market id → stable per-market side. No price read, no
        // lookahead, so expected edge is zero.
        let mut acc: u64 = 1469598103934665603;
        for b in market.market_id.bytes() {
            acc ^= b as u64;
            acc = acc.wrapping_mul(1099511628211);
        }
        if acc & 1 == 0 {
            PredictionSignal::Enter(Side::Yes)
        } else {
            PredictionSignal::Enter(Side::No)
        }
    }
}

/// Oracle strategy that always bets the side the market actually resolved to.
/// NOT a tradeable strategy (it peeks at the resolution) — it exists only to
/// prove the settlement accounting is correct: a perfectly-correct better must
/// score strictly positive.
#[derive(Debug, Clone, Default)]
pub struct AlwaysCorrectStrategy;

impl PredictionStrategy for AlwaysCorrectStrategy {
    fn name(&self) -> &str {
        "always-correct"
    }

    fn decide(&self, market: &PredictionMarket, _idx: usize) -> PredictionSignal {
        match market.resolution {
            Resolution::Yes => PredictionSignal::Enter(Side::Yes),
            Resolution::No => PredictionSignal::Enter(Side::No),
        }
    }
}

/// Adapts an evolved [`HarnessConfig`] into a prediction strategy so the
/// promotion pipeline can score any candidate harness on the prediction
/// fixture — the same artifact the price-driven families evolve.
///
/// The YES-probability series is treated as a degenerate price series (one
/// flat OHLC bar per observation, `close = yes_prob`) and streamed through the
/// shared [`StrategyRunner`] — the identical live signal-evaluation path every
/// other family uses, so no second strategy engine drifts. The first entry the
/// harness fires maps `Long → buy YES`, `Short → buy NO`.
pub struct HarnessPredictionStrategy {
    harness: HarnessConfig,
}

impl HarnessPredictionStrategy {
    pub fn new(harness: HarnessConfig) -> Self {
        Self { harness }
    }
}

impl PredictionStrategy for HarnessPredictionStrategy {
    fn name(&self) -> &str {
        "harness"
    }

    /// Per-observation decisions aren't meaningful for the streaming runner;
    /// the harness path evaluates the whole market in [`Self::first_entry`].
    /// This is provided for trait completeness and returns the same first-entry
    /// side once the runner has reached `idx`.
    fn decide(&self, market: &PredictionMarket, idx: usize) -> PredictionSignal {
        match self.first_entry(market) {
            Some((side, entry_idx)) if entry_idx == idx => PredictionSignal::Enter(side),
            _ => PredictionSignal::Hold,
        }
    }

    fn first_entry(&self, market: &PredictionMarket) -> Option<(Side, usize)> {
        // Treat the YES-probability series as a degenerate price series and run
        // the shared engine once. The engine's entry evaluation is causal (it
        // only reads indicator values at `idx`, never future bars), so the
        // FIRST trade's entry is exactly the side/timestamp the harness would
        // have taken live — without the StrategyRunner's history-warmup quirk,
        // which only surfaces entries opening on the latest streamed bar.
        let candles: Vec<Candle> = market
            .history
            .iter()
            .map(|point| {
                let price = dec(point.yes_prob.clamp(0.0, 1.0));
                Candle {
                    timestamp: point.timestamp,
                    token: market.market_id.clone(),
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: Decimal::ZERO,
                }
            })
            .collect();

        let config = BacktestConfig {
            initial_capital: Decimal::new(10_000, 0),
            harness: self.harness.clone(),
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
        };
        let result = BacktestEngine::new(config).run(&candles, &[]).ok()?;
        // Trades are recorded in close order; the earliest entry_timestamp is
        // the first position the harness opened.
        let first = result
            .trades
            .iter()
            .min_by_key(|t| t.entry_timestamp)?;
        let idx = market
            .history
            .iter()
            .position(|p| p.timestamp == first.entry_timestamp)?;
        let side = match first.direction {
            Direction::Long => Side::Yes,
            Direction::Short => Side::No,
        };
        Some((side, idx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a market whose implied YES probability ramps from `start` to `end`
    /// over `n` hourly points, resolving to `resolution`.
    fn ramp_market(
        id: &str,
        start: f64,
        end: f64,
        n: usize,
        resolution: Resolution,
    ) -> PredictionMarket {
        let n = n.max(2);
        let history = (0..n)
            .map(|i| {
                let f = i as f64 / (n - 1) as f64;
                ProbabilityPoint {
                    timestamp: i as i64 * 3600,
                    yes_prob: start + (end - start) * f,
                }
            })
            .collect();
        PredictionMarket {
            market_id: id.to_string(),
            history,
            resolution,
        }
    }

    /// A balanced fixture: half resolve YES (price drifts up), half resolve NO
    /// (price drifts down), all starting from a near-coin-flip midpoint so the
    /// threshold strategy has to read the trend to be right.
    fn balanced_fixture() -> Vec<PredictionMarket> {
        // 48 hourly points per market: long enough that the streaming
        // StrategyRunner the harness path drives clears its history warmup.
        let mut markets = Vec::new();
        for i in 0..6 {
            markets.push(ramp_market(
                &format!("yes-{i}"),
                0.50,
                0.92,
                48,
                Resolution::Yes,
            ));
        }
        for i in 0..6 {
            markets.push(ramp_market(
                &format!("no-{i}"),
                0.50,
                0.08,
                48,
                Resolution::No,
            ));
        }
        markets
    }

    #[test]
    fn side_wins_accounting() {
        assert!(Side::Yes.wins(Resolution::Yes));
        assert!(!Side::Yes.wins(Resolution::No));
        assert!(Side::No.wins(Resolution::No));
        assert!(!Side::No.wins(Resolution::Yes));
    }

    #[test]
    fn correct_side_is_profitable() {
        // Single market bought YES at p=0.5 that resolves YES: stake 100 buys
        // 200 shares → payout 200, pnl = +100, fee 0.
        let market = ramp_market("m", 0.5, 0.5, 4, Resolution::Yes);
        let out = run_prediction_benchmark(
            &[market],
            &AlwaysCorrectStrategy,
            &PredictionBenchmarkConfig {
                stake_usd: 100.0,
                fee_bps: 0,
            },
        );
        assert_eq!(out.trades.len(), 1);
        let t = &out.trades[0];
        assert!(t.won);
        assert!((t.entry_price - 0.5).abs() < 1e-9);
        assert!((t.pnl_usd - 100.0).abs() < 1e-6, "pnl was {}", t.pnl_usd);
    }

    #[test]
    fn wrong_side_loses_stake() {
        // Buy YES on a market that resolves NO → lose the full stake.
        struct AlwaysYes;
        impl PredictionStrategy for AlwaysYes {
            fn name(&self) -> &str {
                "always-yes"
            }
            fn decide(&self, _m: &PredictionMarket, _i: usize) -> PredictionSignal {
                PredictionSignal::Enter(Side::Yes)
            }
        }
        let market = ramp_market("m", 0.5, 0.5, 4, Resolution::No);
        let out = run_prediction_benchmark(
            &[market],
            &AlwaysYes,
            &PredictionBenchmarkConfig {
                stake_usd: 100.0,
                fee_bps: 0,
            },
        );
        assert_eq!(out.trades.len(), 1);
        assert!(!out.trades[0].won);
        assert!((out.trades[0].pnl_usd + 100.0).abs() < 1e-6);
    }

    #[test]
    fn correct_better_scores_positive() {
        // A strategy that bets the resolved side must score strictly positive
        // total return and a non-negative Sharpe on a balanced fixture.
        let fixture = balanced_fixture();
        let out = run_prediction_benchmark(
            &fixture,
            &AlwaysCorrectStrategy,
            &PredictionBenchmarkConfig::default(),
        );
        assert_eq!(out.markets_entered, fixture.len());
        assert!(
            out.result.stats.total_return_pct > 0.0,
            "expected positive return, got {}",
            out.result.stats.total_return_pct
        );
        assert!(
            out.result.stats.win_rate > 0.99,
            "always-correct should win every market, got win_rate {}",
            out.result.stats.win_rate
        );
        let realized: f64 = out.trades.iter().map(|t| t.pnl_usd).sum();
        assert!(realized > 0.0, "realized pnl {realized} must be positive");
    }

    #[test]
    fn threshold_strategy_extracts_edge() {
        // The real (non-oracle) threshold strategy reads the trend and should
        // still come out positive on the balanced fixture, because price tracks
        // the eventual resolution.
        let fixture = balanced_fixture();
        let out = run_prediction_benchmark(
            &fixture,
            &ThresholdStrategy::default(),
            &PredictionBenchmarkConfig::default(),
        );
        assert!(out.markets_entered >= fixture.len() - 1);
        assert!(
            out.result.stats.total_return_pct > 0.0,
            "threshold strategy should be profitable when price tracks outcome, got {}",
            out.result.stats.total_return_pct
        );
        // Every entry is on the correct side because each market's price has
        // crossed its threshold in the direction of its resolution.
        assert!(out.trades.iter().all(|t| t.won));
    }

    #[test]
    fn coin_flip_is_breakeven_minus_fees() {
        // A no-edge coin-flip on a fixture priced fairly (entry price ≈ implied
        // probability) has expected value ~0 before fees. With a fee it should
        // land near breakeven and strictly below the always-correct better.
        let fixture = balanced_fixture();
        let cfg = PredictionBenchmarkConfig {
            stake_usd: 100.0,
            fee_bps: 50, // 0.5%
        };
        let flip = run_prediction_benchmark(&fixture, &CoinFlipStrategy, &cfg);
        let correct = run_prediction_benchmark(&fixture, &AlwaysCorrectStrategy, &cfg);

        let flip_pnl: f64 = flip.trades.iter().map(|t| t.pnl_usd).sum();
        let correct_pnl: f64 = correct.trades.iter().map(|t| t.pnl_usd).sum();

        // Coin-flip must score strictly worse than the always-correct better.
        assert!(
            flip_pnl < correct_pnl,
            "coin-flip {flip_pnl} should trail always-correct {correct_pnl}"
        );
        // And it must have paid fees on every entry.
        assert!(flip.total_fees_usd > 0.0);
        // Breakeven-ish: total P&L magnitude per market is well within a full
        // stake (it is not systematically winning or losing every market).
        let per_market = flip_pnl / flip.markets_entered as f64;
        assert!(
            per_market.abs() < cfg.stake_usd,
            "coin-flip per-market pnl {per_market} should be near breakeven, not a systematic win/loss"
        );
    }

    #[test]
    fn degenerate_prices_are_skipped() {
        // p=0 or p=1 is unfillable — no counterparty edge. A market that only
        // ever shows a degenerate price yields no trade.
        let market = ramp_market("degenerate", 1.0, 1.0, 4, Resolution::Yes);
        let out = run_prediction_benchmark(
            &[market],
            &AlwaysCorrectStrategy,
            &PredictionBenchmarkConfig::default(),
        );
        assert_eq!(out.trades.len(), 0);
        assert_eq!(out.markets_entered, 0);
    }

    #[test]
    fn harness_strategy_scores_through_shared_pipeline() {
        use crate::backtest::types::{
            EntryCondition, EntryRule, ExitRule, PositionSizing, SignalType,
        };
        // A momentum harness: enter long when short-window price momentum is
        // positive. On the YES markets (price ramping up) it fires Long → buys
        // YES; on NO markets momentum is negative so it stays out or shorts.
        // Either way the evolved HarnessConfig is scored through the SAME
        // StrategyRunner path the live families use — proving the promotion
        // pipeline can fitness-test a prediction candidate.
        let harness = HarnessConfig {
            version: 1,
            entry_rules: vec![EntryRule {
                signal: SignalType::PriceMomentum { lookback_candles: 5 },
                condition: EntryCondition::Positive,
                weight: 1.0,
                tokens: vec![],
            }],
            exit_rules: vec![
                ExitRule::StopLoss { pct: 90.0 },
                ExitRule::TakeProfit { pct: 95.0 },
            ],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
            entry_threshold: 0.1,
            max_positions: 5,
        };
        let fixture = balanced_fixture();
        let strat = HarnessPredictionStrategy::new(harness);
        let out =
            run_prediction_benchmark(&fixture, &strat, &PredictionBenchmarkConfig::default());

        // The harness MUST actually fire entries on the up-ramping YES markets
        // (momentum positive) — otherwise the integration is dead.
        assert!(
            out.markets_entered > 0,
            "harness strategy entered no markets — runner path is not firing"
        );
        // Every fired entry is Long→YES on a YES-resolving up-ramp, so it wins.
        assert!(
            out.trades.iter().all(|t| matches!(t.side, Side::Yes)),
            "momentum-positive should only buy YES on this fixture"
        );
        assert!(
            out.result.stats.total_return_pct > 0.0,
            "momentum harness should be profitable on trending fixture, got {}",
            out.result.stats.total_return_pct
        );
    }

    #[test]
    fn empty_history_market_is_ignored() {
        let market = PredictionMarket {
            market_id: "empty".into(),
            history: Vec::new(),
            resolution: Resolution::Yes,
        };
        let out = run_prediction_benchmark(
            &[market],
            &AlwaysCorrectStrategy,
            &PredictionBenchmarkConfig::default(),
        );
        assert_eq!(out.markets_evaluated, 0);
        assert_eq!(out.trades.len(), 0);
    }
}
