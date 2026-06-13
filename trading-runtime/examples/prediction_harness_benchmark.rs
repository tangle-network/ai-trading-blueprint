//! Deterministic prediction-market benchmark CLI — the prediction-family
//! counterpart to `harness_backtest`.
//!
//! Prediction markets have no continuous price to backtest against; they settle
//! to $0/$1 at resolution. This example scores a `HarnessConfig` candidate (or
//! one of the built-in reference strategies) against a SYNTHETIC, fully
//! deterministic fixture of markets — each with a YES-probability time-series
//! and a known final resolution — so the promotion pipeline gets a reproducible
//! fitness signal with no external data.
//!
//! Request (JSON on stdin):
//!   { "harness": <HarnessConfig>,            // optional; omit to use a reference strategy
//!     "strategy": "harness"|"threshold"|"coin_flip"|"always_correct",  // default "harness" if harness present, else "threshold"
//!     "stake_usd": 100.0,                    // optional, default 100
//!     "fee_bps": 0 }                         // optional, default 0
//!
//! Response (single JSON line on stdout):
//!   {"sharpe":…, "sortino":…, "calmar":…, "max_drawdown_pct":…,
//!    "n_trades":…, "win_rate_pct":…, "total_return_pct":…,
//!    "total_fees_usd":…, "markets_evaluated":…, "markets_entered":…,
//!    "realized_pnl_usd":…}
//!
//! On any error: `{"error":"<message>"}` + exit code 1.

use std::io::{self, Read, Write};
use std::process::ExitCode;

use serde::{Deserialize, Serialize};

use trading_runtime::backtest::{
    AlwaysCorrectStrategy, CoinFlipStrategy, HarnessConfig, HarnessPredictionStrategy,
    PredictionBenchmarkConfig, PredictionMarket, PredictionStrategy, ProbabilityPoint, Resolution,
    ThresholdStrategy, run_prediction_benchmark,
};

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    harness: Option<HarnessConfig>,
    #[serde(default)]
    strategy: Option<String>,
    #[serde(default = "default_stake")]
    stake_usd: f64,
    #[serde(default)]
    fee_bps: u32,
}

fn default_stake() -> f64 {
    100.0
}

#[derive(Debug, Serialize)]
struct Response {
    strategy: String,
    sharpe: f64,
    sortino: f64,
    calmar: f64,
    max_drawdown_pct: f64,
    n_trades: usize,
    win_rate_pct: f64,
    total_return_pct: f64,
    total_fees_usd: f64,
    markets_evaluated: usize,
    markets_entered: usize,
    realized_pnl_usd: f64,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

fn main() -> ExitCode {
    let mut raw = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut raw) {
        return fail(format!("stdin read: {e}"));
    }
    // Empty stdin → score the default threshold reference strategy so the
    // example is runnable with no input (smoke / demo).
    let req: Request = if raw.trim().is_empty() {
        Request {
            harness: None,
            strategy: Some("threshold".into()),
            stake_usd: default_stake(),
            fee_bps: 0,
        }
    } else {
        match serde_json::from_str(&raw) {
            Ok(r) => r,
            Err(e) => return fail(format!("request parse: {e}")),
        }
    };

    let markets = synthetic_fixture();
    let cfg = PredictionBenchmarkConfig {
        stake_usd: req.stake_usd,
        fee_bps: req.fee_bps,
    };

    let kind = req.strategy.clone().unwrap_or_else(|| {
        if req.harness.is_some() {
            "harness"
        } else {
            "threshold"
        }
        .into()
    });

    let harness_strategy;
    let strategy: &dyn PredictionStrategy = match kind.as_str() {
        "harness" => {
            let Some(h) = req.harness.clone() else {
                return fail("strategy=harness requires a 'harness' field".into());
            };
            harness_strategy = HarnessPredictionStrategy::new(h);
            &harness_strategy
        }
        "threshold" => &ThresholdStrategy::default(),
        "coin_flip" => &CoinFlipStrategy,
        "always_correct" => &AlwaysCorrectStrategy,
        other => return fail(format!("unknown strategy '{other}'")),
    };

    let out = run_prediction_benchmark(&markets, strategy, &cfg);
    let realized: f64 = out.trades.iter().map(|t| t.pnl_usd).sum();

    let response = Response {
        strategy: kind,
        sharpe: out.result.stats.sharpe_ratio,
        sortino: out.result.stats.sortino_ratio,
        calmar: out.result.stats.calmar_ratio,
        max_drawdown_pct: out.result.stats.max_drawdown_pct,
        n_trades: out.trades.len(),
        win_rate_pct: out.result.stats.win_rate * 100.0,
        total_return_pct: out.result.stats.total_return_pct,
        total_fees_usd: out.total_fees_usd,
        markets_evaluated: out.markets_evaluated,
        markets_entered: out.markets_entered,
        realized_pnl_usd: realized,
    };

    match serde_json::to_string(&response) {
        Ok(s) => {
            let _ = writeln!(io::stdout(), "{s}");
            ExitCode::SUCCESS
        }
        Err(e) => fail(format!("response serialise: {e}")),
    }
}

fn fail(msg: String) -> ExitCode {
    let _ = writeln!(
        io::stdout(),
        "{}",
        serde_json::to_string(&ErrorResponse { error: msg })
            .unwrap_or_else(|_| "{\"error\":\"unknown\"}".into()),
    );
    ExitCode::FAILURE
}

/// Deterministic synthetic fixture: 5 markets resolving YES (price ramps up)
/// and 5 resolving NO (price ramps down), all from a coin-flip midpoint so a
/// strategy must read the trend to be right. Identical every run.
fn synthetic_fixture() -> Vec<PredictionMarket> {
    // 48 hourly observations per market — long enough to exercise the
    // streaming `StrategyRunner` warmup that the harness path drives.
    let mut markets = Vec::new();
    for i in 0..5 {
        markets.push(ramp(&format!("yes-{i}"), 0.50, 0.90, 48, Resolution::Yes));
    }
    for i in 0..5 {
        markets.push(ramp(&format!("no-{i}"), 0.50, 0.10, 48, Resolution::No));
    }
    markets
}

fn ramp(id: &str, start: f64, end: f64, n: usize, resolution: Resolution) -> PredictionMarket {
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
