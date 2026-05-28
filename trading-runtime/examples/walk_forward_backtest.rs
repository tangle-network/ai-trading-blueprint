//! Walk-forward (baseline vs candidate) compare CLI.
//!
//! Used by the TypeScript persona-eval suite (`evals/src/trading/personas/`)
//! and by any future scenario that needs a deterministic baseline+candidate
//! comparison on synthetic candles. Wraps the same `BacktestEngine::
//! walk_forward_compare` the live promotion path uses — single source of
//! truth, no parallel TS reimplementation.
//!
//! Request shape (JSON on stdin):
//!   {
//!     "baseline":           { "harness": <HarnessConfig>,
//!                              "taker_fee_bps": 18, "slippage_bps": 8,
//!                              "gas_cost_usd": 0 },
//!     "candidate":          { "harness": <HarnessConfig>,
//!                              "taker_fee_bps": 8,  "slippage_bps": 4,
//!                              "gas_cost_usd": 0 },
//!     "candles":            [<Candle>, …],         // required, inline only
//!     "funding":            [<FundingSnapshot>, …], // optional, default []
//!     "train_pct":          0.65,                   // optional, default 0.65
//!     "initial_capital_usd":10000                   // optional, default 10000
//!   }
//!
//! Each side gets its own BacktestConfig — the persona suite explicitly
//! contrasts venues with different fee schedules, so collapsing to a
//! shared fee tuple is wrong (it makes the baseline look better/worse
//! than its real venue would).
//!
//! Response: the full `WalkForwardResult` as JSON on stdout (single line).
//! On error: `{"error":"…"}` and exit 1.

use std::io::{self, Read, Write};
use std::process::ExitCode;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use trading_runtime::backtest::{
    BacktestConfig, BacktestEngine, Candle, FundingSnapshot, HarnessConfig, SlippageModel,
    WalkForwardResult,
};

#[derive(Debug, Deserialize)]
struct SideConfig {
    harness: HarnessConfig,
    #[serde(default = "default_taker_fee_bps")]
    taker_fee_bps: u32,
    #[serde(default = "default_slippage_bps")]
    slippage_bps: u32,
    #[serde(default)]
    gas_cost_usd: i64,
}

#[derive(Debug, Deserialize)]
struct Request {
    baseline: SideConfig,
    candidate: SideConfig,
    candles: Vec<Candle>,
    #[serde(default)]
    funding: Vec<FundingSnapshot>,
    #[serde(default = "default_train_pct")]
    train_pct: f64,
    #[serde(default = "default_capital")]
    initial_capital_usd: i64,
}

fn default_train_pct() -> f64 {
    0.65
}
fn default_capital() -> i64 {
    10_000
}
fn default_taker_fee_bps() -> u32 {
    10
}
fn default_slippage_bps() -> u32 {
    10
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
    let req: Request = match serde_json::from_str(&raw) {
        Ok(r) => r,
        Err(e) => return fail(format!("request parse: {e}")),
    };
    if req.candles.is_empty() {
        return fail("candles must be non-empty".to_string());
    }

    let initial = Decimal::new(req.initial_capital_usd, 0);
    let make_config = |side: SideConfig| BacktestConfig {
        initial_capital: initial,
        harness: side.harness,
        slippage: SlippageModel::FixedBps {
            bps: side.slippage_bps,
        },
        gas_cost_usd: Decimal::new(side.gas_cost_usd, 0),
        taker_fee_bps: side.taker_fee_bps,
    };
    let baseline = make_config(req.baseline);
    let candidate = make_config(req.candidate);

    let result: WalkForwardResult = match BacktestEngine::walk_forward_compare(
        &baseline,
        &candidate,
        &req.candles,
        &req.funding,
        req.train_pct,
    ) {
        Ok(r) => r,
        Err(e) => return fail(format!("walk_forward_compare: {e}")),
    };

    let line = match serde_json::to_string(&result) {
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
        serde_json::to_string(&ErrorResponse { error: msg })
            .unwrap_or_else(|_| "{\"error\":\"unknown\"}".into()),
    );
    ExitCode::FAILURE
}
