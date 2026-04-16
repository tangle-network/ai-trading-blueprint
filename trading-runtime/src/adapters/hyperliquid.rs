use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter, approval, validate_vault_address};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    /// Hyperliquid L1 bridge deposit function. On-chain trades route through
    /// the bridge contract which processes the order on the Hyperliquid L1.
    interface IHyperliquidBridge {
        struct OrderRequest {
            uint32 asset;       // Hyperliquid asset index (0=BTC, 1=ETH, ...)
            bool isBuy;
            uint64 limitPx;     // Price in Hyperliquid's fixed-point format (float * 1e8)
            uint64 sz;          // Size in Hyperliquid's fixed-point format
            uint8 orderType;    // 0=limit, 1=market
            bool reduceOnly;
        }
        function placeOrder(OrderRequest calldata order) external;
    }
}

/// Hyperliquid bridge contract on Arbitrum.
/// On-chain deposits route through this contract → Hyperliquid L1 order book.
const HYPERLIQUID_BRIDGE: &str = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";

/// Supported chains. Hyperliquid's on-chain bridge lives on Arbitrum.
const SUPPORTED_CHAINS: &[u64] = &[42161];

pub struct HyperliquidAdapter {
    bridge: Address,
}

impl HyperliquidAdapter {
    pub fn new() -> Self {
        Self {
            bridge: HYPERLIQUID_BRIDGE
                .parse()
                .expect("valid hyperliquid bridge"),
        }
    }

    pub fn with_bridge(bridge: Address) -> Self {
        Self { bridge }
    }

    /// Encode an order through the Hyperliquid bridge.
    ///
    /// `asset_index` is Hyperliquid's internal asset ID (0=BTC, 1=ETH, etc.).
    /// `limit_px` is the limit price in Hyperliquid's fixed-point format (price * 1e8).
    /// Must be non-zero for limit orders to prevent unbounded slippage.
    /// `size` is the order size in Hyperliquid's fixed-point format.
    fn encode_order(
        &self,
        asset_index: u32,
        is_buy: bool,
        limit_px: u64,
        size: U256,
        reduce_only: bool,
    ) -> Result<Bytes, TradingError> {
        if limit_px == 0 {
            return Err(TradingError::AdapterError {
                protocol: "hyperliquid".into(),
                message: "limit_px must be non-zero — zero disables price protection".into(),
            });
        }

        let sz: u64 = size.try_into().map_err(|_| TradingError::AdapterError {
            protocol: "hyperliquid".into(),
            message: format!("Size {} exceeds u64::MAX", size),
        })?;

        if sz == 0 {
            return Err(TradingError::AdapterError {
                protocol: "hyperliquid".into(),
                message: "Order size must be non-zero".into(),
            });
        }

        let order = IHyperliquidBridge::OrderRequest {
            asset: asset_index,
            isBuy: is_buy,
            limitPx: limit_px,
            sz,
            orderType: 0, // limit order (with price protection)
            reduceOnly: reduce_only,
        };

        let call = IHyperliquidBridge::placeOrderCall { order };
        Ok(Bytes::from(call.abi_encode()))
    }
}

impl Default for HyperliquidAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for HyperliquidAdapter {
    fn protocol_id(&self) -> &str {
        "hyperliquid"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn known_addresses(&self) -> Vec<Address> {
        vec![self.bridge]
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        validate_vault_address(params, "hyperliquid")?;

        let asset_index: u32 = params
            .extra
            .get("asset_index")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        // limit_px: price * 1e8 in Hyperliquid's fixed-point format
        let limit_px: u64 = params
            .extra
            .get("limit_px")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        match params.action {
            Action::OpenLong => {
                let calldata =
                    self.encode_order(asset_index, true, limit_px, params.amount, false)?;
                Ok(EncodedAction {
                    target: self.bridge,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, self.bridge, params.amount)],
                })
            }
            Action::OpenShort => {
                let calldata =
                    self.encode_order(asset_index, false, limit_px, params.amount, false)?;
                Ok(EncodedAction {
                    target: self.bridge,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![approval(params.token_in, self.bridge, params.amount)],
                })
            }
            Action::CloseLong => {
                // Close long = sell, reduce only
                let calldata =
                    self.encode_order(asset_index, false, limit_px, params.amount, true)?;
                Ok(EncodedAction {
                    target: self.bridge,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![],
                })
            }
            Action::CloseShort => {
                // Close short = buy, reduce only
                let calldata =
                    self.encode_order(asset_index, true, limit_px, params.amount, true)?;
                Ok(EncodedAction {
                    target: self.bridge,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                    approvals: vec![],
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "hyperliquid".into(),
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
        let adapter = HyperliquidAdapter::new();
        assert_eq!(adapter.protocol_id(), "hyperliquid");
    }

    #[test]
    fn test_supported_chains_includes_arbitrum() {
        let adapter = HyperliquidAdapter::new();
        assert!(adapter.supported_chains().contains(&42161));
    }

    #[test]
    fn test_encode_open_long() {
        let adapter = HyperliquidAdapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(1_000_000u64), // 1 USDC worth of size
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "asset_index": 1,   // ETH
                "limit_px": 250000000000u64  // $2500.00 * 1e8
            }),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.target,
            HYPERLIQUID_BRIDGE.parse::<Address>().unwrap()
        );
        assert!(result.calldata.len() > 4);
        assert_eq!(result.approvals.len(), 1);
    }

    #[test]
    fn test_encode_close_short_reduce_only() {
        let adapter = HyperliquidAdapter::new();
        let params = ActionParams {
            action: Action::CloseShort,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "asset_index": 0,   // BTC
                "limit_px": 6500000000000u64  // $65000.00 * 1e8
            }),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        // Close = no approvals needed (reduce only)
        assert_eq!(result.approvals.len(), 0);
    }

    #[test]
    fn test_reject_zero_limit_px() {
        let adapter = HyperliquidAdapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "asset_index": 1,
                "limit_px": 0
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

    #[test]
    fn test_reject_zero_size() {
        let adapter = HyperliquidAdapter::new();
        let params = ActionParams {
            action: Action::OpenShort,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::ZERO,
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "asset_index": 1,
                "limit_px": 250000000000u64
            }),
            vault_address: VAULT.parse().unwrap(),
        };
        assert!(adapter.encode_action(&params).is_err());
    }

    #[test]
    fn test_reject_oversized_amount() {
        let adapter = HyperliquidAdapter::new();
        let params = ActionParams {
            action: Action::OpenLong,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::MAX,
            min_output: U256::ZERO,
            extra: serde_json::json!({
                "asset_index": 1,
                "limit_px": 250000000000u64
            }),
            vault_address: VAULT.parse().unwrap(),
        };
        let err = adapter.encode_action(&params).unwrap_err();
        match err {
            TradingError::AdapterError { message, .. } => {
                assert!(message.contains("u64::MAX"), "got: {message}");
            }
            other => panic!("expected AdapterError, got: {other:?}"),
        }
    }

    #[test]
    fn test_unsupported_action() {
        let adapter = HyperliquidAdapter::new();
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
}
