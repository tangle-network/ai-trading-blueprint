use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter, approval, validate_vault_address};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    /// MetaMorpho vaults use ERC-4626 style deposit/withdraw.
    interface IERC4626Vault {
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    }
}

/// Supported chain IDs (Ethereum, Base)
const SUPPORTED_CHAINS: &[u64] = &[1, 8453];

pub struct MorphoVaultAdapter;

impl MorphoVaultAdapter {
    pub fn new() -> Self {
        Self
    }

    /// Encode `deposit(uint256,address)` -- ERC-4626 style.
    fn encode_deposit(&self, amount: U256, vault: Address) -> Bytes {
        let call = IERC4626Vault::depositCall {
            assets: amount,
            receiver: vault,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `withdraw(uint256,address,address)` -- ERC-4626 style.
    fn encode_withdraw(&self, amount: U256, vault: Address) -> Bytes {
        let call = IERC4626Vault::withdrawCall {
            assets: amount,
            receiver: vault,
            owner: vault,
        };
        Bytes::from(call.abi_encode())
    }

    fn vault_from_metadata(params: &ActionParams) -> Result<Address, TradingError> {
        let raw = params
            .extra
            .get("vault_address")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| TradingError::AdapterError {
                protocol: "morpho_vault".into(),
                message: "metadata.vault_address is required for morpho_vault".into(),
            })?;

        let vault = raw
            .parse::<Address>()
            .map_err(|e| TradingError::AdapterError {
                protocol: "morpho_vault".into(),
                message: format!("Invalid metadata.vault_address '{raw}': {e}"),
            })?;
        if vault == Address::ZERO {
            return Err(TradingError::AdapterError {
                protocol: "morpho_vault".into(),
                message: "metadata.vault_address must not be zero".into(),
            });
        }
        Ok(vault)
    }
}

impl Default for MorphoVaultAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for MorphoVaultAdapter {
    fn protocol_id(&self) -> &str {
        "morpho_vault"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        validate_vault_address(params, "morpho_vault")?;
        let morpho_vault = Self::vault_from_metadata(params)?;

        match params.action {
            Action::Supply => {
                let calldata = self.encode_deposit(params.amount, params.vault_address);
                Ok(EncodedAction {
                    target: morpho_vault,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: morpho_vault,
                    approvals: vec![approval(params.token_in, morpho_vault, params.amount)],
                    debt_reduction: None,
                    health_factor: None,
                })
            }
            Action::Withdraw => {
                let calldata = self.encode_withdraw(params.amount, params.vault_address);
                Ok(EncodedAction {
                    target: morpho_vault,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![],
                    debt_reduction: None,
                    health_factor: None,
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "morpho_vault".into(),
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
    const VAULT: &str = "0x0000000000000000000000000000000000000088";

    #[test]
    fn test_protocol_id() {
        let adapter = MorphoVaultAdapter::new();
        assert_eq!(adapter.protocol_id(), "morpho_vault");
    }

    #[test]
    fn test_encode_supply() {
        let adapter = MorphoVaultAdapter::new();
        let params = ActionParams {
            action: Action::Supply,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: MORPHO_VAULT.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({"vault_address": MORPHO_VAULT}),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, MORPHO_VAULT.parse::<Address>().unwrap());
        assert_eq!(
            result.output_token,
            MORPHO_VAULT.parse::<Address>().unwrap()
        );
        assert_eq!(result.min_output, U256::from(990_000u64));
        assert!(result.calldata.len() > 4);
        assert_eq!(result.approvals.len(), 1);
    }

    #[test]
    fn test_encode_withdraw() {
        let adapter = MorphoVaultAdapter::new();
        let params = ActionParams {
            action: Action::Withdraw,
            token_in: MORPHO_VAULT.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::from(490_000u64),
            extra: serde_json::json!({"vault_address": MORPHO_VAULT}),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, MORPHO_VAULT.parse::<Address>().unwrap());
        assert_eq!(result.output_token, TOKEN_USDC.parse::<Address>().unwrap());
    }

    #[test]
    fn test_missing_vault_address_rejected() {
        let adapter = MorphoVaultAdapter::new();
        let params = ActionParams {
            action: Action::Supply,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(1_000_000u64),
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };
        let err = adapter.encode_action(&params).unwrap_err();
        assert!(err.to_string().contains("metadata.vault_address"));
    }
}
