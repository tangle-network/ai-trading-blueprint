//! One-shot HarnessConfig backtest CLI — the cell-level primitive that
//! agent-eval's `runMultiShotOptimization` Dispatch shells out to.
//!
//! Reads a JSON request from stdin, runs the existing `BacktestEngine` on
//! candles pulled from the request's native venue (with a disk cache so
//! repeated cells on the same bot reuse fetched data), and writes a single
//! JSON result line to stdout. All Sharpe / drawdown / fee numbers come
//! from the same primitives the fleet review uses.
//!
//! Request shape (JSON on stdin):
//!   {
//!     "harness": <HarnessConfig>,
//!     "source": "hyperliquid" | "binance" | "coinbase" | "drift" | "polymarket" | "geckoterminal",
//!     "symbol": "BTC" | "base:ETH" | …,
//!     "fee_protocol": "hyperliquid_perp" | "binance" | …,
//!     "candles_limit": 4320,
//!     "candles_cache_dir": "/tmp/agent-eval-candles"
//!   }
//!
//! Response shape (JSON on stdout, single line):
//!   {"sharpe":…, "sharpe_ci_lo":…, "sharpe_ci_hi":…, "sortino":…,
//!    "calmar":…, "max_drawdown_pct":…, "n_trades":…, "win_rate_pct":…,
//!    "total_return_pct":…, "total_fees_usd":…, "total_slippage_usd":…,
//!    "total_gas_usd":…, "candles_processed":…, "oos_sharpe_70_30":…,
//!    "oos_n_trades":…, "in_sample_sharpe":…}
//!
//! On any error: a one-line JSON `{"error": "<message>"}` and exit code 1.
//!
//! Cache key: `{source}-{symbol}-{interval}-{limit}.json` under
//! `candles_cache_dir`. Cell N+1 on the same bot reuses cell N's candles.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};

use trading_runtime::analytics::bootstrap;
use trading_runtime::backtest::{
    BacktestConfig, BacktestEngine, BacktestResult, Candle, HarnessConfig, Interval, SlippageModel,
};
use trading_runtime::candle_sources::{self, Source};
use trading_runtime::protocol_fees;

#[derive(Debug, Deserialize)]
struct Request {
    harness: HarnessConfig,
    source: String,
    symbol: String,
    #[serde(default)]
    fee_protocol: Option<String>,
    #[serde(default = "default_limit")]
    candles_limit: u32,
    #[serde(default)]
    candles_cache_dir: Option<String>,
    /// Optional seed for bootstrap CI reproducibility. Defaults to a hash of
    /// the harness JSON so the same config always produces the same CI.
    #[serde(default)]
    seed: Option<u64>,
}

fn default_limit() -> u32 {
    4320
}

#[derive(Debug, Serialize)]
struct Response {
    sharpe: f64,
    sharpe_ci_lo: f64,
    sharpe_ci_hi: f64,
    sortino: f64,
    calmar: f64,
    max_drawdown_pct: f64,
    n_trades: usize,
    win_rate_pct: f64,
    total_return_pct: f64,
    total_fees_usd: f64,
    total_slippage_usd: f64,
    total_gas_usd: f64,
    candles_processed: usize,
    oos_sharpe_70_30: f64,
    oos_n_trades: usize,
    in_sample_sharpe: f64,
    is_oos_gap: f64,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[tokio::main]
async fn main() -> ExitCode {
    let mut raw = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut raw) {
        return fail(format!("stdin read: {e}"));
    }
    let req: Request = match serde_json::from_str(&raw) {
        Ok(r) => r,
        Err(e) => return fail(format!("request parse: {e}")),
    };

    let source = match Source::parse(&req.source) {
        Ok(s) => s,
        Err(e) => return fail(format!("unknown source: {e}")),
    };

    // ── Candle ingestion, disk-cached per (source, symbol, interval, limit) ──
    let candles = match load_or_fetch_candles(
        source,
        &req.symbol,
        req.candles_limit,
        req.candles_cache_dir.as_deref(),
    )
    .await
    {
        Ok(c) if !c.is_empty() => c,
        Ok(_) => return fail(format!("no candles for {}:{}", req.source, req.symbol)),
        Err(e) => return fail(format!("candle fetch: {e}")),
    };

    // ── Fee calibration: use venue's published taker bps + gas if known ──────
    let fee_protocol = req.fee_protocol.as_deref().unwrap_or(&req.source);
    let (taker_bps, gas_usd) = protocol_fees::schedule_for(fee_protocol)
        .map(|s| (s.taker_bps, s.typical_gas_usd))
        .unwrap_or((10, 2));

    let config = BacktestConfig {
        initial_capital: Decimal::new(10_000, 0),
        harness: req.harness.clone(),
        slippage: SlippageModel::FixedBps { bps: 10 },
        gas_cost_usd: Decimal::new(gas_usd as i64, 0),
        taker_fee_bps: taker_bps,
    };

    let main_result = match BacktestEngine::new(config.clone()).run(&candles, &[]) {
        Ok(r) => r,
        Err(e) => return fail(format!("backtest: {e}")),
    };

    // ── Walk-forward 70/30 in-sample → out-of-sample ─────────────────────────
    let split = (candles.len() as f64 * 0.7) as usize;
    let in_sample = BacktestEngine::new(config.clone())
        .run(&candles[..split], &[])
        .unwrap_or_else(|_| empty_result());
    let out_of_sample = BacktestEngine::new(config)
        .run(&candles[split..], &[])
        .unwrap_or_else(|_| empty_result());

    // ── Bootstrap Sharpe CI over per-trade returns ───────────────────────────
    let returns: Vec<f64> = main_result.trades.iter().map(|t| t.pnl_pct / 100.0).collect();
    let seed = req.seed.unwrap_or_else(|| deterministic_seed(&req.harness));
    let (sharpe_ci_lo, sharpe_ci_hi) = bootstrap::sharpe_ci_95(&returns, seed);

    let response = Response {
        sharpe: main_result.stats.sharpe_ratio,
        sharpe_ci_lo,
        sharpe_ci_hi,
        sortino: main_result.stats.sortino_ratio,
        calmar: main_result.stats.calmar_ratio,
        max_drawdown_pct: main_result.stats.max_drawdown_pct,
        n_trades: main_result.trades.len(),
        win_rate_pct: main_result.stats.win_rate * 100.0,
        total_return_pct: main_result.stats.total_return_pct,
        total_fees_usd: main_result.total_fees.to_f64().unwrap_or(0.0),
        total_slippage_usd: main_result.total_slippage.to_f64().unwrap_or(0.0),
        total_gas_usd: main_result.total_gas.to_f64().unwrap_or(0.0),
        candles_processed: main_result.candles_processed,
        oos_sharpe_70_30: out_of_sample.stats.sharpe_ratio,
        oos_n_trades: out_of_sample.trades.len(),
        in_sample_sharpe: in_sample.stats.sharpe_ratio,
        is_oos_gap: in_sample.stats.sharpe_ratio - out_of_sample.stats.sharpe_ratio,
    };

    let line = match serde_json::to_string(&response) {
        Ok(s) => s,
        Err(e) => return fail(format!("response serialise: {e}")),
    };
    let _ = writeln!(io::stdout(), "{line}");
    ExitCode::SUCCESS
}

fn fail(msg: String) -> ExitCode {
    let _ = writeln!(
        io::stdout(),
        "{}",
        serde_json::to_string(&ErrorResponse { error: msg }).unwrap_or_else(|_| "{\"error\":\"unknown\"}".into()),
    );
    ExitCode::FAILURE
}

fn empty_result() -> BacktestResult {
    BacktestResult {
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
    }
}

fn deterministic_seed(h: &HarnessConfig) -> u64 {
    let s = serde_json::to_string(h).unwrap_or_default();
    let mut acc: u64 = 1469598103934665603;
    for b in s.bytes() {
        acc ^= b as u64;
        acc = acc.wrapping_mul(1099511628211);
    }
    acc
}

async fn load_or_fetch_candles(
    source: Source,
    symbol: &str,
    limit: u32,
    cache_dir: Option<&str>,
) -> Result<Vec<Candle>, String> {
    let cache_path = cache_dir.map(|d| cache_file_path(d, source.name(), symbol, limit));

    if let Some(path) = &cache_path
        && path.exists()
        && let Ok(raw) = fs::read_to_string(path)
        && let Ok(c) = serde_json::from_str::<Vec<Candle>>(&raw)
    {
        if c.len() as u32 >= limit {
            return Ok(c);
        }
    }

    let candles = candle_sources::fetch_from_source(source, symbol, Interval::Hour1, limit)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(path) = &cache_path
        && let Some(parent) = path.parent()
    {
        let _ = fs::create_dir_all(parent);
        if let Ok(s) = serde_json::to_string(&candles) {
            let _ = fs::write(path, s);
        }
    }
    Ok(candles)
}

fn cache_file_path(dir: &str, source: &str, symbol: &str, limit: u32) -> PathBuf {
    // Safe-name the symbol: GeckoTerminal symbols contain ":" (e.g. "base:ETH").
    let safe = symbol.replace([':', '/', ' '], "_");
    Path::new(dir).join(format!("{source}-{safe}-1h-{limit}.json"))
}
