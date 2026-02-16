pub mod aave_v3;
pub mod gmx_v2;
pub mod morpho;
pub mod polymarket;
pub mod stat_arb;
pub mod twap;
pub mod uniswap_v3;
pub mod vertex;

use alloy::primitives::{Address, Bytes, U256};

/// Common trait for protocol adapters
pub trait ProtocolAdapter {
    /// Protocol identifier
    fn protocol_id(&self) -> &str;

    /// Chain IDs this adapter supports
    fn supported_chains(&self) -> Vec<u64>;

    /// Encode a trade action into calldata for the vault to execute
    fn encode_action(
        &self,
        params: &ActionParams,
    ) -> Result<EncodedAction, crate::error::TradingError>;
}

/// Parameters for encoding an action
#[derive(Debug, Clone)]
pub struct ActionParams {
    pub action: crate::types::Action,
    pub token_in: Address,
    pub token_out: Address,
    pub amount: U256,
    pub min_output: U256,
    pub extra: serde_json::Value,
}

/// Encoded action ready for vault execution
#[derive(Debug, Clone)]
pub struct EncodedAction {
    pub target: Address,
    pub calldata: Bytes,
    pub value: U256,
    pub min_output: U256,
    pub output_token: Address,
}

/// Helper to parse an address from JSON extra params or a default string.
pub fn parse_address_or(value: Option<&serde_json::Value>, default: &str) -> Address {
    value
        .and_then(|v| v.as_str())
        .unwrap_or(default)
        .parse::<Address>()
        .unwrap_or(Address::ZERO)
}
