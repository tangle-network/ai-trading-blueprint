pub mod baseline;
pub mod cost_model;
pub mod engine;
pub mod history;
pub mod indicators;
pub mod prediction;
pub mod runner;
pub mod types;

pub use baseline::{
    DEFAULT_BASELINE_LOOKBACK_DAYS, run_baseline_backtest, strategy_supports_baseline,
};
pub use engine::BacktestEngine;
pub use history::{Interval, fetch_candles};
pub use prediction::{
    AlwaysCorrectStrategy, CoinFlipStrategy, HarnessPredictionStrategy, PredictionBenchmarkConfig,
    PredictionBenchmarkResult, PredictionMarket, PredictionSignal, PredictionStrategy,
    PredictionTrade, ProbabilityPoint, Resolution, Side, ThresholdStrategy,
    run_prediction_benchmark,
};
pub use runner::StrategyRunner;
pub use types::*;
