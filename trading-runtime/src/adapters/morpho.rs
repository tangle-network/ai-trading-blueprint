use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{parse_address_or, ActionParams, EncodedAction, ProtocolAdapter};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    /// Morpho vault uses ERC-4626 style deposit/withdraw.
    interface IMorpho {
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    }
}

/// Default Morpho vault address (placeholder -- varies per market)
const DEFAULT_MORPHO_VAULT: &str = "0x0000000000000000000000000000000000000000";

/// Supported chain IDs (Ethereum, Base)
const SUPPORTED_CHAINS: &[u64] = &[1, 8453];

pub struct MorphoAdapter {
    vault_address: Address,
}

impl MorphoAdapter {
    pub fn new() -> Self {
        Self {
            vault_address: DEFAULT_MORPHO_VAULT
                .parse()
                .expect("valid morpho vault address"),
        }
    }

    pub fn with_vault(vault_address: Address) -> Self {
        Self { vault_address }
    }

    /// Encode `deposit(uint256,address)` -- ERC-4626 style.
    fn encode_deposit(&self, amount: U256) -> Bytes {
        let call = IMorpho::depositCall {
            assets: amount,
            receiver: Address::ZERO,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `withdraw(uint256,address,address)` -- ERC-4626 style.
    fn encode_withdraw(&self, amount: U256) -> Bytes {
        let call = IMorpho::withdrawCall {
            assets: amount,
            receiver: Address::ZERO,
            owner: Address::ZERO,
        };
        Bytes::from(call.abi_encode())
    }
}

impl Default for MorphoAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for MorphoAdapter {
    fn protocol_id(&self) -> &str {
        "morpho"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        // Allow overriding the vault address via extra params
        let vault = parse_address_or(
            params.extra.get("vault_address"),
            &format!("{:?}", self.vault_address),
        );

        match params.action {
            Action::Supply => {
                let calldata = self.encode_deposit(params.amount);
                Ok(EncodedAction {
                    target: vault,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_in,
                })
            }
            Action::Withdraw => {
                let calldata = self.encode_withdraw(params.amount);
                Ok(EncodedAction {
                    target: vault,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_in,
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "morpho".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_USDC: &str = "0x0000000000000000000000000000000000000001";
    const MORPHO_VAULT: &str = "0x0000000000000000000000000000000000000099";

    #[test]
    fn test_protocol_id() {
        let adapter = MorphoAdapter::new();
        assert_eq!(adapter.protocol_id(), "morpho");
    }

    #[test]
    fn test_encode_supply() {
        let adapter = MorphoAdapter::with_vault(MORPHO_VAULT.parse().unwrap());
        let params = ActionParams {
            action: Action::Supply,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(1_000_000u64),
            extra: serde_json::Value::Null,
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, MORPHO_VAULT.parse::<Address>().unwrap());
        assert!(result.calldata.len() > 4);
    }

    #[test]
    fn test_encode_withdraw() {
        let adapter = MorphoAdapter::with_vault(MORPHO_VAULT.parse().unwrap());
        let params = ActionParams {
            action: Action::Withdraw,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::from(490_000u64),
            extra: serde_json::Value::Null,
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, MORPHO_VAULT.parse::<Address>().unwrap());
    }

    #[test]
    fn test_vault_override_via_extra() {
        let adapter = MorphoAdapter::new();
        let custom_vault = "0x0000000000000000000000000000000000000042";
        let params = ActionParams {
            action: Action::Supply,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(1_000_000u64),
            extra: serde_json::json!({"vault_address": custom_vault}),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, custom_vault.parse::<Address>().unwrap());
    }
}
