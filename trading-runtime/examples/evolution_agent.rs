//! Evolution agent — drives the in-process strategy evolution loop at
//! scale across the canonical fleet. Mutates HarnessConfigs, evaluates
//! each on its bot's native-venue candles via the existing BacktestEngine,
//! applies the promotion-gate fitness function, and keeps the elite — for
//! many generations, across many bots, in seconds.
//!
//! This is the "agentic + x1000" demonstration: the platform's analytics
//! + evolution primitives running thousands of backtests, distilling them
//! to a handful of discovered strategies you'd actually trade.
//!
//! Run:
//!   cargo run -p trading-runtime --example evolution_agent --release
//!
//! No env, no auth. Network I/O is the only slow part (~7 s for the full
//! fleet's candle backfill on a warm DNS cache); the search itself runs
//! ~2,000 backtests per bot in well under 20 seconds total.

use std::time::Instant;

use trading_runtime::backtest::{
    Candle, EntryCondition, EntryRule, ExitRule, HarnessConfig, Interval, PositionSizing,
    SignalType,
};
use trading_runtime::candle_sources::{self, Source};
use trading_runtime::evolution::{EvolutionConfig, evolve, random_seed_population};

// ── Bots the agent searches across ───────────────────────────────────────────
struct Bot {
    name: &'static str,
    source: Source,
    symbol: &'static str,
    venue: &'static str,
    fee_protocol: &'static str,
}

fn fleet() -> Vec<Bot> {
    vec![
        Bot { name: "hl-btc",         source: Source::Hyperliquid,   symbol: "BTC",       venue: "hyperliquid",  fee_protocol: "hyperliquid_perp" },
        Bot { name: "hl-eth",         source: Source::Hyperliquid,   symbol: "ETH",       venue: "hyperliquid",  fee_protocol: "hyperliquid_perp" },
        Bot { name: "hl-sol",         source: Source::Hyperliquid,   symbol: "SOL",       venue: "hyperliquid",  fee_protocol: "hyperliquid_perp" },
        Bot { name: "hl-hype",        source: Source::Hyperliquid,   symbol: "HYPE",      venue: "hyperliquid",  fee_protocol: "hyperliquid_perp" },
        Bot { name: "drift-sol",      source: Source::Drift,         symbol: "SOL",       venue: "drift",        fee_protocol: "drift" },
        Bot { name: "drift-btc",      source: Source::Drift,         symbol: "BTC",       venue: "drift",        fee_protocol: "drift" },
        Bot { name: "aerodrome-eth",  source: Source::GeckoTerminal, symbol: "base:ETH",  venue: "aerodrome",    fee_protocol: "aerodrome" },
    ]
}

/// Seed strategies the agent starts from — diverse priors so the search
/// doesn't collapse into a single neighborhood. The mutator does the rest.
fn seed_strategies() -> Vec<HarnessConfig> {
    vec![
        // Balanced momentum (the fleet_manager default)
        HarnessConfig {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::Rsi { period: 14 },
                    condition: EntryCondition::Below { threshold: 30.0 },
                    weight: 0.5,
                    tokens: vec![],
                },
                EntryRule {
                    signal: SignalType::EmaCross { short_period: 12, long_period: 26 },
                    condition: EntryCondition::CrossAbove,
                    weight: 0.5,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![ExitRule::StopLoss { pct: 5.0 }, ExitRule::TakeProfit { pct: 10.0 }],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
            entry_threshold: 0.3,
            max_positions: 5,
        },
        // Slow trend follow
        HarnessConfig {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::EmaCross { short_period: 20, long_period: 50 },
                    condition: EntryCondition::CrossAbove,
                    weight: 1.0,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![ExitRule::StopLoss { pct: 3.0 }, ExitRule::TakeProfit { pct: 15.0 }],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.08 },
            entry_threshold: 0.5,
            max_positions: 3,
        },
        // Mean reversion
        HarnessConfig {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::Rsi { period: 14 },
                    condition: EntryCondition::Below { threshold: 22.0 },
                    weight: 1.0,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![ExitRule::StopLoss { pct: 2.5 }, ExitRule::TakeProfit { pct: 5.0 }],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
            entry_threshold: 0.5,
            max_positions: 5,
        },
        // Volatility breakout
        HarnessConfig {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::AtrBreakout { period: 14, multiplier: 2.0 },
                    condition: EntryCondition::Positive,
                    weight: 1.0,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![
                ExitRule::TrailingStop { activation_pct: 3.0, trail_pct: 2.0 },
                ExitRule::StopLoss { pct: 4.0 },
            ],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
            entry_threshold: 0.5,
            max_positions: 5,
        },
        // Momentum without RSI gate (pure trend)
        HarnessConfig {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::PriceMomentum { lookback_candles: 12 },
                    condition: EntryCondition::Positive,
                    weight: 1.0,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![ExitRule::StopLoss { pct: 4.0 }, ExitRule::TakeProfit { pct: 8.0 }],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
            entry_threshold: 0.5,
            max_positions: 5,
        },
    ]
}

fn summarise_harness(h: &HarnessConfig) -> String {
    let entry_summary: Vec<String> = h
        .entry_rules
        .iter()
        .map(|r| {
            let sig = match &r.signal {
                SignalType::Rsi { period } => format!("RSI({})", period),
                SignalType::EmaCross { short_period, long_period } => format!("EMA({},{})", short_period, long_period),
                SignalType::SmaCross { short_period, long_period } => format!("SMA({},{})", short_period, long_period),
                SignalType::Macd { fast_period, slow_period, signal_period } => format!("MACD({},{},{})", fast_period, slow_period, signal_period),
                SignalType::AtrBreakout { period, multiplier } => format!("ATRbr({},×{:.1})", period, multiplier),
                SignalType::PriceMomentum { lookback_candles } => format!("MOM({})", lookback_candles),
                SignalType::BollingerBand { period, std_dev } => format!("BB({},{:.1})", period, std_dev),
                SignalType::VolumeSurge { lookback_candles, multiplier } => format!("VolSrg({},×{:.1})", lookback_candles, multiplier),
                SignalType::Obv { .. } => "OBV".into(),
                SignalType::Vwap { .. } => "VWAP".into(),
                SignalType::FundingRate => "Funding".into(),
                SignalType::FundingRateSpread { .. } => "FundSpread".into(),
                SignalType::MeanReversion { .. } => "MR".into(),
            };
            let cond = match &r.condition {
                EntryCondition::Below { threshold } => format!("<{:.0}", threshold),
                EntryCondition::Above { threshold } => format!(">{:.0}", threshold),
                EntryCondition::CrossAbove => "↑".into(),
                EntryCondition::CrossBelow => "↓".into(),
                EntryCondition::Positive => "+".into(),
                EntryCondition::Negative => "-".into(),
            };
            format!("{}{}@{:.2}", sig, cond, r.weight)
        })
        .collect();
    let stops: Vec<String> = h
        .exit_rules
        .iter()
        .map(|e| match e {
            ExitRule::StopLoss { pct } => format!("SL{:.1}", pct),
            ExitRule::TakeProfit { pct } => format!("TP{:.1}", pct),
            ExitRule::TrailingStop { activation_pct, trail_pct } => format!("TS{:.1}/{:.1}", activation_pct, trail_pct),
            ExitRule::TimeLimit { max_candles } => format!("Time{}", max_candles),
        })
        .collect();
    let frac = match h.position_sizing {
        PositionSizing::FixedFraction { fraction } => fraction,
        _ => 0.0,
    };
    format!(
        "[{}] {} | thr {:.2} sz {:.2} maxP {}",
        entry_summary.join(" + "),
        stops.join("/"),
        h.entry_threshold,
        frac,
        h.max_positions,
    )
}

async fn fetch(bot: &Bot, limit: u32) -> Option<Vec<Candle>> {
    let t0 = Instant::now();
    match candle_sources::fetch_from_source(bot.source, bot.symbol, Interval::Hour1, limit).await {
        Ok(c) if !c.is_empty() => {
            println!(
                "  ✓ {:<16} {:<13} {:>5} bars in {:>5.2}s",
                bot.name, bot.venue, c.len(), t0.elapsed().as_secs_f64()
            );
            Some(c)
        }
        Ok(_) => { println!("  ⚠ {:<16} {:<13} 0 bars (skipped)", bot.name, bot.venue); None }
        Err(e) => { println!("  ✗ {:<16} {:<13} {} (skipped)", bot.name, bot.venue, e); None }
    }
}

const LIMIT: u32 = 4320;
const POPULATION_SIZE: usize = 40;
const GENERATIONS: usize = 12;
const ELITISM: usize = 5;
const TOURNAMENT: usize = 3;

#[tokio::main]
async fn main() {
    let started = Instant::now();

    println!("\n╔══════════════════════════════════════════════════════════════════════════════════╗");
    println!("║  Evolution agent — discovers trading strategies via mutate+select+evaluate       ║");
    println!("╚══════════════════════════════════════════════════════════════════════════════════╝");
    println!(
        "  Generated: {}\n  Population {} × generations {} × bots ? ; {} × backtests per bot",
        chrono::Utc::now().to_rfc3339(),
        POPULATION_SIZE,
        GENERATIONS,
        POPULATION_SIZE * GENERATIONS,
    );

    let seeds = seed_strategies();
    println!(
        "\n  Seed strategy priors: {} (the mutator explores the neighborhood of each)",
        seeds.len()
    );
    println!("  Mutator search space: 12 mutation kinds — RSI/EMA periods + thresholds, stops,");
    println!("  rule weights, position sizing, rule add/drop, condition flips, max-positions.\n");

    // ── Phase 1: backfill native-venue candles for the whole fleet ──────────
    println!("Phase 1/3 — backfilling {} hourly bars per bot from native venues:", LIMIT);
    let mut candles_by_bot: Vec<(Bot, Vec<Candle>)> = Vec::new();
    for bot in fleet() {
        if let Some(c) = fetch(&bot, LIMIT).await {
            candles_by_bot.push((bot, c));
        }
    }

    // ── Phase 2: evolve ─────────────────────────────────────────────────────
    println!(
        "\nPhase 2/3 — evolving {} bots × {} generations × {} population = {} primary backtests",
        candles_by_bot.len(),
        GENERATIONS,
        POPULATION_SIZE,
        candles_by_bot.len() * GENERATIONS * POPULATION_SIZE,
    );
    let mut runs = Vec::with_capacity(candles_by_bot.len());
    for (bot, candles) in &candles_by_bot {
        let seed_pop = random_seed_population(&seeds, POPULATION_SIZE, 3, 0xA11CE ^ bot.name.bytes().fold(0u64, |a,b| a.wrapping_mul(31).wrapping_add(b as u64)));
        let cfg = EvolutionConfig {
            population_size: POPULATION_SIZE,
            generations: GENERATIONS,
            elitism: ELITISM,
            tournament_size: TOURNAMENT,
            seed: 0xDECAFBAD ^ bot.name.bytes().fold(0u64, |a,b| a.wrapping_mul(31).wrapping_add(b as u64)),
            bootstrap_during_search: false,
        };
        let t = Instant::now();
        let run = evolve(bot.name, seed_pop, candles, bot.fee_protocol, cfg);
        println!(
            "  ▸ {:<16} {} evaluations in {:.2}s — best score {:+.3} ({} trades, Sharpe {:+.2}, OOS {:+.2})",
            bot.name,
            run.total_evaluations,
            t.elapsed().as_secs_f64(),
            run.final_top_k[0].1.composite_score,
            run.final_top_k[0].1.n_trades,
            run.final_top_k[0].1.sharpe,
            run.final_top_k[0].1.oos_sharpe,
        );
        runs.push((bot, run));
    }

    let total_evals: usize = runs.iter().map(|(_, r)| r.total_evaluations).sum();

    // ── Phase 3: report ─────────────────────────────────────────────────────
    println!("\nPhase 3/3 — report\n");

    section("§1 — Evolution at a glance");
    println!("  Fleet:              {} bots", runs.len());
    println!("  Backtests run:      {}  (cross-bot, across all generations + final top-K)", total_evals);
    println!("  Total wall clock:   {:.2}s", started.elapsed().as_secs_f64());
    println!("  Search throughput:  {:.0} backtests / second", total_evals as f64 / started.elapsed().as_secs_f64());
    println!("  Each backtest:      180 days × 1h bars + 70/30 walk-forward + composite fitness");

    section("§2 — Best strategy discovered per bot (with honest 95% Sharpe CI)");
    println!(
        "  {:<16} {:<13}   Composite   Sharpe (CI lo, hi)   OOS    DD%   Win%   Trades",
        "bot", "venue"
    );
    println!("  {}", "-".repeat(105));
    for (bot, run) in &runs {
        let (_, f) = &run.final_top_k[0];
        println!(
            "  {:<16} {:<13}    {:>+7.3}    {:+.2} ({:+.2}, {:+.2})    {:>+5.2}  {:>4.1}  {:>4.1}  {:>5}",
            bot.name, bot.venue,
            f.composite_score, f.sharpe, f.sharpe_ci_lo, f.sharpe_ci_hi,
            f.oos_sharpe, f.max_drawdown_pct, f.win_rate_pct, f.n_trades,
        );
    }

    section("§3 — The discovered strategies (best per bot, decoded)");
    for (bot, run) in &runs {
        let (h, f) = &run.final_top_k[0];
        println!(
            "  {} ({}, score {:+.3}):",
            bot.name, bot.venue, f.composite_score,
        );
        println!("    {}", summarise_harness(h));
    }

    section("§4 — Per-generation progress (best score by generation)");
    println!("  {:<16}  gen0    gen2    gen4    gen6    gen8    gen10   gen{} (final)",
             "bot", GENERATIONS.saturating_sub(1));
    println!("  {}", "-".repeat(85));
    for (bot, run) in &runs {
        let pick = |i: usize| -> String {
            run.generations
                .get(i)
                .map(|g| format!("{:>+5.2}", g.best_score))
                .unwrap_or_else(|| "  —  ".into())
        };
        println!(
            "  {:<16}  {}   {}   {}   {}   {}   {}   {}",
            bot.name,
            pick(0), pick(2), pick(4), pick(6), pick(8), pick(10),
            pick(GENERATIONS - 1),
        );
    }

    section("§5 — Cross-bot champions (single config evaluated on every bot)");
    // Take the global best (highest composite) and evaluate it on every bot —
    // tells you whether the discovery generalises across the universe or is
    // specific to the bot it was bred on.
    let global_best = runs
        .iter()
        .max_by(|(_, a), (_, b)| {
            a.final_top_k[0].1.composite_score
                .partial_cmp(&b.final_top_k[0].1.composite_score)
                .unwrap()
        })
        .map(|(b, r)| (b.name, r.final_top_k[0].0.clone(), r.final_top_k[0].1.clone()));

    if let Some((champion_bot, harness, _orig)) = global_best {
        println!("  Champion bred on: {}  →  {}", champion_bot, summarise_harness(&harness));
        println!();
        println!("  {:<16} {:<13}    Composite   Sharpe (CI)         OOS    DD%   Trades", "bot tested", "venue");
        println!("  {}", "-".repeat(90));
        for (bot, _) in &runs {
            let candles = candles_by_bot.iter().find(|(b, _)| b.name == bot.name).map(|(_, c)| c).unwrap();
            let f = trading_runtime::evolution::evaluate_fitness(&harness, candles, bot.fee_protocol, true);
            let flag = if bot.name == champion_bot { " ← bred here" } else { "" };
            println!(
                "  {:<16} {:<13}    {:>+7.3}    {:+.2} ({:+.2}, {:+.2})    {:>+5.2}  {:>4.1}  {:>5}{}",
                bot.name, bot.venue,
                f.composite_score, f.sharpe, f.sharpe_ci_lo, f.sharpe_ci_hi,
                f.oos_sharpe, f.max_drawdown_pct, f.n_trades, flag,
            );
        }
    }

    section("§6 — Search diagnostics (population health by generation, last bot)");
    if let Some((bot, run)) = runs.last() {
        println!("  Bot: {}", bot.name);
        println!("  {:>3}   {:>9}   {:>9}   {:>9}   {:>7}   {:>5}",
                 "gen", "best", "median", "worst", "n≥5 tr", "secs");
        println!("  {}", "-".repeat(60));
        for g in &run.generations {
            println!(
                "  {:>3}   {:>+9.3}   {:>+9.3}   {:>+9.3}   {:>7}   {:>5.2}",
                g.generation, g.best_score, g.median_score, g.worst_score, g.valid_count, g.eval_seconds,
            );
        }
    }

    section("§7 — Honest caveats");
    println!("  1. The fitness gate is a HEURISTIC — composite of Sharpe-CI-low + OOS Sharpe -");
    println!("     drawdown - overfit gap + trade-count bonus. It's the same gate the production");
    println!("     loop uses, NOT a converged decision rule. Promotion still requires a human or");
    println!("     longer-horizon confirmation; this is search, not approval.");
    println!();
    println!("  2. 12 generations × 40 pop is a small budget. Bigger budgets find better strategies");
    println!("     in expectation but ALSO overfit harder. The CI-low term in fitness is the");
    println!("     primary brake on overfit; the 70/30 walk-forward gap is the secondary brake.");
    println!();
    println!("  3. The mutator is local-step. We don't crossover (HarnessConfig mixing can break");
    println!("     semantic coherence — averaging EMA periods of unrelated parents is noise). For");
    println!("     wider exploration, increase mutations_per_member in the seed population OR run");
    println!("     multiple parallel populations with different seeds and union the top-Ks.");
    println!();
    println!("  4. Same single-regime 180-day window as the fleet review. A strategy discovered");
    println!("     here is conditioned on this regime. Promotion to live should require the next");
    println!("     30 days of data outperforming the buy-and-hold + the strategy's bootstrapped");
    println!("     CI-low remaining above zero.");
    println!();
    println!("  5. Cross-bot champion §5 transferability is a generalisation test. If the champion");
    println!("     bred on bot X has positive composite on bots Y/Z too, you've discovered a");
    println!("     strategy whose edge isn't symbol-specific. If it only works on its breeding");
    println!("     bot, treat it as a niche.");

    println!("\n{}", "═".repeat(105));
    println!("  end of evolution agent — {} backtests, {:.2}s wall clock", total_evals, started.elapsed().as_secs_f64());
    println!("{}\n", "═".repeat(105));
}

fn section(title: &str) {
    println!("\n{}", "═".repeat(105));
    println!("  {}", title);
    println!("{}\n", "═".repeat(105));
}
