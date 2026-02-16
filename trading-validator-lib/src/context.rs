//! Operator identity context for the validator binary.
//!
//! Initialized once at startup from the `BlueprintEnvironment` keystore.
//! Job handlers and the HTTP server use this to identify which operator
//! this process represents.

use alloy::primitives::Address;
use once_cell::sync::OnceCell;

/// Runtime context for the validator operator.
#[derive(Debug, Clone)]
pub struct ValidatorOperatorContext {
    /// This operator's Ethereum address (from keystore ECDSA key).
    pub operator_address: Address,
    /// Hex-encoded private key for EIP-712 signing.
    pub signing_key_hex: String,
    /// The Tangle service ID this operator is part of.
    pub service_id: u64,
    /// The blueprint ID for the validator blueprint.
    pub blueprint_id: u64,
    /// Chain ID for EIP-712 domain.
    pub chain_id: u64,
    /// TradeValidator contract address for EIP-712 domain.
    pub verifying_contract: Address,
}

static VALIDATOR_CTX: OnceCell<ValidatorOperatorContext> = OnceCell::new();

/// Initialize the operator context.  Must be called once at startup.
pub fn init_operator_context(ctx: ValidatorOperatorContext) -> Result<(), String> {
    VALIDATOR_CTX
        .set(ctx)
        .map_err(|_| "Operator context already initialized".to_string())
}

/// Get the operator context.  Returns `None` if not yet initialized
/// (e.g., in unit tests that don't set up the full environment).
pub fn operator_context() -> Option<&'static ValidatorOperatorContext> {
    VALIDATOR_CTX.get()
}
