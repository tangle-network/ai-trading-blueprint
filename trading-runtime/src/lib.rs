pub mod aave_v3_registry;
pub mod adapters;
pub mod backtest;
pub mod calldata_decoder;
pub mod chain;
#[allow(clippy::too_many_arguments)]
pub mod contracts;
pub mod envelope;
pub mod envelope_registry;
pub mod error;
pub mod evals;
pub mod execution_hash;
pub mod executor;
pub mod fees;
pub mod hyperevm_corewriter;
pub mod hyperliquid;
pub mod intent;
pub mod leaderboard;
pub mod learning;
pub mod market_data;
pub mod multicall;
pub mod polymarket_clob;
pub mod portfolio;
pub mod protocol_fees;
pub mod signature_verify;
pub mod simulator;
pub mod solana;
pub mod strategy;
pub mod supported_assets;
pub mod token_metadata;
pub mod types;
pub mod url_validation;
pub mod validator_client;
pub mod vault_client;

pub mod cex;

/// Crate-private process-wide lock for tests that mutate global env vars.
/// `cex::keys` and `solana::keys` test modules both touch
/// `SOLANA_OPERATOR_PRIVATE_KEY`; without a single mutex shared across
/// modules, parallel test execution interleaves their set/remove pairs
/// and the test reading the value sees `None` mid-flight.
#[cfg(test)]
pub(crate) static TEST_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub use envelope::{
    AaveBorrowEnforcement, AaveRepayEnforcement, AaveSupplyEnforcement, AaveWithdrawEnforcement,
    AerodromeSwapEnforcement, ClobContext, ClobPolicy, CurveStableSwapEnforcement, EnvelopeBinding,
    EnvelopeEnforcement, EnvelopeError, EnvelopeSignature, MorphoBorrowEnforcement,
    MorphoRepayEnforcement, MorphoSupplyEnforcement, MorphoWithdrawEnforcement,
    PancakeswapV3SwapEnforcement, PerpsContext, PerpsPolicy, SignedEnvelope, TradingPolicy,
    UniswapV3SwapEnforcement, UniswapV4SwapEnforcement, UniversalContext, VaultContext,
    VaultPolicy, check_clob, check_perps, check_universal, check_vault,
};
pub use error::TradingError;
pub use intent::TradeIntentBuilder;
pub use types::*;
