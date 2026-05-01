use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter, approval, validate_vault_address};
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
    ///
    /// `price_x18` is the limit price in Vertex's X18 format (18 decimals).
    /// It MUST be non-zero — a zero priceX18 produces a market order with no
    /// slippage protection, allowing the sequencer to fill at any price.
    fn encode_place_order(
        &self,
        product_id: u32,
        amount: U256,
        price_x18: u128,
        is_long: bool,
    ) -> Result<Bytes, TradingError> {
        // Reject amounts that exceed i128::MAX instead of silently clamping.
        // A U256::MAX silently becoming ~1.7e38 would open a real position.
        let abs_amount: i128 = amount.try_into().map_err(|_| TradingError::AdapterError {
            protocol: "vertex".into(),
            message: format!(
                "Amount {} exceeds i128::MAX — cannot encode Vertex order",
                amount
            ),
        })?;

        let signed_amount = if is_long { abs_amount } else { -abs_amount };

        if price_x18 == 0 {
            return Err(TradingError::AdapterError {
                protocol: "vertex".into(),
                message: "priceX18 must be non-zero — zero produces an unprotected market order"
                    .into(),
            });
        }

        let order = PlaceOrderParams {
            productId: product_id,
            amount: signed_amount,
            priceX18: price_x18,
            isLong: is_long,
        };

        // Encode the inner order params, then wrap in submitSlowModeTransaction
        let inner_bytes = alloy::sol_types::SolValue::abi_encode(&order);
        let call = IEndpoint::submitSlowModeTransactionCall {
            transaction: Bytes::from(inner_bytes),
        };
        Ok(Bytes::from(call.abi_encode()))
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

    fn known_addresses(&self) -> Vec<Address> {
        vec![self.endpoint]
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        validate_vault_address(params, "vertex")?;

        let product_id: u32 = params
            .extra
            .get("product_id")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        // Parse price_x18 from extras. A missing or zero value is rejected
        // by encode_place_order to prevent unprotected market orders.
        let price_x18: u128 = params
            .extra
            .get("price")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u128>().ok())
            .unwrap_or(0);

        match params.action {
            Action::OpenLong => {
                let calldata =
                    self.encode_place_order(product_id, params.amount, price_x18, true)?;
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, self.endpoint, params.amount)],
                    debt_reduction: None,
                })
            }
            Action::OpenShort => {
                let calldata =
                    self.encode_place_order(product_id, params.amount, price_x18, false)?;
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, self.endpoint, params.amount)],
                    debt_reduction: None,
                })
            }
            Action::CloseLong => {
                // Close long = open short to flatten
                let calldata =
                    self.encode_place_order(product_id, params.amount, price_x18, false)?;
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![],
                    debt_reduction: None,
                })
            }
            Action::CloseShort => {
                // Close short = open long to flatten
                let calldata =
                    self.encode_place_order(product_id, params.amount, price_x18, true)?;
                Ok(EncodedAction {
                    target: self.endpoint,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![],
                    debt_reduction: None,
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
    const VAULT: &str = "0x0000000000000000000000000000000000000099";

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
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, VERTEX_ENDPOINT.parse::<Address>().unwrap());
        assert!(result.calldata.len() > 4);
        assert_eq!(result.approvals.len(), 1);
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
            vault_address: VAULT.parse().unwrap(),
        };
        assert!(adapter.encode_action(&params).is_err());
    }

    /// C-3: U256::MAX must not silently clamp to i128::MAX
    #[test]
    fn test_reject_oversized_amount() {
        let adapter = VertexAdapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::MAX,
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "product_id": 2,
                "price": "2500000000000000000000"
            }),
            vault_address: VAULT.parse().unwrap(),
        };
        let err = adapter.encode_action(&params).unwrap_err();
        match err {
            TradingError::AdapterError { message, .. } => {
                assert!(message.contains("exceeds i128::MAX"), "got: {message}");
            }
            other => panic!("expected AdapterError, got: {other:?}"),
        }
    }

    /// C-4: Zero price must be rejected (no unprotected market orders)
    #[test]
    fn test_reject_zero_price() {
        let adapter = VertexAdapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(10_000_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "product_id": 2,
                "price": "0"
            }),
            vault_address: VAULT.parse().unwrap(),
        };
        let err = adapter.encode_action(&params).unwrap_err();
        match err {
            TradingError::AdapterError { message, .. } => {
                assert!(message.contains("non-zero"), "got: {message}");
            }
            other => panic!("expected AdapterError, got: {other:?}"),
        }
    }

    /// C-4: Missing price field defaults to 0 and is rejected
    #[test]
    fn test_reject_missing_price() {
        let adapter = VertexAdapter::new();
        let params = ActionParams {
            action: Action::OpenShort,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(10_000_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({ "product_id": 2 }),
            vault_address: VAULT.parse().unwrap(),
        };
        assert!(adapter.encode_action(&params).is_err());
    }
}
