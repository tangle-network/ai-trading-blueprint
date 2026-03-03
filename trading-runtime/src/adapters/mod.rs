pub mod aave_v3;
pub mod gmx_v2;
pub mod morpho;
pub mod polymarket;
pub mod stat_arb;
pub mod twap;
pub mod uniswap_v3;
pub mod vertex;

use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

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

    /// Known protocol addresses (routers, pools, factories) for simulation risk analysis.
    /// The risk analyzer treats transfers/approvals to these addresses as expected behavior.
    fn known_addresses(&self) -> Vec<Address> {
        Vec::new()
    }
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
    pub vault_address: Address,
}

/// A pre-call to execute before the main vault action (e.g., ERC20 approve).
#[derive(Debug, Clone)]
pub struct PreCall {
    pub target: Address,
    pub calldata: Bytes,
    pub value: U256,
}

/// Encoded action ready for vault execution
#[derive(Debug, Clone)]
pub struct EncodedAction {
    pub target: Address,
    pub calldata: Bytes,
    pub value: U256,
    pub min_output: U256,
    pub output_token: Address,
    pub pre_calls: Vec<PreCall>,
}

sol! {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Encode an ERC20 approve pre-call.
pub fn encode_erc20_approve(token: Address, spender: Address, amount: U256) -> PreCall {
    let calldata = approveCall { spender, amount }.abi_encode();
    PreCall {
        target: token,
        calldata: Bytes::from(calldata),
        value: U256::ZERO,
    }
}

/// Validate that the vault address is not zero.
pub fn validate_vault_address(
    params: &ActionParams,
    protocol: &str,
) -> Result<(), crate::error::TradingError> {
    if params.vault_address == Address::ZERO {
        return Err(crate::error::TradingError::AdapterError {
            protocol: protocol.into(),
            message: "vault_address must not be zero".into(),
        });
    }
    Ok(())
}

/// Helper to parse an address from JSON extra params or a default string.
///
/// Returns an error if the value is present but not a valid address,
/// preventing silent fallback to `Address::ZERO`.
pub fn parse_address_or(
    value: Option<&serde_json::Value>,
    default: &str,
) -> Result<Address, crate::error::TradingError> {
    let raw = value.and_then(|v| v.as_str()).unwrap_or(default);
    raw.parse::<Address>()
        .map_err(|e| crate::error::TradingError::AdapterError {
            protocol: "common".into(),
            message: format!("Invalid address '{raw}': {e}"),
        })
}
