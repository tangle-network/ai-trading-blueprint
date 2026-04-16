use std::time::{SystemTime, UNIX_EPOCH};

use alloy::primitives::{Address, Bytes, Signed, U256, Uint};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter, approval, validate_vault_address};
use crate::error::TradingError;
use crate::types::Action;

/// Alloy type alias for int24 (used for Aerodrome Slipstream tick spacing)
type Int24 = Signed<24, 1>;
/// Alloy type alias for uint160 (used for sqrtPriceLimitX96)
type Uint160 = Uint<160, 3>;

sol! {
    /// Aerodrome Slipstream (concentrated liquidity) swap router.
    /// Fork of Uniswap V3 SwapRouter with `tickSpacing` replacing `fee`.
    interface ISlipstreamRouter {
        struct ExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            int24 tickSpacing;
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
            int24 tickSpacing;
            address recipient;
            uint256 deadline;
            uint256 amountOut;
            uint256 amountInMaximum;
            uint160 sqrtPriceLimitX96;
        }
        function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
    }
}

/// Aerodrome Slipstream SwapRouter on Base.
const SLIPSTREAM_ROUTER: &str = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";

/// Supported chains: Base only.
const SUPPORTED_CHAINS: &[u64] = &[8453];

/// Default tick spacing (200 = ~30bps fee tier, most common for volatile pairs).
const DEFAULT_TICK_SPACING: i32 = 200;

fn default_deadline() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + 1800
}

pub struct AerodromeAdapter {
    router: Address,
}

impl AerodromeAdapter {
    pub fn new() -> Self {
        Self {
            router: SLIPSTREAM_ROUTER
                .parse()
                .expect("valid aerodrome slipstream router"),
        }
    }

    pub fn with_router(router: Address) -> Self {
        Self { router }
    }

    fn encode_exact_input_single(
        &self,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
        amount_out_min: U256,
        tick_spacing: i32,
        recipient: Address,
    ) -> Bytes {
        let call = ISlipstreamRouter::exactInputSingleCall {
            params: ISlipstreamRouter::ExactInputSingleParams {
                tokenIn: token_in,
                tokenOut: token_out,
                tickSpacing: Int24::try_from(tick_spacing as i64).unwrap_or(Int24::try_from(DEFAULT_TICK_SPACING as i64).unwrap()),
                recipient,
                deadline: U256::from(default_deadline()),
                amountIn: amount_in,
                amountOutMinimum: amount_out_min,
                sqrtPriceLimitX96: Uint160::ZERO,
            },
        };
        Bytes::from(call.abi_encode())
    }

    fn encode_exact_output_single(
        &self,
        token_in: Address,
        token_out: Address,
        amount_out: U256,
        amount_in_max: U256,
        tick_spacing: i32,
        recipient: Address,
    ) -> Bytes {
        let call = ISlipstreamRouter::exactOutputSingleCall {
            params: ISlipstreamRouter::ExactOutputSingleParams {
                tokenIn: token_in,
                tokenOut: token_out,
                tickSpacing: Int24::try_from(tick_spacing as i64).unwrap_or(Int24::try_from(DEFAULT_TICK_SPACING as i64).unwrap()),
                recipient,
                deadline: U256::from(default_deadline()),
                amountOut: amount_out,
                amountInMaximum: amount_in_max,
                sqrtPriceLimitX96: Uint160::ZERO,
            },
        };
        Bytes::from(call.abi_encode())
    }
}

impl Default for AerodromeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for AerodromeAdapter {
    fn protocol_id(&self) -> &str {
        "aerodrome"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn known_addresses(&self) -> Vec<Address> {
        vec![self.router]
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        validate_vault_address(params, "aerodrome")?;

        // tick_spacing: 1 (1bps), 50 (5bps), 100 (5bps), 200 (30bps), 2000 (100bps)
        let tick_spacing: i32 = params
            .extra
            .get("tick_spacing")
            .and_then(|v| v.as_i64())
            .unwrap_or(DEFAULT_TICK_SPACING as i64) as i32;

        match params.action {
            Action::Swap => {
                let calldata = self.encode_exact_input_single(
                    params.token_in,
                    params.token_out,
                    params.amount,
                    params.min_output,
                    tick_spacing,
                    params.vault_address,
                );
                Ok(EncodedAction {
                    target: self.router,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, self.router, params.amount)],
                })
            }
            Action::Buy => {
                // exactOutputSingle — buy exact amount of output token
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
                    tick_spacing,
                    params.vault_address,
                );
                Ok(EncodedAction {
                    target: self.router,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, self.router, amount_in_max)],
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "aerodrome".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Base USDC and WETH addresses
    const USDC: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const WETH: &str = "0x4200000000000000000000000000000000000006";
    const VAULT: &str = "0x0000000000000000000000000000000000000099";

    #[test]
    fn test_protocol_id() {
        let adapter = AerodromeAdapter::new();
        assert_eq!(adapter.protocol_id(), "aerodrome");
    }

    #[test]
    fn test_supported_chains_base_only() {
        let adapter = AerodromeAdapter::new();
        let chains = adapter.supported_chains();
        assert_eq!(chains, vec![8453]);
    }

    #[test]
    fn test_encode_swap_exact_input() {
        let adapter = AerodromeAdapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: USDC.parse().unwrap(),
            token_out: WETH.parse().unwrap(),
            amount: U256::from(1_000_000u64), // 1 USDC (6 decimals)
            min_output: U256::from(400_000_000_000_000u64), // ~0.0004 ETH
            extra: serde_json::json!({ "tick_spacing": 200 }),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.target,
            SLIPSTREAM_ROUTER.parse::<Address>().unwrap()
        );
        assert!(result.calldata.len() > 4);
        assert_eq!(result.output_token, WETH.parse::<Address>().unwrap());
        assert_eq!(result.approvals.len(), 1);
        assert_eq!(
            result.approvals[0].spender,
            SLIPSTREAM_ROUTER.parse::<Address>().unwrap()
        );
    }

    #[test]
    fn test_encode_swap_default_tick_spacing() {
        let adapter = AerodromeAdapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: USDC.parse().unwrap(),
            token_out: WETH.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({}), // no tick_spacing → default 200
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params);
        assert!(result.is_ok());
    }

    #[test]
    fn test_encode_buy_exact_output() {
        let adapter = AerodromeAdapter::new();
        let params = ActionParams {
            action: Action::Buy,
            token_in: USDC.parse().unwrap(),
            token_out: WETH.parse().unwrap(),
            amount: U256::from(1_000_000_000_000_000_000u64), // 1 ETH
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "tick_spacing": 200,
                "amount_in_max": "3000000000" // 3000 USDC
            }),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.approvals.len(), 1);
        // Approval amount should be amount_in_max, not amount
        assert_eq!(result.approvals[0].amount, U256::from(3_000_000_000u64));
    }

    #[test]
    fn test_unsupported_action() {
        let adapter = AerodromeAdapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: USDC.parse().unwrap(),
            token_out: WETH.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };
        assert!(adapter.encode_action(&params).is_err());
    }

    #[test]
    fn test_zero_vault_rejected() {
        let adapter = AerodromeAdapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: USDC.parse().unwrap(),
            token_out: WETH.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({}),
            vault_address: Address::ZERO,
        };
        assert!(adapter.encode_action(&params).is_err());
    }

    #[test]
    fn test_known_addresses() {
        let adapter = AerodromeAdapter::new();
        let addrs = adapter.known_addresses();
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0], SLIPSTREAM_ROUTER.parse::<Address>().unwrap());
    }
}
