//! Operator identity context for the trading blueprint binary.
//!
//! Initialized once at startup from the `BlueprintEnvironment`.
//! Provides shared configuration that per-bot API instances need.

use once_cell::sync::OnceCell;

/// Runtime context for the trading blueprint operator.
#[derive(Debug, Clone)]
pub struct TradingOperatorContext {
    /// This operator's Ethereum address.
    pub operator_address: String,
    /// Private key for signing transactions (hex-encoded).
    pub private_key: String,
    /// The Tangle service ID.
    pub service_id: u64,
    /// Market data API base URL.
    pub market_data_base_url: String,
    /// Validation deadline in seconds.
    pub validation_deadline_secs: u64,
    /// Minimum validator score for approval.
    pub min_validator_score: u32,
    /// On-chain StrategyRegistry contract address (hex).
    pub strategy_registry_address: String,
    /// On-chain FeeDistributor contract address (hex).
    pub fee_distributor_address: String,
}

static TRADING_CTX: OnceCell<TradingOperatorContext> = OnceCell::new();

/// Initialize the operator context.  Must be called once at startup.
pub fn init_operator_context(ctx: TradingOperatorContext) -> Result<(), String> {
    TRADING_CTX
        .set(ctx)
        .map_err(|_| "Trading operator context already initialized".to_string())
}

/// Get the operator context.
pub fn operator_context() -> Option<&'static TradingOperatorContext> {
    TRADING_CTX.get()
}
