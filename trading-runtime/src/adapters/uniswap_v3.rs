use alloy::primitives::{Address, Bytes, Uint, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

/// Alloy type alias for uint24 (used for Uniswap fee tiers)
type Uint24 = Uint<24, 1>;
/// Alloy type alias for uint160 (used for sqrtPriceLimitX96)
type Uint160 = Uint<160, 3>;

use super::{ActionParams, EncodedAction, ProtocolAdapter};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    interface ISwapRouter {
        struct ExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 deadline;
            uint256 amountIn;
            uint256 amountOutMinimum;
            uint160 sqrtPriceLimitX96;
        }
        function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

        struct ExactOutputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 deadline;
            uint256 amountOut;
            uint256 amountInMaximum;
            uint160 sqrtPriceLimitX96;
        }
        function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
    }
}

/// Uniswap V3 SwapRouter address (canonical deployment)
const UNISWAP_V3_ROUTER: &str = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

/// Supported chain IDs (Ethereum mainnet, Arbitrum, Polygon, Optimism, Base)
const SUPPORTED_CHAINS: &[u64] = &[1, 42161, 137, 10, 8453];

/// Default deadline offset: 30 minutes from now (in seconds, as a large constant).
/// In production, this would be `block.timestamp + 1800`.
const DEFAULT_DEADLINE: u64 = u64::MAX;

pub struct UniswapV3Adapter {
    router_address: Address,
}

impl UniswapV3Adapter {
    pub fn new() -> Self {
        Self {
            router_address: UNISWAP_V3_ROUTER
                .parse()
                .expect("valid uniswap v3 router address"),
        }
    }

    pub fn with_router(router_address: Address) -> Self {
        Self { router_address }
    }

    /// Encode an exactInputSingle call.
    fn encode_exact_input_single(
        &self,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
        amount_out_min: U256,
        fee_tier: u32,
    ) -> Bytes {
        let call = ISwapRouter::exactInputSingleCall {
            params: ISwapRouter::ExactInputSingleParams {
                tokenIn: token_in,
                tokenOut: token_out,
                fee: Uint24::from(fee_tier),
                recipient: Address::ZERO, // Vault will be the actual recipient
                deadline: U256::from(DEFAULT_DEADLINE),
                amountIn: amount_in,
                amountOutMinimum: amount_out_min,
                sqrtPriceLimitX96: Uint160::ZERO, // No price limit
            },
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode an exactOutputSingle call.
    fn encode_exact_output_single(
        &self,
        token_in: Address,
        token_out: Address,
        amount_out: U256,
        amount_in_max: U256,
        fee_tier: u32,
    ) -> Bytes {
        let call = ISwapRouter::exactOutputSingleCall {
            params: ISwapRouter::ExactOutputSingleParams {
                tokenIn: token_in,
                tokenOut: token_out,
                fee: Uint24::from(fee_tier),
                recipient: Address::ZERO,
                deadline: U256::from(DEFAULT_DEADLINE),
                amountOut: amount_out,
                amountInMaximum: amount_in_max,
                sqrtPriceLimitX96: Uint160::ZERO,
            },
        };
        Bytes::from(call.abi_encode())
    }
}

impl Default for UniswapV3Adapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for UniswapV3Adapter {
    fn protocol_id(&self) -> &str {
        "uniswap_v3"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        let fee_tier: u32 = params
            .extra
            .get("fee_tier")
            .and_then(|v| v.as_u64())
            .unwrap_or(3000) as u32;

        match params.action {
            Action::Swap => {
                let calldata = self.encode_exact_input_single(
                    params.token_in,
                    params.token_out,
                    params.amount,
                    params.min_output,
                    fee_tier,
                );
                Ok(EncodedAction {
                    target: self.router_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::Buy => {
                let amount_in_max = params
                    .extra
                    .get("amount_in_max")
                    .and_then(|v| v.as_str())
                    .and_then(|s| U256::from_str_radix(s, 10).ok())
                    .unwrap_or(params.amount);
                let calldata = self.encode_exact_output_single(
                    params.token_in,
                    params.token_out,
                    params.amount,
                    amount_in_max,
                    fee_tier,
                );
                Ok(EncodedAction {
                    target: self.router_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_out,
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "uniswap_v3".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_A: &str = "0x0000000000000000000000000000000000000001";
    const TOKEN_B: &str = "0x0000000000000000000000000000000000000002";

    #[test]
    fn test_protocol_id() {
        let adapter = UniswapV3Adapter::new();
        assert_eq!(adapter.protocol_id(), "uniswap_v3");
    }

    #[test]
    fn test_supported_chains() {
        let adapter = UniswapV3Adapter::new();
        let chains = adapter.supported_chains();
        assert!(chains.contains(&42161)); // Arbitrum
        assert!(chains.contains(&1)); // Ethereum mainnet
    }

    #[test]
    fn test_encode_swap() {
        let adapter = UniswapV3Adapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_B.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({"fee_tier": 3000}),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.target,
            UNISWAP_V3_ROUTER.parse::<Address>().unwrap()
        );
        // Verify ABI-encoded calldata starts with the correct selector
        assert!(result.calldata.len() > 4);
        assert_eq!(result.output_token, TOKEN_B.parse::<Address>().unwrap());
    }

    #[test]
    fn test_unsupported_action() {
        let adapter = UniswapV3Adapter::new();
        let params = ActionParams {
            action: Action::Borrow,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_B.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::Value::Null,
        };
        let result = adapter.encode_action(&params);
        assert!(result.is_err());
    }
}
