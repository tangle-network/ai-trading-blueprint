use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{parse_address_or, ActionParams, EncodedAction, ProtocolAdapter};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    interface IExchangeRouter {
        struct CreateOrderParams {
            address receiver;
            address cancellationReceiver;
            address callbackContract;
            address uiFeeReceiver;
            address market;
            address initialCollateralToken;
            address[] swapPath;
            uint256 sizeDeltaUsd;
            uint256 initialCollateralDeltaAmount;
            uint256 triggerPrice;
            uint256 acceptablePrice;
            uint256 executionFee;
            uint256 callbackGasLimit;
            uint256 minOutputAmount;
            uint8 orderType;
            uint8 decreasePositionSwapType;
            bool isLong;
            bool shouldUnwrapNativeToken;
            bool autoCancel;
            bytes32 referralCode;
        }

        function createOrder(CreateOrderParams calldata params) external returns (bytes32);
    }
}

/// GMX V2 Exchange Router on Arbitrum
const GMX_V2_EXCHANGE_ROUTER: &str = "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8";

/// GMX V2 Order Vault on Arbitrum
const GMX_V2_ORDER_VAULT: &str = "0x31eF83a530Fde1B38deDA89C0A6c72d85CEB7807";

/// Supported chain IDs (Arbitrum, Avalanche)
const SUPPORTED_CHAINS: &[u64] = &[42161, 43114];

/// GMX order types
const ORDER_TYPE_MARKET_INCREASE: u8 = 0;
const ORDER_TYPE_MARKET_DECREASE: u8 = 4;

pub struct GmxV2Adapter {
    exchange_router: Address,
    #[allow(dead_code)]
    order_vault: Address,
}

impl GmxV2Adapter {
    pub fn new() -> Self {
        Self {
            exchange_router: GMX_V2_EXCHANGE_ROUTER
                .parse()
                .expect("valid gmx exchange router"),
            order_vault: GMX_V2_ORDER_VAULT
                .parse()
                .expect("valid gmx order vault"),
        }
    }

    pub fn with_addresses(exchange_router: Address, order_vault: Address) -> Self {
        Self {
            exchange_router,
            order_vault,
        }
    }

    /// Encode a createOrder call for opening or closing a position.
    fn encode_create_order(
        &self,
        market: Address,
        initial_collateral_token: Address,
        size_delta_usd: U256,
        is_long: bool,
        is_increase: bool,
    ) -> Bytes {
        let order_type = if is_increase {
            ORDER_TYPE_MARKET_INCREASE
        } else {
            ORDER_TYPE_MARKET_DECREASE
        };

        let call = IExchangeRouter::createOrderCall {
            params: IExchangeRouter::CreateOrderParams {
                receiver: Address::ZERO,
                cancellationReceiver: Address::ZERO,
                callbackContract: Address::ZERO,
                uiFeeReceiver: Address::ZERO,
                market,
                initialCollateralToken: initial_collateral_token,
                swapPath: vec![],
                sizeDeltaUsd: size_delta_usd,
                initialCollateralDeltaAmount: U256::ZERO,
                triggerPrice: U256::ZERO,
                acceptablePrice: if is_long {
                    U256::MAX
                } else {
                    U256::ZERO
                },
                executionFee: U256::ZERO,
                callbackGasLimit: U256::ZERO,
                minOutputAmount: U256::ZERO,
                orderType: order_type,
                decreasePositionSwapType: 0,
                isLong: is_long,
                shouldUnwrapNativeToken: false,
                autoCancel: false,
                referralCode: Default::default(),
            },
        };
        Bytes::from(call.abi_encode())
    }
}

impl Default for GmxV2Adapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for GmxV2Adapter {
    fn protocol_id(&self) -> &str {
        "gmx_v2"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        let market = parse_address_or(
            params.extra.get("market"),
            "0x0000000000000000000000000000000000000000",
        );

        match params.action {
            Action::OpenLong => {
                let calldata = self.encode_create_order(
                    market,
                    params.token_in,
                    params.amount,
                    true,
                    true,
                );
                Ok(EncodedAction {
                    target: self.exchange_router,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::OpenShort => {
                let calldata = self.encode_create_order(
                    market,
                    params.token_in,
                    params.amount,
                    false,
                    true,
                );
                Ok(EncodedAction {
                    target: self.exchange_router,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::CloseLong => {
                let calldata = self.encode_create_order(
                    market,
                    params.token_in,
                    params.amount,
                    true,
                    false,
                );
                Ok(EncodedAction {
                    target: self.exchange_router,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::CloseShort => {
                let calldata = self.encode_create_order(
                    market,
                    params.token_in,
                    params.amount,
                    false,
                    false,
                );
                Ok(EncodedAction {
                    target: self.exchange_router,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "gmx_v2".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_WETH: &str = "0x0000000000000000000000000000000000000001";
    const TOKEN_USDC: &str = "0x0000000000000000000000000000000000000002";
    const ETH_USD_MARKET: &str = "0x0000000000000000000000000000000000000099";

    #[test]
    fn test_protocol_id() {
        let adapter = GmxV2Adapter::new();
        assert_eq!(adapter.protocol_id(), "gmx_v2");
    }

    #[test]
    fn test_supported_chains_includes_arbitrum() {
        let adapter = GmxV2Adapter::new();
        assert!(adapter.supported_chains().contains(&42161));
    }

    #[test]
    fn test_encode_open_long() {
        let adapter = GmxV2Adapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: TOKEN_WETH.parse().unwrap(),
            token_out: TOKEN_WETH.parse().unwrap(),
            amount: U256::from(50_000_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({"market": ETH_USD_MARKET}),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.target,
            GMX_V2_EXCHANGE_ROUTER.parse::<Address>().unwrap()
        );
        assert!(result.calldata.len() > 4);
    }

    #[test]
    fn test_encode_open_short() {
        let adapter = GmxV2Adapter::new();
        let params = ActionParams {
            action: Action::OpenShort,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(25_000_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({"market": ETH_USD_MARKET}),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.target,
            GMX_V2_EXCHANGE_ROUTER.parse::<Address>().unwrap()
        );
    }

    #[test]
    fn test_unsupported_action() {
        let adapter = GmxV2Adapter::new();
        let params = ActionParams {
            action: Action::Supply,
            token_in: TOKEN_WETH.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(100u64),
            min_output: U256::ZERO,
            extra: serde_json::Value::Null,
        };
        assert!(adapter.encode_action(&params).is_err());
    }
}
