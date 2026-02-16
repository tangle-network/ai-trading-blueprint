//! Trade execution pipeline — wires adapters, vault encoding, and chain
//! submission into a single `execute_validated_trade` call.

use alloy::primitives::{Address, U256};
use alloy::providers::Provider;

use crate::adapters::{
    ActionParams, EncodedAction, ProtocolAdapter,
    aave_v3::AaveV3Adapter,
    gmx_v2::GmxV2Adapter,
    morpho::MorphoAdapter,
    polymarket::PolymarketAdapter,
    uniswap_v3::UniswapV3Adapter,
    vertex::VertexAdapter,
};
use crate::chain::ChainClient;
use crate::error::TradingError;
use crate::types::{TradeIntent, ValidationResult};
use crate::vault_client::VaultClient;

/// Outcome of a successfully submitted transaction.
#[derive(Debug, Clone)]
pub struct TransactionOutcome {
    pub tx_hash: String,
    pub block_number: Option<u64>,
    pub gas_used: Option<u128>,
}

/// Wires adapter encoding → vault execute encoding → chain transaction submission.
pub struct TradeExecutor {
    vault_client: VaultClient,
    chain_client: ChainClient,
}

impl TradeExecutor {
    /// Create a new executor.
    ///
    /// * `vault_address` — hex-encoded vault contract address (0x-prefixed)
    /// * `rpc_url` — JSON-RPC endpoint
    /// * `private_key` — hex-encoded operator private key
    /// * `chain_id` — target chain ID
    pub fn new(
        vault_address: &str,
        rpc_url: &str,
        private_key: &str,
        chain_id: u64,
    ) -> Result<Self, TradingError> {
        let vault_client = VaultClient::new(vault_address.to_string(), rpc_url.to_string(), chain_id);
        let chain_client = ChainClient::new(rpc_url, private_key, chain_id)?;
        Ok(Self {
            vault_client,
            chain_client,
        })
    }

    /// Execute a validated trade on-chain.
    ///
    /// Flow:
    /// 1. Look up the protocol adapter from `intent.target_protocol`
    /// 2. Convert intent fields → `ActionParams`
    /// 3. Encode action via adapter → `EncodedAction`
    /// 4. Collect validator signatures + scores from `ValidationResult`
    /// 5. Encode `vault.execute()` call via `VaultClient`
    /// 6. Submit transaction via `ChainClient` and wait for receipt
    pub async fn execute_validated_trade(
        &self,
        intent: &TradeIntent,
        validation: &ValidationResult,
    ) -> Result<TransactionOutcome, TradingError> {
        // 1. Get the right adapter
        let adapter = get_adapter(&intent.target_protocol)?;

        // 2. Build ActionParams from the intent
        let token_in: Address = intent
            .token_in
            .parse()
            .map_err(|e| TradingError::AdapterError {
                protocol: intent.target_protocol.clone(),
                message: format!("Invalid token_in address: {e}"),
            })?;

        let token_out: Address = intent
            .token_out
            .parse()
            .map_err(|e| TradingError::AdapterError {
                protocol: intent.target_protocol.clone(),
                message: format!("Invalid token_out address: {e}"),
            })?;

        // Convert Decimal amounts to U256 (treating as raw token units)
        let amount = decimal_to_u256(&intent.amount_in)?;
        let min_output = decimal_to_u256(&intent.min_amount_out)?;

        let params = ActionParams {
            action: intent.action.clone(),
            token_in,
            token_out,
            amount,
            min_output,
            extra: intent.metadata.clone(),
        };

        // 3. Encode the action
        let encoded: EncodedAction = adapter.encode_action(&params)?;

        // 4. Collect validator signatures and scores
        let (signatures, scores) = collect_validator_data(validation)?;

        // 5. Parse intent_hash → [u8; 32]
        let intent_hash = parse_intent_hash(&validation.intent_hash)?;

        // 6. Compute deadline as U256
        let deadline = U256::from(
            intent
                .deadline
                .timestamp()
                .max(0) as u64,
        );

        // 7. Encode vault.execute()
        let tx = self.vault_client.encode_execute(
            &format!("{}", encoded.target),
            &encoded.calldata,
            &encoded.value.to_string(),
            &encoded.min_output.to_string(),
            &format!("{}", encoded.output_token),
            intent_hash,
            signatures,
            scores,
            deadline,
        )?;

        // 8. Submit via ChainClient
        let to_addr: Address = tx
            .to
            .parse()
            .map_err(|e| TradingError::VaultError(format!("Invalid vault address in tx: {e}")))?;

        let tx_request = alloy::rpc::types::TransactionRequest::default()
            .to(to_addr)
            .input(alloy::primitives::Bytes::from(tx.data).into())
            .value(U256::from_str_radix(tx.value.trim_start_matches("0x"), 10).unwrap_or_default());

        let pending = self
            .chain_client
            .provider
            .send_transaction(tx_request)
            .await
            .map_err(|e| TradingError::VaultError(format!("Transaction send failed: {e}")))?;

        let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));

        let receipt = pending
            .get_receipt()
            .await
            .map_err(|e| TradingError::VaultError(format!("Receipt fetch failed: {e}")))?;

        Ok(TransactionOutcome {
            tx_hash,
            block_number: Some(receipt.block_number.unwrap_or(0)),
            gas_used: Some(receipt.gas_used.into()),
        })
    }
}

/// Registry: map protocol name → adapter instance.
pub fn get_adapter(protocol: &str) -> Result<Box<dyn ProtocolAdapter + Send>, TradingError> {
    match protocol {
        "uniswap_v3" => Ok(Box::new(UniswapV3Adapter::new())),
        "aave_v3" => Ok(Box::new(AaveV3Adapter::new())),
        "gmx_v2" => Ok(Box::new(GmxV2Adapter::new())),
        "morpho" => Ok(Box::new(MorphoAdapter::new())),
        "vertex" => Ok(Box::new(VertexAdapter::new())),
        "polymarket" => Ok(Box::new(PolymarketAdapter::new())),
        other => Err(TradingError::AdapterError {
            protocol: other.to_string(),
            message: "Unknown protocol".to_string(),
        }),
    }
}

/// Convert `rust_decimal::Decimal` to `U256`.
///
/// Treats the decimal value as a raw integer (truncates fractional part).
fn decimal_to_u256(d: &rust_decimal::Decimal) -> Result<U256, TradingError> {
    // Truncate to integer
    let int_str = d.trunc().to_string();
    // Handle negative values
    if int_str.starts_with('-') {
        return Err(TradingError::VaultError(
            "Cannot convert negative Decimal to U256".into(),
        ));
    }
    U256::from_str_radix(&int_str, 10)
        .map_err(|e| TradingError::VaultError(format!("Decimal→U256 conversion failed: {e}")))
}

/// Extract validator signatures (as raw bytes) and scores (as U256) from a
/// `ValidationResult`.
fn collect_validator_data(
    validation: &ValidationResult,
) -> Result<(Vec<Vec<u8>>, Vec<U256>), TradingError> {
    let mut signatures = Vec::new();
    let mut scores = Vec::new();

    for resp in &validation.validator_responses {
        // Decode hex signature (strip 0x prefix)
        let sig_hex = resp.signature.strip_prefix("0x").unwrap_or(&resp.signature);
        let sig_bytes = hex::decode(sig_hex).map_err(|e| {
            TradingError::ValidatorError(format!(
                "Invalid signature hex from {}: {e}",
                resp.validator
            ))
        })?;
        signatures.push(sig_bytes);
        scores.push(U256::from(resp.score));
    }

    Ok((signatures, scores))
}

/// Parse a hex-encoded intent hash string into a fixed 32-byte array.
fn parse_intent_hash(hash: &str) -> Result<[u8; 32], TradingError> {
    let stripped = hash.strip_prefix("0x").unwrap_or(hash);
    let bytes = hex::decode(stripped)
        .map_err(|e| TradingError::VaultError(format!("Invalid intent_hash hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(TradingError::VaultError(format!(
            "intent_hash must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;

    #[test]
    fn test_get_adapter_known() {
        assert!(get_adapter("uniswap_v3").is_ok());
        assert!(get_adapter("aave_v3").is_ok());
        assert!(get_adapter("gmx_v2").is_ok());
    }

    #[test]
    fn test_get_adapter_unknown() {
        assert!(get_adapter("does_not_exist").is_err());
    }

    #[test]
    fn test_decimal_to_u256() {
        let d = Decimal::new(1000, 0);
        let u = decimal_to_u256(&d).unwrap();
        assert_eq!(u, U256::from(1000u64));
    }

    #[test]
    fn test_decimal_to_u256_truncates_fraction() {
        let d = Decimal::new(12345, 2); // 123.45
        let u = decimal_to_u256(&d).unwrap();
        assert_eq!(u, U256::from(123u64));
    }

    #[test]
    fn test_decimal_to_u256_negative_fails() {
        let d = Decimal::new(-100, 0);
        assert!(decimal_to_u256(&d).is_err());
    }

    #[test]
    fn test_parse_intent_hash() {
        let hash = format!("0x{}", "ab".repeat(32));
        let result = parse_intent_hash(&hash).unwrap();
        assert_eq!(result, [0xab; 32]);
    }

    #[test]
    fn test_parse_intent_hash_wrong_length() {
        let hash = "0xabcd";
        assert!(parse_intent_hash(hash).is_err());
    }

    #[test]
    fn test_collect_validator_data() {
        use crate::types::{ValidationResult, ValidatorResponse};

        let validation = ValidationResult {
            approved: true,
            aggregate_score: 85,
            validator_responses: vec![
                ValidatorResponse {
                    validator: "0xValidator1".into(),
                    score: 85,
                    signature: format!("0x{}", "aa".repeat(65)),
                    reasoning: "ok".into(),
                    chain_id: None,
                    verifying_contract: None,
                    validated_at: None,
                },
                ValidatorResponse {
                    validator: "0xValidator2".into(),
                    score: 90,
                    signature: format!("0x{}", "bb".repeat(65)),
                    reasoning: "good".into(),
                    chain_id: None,
                    verifying_contract: None,
                    validated_at: None,
                },
            ],
            intent_hash: format!("0x{}", "cc".repeat(32)),
        };

        let (sigs, scores) = collect_validator_data(&validation).unwrap();
        assert_eq!(sigs.len(), 2);
        assert_eq!(scores.len(), 2);
        assert_eq!(sigs[0].len(), 65);
        assert_eq!(scores[0], U256::from(85u32));
        assert_eq!(scores[1], U256::from(90u32));
    }
}
