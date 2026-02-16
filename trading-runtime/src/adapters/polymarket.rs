use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{ActionParams, EncodedAction, ProtocolAdapter};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    interface IConditionalTokens {
        function splitPosition(
            address collateralToken,
            bytes32 parentCollectionId,
            bytes32 conditionId,
            uint256[] calldata partition,
            uint256 amount
        ) external;

        function mergePositions(
            address collateralToken,
            bytes32 parentCollectionId,
            bytes32 conditionId,
            uint256[] calldata partition,
            uint256 amount
        ) external;

        function redeemPositions(
            address collateralToken,
            bytes32 parentCollectionId,
            bytes32 conditionId,
            uint256[] calldata indexSets
        ) external;
    }
}

/// Polymarket CTF Exchange on Polygon
const CTF_EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

/// Conditional Tokens Framework contract
const CTF_CONTRACT: &str = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

/// Supported chain IDs (Polygon)
const SUPPORTED_CHAINS: &[u64] = &[137];

pub struct PolymarketAdapter {
    #[allow(dead_code)]
    ctf_exchange: Address,
    ctf_contract: Address,
}

impl PolymarketAdapter {
    pub fn new() -> Self {
        Self {
            ctf_exchange: CTF_EXCHANGE.parse().expect("valid ctf exchange address"),
            ctf_contract: CTF_CONTRACT.parse().expect("valid ctf contract address"),
        }
    }

    pub fn with_addresses(ctf_exchange: Address, ctf_contract: Address) -> Self {
        Self {
            ctf_exchange,
            ctf_contract,
        }
    }

    /// Encode a buy (split position): split collateral into conditional tokens.
    fn encode_buy(
        &self,
        collateral_token: Address,
        condition_id: FixedBytes<32>,
        amount: U256,
    ) -> Bytes {
        // Binary outcome: partition = [1, 2] for YES/NO
        let partition = vec![U256::from(1), U256::from(2)];
        let call = IConditionalTokens::splitPositionCall {
            collateralToken: collateral_token,
            parentCollectionId: FixedBytes::ZERO,
            conditionId: condition_id,
            partition,
            amount,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode a sell (merge positions): merge conditional tokens back to collateral.
    fn encode_sell(
        &self,
        collateral_token: Address,
        condition_id: FixedBytes<32>,
        amount: U256,
    ) -> Bytes {
        let partition = vec![U256::from(1), U256::from(2)];
        let call = IConditionalTokens::mergePositionsCall {
            collateralToken: collateral_token,
            parentCollectionId: FixedBytes::ZERO,
            conditionId: condition_id,
            partition,
            amount,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode a redeem for resolved conditions.
    fn encode_redeem(
        &self,
        collateral_token: Address,
        condition_id: FixedBytes<32>,
    ) -> Bytes {
        // Redeem both outcome slots
        let index_sets = vec![U256::from(1), U256::from(2)];
        let call = IConditionalTokens::redeemPositionsCall {
            collateralToken: collateral_token,
            parentCollectionId: FixedBytes::ZERO,
            conditionId: condition_id,
            indexSets: index_sets,
        };
        Bytes::from(call.abi_encode())
    }

    /// Parse a condition_id from a hex string in the extra params.
    fn parse_condition_id(extra: &serde_json::Value) -> FixedBytes<32> {
        extra
            .get("condition_id")
            .and_then(|v| v.as_str())
            .and_then(|s| {
                let s = s.strip_prefix("0x").unwrap_or(s);
                let bytes = hex::decode(s).ok()?;
                if bytes.len() == 32 {
                    Some(FixedBytes::from_slice(&bytes))
                } else {
                    None
                }
            })
            .unwrap_or(FixedBytes::ZERO)
    }
}

impl Default for PolymarketAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for PolymarketAdapter {
    fn protocol_id(&self) -> &str {
        "polymarket"
    }

    fn supported_chains(&self) -> Vec<u64> {
        SUPPORTED_CHAINS.to_vec()
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        let condition_id = Self::parse_condition_id(&params.extra);

        match params.action {
            Action::Buy => {
                let calldata = self.encode_buy(
                    params.token_in,
                    condition_id,
                    params.amount,
                );
                Ok(EncodedAction {
                    target: self.ctf_contract,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            Action::Sell => {
                let calldata = self.encode_sell(
                    params.token_in,
                    condition_id,
                    params.amount,
                );
                Ok(EncodedAction {
                    target: self.ctf_contract,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_in,
                })
            }
            Action::Redeem => {
                let calldata = self.encode_redeem(
                    params.token_out, // collateral token to redeem into
                    condition_id,
                );
                Ok(EncodedAction {
                    target: self.ctf_contract,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: params.token_out,
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "polymarket".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_USDC: &str = "0x0000000000000000000000000000000000000001";
    const TOKEN_CTF: &str = "0x0000000000000000000000000000000000000002";

    #[test]
    fn test_protocol_id() {
        let adapter = PolymarketAdapter::new();
        assert_eq!(adapter.protocol_id(), "polymarket");
    }

    #[test]
    fn test_supported_chains_polygon() {
        let adapter = PolymarketAdapter::new();
        assert!(adapter.supported_chains().contains(&137));
    }

    #[test]
    fn test_encode_buy() {
        let adapter = PolymarketAdapter::new();
        let params = ActionParams {
            action: Action::Buy,
            token_in: TOKEN_USDC.parse().unwrap(),
            token_out: TOKEN_CTF.parse().unwrap(),
            amount: U256::from(100_000_000u64),
            min_output: U256::from(90_000_000u64),
            extra: serde_json::json!({
                "condition_id": "0x0000000000000000000000000000000000000000000000000000000000000001"
            }),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, CTF_CONTRACT.parse::<Address>().unwrap());
        assert!(result.calldata.len() > 4);
    }

    #[test]
    fn test_encode_redeem() {
        let adapter = PolymarketAdapter::new();
        let params = ActionParams {
            action: Action::Redeem,
            token_in: TOKEN_CTF.parse().unwrap(),
            token_out: TOKEN_USDC.parse().unwrap(),
            amount: U256::from(100_000_000u64),
            min_output: U256::from(100_000_000u64),
            extra: serde_json::json!({
                "condition_id": "0x0000000000000000000000000000000000000000000000000000000000000001"
            }),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, CTF_CONTRACT.parse::<Address>().unwrap());
    }
}
