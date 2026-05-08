use std::time::{SystemTime, UNIX_EPOCH};

use alloy::primitives::{Address, Bytes, U256, Uint};
use alloy::sol;
use alloy::sol_types::SolCall;

/// Alloy type alias for uint24 (used for Uniswap fee tiers)
type Uint24 = Uint<24, 1>;
/// Alloy type alias for uint160 (used for sqrtPriceLimitX96)
type Uint160 = Uint<160, 3>;

use super::{ActionParams, EncodedAction, ProtocolAdapter, approval, validate_vault_address};
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

        struct ExactInputParams {
            bytes path;
            address recipient;
            uint256 deadline;
            uint256 amountIn;
            uint256 amountOutMinimum;
        }
        function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);

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

/// Compute a realistic deadline: 30 minutes from now.
fn default_deadline() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + 1800
}

fn deadline_from_extra(extra: &serde_json::Value) -> u64 {
    ["execution_deadline", "uniswap_deadline", "deadline"]
        .iter()
        .find_map(|key| {
            extra
                .get(key)
                .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
                .filter(|value| *value > 0)
        })
        .unwrap_or_else(default_deadline)
}

pub struct UniswapV3Adapter {
    router_address: Address,
}

struct ExactInputSingleArgs {
    token_in: Address,
    token_out: Address,
    amount_in: U256,
    amount_out_min: U256,
    fee_tier: u32,
    recipient: Address,
    deadline: u64,
}

struct ExactInputArgs {
    path: Bytes,
    amount_in: U256,
    amount_out_min: U256,
    recipient: Address,
    deadline: u64,
}

struct ExactOutputSingleArgs {
    token_in: Address,
    token_out: Address,
    amount_out: U256,
    amount_in_max: U256,
    fee_tier: u32,
    recipient: Address,
    deadline: u64,
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
    fn encode_exact_input_single(&self, args: ExactInputSingleArgs) -> Bytes {
        let call = ISwapRouter::exactInputSingleCall {
            params: ISwapRouter::ExactInputSingleParams {
                tokenIn: args.token_in,
                tokenOut: args.token_out,
                fee: Uint24::from(args.fee_tier),
                recipient: args.recipient,
                deadline: U256::from(args.deadline),
                amountIn: args.amount_in,
                amountOutMinimum: args.amount_out_min,
                sqrtPriceLimitX96: Uint160::ZERO, // No price limit
            },
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode an exactInput call with an explicit Uniswap path.
    fn encode_exact_input(&self, args: ExactInputArgs) -> Bytes {
        let call = ISwapRouter::exactInputCall {
            params: ISwapRouter::ExactInputParams {
                path: args.path,
                recipient: args.recipient,
                deadline: U256::from(args.deadline),
                amountIn: args.amount_in,
                amountOutMinimum: args.amount_out_min,
            },
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode an exactOutputSingle call.
    fn encode_exact_output_single(&self, args: ExactOutputSingleArgs) -> Bytes {
        let call = ISwapRouter::exactOutputSingleCall {
            params: ISwapRouter::ExactOutputSingleParams {
                tokenIn: args.token_in,
                tokenOut: args.token_out,
                fee: Uint24::from(args.fee_tier),
                recipient: args.recipient,
                deadline: U256::from(args.deadline),
                amountOut: args.amount_out,
                amountInMaximum: args.amount_in_max,
                sqrtPriceLimitX96: Uint160::ZERO,
            },
        };
        Bytes::from(call.abi_encode())
    }
}

fn route_tokens(extra: &serde_json::Value) -> Option<Vec<Address>> {
    let values = extra
        .get("route_tokens")
        .or_else(|| extra.get("route"))
        .and_then(serde_json::Value::as_array)?;
    let tokens = values
        .iter()
        .map(|value| value.as_str()?.parse::<Address>().ok())
        .collect::<Option<Vec<_>>>()?;
    (tokens.len() >= 2).then_some(tokens)
}

fn route_fee_tiers(extra: &serde_json::Value, hop_count: usize) -> Result<Vec<u32>, TradingError> {
    let Some(values) = extra.get("fee_tiers").and_then(serde_json::Value::as_array) else {
        return Err(TradingError::AdapterError {
            protocol: "uniswap_v3".into(),
            message: "fee_tiers is required when route_tokens is provided".into(),
        });
    };

    if values.len() != hop_count {
        return Err(TradingError::AdapterError {
            protocol: "uniswap_v3".into(),
            message: format!("fee_tiers must contain exactly {hop_count} entries"),
        });
    }

    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let fee = value.as_u64().ok_or_else(|| TradingError::AdapterError {
                protocol: "uniswap_v3".into(),
                message: format!("fee_tiers[{index}] must be a number"),
            })?;
            if fee > 0xFF_FFFF {
                return Err(TradingError::AdapterError {
                    protocol: "uniswap_v3".into(),
                    message: format!("fee_tiers[{index}] exceeds uint24"),
                });
            }
            Ok(fee as u32)
        })
        .collect()
}

fn encode_uniswap_path(tokens: &[Address], fee_tiers: &[u32]) -> Bytes {
    let mut path = Vec::with_capacity((tokens.len() * 20) + (fee_tiers.len() * 3));
    for (index, token) in tokens.iter().enumerate() {
        path.extend_from_slice(token.as_slice());
        if let Some(fee) = fee_tiers.get(index) {
            path.push(((fee >> 16) & 0xff) as u8);
            path.push(((fee >> 8) & 0xff) as u8);
            path.push((fee & 0xff) as u8);
        }
    }
    Bytes::from(path)
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

    fn known_addresses(&self) -> Vec<Address> {
        vec![self.router_address]
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        validate_vault_address(params, "uniswap_v3")?;

        let fee_tier: u32 = params
            .extra
            .get("fee_tier")
            .and_then(|v| v.as_u64())
            .unwrap_or(3000) as u32;

        let router: Address = UNISWAP_V3_ROUTER.parse().expect("valid router address");
        let deadline = deadline_from_extra(&params.extra);

        match params.action {
            Action::Swap => {
                let calldata = if let Some(tokens) = route_tokens(&params.extra) {
                    if tokens.first() != Some(&params.token_in)
                        || tokens.last() != Some(&params.token_out)
                    {
                        return Err(TradingError::AdapterError {
                            protocol: "uniswap_v3".into(),
                            message: "route_tokens must start with token_in and end with token_out"
                                .into(),
                        });
                    }
                    let fee_tiers = route_fee_tiers(&params.extra, tokens.len() - 1)?;
                    self.encode_exact_input(ExactInputArgs {
                        path: encode_uniswap_path(&tokens, &fee_tiers),
                        amount_in: params.amount,
                        amount_out_min: params.min_output,
                        recipient: params.vault_address,
                        deadline,
                    })
                } else {
                    self.encode_exact_input_single(ExactInputSingleArgs {
                        token_in: params.token_in,
                        token_out: params.token_out,
                        amount_in: params.amount,
                        amount_out_min: params.min_output,
                        fee_tier,
                        recipient: params.vault_address,
                        deadline,
                    })
                };
                Ok(EncodedAction {
                    target: self.router_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, router, params.amount)],
                    debt_reduction: None,
                    health_factor: None,
                })
            }
            Action::Buy => {
                let amount_in_max = params
                    .extra
                    .get("amount_in_max")
                    .and_then(|v| v.as_str())
                    .and_then(|s| U256::from_str_radix(s, 10).ok())
                    .unwrap_or(params.amount);
                let calldata = self.encode_exact_output_single(ExactOutputSingleArgs {
                    token_in: params.token_in,
                    token_out: params.token_out,
                    amount_out: params.amount,
                    amount_in_max,
                    fee_tier,
                    recipient: params.vault_address,
                    deadline,
                });
                Ok(EncodedAction {
                    target: self.router_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, router, amount_in_max)],
                    debt_reduction: None,
                    health_factor: None,
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
    const TOKEN_C: &str = "0x0000000000000000000000000000000000000003";
    const VAULT: &str = "0x0000000000000000000000000000000000000099";

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
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, UNISWAP_V3_ROUTER.parse::<Address>().unwrap());
        assert!(result.calldata.len() > 4);
        assert_eq!(result.output_token, TOKEN_B.parse::<Address>().unwrap());
        assert_eq!(result.approvals.len(), 1);
        assert_eq!(
            result.approvals[0].spender,
            UNISWAP_V3_ROUTER.parse::<Address>().unwrap()
        );
    }

    #[test]
    fn test_encode_swap_uses_execution_deadline() {
        let adapter = UniswapV3Adapter::new();
        let make_params = |deadline| ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_B.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({
                "fee_tier": 3000,
                "execution_deadline": deadline,
            }),
            vault_address: VAULT.parse().unwrap(),
        };

        let first = adapter.encode_action(&make_params(1_777_735_000)).unwrap();
        let same = adapter.encode_action(&make_params(1_777_735_000)).unwrap();
        let different = adapter.encode_action(&make_params(1_777_735_001)).unwrap();

        assert_eq!(first.calldata, same.calldata);
        assert_ne!(first.calldata, different.calldata);
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
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params);
        assert!(result.is_err());
    }

    #[test]
    fn test_explicit_route_rejects_missing_fee_tiers() {
        let adapter = UniswapV3Adapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_C.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({
                "route_tokens": [TOKEN_A, TOKEN_B, TOKEN_C],
            }),
            vault_address: VAULT.parse().unwrap(),
        };

        let result = adapter.encode_action(&params);

        assert!(matches!(result, Err(TradingError::AdapterError { .. })));
    }

    #[test]
    fn test_explicit_route_accepts_matching_fee_tiers() {
        let adapter = UniswapV3Adapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_C.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({
                "route_tokens": [TOKEN_A, TOKEN_B, TOKEN_C],
                "fee_tiers": [500, 3000],
            }),
            vault_address: VAULT.parse().unwrap(),
        };

        let result = adapter.encode_action(&params).unwrap();

        assert!(result.calldata.len() > 4);
    }

    #[test]
    fn test_explicit_route_rejects_wrong_fee_tier_count() {
        let adapter = UniswapV3Adapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_C.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({
                "route_tokens": [TOKEN_A, TOKEN_B, TOKEN_C],
                "fee_tiers": [500],
            }),
            vault_address: VAULT.parse().unwrap(),
        };

        let result = adapter.encode_action(&params);

        assert!(matches!(result, Err(TradingError::AdapterError { .. })));
    }

    #[test]
    fn test_explicit_route_rejects_non_numeric_fee_tier() {
        let adapter = UniswapV3Adapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_C.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({
                "route_tokens": [TOKEN_A, TOKEN_B, TOKEN_C],
                "fee_tiers": [500, "3000"],
            }),
            vault_address: VAULT.parse().unwrap(),
        };

        let result = adapter.encode_action(&params);

        assert!(matches!(result, Err(TradingError::AdapterError { .. })));
    }

    #[test]
    fn test_zero_vault_address_rejected() {
        let adapter = UniswapV3Adapter::new();
        let params = ActionParams {
            action: Action::Swap,
            token_in: TOKEN_A.parse().unwrap(),
            token_out: TOKEN_B.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(990_000u64),
            extra: serde_json::json!({"fee_tier": 3000}),
            vault_address: Address::ZERO,
        };
        let result = adapter.encode_action(&params);
        assert!(result.is_err());
    }
}
