pub mod adapters;
pub mod calldata_decoder;
pub mod chain;
#[allow(clippy::too_many_arguments)]
pub mod contracts;
pub mod error;
pub mod executor;
pub mod fees;
pub mod intent;
pub mod market_data;
pub mod polymarket_clob;
pub mod portfolio;
pub mod simulator;
pub mod strategy;
pub mod types;
pub mod signature_verify;
pub mod validator_client;
pub mod vault_client;

pub use error::TradingError;
pub use intent::TradeIntentBuilder;
pub use types::*;
