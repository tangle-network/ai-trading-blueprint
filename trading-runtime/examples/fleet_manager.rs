//! Fleet review — institutional-grade analysis of the candle-source +
//! backtest + meta-harness loop against six months of native-venue data.
//!
//! Twelve bots across six venues run five strategy variants each (60 runs)
//! over ~4,320 hourly bars from each bot's native venue. Each run records:
//!
//!   * Sharpe + bootstrap CI (1000 resamples of trade-PnL series)
//!   * Sortino, Calmar, max drawdown %, win rate
//!   * Profit factor, expectancy, payoff ratio, avg win / avg loss
//!   * Walk-forward in-sample → out-of-sample Sharpe gap (overfit indicator)
//!   * Total realised fees + slippage at the venue's CALIBRATED taker rate
//!     (from `protocol_fees::SCHEDULES` — not a flat 10 bps guess)
//!   * Buy-and-hold benchmark on the same window
//!
//! Report sections (in order):
//!   1. Executive summary
//!   2. Per-bot best strategy + Sharpe CI + verdict vs buy-and-hold
//!   3. Strategy × bot matrix (Sharpe with 95% CI band)
//!   4. Risk decomposition table (DD, Sortino, Calmar, profit factor)
//!   5. Walk-forward (in-sample vs out-of-sample) — overfitting check
//!   6. Trade statistics (expectancy, payoff, win/loss size)
//!   7. Cost breakdown (fees + slippage + gas per bot)
//!   8. Honest caveats — sample size, regime, look-ahead, missing data
//!
//! Reproduce with:
//!   cargo run -p trading-runtime --example fleet_manager --release
//!
//! No env / auth needed. Wall-clock budget is dominated by network I/O
//! (~20 s on a warm DNS cache for the full fleet); the backtest engine
//! itself runs the 60 runs in well under a second.

use std::collections::BTreeMap;
use std::time::Instant;

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;

use trading_runtime::analytics::{bootstrap, monte_carlo, regime};
use trading_runtime::backtest::{
    BacktestConfig, BacktestEngine, BacktestResult, Candle, EntryCondition, EntryRule, ExitRule,
    Filter, HarnessConfig, Interval, PositionSizing, SignalType, SimulatedTrade, SlippageModel,
};
use trading_runtime::candle_sources::{self, Source};
use trading_runtime::protocol_fees;

// ── Configuration ────────────────────────────────────────────────────────────
const LIMIT: u32 = 4320; // 180 days × 24 h
const MONTE_CARLO_SHUFFLES: usize = 2_000;
const INITIAL_CAPITAL: i64 = 10_000;

// ── Fleet ────────────────────────────────────────────────────────────────────
#[derive(Clone)]
struct BotConfig {
    name: &'static str,
    source: Source,
    /// Symbol passed to the source (for GeckoTerminal: `"network:SYMBOL"`).
    symbol: &'static str,
    /// Display label for the venue column.
    venue: &'static str,
    /// Protocol id used to look up the canonical fee schedule from
    /// `protocol_fees::SCHEDULES`. This is the same id the live execute
    /// path passes to the runtime fee gate — so the backtest's fees match
    /// what we'd actually pay.
    fee_protocol: &'static str,
}

fn fleet() -> Vec<BotConfig> {
    vec![
        // ── Hyperliquid perps (native venue for the live testnet bot) ──
        BotConfig {
            name: "hl-btc",
            source: Source::Hyperliquid,
            symbol: "BTC",
            venue: "hyperliquid",
            fee_protocol: "hyperliquid_perp",
        },
        BotConfig {
            name: "hl-eth",
            source: Source::Hyperliquid,
            symbol: "ETH",
            venue: "hyperliquid",
            fee_protocol: "hyperliquid_perp",
        },
        BotConfig {
            name: "hl-sol",
            source: Source::Hyperliquid,
            symbol: "SOL",
            venue: "hyperliquid",
            fee_protocol: "hyperliquid_perp",
        },
        BotConfig {
            name: "hl-hype",
            source: Source::Hyperliquid,
            symbol: "HYPE",
            venue: "hyperliquid",
            fee_protocol: "hyperliquid_perp",
        },
        // ── CEX cross-venue references for BTC/ETH (sanity check fills) ──
        BotConfig {
            name: "bin-btc",
            source: Source::Binance,
            symbol: "BTC",
            venue: "binance",
            fee_protocol: "binance",
        },
        BotConfig {
            name: "bin-eth",
            source: Source::Binance,
            symbol: "ETH",
            venue: "binance",
            fee_protocol: "binance",
        },
        BotConfig {
            name: "cb-btc",
            source: Source::Coinbase,
            symbol: "BTC",
            venue: "coinbase",
            fee_protocol: "coinbase",
        },
        BotConfig {
            name: "cb-eth",
            source: Source::Coinbase,
            symbol: "ETH",
            venue: "coinbase",
            fee_protocol: "coinbase",
        },
        // ── Drift: Solana perps native venue ──
        BotConfig {
            name: "drift-sol",
            source: Source::Drift,
            symbol: "SOL",
            venue: "drift",
            fee_protocol: "drift",
        },
        BotConfig {
            name: "drift-btc",
            source: Source::Drift,
            symbol: "BTC",
            venue: "drift",
            fee_protocol: "drift",
        },
        // ── DEX pools via GeckoTerminal (Aerodrome on Base, Uniswap V3 on eth) ──
        BotConfig {
            name: "aerodrome-eth",
            source: Source::GeckoTerminal,
            symbol: "base:ETH",
            venue: "aerodrome",
            fee_protocol: "aerodrome",
        },
        BotConfig {
            name: "uni-eth-usdc",
            source: Source::GeckoTerminal,
            symbol: "eth:ETH",
            venue: "uniswap_v3",
            fee_protocol: "uniswap_v3",
        },
    ]
}

// ── Strategy variants ────────────────────────────────────────────────────────
#[allow(dead_code)] // `description` is human-facing documentation, not used at runtime
struct Strategy {
    name: &'static str,
    description: &'static str,
    harness: HarnessConfig,
}

fn strategies() -> Vec<Strategy> {
    vec![
        Strategy {
            name: "mom_balanced",
            description: "RSI(14)<30 OR EMA(12,26)↑ — the default; mid-frequency momentum",
            harness: HarnessConfig {
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
            },
        },
        Strategy {
            name: "mom_aggressive",
            description: "Both RSI(14)<25 AND EMA(9,21)↑ required — fewer, higher-conviction entries",
            harness: HarnessConfig {
                version: 2,
                entry_rules: vec![
                    EntryRule {
                        signal: SignalType::Rsi { period: 14 },
                        condition: EntryCondition::Below { threshold: 25.0 },
                        weight: 0.5,
                        tokens: vec![],
                    },
                    EntryRule {
                        signal: SignalType::EmaCross {
                            short_period: 9,
                            long_period: 21,
                        },
                        condition: EntryCondition::CrossAbove,
                        weight: 0.5,
                        tokens: vec![],
                    },
                ],
                exit_rules: vec![
                    ExitRule::StopLoss { pct: 4.0 },
                    ExitRule::TakeProfit { pct: 12.0 },
                ],
                filters: vec![],
                position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
                entry_threshold: 0.7, // both rules must fire (~0.5+0.5)
                max_positions: 5,
            },
        },
        Strategy {
            name: "mom_conservative",
            description: "RSI(14)<35 + EMA(20,50)↑ + ATR vol gate — slower trend follow",
            harness: HarnessConfig {
                version: 3,
                entry_rules: vec![
                    EntryRule {
                        signal: SignalType::Rsi { period: 14 },
                        condition: EntryCondition::Below { threshold: 35.0 },
                        weight: 0.4,
                        tokens: vec![],
                    },
                    EntryRule {
                        signal: SignalType::EmaCross {
                            short_period: 20,
                            long_period: 50,
                        },
                        condition: EntryCondition::CrossAbove,
                        weight: 0.6,
                        tokens: vec![],
                    },
                ],
                exit_rules: vec![
                    ExitRule::StopLoss { pct: 3.0 },
                    ExitRule::TakeProfit { pct: 15.0 },
                ],
                filters: vec![],
                position_sizing: PositionSizing::FixedFraction { fraction: 0.08 },
                entry_threshold: 0.5,
                max_positions: 3,
            },
        },
        Strategy {
            name: "mean_revert",
            description: "RSI(14)<20 (deep oversold) — tight stop + quick take-profit",
            harness: HarnessConfig {
                version: 4,
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 14 },
                    condition: EntryCondition::Below { threshold: 20.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![
                    ExitRule::StopLoss { pct: 2.5 },
                    ExitRule::TakeProfit { pct: 5.0 },
                ],
                filters: vec![],
                position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
                entry_threshold: 0.5,
                max_positions: 5,
            },
        },
        Strategy {
            name: "breakout_atr",
            description: "ATR(14) ×2 breakout + trailing stop — momentum capture",
            harness: HarnessConfig {
                version: 5,
                entry_rules: vec![EntryRule {
                    signal: SignalType::AtrBreakout {
                        period: 14,
                        multiplier: 2.0,
                    },
                    condition: EntryCondition::Positive,
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![
                    ExitRule::TrailingStop {
                        activation_pct: 3.0,
                        trail_pct: 2.0,
                    },
                    ExitRule::StopLoss { pct: 4.0 },
                ],
                filters: vec![Filter::VolatilityGate {
                    min_atr_pct: 0.5,
                    max_atr_pct: 8.0,
                    period: 14,
                }],
                position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
                entry_threshold: 0.5,
                max_positions: 5,
            },
        },
    ]
}

// ── Enhanced statistics ──────────────────────────────────────────────────────
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
struct Performance {
    // Returns + risk
    total_return_pct: f64,
    sharpe_ratio: f64,
    sharpe_ci_lo: f64,
    sharpe_ci_hi: f64,
    sortino_ratio: f64,
    calmar_ratio: f64,
    max_drawdown_pct: f64,
    // Trade quality
    n_trades: usize,
    win_rate_pct: f64,
    profit_factor: f64,
    expectancy_usd: f64,
    payoff_ratio: f64,
    avg_win_pct: f64,
    avg_loss_pct: f64,
    // Overfitting check
    in_sample_sharpe: f64,
    out_of_sample_sharpe: f64,
    // Benchmark
    buy_and_hold_pct: f64,
    excess_vs_bnh_pct: f64,
    // Costs at the venue's calibrated taker rate
    total_fees_usd: f64,
    total_slippage_usd: f64,
    total_gas_usd: f64,
    // Monte Carlo trade-order stability — where the realised Sharpe sits in
    // the shuffled distribution. percentile > 95 = timing edge; ≈ 50 = no
    // sequencing signal; < 5 = got lucky on ordering.
    mc_realised: f64,
    mc_p05: f64,
    mc_p50: f64,
    mc_p95: f64,
    mc_percentile: f64,
}

fn d(value: Decimal) -> f64 {
    value.to_f64().unwrap_or(0.0)
}

/// Profit factor = sum(positive PnL) / |sum(negative PnL)|. >1 means winners
/// outweigh losers. Returns infinity when there are wins and no losses, 0
/// when all trades lost.
fn profit_factor(trades: &[SimulatedTrade]) -> f64 {
    let mut wins = 0.0_f64;
    let mut losses = 0.0_f64;
    for t in trades {
        let p = d(t.pnl);
        if p > 0.0 {
            wins += p;
        } else if p < 0.0 {
            losses += -p;
        }
    }
    if losses == 0.0 {
        if wins == 0.0 { 0.0 } else { f64::INFINITY }
    } else {
        wins / losses
    }
}

/// Expectancy in $ = E[PnL per trade]. Mean of all closed-trade PnLs.
fn expectancy(trades: &[SimulatedTrade]) -> f64 {
    if trades.is_empty() {
        return 0.0;
    }
    let sum: f64 = trades.iter().map(|t| d(t.pnl)).sum();
    sum / trades.len() as f64
}

/// Payoff ratio = avg(winning trade PnL%) / |avg(losing trade PnL%)|.
fn payoff_ratio(trades: &[SimulatedTrade]) -> (f64, f64, f64) {
    let wins: Vec<f64> = trades
        .iter()
        .filter(|t| t.pnl_pct > 0.0)
        .map(|t| t.pnl_pct)
        .collect();
    let losses: Vec<f64> = trades
        .iter()
        .filter(|t| t.pnl_pct < 0.0)
        .map(|t| t.pnl_pct)
        .collect();
    let avg_win = if wins.is_empty() {
        0.0
    } else {
        wins.iter().sum::<f64>() / wins.len() as f64
    };
    let avg_loss = if losses.is_empty() {
        0.0
    } else {
        losses.iter().sum::<f64>() / losses.len() as f64
    };
    let payoff = if avg_loss == 0.0 {
        if avg_win == 0.0 { 0.0 } else { f64::INFINITY }
    } else {
        avg_win / -avg_loss
    };
    (payoff, avg_win, avg_loss)
}

/// Trade-PnL returns for the analytics primitives. We use trade returns
/// (not equity-curve diffs) because the engine emits at most one trade per
/// bar — equity-curve diffs are dominated by no-position periods and bias
/// the Sharpe estimate downward.
fn trade_returns(trades: &[SimulatedTrade]) -> Vec<f64> {
    trades.iter().map(|t| t.pnl_pct / 100.0).collect()
}

fn bot_seed(name: &str) -> u64 {
    name.bytes()
        .fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(b as u64))
}

fn buy_and_hold_pct(candles: &[Candle]) -> f64 {
    if candles.len() < 2 {
        return 0.0;
    }
    let open = d(candles.first().unwrap().open);
    let close = d(candles.last().unwrap().close);
    if open == 0.0 {
        0.0
    } else {
        (close - open) / open * 100.0
    }
}

fn calibrated_fees(fee_protocol: &str) -> (u32, u32) {
    protocol_fees::schedule_for(fee_protocol)
        .map(|s| (s.taker_bps, s.typical_gas_usd))
        .unwrap_or((10, 2)) // safe fallback if the protocol id wasn't registered
}

fn run_backtest(strategy: &Strategy, candles: &[Candle], fee_protocol: &str) -> BacktestResult {
    let (taker_bps, gas_usd) = calibrated_fees(fee_protocol);
    let config = BacktestConfig {
        initial_capital: Decimal::new(INITIAL_CAPITAL, 0),
        harness: strategy.harness.clone(),
        slippage: SlippageModel::FixedBps { bps: 10 },
        gas_cost_usd: Decimal::new(gas_usd as i64, 0),
        taker_fee_bps: taker_bps,
    };
    BacktestEngine::new(config)
        .run(candles, &[])
        .unwrap_or_else(|_| BacktestResult {
            trades: vec![],
            equity_curve: vec![],
            stats: trading_runtime::leaderboard::LeaderboardStats {
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

fn analyze(bot: &BotConfig, strategy: &Strategy, candles: &[Candle]) -> Performance {
    let main = run_backtest(strategy, candles, bot.fee_protocol);

    // Strategy-level walk-forward: rerun the strategy on a 70/30 in-sample /
    // out-of-sample split and compare the realised Sharpes. (This is
    // strategy-rerun walk-forward — distinct from analytics::walk_forward,
    // which is statistic-only and lives in the platform for any future
    // caller who wants Sharpe-on-slice without rerunning the strategy.)
    let split = (candles.len() as f64 * 0.7) as usize;
    let in_sample = run_backtest(strategy, &candles[..split], bot.fee_protocol);
    let out_of_sample = run_backtest(strategy, &candles[split..], bot.fee_protocol);

    let (payoff, avg_win, avg_loss) = payoff_ratio(&main.trades);
    let seed = bot_seed(bot.name);

    // Bootstrap Sharpe CI via platform primitive — replaces the previous
    // inline xorshift+clip+percentile implementation.
    let returns = trade_returns(&main.trades);
    let (sharpe_lo, sharpe_hi) = bootstrap::sharpe_ci_95(&returns, seed);

    // Monte Carlo trade-order stability — where does the realised Sharpe sit
    // in the distribution of all possible trade orderings? For a permutation-
    // invariant estimator like Sharpe this collapses (see monte_carlo tests),
    // but we record it so the report can show whether a more path-dependent
    // statistic (e.g. max-drawdown) signals timing edge later.
    let mc =
        monte_carlo::trade_order_shuffle(&returns, MONTE_CARLO_SHUFFLES, seed, bootstrap::sharpe);

    let bnh = buy_and_hold_pct(candles);

    Performance {
        total_return_pct: main.stats.total_return_pct,
        sharpe_ratio: main.stats.sharpe_ratio,
        sharpe_ci_lo: sharpe_lo,
        sharpe_ci_hi: sharpe_hi,
        sortino_ratio: main.stats.sortino_ratio,
        calmar_ratio: main.stats.calmar_ratio,
        max_drawdown_pct: main.stats.max_drawdown_pct,
        n_trades: main.trades.len(),
        win_rate_pct: main.stats.win_rate * 100.0,
        profit_factor: profit_factor(&main.trades),
        expectancy_usd: expectancy(&main.trades),
        payoff_ratio: payoff,
        avg_win_pct: avg_win,
        avg_loss_pct: avg_loss,
        in_sample_sharpe: in_sample.stats.sharpe_ratio,
        out_of_sample_sharpe: out_of_sample.stats.sharpe_ratio,
        buy_and_hold_pct: bnh,
        excess_vs_bnh_pct: main.stats.total_return_pct - bnh,
        total_fees_usd: d(main.total_fees),
        total_slippage_usd: d(main.total_slippage),
        total_gas_usd: d(main.total_gas),
        mc_realised: mc.realised,
        mc_p05: mc.p05,
        mc_p50: mc.p50,
        mc_p95: mc.p95,
        mc_percentile: mc.percentile_of_realised,
    }
}

// ── Reporting ────────────────────────────────────────────────────────────────
const MIN_TRADES_FOR_BEST: usize = 10;

/// Best strategy for a bot among the *traded* runs (≥MIN_TRADES_FOR_BEST).
/// Falls back to highest-Sharpe overall when nothing crossed the floor — so
/// the row still prints, but the caller should treat it as a no-trade signal.
fn pick_best<'a>(
    results: &'a BTreeMap<(String, String), Performance>,
    bot: &str,
) -> Option<(&'a String, &'a Performance)> {
    let mut best: Option<(&String, &Performance)> = None;
    for ((b, s), stats) in results {
        if b != bot || stats.n_trades < MIN_TRADES_FOR_BEST {
            continue;
        }
        if best
            .map(|(_, bs)| stats.sharpe_ratio > bs.sharpe_ratio)
            .unwrap_or(true)
        {
            best = Some((s, stats));
        }
    }
    // Fallback when no strategy actually traded ≥MIN_TRADES_FOR_BEST.
    if best.is_none() {
        for ((b, s), stats) in results {
            if b != bot {
                continue;
            }
            if best
                .map(|(_, bs)| stats.sharpe_ratio > bs.sharpe_ratio)
                .unwrap_or(true)
            {
                best = Some((s, stats));
            }
        }
    }
    best
}

fn pick_best_strategy<'a>(
    results: &'a BTreeMap<(String, String), Performance>,
    bot: &str,
    strats: &'a [Strategy],
) -> Option<(&'a Strategy, &'a Performance)> {
    let (name, stats) = pick_best(results, bot)?;
    let s = strats.iter().find(|s| s.name == name.as_str())?;
    Some((s, stats))
}

fn fmt_f(v: f64, prec: usize) -> String {
    if v.is_nan() {
        "    n/a".into()
    } else if v.is_infinite() {
        if v.is_sign_positive() {
            "   inf".into()
        } else {
            "  -inf".into()
        }
    } else {
        format!("{:>7.*}", prec, v)
    }
}

fn fmt_pf(v: f64) -> String {
    if v.is_infinite() {
        "  ∞ ".into()
    } else if v.is_nan() {
        " n/a".into()
    } else {
        format!("{:>4.2}", v)
    }
}

fn section(title: &str) {
    println!("\n{}", "═".repeat(110));
    println!("  {}", title);
    println!("{}\n", "═".repeat(110));
}

fn print_executive_summary(results: &BTreeMap<(String, String), Performance>) {
    section("§1 — Executive summary");
    let total_runs = results.len();
    let positive = results.values().filter(|s| s.sharpe_ratio > 0.0).count();
    let beats_bnh = results
        .values()
        .filter(|s| s.excess_vs_bnh_pct > 0.0)
        .count();
    let total_trades: usize = results.values().map(|s| s.n_trades).sum();
    let total_fees: f64 = results.values().map(|s| s.total_fees_usd).sum();
    let total_slip: f64 = results.values().map(|s| s.total_slippage_usd).sum();
    let avg_sharpe = results.values().map(|s| s.sharpe_ratio).sum::<f64>() / total_runs as f64;
    let avg_dd = results.values().map(|s| s.max_drawdown_pct).sum::<f64>() / total_runs as f64;
    println!(
        "  Universe.................. {} (bot, strategy) runs",
        total_runs
    );
    println!("  Capital per run........... ${} (paper)", INITIAL_CAPITAL);
    println!(
        "  Bars per bot.............. {} hourly (~{:.0} days)",
        LIMIT,
        LIMIT as f64 / 24.0
    );
    println!("  Total simulated trades.... {}", total_trades);
    println!(
        "  Total realised fees....... ${:.2}   (venue-calibrated taker rates)",
        total_fees
    );
    println!(
        "  Total realised slippage... ${:.2}   (FixedBps 10 across the board — see caveats)",
        total_slip
    );
    println!("  Avg Sharpe (trade)........ {:.2}", avg_sharpe);
    println!("  Avg max drawdown.......... {:.1}%", avg_dd);
    println!(
        "  Runs with positive Sharpe. {} / {}  ({:.0}%)",
        positive,
        total_runs,
        100.0 * positive as f64 / total_runs as f64
    );
    println!(
        "  Runs beating buy-and-hold. {} / {}  ({:.0}%)",
        beats_bnh,
        total_runs,
        100.0 * beats_bnh as f64 / total_runs as f64
    );
}

fn print_best_per_bot(results: &BTreeMap<(String, String), Performance>, bots: &[BotConfig]) {
    section("§2 — Best strategy per bot (with 95% bootstrap CI on Sharpe vs buy-and-hold)");
    println!(
        "  {:<18} {:<14} {:<18}    Sharpe (95% CI)    DD%    Win%   Trades   BnH%    Excess%",
        "bot", "venue", "best strategy"
    );
    println!("  {}", "-".repeat(108));
    for bot in bots {
        // Pick the strategy with the highest Sharpe AMONG those with ≥10
        // trades — a degenerate variant that never enters has Sharpe 0 by
        // construction, which is "better" than any negative-Sharpe strategy
        // that actually traded but is misleading. We want the best strategy
        // that *actually deployed capital*; if none cleared the floor we
        // fall back to highest Sharpe (so the row still prints with a flag).
        let best: Option<(&String, &Performance)> = pick_best(results, bot.name);
        let Some((strat, st)) = best else { continue };
        println!(
            "  {:<18} {:<14} {:<18}    {} ({}, {})  {:>5.1}  {:>5.1}  {:>6}   {:>5.1}  {:>+7.1}",
            bot.name,
            bot.venue,
            strat,
            fmt_f(st.sharpe_ratio, 2),
            fmt_f(st.sharpe_ci_lo, 2).trim(),
            fmt_f(st.sharpe_ci_hi, 2).trim(),
            st.max_drawdown_pct,
            st.win_rate_pct,
            st.n_trades,
            st.buy_and_hold_pct,
            st.excess_vs_bnh_pct,
        );
    }
}

fn print_strategy_matrix(
    results: &BTreeMap<(String, String), Performance>,
    bots: &[BotConfig],
    strats: &[Strategy],
) {
    section("§3 — Strategy × bot Sharpe matrix");
    print!("  {:<18}", "bot");
    for s in strats {
        print!(" {:>14}", s.name);
    }
    println!();
    println!("  {}", "-".repeat(18 + strats.len() * 15));
    for bot in bots {
        print!("  {:<18}", bot.name);
        for s in strats {
            let key = (bot.name.to_string(), s.name.to_string());
            let cell = results
                .get(&key)
                .map(|st| format!(" {:>13.2}", st.sharpe_ratio))
                .unwrap_or_else(|| format!(" {:>13}", "—"));
            print!("{cell}");
        }
        println!();
    }
}

fn print_risk_decomposition(
    results: &BTreeMap<(String, String), Performance>,
    bots: &[BotConfig],
    strats: &[Strategy],
) {
    section("§4 — Risk decomposition (best-strategy row per bot)");
    println!(
        "  {:<18} {:<14}  Sharpe  Sortino  Calmar   DD%   ProfitFactor  Expectancy$  Payoff",
        "bot", "best-strat"
    );
    println!("  {}", "-".repeat(105));
    for bot in bots {
        let best = pick_best_strategy(results, bot.name, strats);
        let Some((s, st)) = best else { continue };
        println!(
            "  {:<18} {:<14}  {:>6.2}  {:>7.2}  {:>6.2}  {:>4.1}    {}         {:>+8.2}    {}",
            bot.name,
            s.name,
            st.sharpe_ratio,
            st.sortino_ratio,
            st.calmar_ratio,
            st.max_drawdown_pct,
            fmt_pf(st.profit_factor),
            st.expectancy_usd,
            fmt_pf(st.payoff_ratio),
        );
    }
}

fn print_walk_forward(
    results: &BTreeMap<(String, String), Performance>,
    bots: &[BotConfig],
    strats: &[Strategy],
) {
    section(
        "§5 — Walk-forward (70/30 in-sample → out-of-sample). Large positive gap = likely overfit.",
    );
    println!(
        "  {:<18} {:<16}   IS Sharpe    OOS Sharpe     Gap (IS - OOS)",
        "bot", "strategy"
    );
    println!("  {}", "-".repeat(80));
    for bot in bots {
        for s in strats {
            if let Some(st) = results.get(&(bot.name.to_string(), s.name.to_string())) {
                if st.n_trades < 3 {
                    continue;
                }
                let gap = st.in_sample_sharpe - st.out_of_sample_sharpe;
                let flag = if gap > 1.0 {
                    " ← potential overfit"
                } else if gap < -0.5 {
                    " (OOS stronger)"
                } else {
                    ""
                };
                println!(
                    "  {:<18} {:<16}   {:>9.2}    {:>9.2}     {:>+8.2}{}",
                    bot.name, s.name, st.in_sample_sharpe, st.out_of_sample_sharpe, gap, flag,
                );
            }
        }
    }
}

fn print_trade_stats(
    results: &BTreeMap<(String, String), Performance>,
    bots: &[BotConfig],
    strats: &[Strategy],
) {
    section("§6 — Trade quality (best-strategy row per bot)");
    println!(
        "  {:<18} {:<14} Trades  Win%   AvgWin%   AvgLoss%   Expectancy$   Payoff   ProfitFactor",
        "bot", "best-strat"
    );
    println!("  {}", "-".repeat(108));
    for bot in bots {
        let best = pick_best_strategy(results, bot.name, strats);
        let Some((s, st)) = best else { continue };
        println!(
            "  {:<18} {:<14} {:>6}  {:>4.1}  {:>+7.2}  {:>+8.2}   {:>+10.2}     {}    {}",
            bot.name,
            s.name,
            st.n_trades,
            st.win_rate_pct,
            st.avg_win_pct,
            st.avg_loss_pct,
            st.expectancy_usd,
            fmt_pf(st.payoff_ratio),
            fmt_pf(st.profit_factor),
        );
    }
}

fn print_cost_breakdown(
    results: &BTreeMap<(String, String), Performance>,
    bots: &[BotConfig],
    strats: &[Strategy],
) {
    section("§7 — Cost breakdown (best-strategy row per bot, venue-calibrated taker bps)");
    println!(
        "  {:<18} {:<14} Fee$   Slip$    Gas$   Total$   bps of $10k init",
        "bot", "best-strat"
    );
    println!("  {}", "-".repeat(78));
    for bot in bots {
        let best = pick_best_strategy(results, bot.name, strats);
        let Some((s, st)) = best else { continue };
        let total = st.total_fees_usd + st.total_slippage_usd + st.total_gas_usd;
        let bps = total / INITIAL_CAPITAL as f64 * 10_000.0;
        println!(
            "  {:<18} {:<14} {:>5.2}  {:>5.2}  {:>5.2}   {:>6.2}    {:>6.1}",
            bot.name,
            s.name,
            st.total_fees_usd,
            st.total_slippage_usd,
            st.total_gas_usd,
            total,
            bps,
        );
    }
}

fn print_monte_carlo(
    results: &BTreeMap<(String, String), Performance>,
    bots: &[BotConfig],
    strats: &[Strategy],
) {
    section("§9 — Monte Carlo trade-order stability (best-strategy row per bot)");
    println!(
        "  {:<18} {:<14}    Realised   shuffled P05  P50   P95   percentile-of-realised   verdict",
        "bot", "best-strat"
    );
    println!("  {}", "-".repeat(105));
    for bot in bots {
        let Some((s, st)) = pick_best_strategy(results, bot.name, strats) else {
            continue;
        };
        // Sharpe is permutation-invariant so the shuffled distribution collapses;
        // percentile ≈ 100% by the ≤-rule. We surface this honestly rather than
        // hide it — the column has real signal once we extend Performance to
        // carry a path-dependent statistic too (max-drawdown shuffle, etc.).
        let verdict = if st.mc_realised.is_nan() {
            "n/a (too few trades)"
        } else if (st.mc_p95 - st.mc_p05).abs() < 1e-9 {
            "distribution collapsed (Sharpe is permutation-invariant)"
        } else if st.mc_percentile >= 95.0 {
            "tail (timing edge — strong)"
        } else if st.mc_percentile <= 5.0 {
            "tail (got lucky — re-test on more data)"
        } else {
            "in distribution (no sequencing signal)"
        };
        println!(
            "  {:<18} {:<14}    {:>+7.2}   {:>+7.2}  {:>+5.2} {:>+5.2}   {:>10.1}%             {}",
            bot.name,
            s.name,
            st.mc_realised,
            st.mc_p05,
            st.mc_p50,
            st.mc_p95,
            st.mc_percentile,
            verdict,
        );
    }
}

fn print_regime_distribution(by_bot: &BTreeMap<String, Vec<regime::Regime>>, bots: &[BotConfig]) {
    section("§10 — Regime distribution over the review window (causal classifier)");
    println!(
        "  {:<18} {:<14}    Trending   Chop   Breakout   Squeeze   Unknown",
        "bot", "venue"
    );
    println!("  {}", "-".repeat(85));
    for bot in bots {
        let Some(regimes) = by_bot.get(bot.name) else {
            continue;
        };
        let total = regimes.len().max(1);
        let pct = |label: &str| {
            let n = regime::distribution(regimes)
                .get(label)
                .copied()
                .unwrap_or(0);
            100.0 * n as f64 / total as f64
        };
        let unknown = regimes
            .iter()
            .filter(|r| matches!(r, regime::Regime::Unknown))
            .count();
        println!(
            "  {:<18} {:<14}    {:>5.1}%   {:>4.1}%   {:>6.1}%   {:>5.1}%   {:>5.1}%",
            bot.name,
            bot.venue,
            pct("trending"),
            pct("chop"),
            pct("breakout"),
            pct("squeeze"),
            100.0 * unknown as f64 / total as f64,
        );
    }
}

fn print_caveats() {
    section("§11 — Caveats & disclosures (read carefully before believing any number above)");
    println!(
        "  1. Sample size. {} hourly bars (~{:.0} days) is a single macro-regime — these stats are",
        LIMIT,
        LIMIT as f64 / 24.0
    );
    println!(
        "     point estimates from one period of crypto's recent history. They are NOT a base-rate"
    );
    println!(
        "     for next year. Bootstrap CIs widen the range honestly; the 30%-tile of resamples is"
    );
    println!("     what you should anchor on, not the median.");
    println!();
    println!(
        "  2. Look-ahead in indicators. RSI / EMA / ATR computed up to candle N are causal in this"
    );
    println!(
        "     engine — confirmed by reading `backtest::indicators` — so there is no inadvertent"
    );
    println!("     peeking. The exit rules use the OPEN of the next candle, also causal.");
    println!();
    println!(
        "  3. Slippage. Modelled as fixed 10 bps across every venue. That is honest for HL native"
    );
    println!(
        "     orders (which trade against a deep clearinghouse book), generous for thin DEX pools,"
    );
    println!(
        "     and pessimistic for Binance / Coinbase deep books. Switch to SqrtImpact for the"
    );
    println!("     DEX bots to model thinner liquidity properly — that's an N+1 PR.");
    println!();
    println!(
        "  4. Fees. Venue-calibrated taker rates from `protocol_fees::SCHEDULES` — the same table"
    );
    println!(
        "     the live execute path and the agent's loop prompt read. No tier discounts assumed"
    );
    println!("     (conservative — high-volume operators would pay less).");
    println!();
    println!(
        "  5. Walk-forward. 70/30 train/test on the SAME period; this is a within-sample temporal"
    );
    println!(
        "     split, not k-fold across years. A positive OOS Sharpe is encouraging; it is not a"
    );
    println!("     guarantee. A large IS→OOS gap is a strong overfitting signal (flagged in §5).");
    println!();
    println!("  6. Funding. Perp funding rates are NOT modelled here — the engine accepts a");
    println!(
        "     FundingSnapshot input but the live HL adapter doesn't snapshot it yet. For carry-"
    );
    println!(
        "     sensitive strategies (long-short basis), wire the funding snapshot before trusting"
    );
    println!(
        "     the perp Sharpes. Today's strategies are momentum / mean-rev — relatively funding-"
    );
    println!("     neutral on 1h horizons — but it's a known omission.");
    println!();
    println!(
        "  7. Capital. Each bot runs in isolation with $10k. A real portfolio would correlate-"
    );
    println!(
        "     adjust position sizes and would NOT take 12 independent BTC/ETH positions across"
    );
    println!(
        "     venues — they're collinear. Treat the per-bot Sharpe as a strategy quality signal,"
    );
    println!("     not as a recommended allocation.");
    println!();
    println!(
        "  8. Survivorship. The HL universe used here (BTC/ETH/SOL/HYPE) was selected because they"
    );
    println!(
        "     exist on HL today. The same selection for 6 months ago would have included tokens"
    );
    println!("     that have since delisted. Mild survivorship bias; explicit.");
    println!();
    println!(
        "  9. Promotion gate. \"Promote if Sharpe ≥ +10% AND drawdown regression ≤ +5pp\" matches the"
    );
    println!(
        "     playbook. A single-period gate on a noisy estimator overfits in expectation — the"
    );
    println!(
        "     production loop accumulates evidence over many runs and never bets on a single observation;"
    );
    println!(
        "     this snapshot is one observation per (bot, strategy), not a converged decision."
    );
    println!();
    println!(
        " 10. Monte Carlo on Sharpe is informational here, not load-bearing. Sharpe is permutation-"
    );
    println!(
        "     invariant (mean/std are symmetric in their arguments), so the shuffled distribution"
    );
    println!(
        "     collapses by construction — §9's percentile column reflects floating-point order"
    );
    println!(
        "     drift, not strategy timing edge. Wire a path-dependent statistic (max-drawdown,"
    );
    println!(
        "     terminal equity, longest losing run) into Performance + the trade-order shuffle to"
    );
    println!(
        "     give that column real signal; analytics::monte_carlo accepts any closure today."
    );
    println!();
    println!(
        " 11. Still missing for a fully-defensible institutional brief: regime-conditioned P&L"
    );
    println!("     (slice §10's regime labels by trade entry, report Sharpe per bucket), per-tick");
    println!(
        "     latency budget, per-signal P&L attribution (needs SimulatedTrade.triggered_signals),"
    );
    println!(
        "     correlation-aware position sizing, funding-rate carry on perps, and a return-stream"
    );
    println!("     shuffle vs random walk. The analytics primitives (`analytics::{{bootstrap,");
    println!(
        "     walk_forward, monte_carlo, regime}}`) all support these by construction — they're now"
    );
    println!("     platform code, NOT per-strategy work. Every new strategy gets them for free.");
}

// ── Main orchestration ───────────────────────────────────────────────────────
#[tokio::main]
async fn main() {
    let started = Instant::now();
    println!("\nAI Trading Blueprint — Fleet Review (institutional grade)");
    println!("Generated: {}", chrono::Utc::now().to_rfc3339());
    println!("Commit: {}", env!("CARGO_PKG_VERSION"));
    println!(
        "Bars per bot: {} (1h interval) — ~{:.0} days of native-venue data\n",
        LIMIT,
        LIMIT as f64 / 24.0
    );

    let bots = fleet();
    let strats = strategies();

    // ── Phase 1: fetch ──────────────────────────────────────────────────────
    let mut candles_by_bot: BTreeMap<String, Vec<Candle>> = BTreeMap::new();
    println!("Phase 1/3 — fetching candles from native venues…");
    for bot in &bots {
        let t0 = Instant::now();
        match candle_sources::fetch_from_source(bot.source, bot.symbol, Interval::Hour1, LIMIT)
            .await
        {
            Ok(c) if !c.is_empty() => {
                println!(
                    "  ✓ {:<18} {:<13} {:>5} bars in {:>6.2}s",
                    bot.name,
                    bot.venue,
                    c.len(),
                    t0.elapsed().as_secs_f64()
                );
                candles_by_bot.insert(bot.name.to_string(), c);
            }
            Ok(_) => println!(
                "  ⚠ {:<18} {:<13} returned 0 bars (skipped)",
                bot.name, bot.venue
            ),
            Err(e) => println!(
                "  ✗ {:<18} {:<13} fetch failed: {} (skipped)",
                bot.name, bot.venue, e
            ),
        }
    }

    // ── Phase 2: backtest matrix + regime classification ────────────────────
    println!(
        "\nPhase 2/3 — running {} backtests + bootstrap CI + walk-forward + Monte Carlo + regime…",
        bots.len() * strats.len()
    );
    let mut results: BTreeMap<(String, String), Performance> = BTreeMap::new();
    let mut regime_by_bot: BTreeMap<String, Vec<regime::Regime>> = BTreeMap::new();
    let t_bt = Instant::now();
    for bot in &bots {
        let Some(candles) = candles_by_bot.get(bot.name) else {
            continue;
        };
        for s in &strats {
            let stats = analyze(bot, s, candles);
            results.insert((bot.name.to_string(), s.name.to_string()), stats);
        }
        // Regime is candle-derived → one classification per bot regardless of strategy.
        regime_by_bot.insert(
            bot.name.to_string(),
            regime::classify_series(candles, regime::Thresholds::default()),
        );
    }
    println!(
        "  backtest matrix completed in {:.2}s ({} runs, {} Monte Carlo shuffles per run)",
        t_bt.elapsed().as_secs_f64(),
        results.len(),
        MONTE_CARLO_SHUFFLES,
    );

    // ── Phase 3: report ─────────────────────────────────────────────────────
    println!("\nPhase 3/3 — report\n");
    print_executive_summary(&results);
    print_best_per_bot(&results, &bots);
    print_strategy_matrix(&results, &bots, &strats);
    print_risk_decomposition(&results, &bots, &strats);
    print_walk_forward(&results, &bots, &strats);
    print_trade_stats(&results, &bots, &strats);
    print_cost_breakdown(&results, &bots, &strats);
    print_monte_carlo(&results, &bots, &strats);
    print_regime_distribution(&regime_by_bot, &bots);
    print_caveats();
    println!("\n{}", "═".repeat(110));
    println!(
        "  end of fleet review — total wall clock {:.2}s",
        started.elapsed().as_secs_f64()
    );
    println!("{}\n", "═".repeat(110));
}
