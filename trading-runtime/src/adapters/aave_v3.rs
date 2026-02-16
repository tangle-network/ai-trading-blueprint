use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter};
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

/// Aave V3 Pool on Arbitrum
const AAVE_V3_POOL: &str = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

/// Supported chain IDs (Ethereum, Arbitrum, Polygon, Optimism, Avalanche, Base)
const SUPPORTED_CHAINS: &[u64] = &[1, 42161, 137, 10, 43114, 8453];

pub struct AaveV3Adapter {
    pool_address: Address,
}

impl AaveV3Adapter {
    pub fn new() -> Self {
        Self {
            pool_address: AAVE_V3_POOL.parse().expect("valid aave v3 pool address"),
        }
    }

    pub fn with_pool(pool_address: Address) -> Self {
        Self { pool_address }
    }

    /// Encode `supply(address,uint256,address,uint16)`.
    /// `onBehalfOf` is set to Address::ZERO (vault fills in).
    fn encode_supply(&self, asset: Address, amount: U256) -> Bytes {
        let call = IPool::supplyCall {
            asset,
            amount,
            onBehalfOf: Address::ZERO,
            referralCode: 0,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `withdraw(address,uint256,address)`.
    fn encode_withdraw(&self, asset: Address, amount: U256) -> Bytes {
        let call = IPool::withdrawCall {
            asset,
            amount,
            to: Address::ZERO, // vault address filled in on-chain
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `borrow(address,uint256,uint256,uint16,address)`.
    fn encode_borrow(&self, asset: Address, amount: U256, rate_mode: u8) -> Bytes {
        let call = IPool::borrowCall {
            asset,
            amount,
            interestRateMode: U256::from(rate_mode),
            referralCode: 0,
            onBehalfOf: Address::ZERO,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `repay(address,uint256,uint256,address)`.
    fn encode_repay(&self, asset: Address, amount: U256, rate_mode: u8) -> Bytes {
        let call = IPool::repayCall {
            asset,
            amount,
            interestRateMode: U256::from(rate_mode),
            onBehalfOf: Address::ZERO,
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

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        let rate_mode: u8 = params
            .extra
            .get("rate_mode")
            .and_then(|v| v.as_u64())
            .unwrap_or(2) as u8; // Default: variable rate

        match params.action {
            Action::Supply => {
                let calldata = self.encode_supply(params.token_in, params.amount);
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_in, // aToken
                })
            }
            Action::Withdraw => {
                let calldata = self.encode_withdraw(params.token_in, params.amount);
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_in,
                })
            }
            Action::Borrow => {
                let calldata =
                    self.encode_borrow(params.token_out, params.amount, rate_mode);
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_out,
                })
            }
            Action::Repay => {
                let calldata =
                    self.encode_repay(params.token_in, params.amount, rate_mode);
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: U256::ZERO,
                    output_token: params.token_in,
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

    const TOKEN_USDC: &str = "0x0000000000000000000000000000000000000001";
    const TOKEN_WETH: &str = "0x0000000000000000000000000000000000000002";

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
            min_output: U256::from(1_000_000u64),
            extra: serde_json::Value::Null,
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, AAVE_V3_POOL.parse::<Address>().unwrap());
        assert!(result.calldata.len() > 4);
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
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, AAVE_V3_POOL.parse::<Address>().unwrap());
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
        };
        assert!(adapter.encode_action(&params).is_err());
    }
}
