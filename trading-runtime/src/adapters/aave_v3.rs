use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter, approval, validate_vault_address};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    interface IPool {
        function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
        function withdraw(address asset, uint256 amount, address to) external returns (uint256);
        function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
        function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
    }
}

/// Aave V3 Pool on Ethereum mainnet.
const AAVE_V3_POOL_ETHEREUM: &str = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

/// Aave V3 Pool shared across Arbitrum, Polygon, Optimism, and Avalanche.
const AAVE_V3_POOL_SHARED_L2: &str = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

/// Aave V3 Pool on Base.
const AAVE_V3_POOL_BASE: &str = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

/// Ethereum mainnet Aave V3 aToken addresses for common reserves used in local QA.
const AAVE_V3_A_TOKEN_WETH_ETHEREUM: &str = "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8";
const AAVE_V3_A_TOKEN_USDC_ETHEREUM: &str = "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c";
const AAVE_V3_A_TOKEN_DAI_ETHEREUM: &str = "0x018008bfb33d285247A21d44E50697654f754e63";

const WETH_ETHEREUM: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC_ETHEREUM: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI_ETHEREUM: &str = "0x6b175474e89094c44da98b954eedeac495271d0f";

/// Supported canonical chain IDs (Ethereum, Arbitrum, Polygon, Optimism,
/// Avalanche, Base). Synthetic fork IDs should be normalized by the shared
/// adapter lookup before calling `for_chain`.
const SUPPORTED_CHAINS: &[u64] = &[1, 42161, 137, 10, 43114, 8453];

pub struct AaveV3Adapter {
    chain_id: u64,
    pool_address: Address,
}

impl AaveV3Adapter {
    pub fn new() -> Self {
        Self::for_chain(1).expect("ethereum is a supported Aave V3 chain")
    }

    pub fn with_pool(pool_address: Address) -> Self {
        Self {
            chain_id: 1,
            pool_address,
        }
    }

    pub fn for_chain(chain_id: u64) -> Result<Self, TradingError> {
        let pool_address = match chain_id {
            1 => AAVE_V3_POOL_ETHEREUM,
            42161 | 137 | 10 | 43114 => AAVE_V3_POOL_SHARED_L2,
            8453 => AAVE_V3_POOL_BASE,
            other => {
                return Err(TradingError::AdapterError {
                    protocol: "aave_v3".into(),
                    message: format!("Unsupported chain_id for Aave V3: {other}"),
                });
            }
        };

        Ok(Self {
            chain_id,
            pool_address: pool_address.parse().expect("valid aave v3 pool address"),
        })
    }

    fn a_token_for_asset(&self, asset: Address) -> Option<Address> {
        match self.chain_id {
            1 => {
                let asset = format!("{asset:#x}");
                match asset.as_str() {
                    WETH_ETHEREUM => Some(
                        AAVE_V3_A_TOKEN_WETH_ETHEREUM
                            .parse()
                            .expect("valid aToken address"),
                    ),
                    USDC_ETHEREUM => Some(
                        AAVE_V3_A_TOKEN_USDC_ETHEREUM
                            .parse()
                            .expect("valid aToken address"),
                    ),
                    DAI_ETHEREUM => Some(
                        AAVE_V3_A_TOKEN_DAI_ETHEREUM
                            .parse()
                            .expect("valid aToken address"),
                    ),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// Encode `supply(address,uint256,address,uint16)`.
    fn encode_supply(&self, asset: Address, amount: U256, vault: Address) -> Bytes {
        let call = IPool::supplyCall {
            asset,
            amount,
            onBehalfOf: vault,
            referralCode: 0,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `withdraw(address,uint256,address)`.
    fn encode_withdraw(&self, asset: Address, amount: U256, vault: Address) -> Bytes {
        let call = IPool::withdrawCall {
            asset,
            amount,
            to: vault,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `borrow(address,uint256,uint256,uint16,address)`.
    fn encode_borrow(&self, asset: Address, amount: U256, rate_mode: u8, vault: Address) -> Bytes {
        let call = IPool::borrowCall {
            asset,
            amount,
            interestRateMode: U256::from(rate_mode),
            referralCode: 0,
            onBehalfOf: vault,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `repay(address,uint256,uint256,address)`.
    fn encode_repay(&self, asset: Address, amount: U256, rate_mode: u8, vault: Address) -> Bytes {
        let call = IPool::repayCall {
            asset,
            amount,
            interestRateMode: U256::from(rate_mode),
            onBehalfOf: vault,
        };
        Bytes::from(call.abi_encode())
    }
}

impl Default for AaveV3Adapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for AaveV3Adapter {
    fn protocol_id(&self) -> &str {
        "aave_v3"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn known_addresses(&self) -> Vec<Address> {
        vec![self.pool_address]
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        validate_vault_address(params, "aave_v3")?;

        let rate_mode: u8 = params
            .extra
            .get("rate_mode")
            .and_then(|v| v.as_u64())
            .unwrap_or(2) as u8; // Default: variable rate

        match params.action {
            Action::Supply => {
                let output_token = self.a_token_for_asset(params.token_in).ok_or_else(|| {
                    TradingError::AdapterError {
                        protocol: "aave_v3".into(),
                        message: format!(
                            "Missing Aave V3 aToken mapping for asset {} on chain {}",
                            params.token_in, self.chain_id
                        ),
                    }
                })?;
                let calldata =
                    self.encode_supply(params.token_in, params.amount, params.vault_address);
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token,
                    approvals: vec![approval(params.token_in, self.pool_address, params.amount)],
                })
            }
            Action::Withdraw => {
                let calldata =
                    self.encode_withdraw(params.token_in, params.amount, params.vault_address);
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_in,
                    approvals: vec![],
                })
            }
            Action::Borrow => {
                let calldata = self.encode_borrow(
                    params.token_out,
                    params.amount,
                    rate_mode,
                    params.vault_address,
                );
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_out,
                    approvals: vec![],
                })
            }
            Action::Repay => {
                let calldata = self.encode_repay(
                    params.token_in,
                    params.amount,
                    rate_mode,
                    params.vault_address,
                );
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: U256::ZERO,
                    output_token: params.token_in,
                    approvals: vec![approval(params.token_in, self.pool_address, params.amount)],
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_USDC: &str = USDC_ETHEREUM;
    const TOKEN_WETH: &str = WETH_ETHEREUM;
    const VAULT: &str = "0x0000000000000000000000000000000000000099";

    #[test]
    fn test_protocol_id() {
        let adapter = AaveV3Adapter::new();
        assert_eq!(adapter.protocol_id(), "aave_v3");
    }

    #[test]
    fn test_encode_supply() {
        let adapter = AaveV3Adapter::new();
        let params = ActionParams {
            action: Action::Supply,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(999_999u64),
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.target,
            AAVE_V3_POOL_ETHEREUM.parse::<Address>().unwrap()
        );
        assert!(result.calldata.len() > 4);
        assert_eq!(result.approvals.len(), 1);
        assert_eq!(
            result.output_token,
            AAVE_V3_A_TOKEN_USDC_ETHEREUM.parse::<Address>().unwrap()
        );
        assert_eq!(result.min_output, U256::from(999_999u64));
    }

    #[test]
    fn test_encode_borrow() {
        let adapter = AaveV3Adapter::new();
        let params = ActionParams {
            action: Action::Borrow,
            token_in: TOKEN_WETH.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::from(500_000u64),
            extra: serde_json::json!({"rate_mode": 2}),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.target,
            AAVE_V3_POOL_ETHEREUM.parse::<Address>().unwrap()
        );
    }

    #[test]
    fn test_for_chain_uses_ethereum_pool() {
        let adapter = AaveV3Adapter::for_chain(1).unwrap();
        assert_eq!(
            adapter.known_addresses(),
            vec![AAVE_V3_POOL_ETHEREUM.parse::<Address>().unwrap()]
        );
    }

    #[test]
    fn test_for_chain_uses_shared_l2_pool() {
        let adapter = AaveV3Adapter::for_chain(42161).unwrap();
        assert_eq!(
            adapter.known_addresses(),
            vec![AAVE_V3_POOL_SHARED_L2.parse::<Address>().unwrap()]
        );
    }

    #[test]
    fn test_for_chain_uses_base_pool() {
        let adapter = AaveV3Adapter::for_chain(8453).unwrap();
        assert_eq!(
            adapter.known_addresses(),
            vec![AAVE_V3_POOL_BASE.parse::<Address>().unwrap()]
        );
    }

    #[test]
    fn test_for_chain_rejects_unknown_chain() {
        let err = AaveV3Adapter::for_chain(31337)
            .err()
            .expect("should reject unsupported chain");
        assert!(err.to_string().contains("Unsupported chain_id"), "{err}");
    }

    #[test]
    fn test_for_chain_rejects_synthetic_fork_chain() {
        let err = AaveV3Adapter::for_chain(31339)
            .err()
            .expect("synthetic fork ids should be normalized before adapter lookup");
        assert!(err.to_string().contains("Unsupported chain_id"), "{err}");
    }

    #[test]
    fn test_unsupported_action() {
        let adapter = AaveV3Adapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_WETH.parse().unwrap(),
            amount: U256::from(100u64),
            min_output: U256::ZERO,
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };
        assert!(adapter.encode_action(&params).is_err());
    }
}
