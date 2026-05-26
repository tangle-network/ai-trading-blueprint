//! Drive a multi-bot paper-trading fleet end-to-end against live candle data.
//!
//! Proof-of-life for the new candle-source framework + the existing backtest
//! engine: every bot pulls real candles from its NATIVE venue (HL bots from
//! Hyperliquid, DEX bots from GeckoTerminal, etc.), runs a backtest, and the
//! fleet-level summary is what a human trading manager would actually want
//! to see across their roster: Sharpe, drawdown, win rate, trade count, real
//! fees paid.
//!
//! It also runs the baseline strategy AND a variant on each bot, and prints
//! the kind of "should we promote this variant?" decision row the agent's
//! meta-harness loop emits at runtime.
//!
//! Run with:
//!   cargo run -p trading-runtime --example fleet_manager --release
//!
//! No env / config needed — every endpoint is public + unauthenticated.

use std::time::Instant;

use trading_runtime::backtest::{
    BacktestConfig, BacktestEngine, BacktestResult, EntryCondition, EntryRule, ExitRule,
    HarnessConfig, Interval, PositionSizing, SignalType, SlippageModel,
};
use trading_runtime::candle_sources::{self, Source};

/// One bot in the fleet. Each runs against its native venue.
struct Bot {
    name: &'static str,
    source: Source,
    /// Symbol to pass to the source. For GeckoTerminal: `"network:SYMBOL"`.
    symbol: &'static str,
}

fn fleet() -> Vec<Bot> {
    // A diverse roster: HL perps (native), CEX references, Solana perps via Drift,
    // a Base DEX pool via GeckoTerminal, and a US-regulated reference via Coinbase.
    vec![
        Bot { name: "hl-btc-momentum",    source: Source::Hyperliquid,   symbol: "BTC" },
        Bot { name: "hl-eth-momentum",    source: Source::Hyperliquid,   symbol: "ETH" },
        Bot { name: "hl-sol-momentum",    source: Source::Hyperliquid,   symbol: "SOL" },
        Bot { name: "hl-hype-momentum",   source: Source::Hyperliquid,   symbol: "HYPE" },
        Bot { name: "binance-btc-ref",    source: Source::Binance,       symbol: "BTC" },
        Bot { name: "coinbase-eth-ref",   source: Source::Coinbase,      symbol: "ETH" },
        Bot { name: "drift-sol-perp",     source: Source::Drift,         symbol: "SOL" },
        Bot { name: "dex-aerodrome-eth",  source: Source::GeckoTerminal, symbol: "base:ETH" },
    ]
}

/// Two strategies — the default RSI(14)<30 + EMA(12,26) cross baseline, and
/// a more aggressive variant with a tighter RSI threshold + faster EMAs.
/// The fleet runs both and compares.
fn baseline() -> HarnessConfig {
    HarnessConfig::default()
}

fn variant_aggressive() -> HarnessConfig {
    HarnessConfig {
        version: 2,
        entry_rules: vec![
            EntryRule {
                signal: SignalType::Rsi { period: 14 },
                condition: EntryCondition::Below { threshold: 25.0 }, // tighter oversold
                weight: 0.6,
                tokens: vec![],
            },
            EntryRule {
                signal: SignalType::EmaCross {
                    short_period: 9,  // faster
                    long_period: 21,
                },
                condition: EntryCondition::CrossAbove,
                weight: 0.4,
                tokens: vec![],
            },
        ],
        exit_rules: vec![
            ExitRule::StopLoss { pct: 4.0 },   // tighter stop
            ExitRule::TakeProfit { pct: 12.0 }, // wider take-profit
        ],
        filters: vec![],
        position_sizing: PositionSizing::FixedFraction { fraction: 0.1 },
        entry_threshold: 0.4, // require more agreement
        max_positions: 5,
    }
}

async fn fetch_with_progress(bot: &Bot, limit: u32) -> Option<Vec<trading_runtime::backtest::Candle>> {
    let started = Instant::now();
    match candle_sources::fetch_from_source(bot.source, bot.symbol, Interval::Hour1, limit).await {
        Ok(c) if !c.is_empty() => {
            println!(
                "  fetched {:>4} {} candles from {:<14} for {:<16}  ({:?})",
                c.len(),
                "1h",
                bot.source.name(),
                bot.symbol,
                started.elapsed()
            );
            Some(c)
        }
        Ok(_) => {
            println!(
                "  WARN: {} returned 0 candles for {} on {}",
                bot.source.name(),
                bot.symbol,
                bot.name
            );
            None
        }
        Err(e) => {
            println!(
                "  ERR : {} fetch failed for {} on {}: {}",
                bot.source.name(),
                bot.symbol,
                bot.name,
                e
            );
            None
        }
    }
}

fn run_backtest(harness: HarnessConfig, candles: &[trading_runtime::backtest::Candle]) -> BacktestResult {
    let config = BacktestConfig {
        initial_capital: rust_decimal::Decimal::new(10_000, 0),
        harness,
        slippage: SlippageModel::FixedBps { bps: 10 },
        gas_cost_usd: rust_decimal::Decimal::new(2, 0),
        taker_fee_bps: 5, // matches our hyperliquid taker rate from protocol_fees::SCHEDULES
    };
    BacktestEngine::new(config).run(candles, &[]).unwrap_or_else(|e| {
        println!("  backtest error: {e}");
        // Return empty-result so the row still prints with zeros.
        BacktestEngine::new(BacktestConfig::default())
            .run(&[], &[])
            .unwrap()
    })
}

fn promote(baseline: &BacktestResult, variant: &BacktestResult) -> &'static str {
    let b_sharpe = baseline.stats.sharpe_ratio;
    let v_sharpe = variant.stats.sharpe_ratio;
    let b_dd = baseline.stats.max_drawdown_pct;
    let v_dd = variant.stats.max_drawdown_pct;
    // Promotion gate (matches docs/playbook): Sharpe >+10% AND drawdown ≤ +5%.
    let sharpe_ok = if b_sharpe.abs() < 1e-6 {
        v_sharpe > b_sharpe
    } else {
        (v_sharpe - b_sharpe) / b_sharpe.abs() >= 0.10
    };
    let dd_ok = v_dd - b_dd <= 5.0;
    if sharpe_ok && dd_ok {
        "PROMOTE"
    } else {
        "keep   "
    }
}

#[tokio::main]
async fn main() {
    println!("\n=== Fleet manager — paper-trading roster against live candle data ===\n");
    println!("Backfilling {} hourly bars per bot from native venues…", LIMIT);

    let bots = fleet();
    let mut rows: Vec<(String, BacktestResult, BacktestResult)> = Vec::new();

    for bot in &bots {
        println!("\n[{}]", bot.name);
        let Some(candles) = fetch_with_progress(bot, LIMIT).await else { continue };
        let baseline_r = run_backtest(baseline(), &candles);
        let variant_r = run_backtest(variant_aggressive(), &candles);
        rows.push((bot.name.to_string(), baseline_r, variant_r));
    }

    if rows.is_empty() {
        println!("\nNo bots produced any results — check network / venue availability.");
        return;
    }

    println!("\n\n=== FLEET BACKTEST RESULTS ({} bots, last {} hourly bars) ===", rows.len(), LIMIT);
    println!(
        "\n{:<22} {:<10} | {:>8} {:>10} {:>8} {:>10} | {:>8} {:>10} {:>8} {:>10} | {}",
        "bot",
        "venue",
        "B/Sharp",
        "B/DD%",
        "B/Win%",
        "B/Trades",
        "V/Sharp",
        "V/DD%",
        "V/Win%",
        "V/Trades",
        "verdict",
    );
    println!("{}", "-".repeat(140));
    for (bot, base, variant) in &rows {
        let venue = bots
            .iter()
            .find(|b| b.name == bot)
            .map(|b| b.source.name())
            .unwrap_or("?");
        let row = |r: &BacktestResult| {
            (
                r.stats.sharpe_ratio,
                r.stats.max_drawdown_pct,
                r.stats.win_rate * 100.0,
                r.trades.len() as u32,
            )
        };
        let (bs, bd, bw, bt) = row(base);
        let (vs, vd, vw, vt) = row(variant);
        println!(
            "{:<22} {:<10} | {:>8.2} {:>9.1}% {:>7.1}% {:>10} | {:>8.2} {:>9.1}% {:>7.1}% {:>10} | {}",
            bot,
            venue,
            bs,
            bd,
            bw,
            bt,
            vs,
            vd,
            vw,
            vt,
            promote(base, variant),
        );
    }

    let total_trades: usize = rows
        .iter()
        .map(|(_, b, v)| b.trades.len() + v.trades.len())
        .sum();
    let total_fees: rust_decimal::Decimal = rows
        .iter()
        .map(|(_, b, v)| b.total_fees + v.total_fees)
        .sum();
    let promoted = rows
        .iter()
        .filter(|(_, b, v)| promote(b, v) == "PROMOTE")
        .count();
    println!("\n=== Fleet summary ===");
    println!("  bots reporting: {}", rows.len());
    println!("  total simulated trades across baseline + variant: {}", total_trades);
    println!("  total simulated fees ($): {}", total_fees);
    println!("  variants the meta-harness would PROMOTE: {} / {}", promoted, rows.len());
    println!(
        "  promotion gate: Sharpe +10% AND drawdown regression ≤ +5pp (matches playbook)\n"
    );
}

const LIMIT: u32 = 720; // ~30 days of hourly bars per bot (24 × 30)
