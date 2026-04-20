pub mod adapters;
pub mod backtest;
pub mod calldata_decoder;
pub mod chain;
#[allow(clippy::too_many_arguments)]
pub mod contracts;
pub mod error;
pub mod executor;
pub mod fees;
pub mod hyperliquid;
pub mod intent;
pub mod leaderboard;
pub mod market_data;
pub mod polymarket_clob;
pub mod portfolio;
pub mod signature_verify;
pub mod simulator;
pub mod strategy;
pub mod trading_envelope;
pub mod types;
pub mod url_validation;
pub mod validator_client;
pub mod vault_client;

pub use error::TradingError;
pub use intent::TradeIntentBuilder;
pub use types::*;
