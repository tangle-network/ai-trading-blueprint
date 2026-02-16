use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    interface IEndpoint {
        struct SlowModeTransaction {
            uint64 executableAt;
            address sender;
            bytes tx;
        }
        function submitSlowModeTransaction(bytes calldata transaction) external;
    }

    /// Vertex order parameters encoded within the slow-mode transaction bytes.
    struct PlaceOrderParams {
        uint32 productId;
        int128 amount;
        uint128 priceX18;
        bool isLong;
    }
}

/// Vertex Endpoint on Arbitrum
const VERTEX_ENDPOINT: &str = "0xbbEE07B3e8121227AfCFe1E2B82772571571e06A";

/// Supported chain IDs (Arbitrum, Mantle, Blast, Base, Sei)
const SUPPORTED_CHAINS: &[u64] = &[42161, 5000, 81457, 8453, 1329];

pub struct VertexAdapter {
    endpoint: Address,
}

impl VertexAdapter {
    pub fn new() -> Self {
        Self {
            endpoint: VERTEX_ENDPOINT.parse().expect("valid vertex endpoint"),
        }
    }

    pub fn with_endpoint(endpoint: Address) -> Self {
        Self { endpoint }
    }

    /// Encode a perp order submission via submitSlowModeTransaction.
    fn encode_place_order(
        &self,
        product_id: u32,
        amount: U256,
        _price: &str,
        is_long: bool,
    ) -> Bytes {
        // Build the inner transaction bytes containing the order params.
        // Vertex encodes product_id, amount, and direction in the tx bytes.
        let signed_amount: i128 = if is_long {
            amount.try_into().unwrap_or(i128::MAX)
        } else {
            -(amount.try_into().unwrap_or(i128::MAX))
        };

        let order = PlaceOrderParams {
            productId: product_id,
            amount: signed_amount,
            priceX18: 0u128, // Market order, price set by engine
            isLong: is_long,
        };

        // Encode the inner order params, then wrap in submitSlowModeTransaction
        let inner_bytes = alloy::sol_types::SolValue::abi_encode(&order);
        let call = IEndpoint::submitSlowModeTransactionCall {
            transaction: Bytes::from(inner_bytes),
        };
        Bytes::from(call.abi_encode())
    }
}

impl Default for VertexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for VertexAdapter {
    fn protocol_id(&self) -> &str {
        "vertex"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        let product_id: u32 = params
            .extra
            .get("product_id")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        let price = params
            .extra
            .get("price")
            .and_then(|v| v.as_str())
            .unwrap_or("0");

        match params.action {
            Action::OpenLong => {
                let calldata =
                    self.encode_place_order(product_id, params.amount, price, true);
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::OpenShort => {
                let calldata =
                    self.encode_place_order(product_id, params.amount, price, false);
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::CloseLong => {
                // Close long = open short to flatten
                let calldata =
                    self.encode_place_order(product_id, params.amount, price, false);
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::CloseShort => {
                // Close short = open long to flatten
                let calldata =
                    self.encode_place_order(product_id, params.amount, price, true);
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "vertex".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_USDC: &str = "0x0000000000000000000000000000000000000001";

    #[test]
    fn test_protocol_id() {
        let adapter = VertexAdapter::new();
        assert_eq!(adapter.protocol_id(), "vertex");
    }

    #[test]
    fn test_supported_chains_includes_arbitrum() {
        let adapter = VertexAdapter::new();
        assert!(adapter.supported_chains().contains(&42161));
    }

    #[test]
    fn test_encode_open_long() {
        let adapter = VertexAdapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(10_000_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "product_id": 2,
                "price": "2500000000000000000000"
            }),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, VERTEX_ENDPOINT.parse::<Address>().unwrap());
        assert!(result.calldata.len() > 4);
    }

    #[test]
    fn test_unsupported_action() {
        let adapter = VertexAdapter::new();
        let params = ActionParams {
            action: Action::Supply,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(100u64),
            min_output: U256::ZERO,
            extra: serde_json::Value::Null,
        };
        assert!(adapter.encode_action(&params).is_err());
    }
}
