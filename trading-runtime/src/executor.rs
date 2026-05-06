//! Trade execution pipeline — wires adapters, vault encoding, and chain
//! submission into a single `execute_validated_trade` call.
//!
//! Includes pre-submission transaction simulation to detect malicious payloads
//! before they hit the chain.

use alloy::primitives::{Address, B256, U256, keccak256};
use alloy::providers::Provider;

use crate::adapters::{
    ActionParams, EncodedAction, ProtocolAdapter, aave_v3::AaveV3Adapter,
    aerodrome::AerodromeAdapter, gmx_v2::GmxV2Adapter, hyperliquid::HyperliquidAdapter,
    morpho::MorphoVaultAdapter, polymarket::PolymarketAdapter, twap::TwapAdapter,
    uniswap_v3::UniswapV3Adapter, vertex::VertexAdapter,
};
use crate::chain::ChainClient;
use crate::error::TradingError;
use crate::execution_hash::{format_b256, hash_execution_payload};
use crate::simulator::{
    SimulationRequest, TransactionSimulator,
    risk_analyzer::{TradeContext, analyze_simulation},
};
use crate::supported_assets::{SupportedAsset, TradeAssetRole, is_supported_trade_asset};
use crate::types::{TradeIntent, ValidationResult};
use crate::vault_client::{Approval as VaultApproval, EncodedTransaction, VaultClient};

const DEFAULT_EXECUTION_GAS_LIMIT: u64 = 3_000_000;
const LOCAL_ETHEREUM_FORK_CHAIN_IDS: &[u64] = &[31_338, 31_339];

fn gas_limit_from_env(var: &str, default: u64) -> u64 {
    std::env::var(var)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

/// Outcome of a successfully submitted transaction.
#[derive(Debug, Clone)]
pub struct TransactionOutcome {
    pub tx_hash: String,
    pub block_number: Option<u64>,
    pub gas_used: Option<u128>,
    pub output_token: Option<Address>,
    pub output_gained: Option<U256>,
}

/// Wires adapter encoding → simulation → vault execute encoding → chain transaction submission.
pub struct TradeExecutor {
    vault_client: VaultClient,
    chain_client: ChainClient,
    simulator: Option<Box<dyn TransactionSimulator>>,
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
        let vault_client =
            VaultClient::new(vault_address.to_string(), rpc_url.to_string(), chain_id);
        let chain_client = ChainClient::new(rpc_url, private_key, chain_id)?;
        let sim_config = crate::simulator::SimulatorConfig::from_env();
        let simulator = crate::simulator::create_simulator(rpc_url.to_string(), &sim_config);
        Ok(Self {
            vault_client,
            chain_client,
            simulator: Some(simulator),
        })
    }

    /// Create an executor without transaction simulation.
    pub fn new_without_simulation(
        vault_address: &str,
        rpc_url: &str,
        private_key: &str,
        chain_id: u64,
    ) -> Result<Self, TradingError> {
        let vault_client =
            VaultClient::new(vault_address.to_string(), rpc_url.to_string(), chain_id);
        let chain_client = ChainClient::new(rpc_url, private_key, chain_id)?;
        Ok(Self {
            vault_client,
            chain_client,
            simulator: None,
        })
    }

    /// Create an executor using a shared `ChainClient`.
    ///
    /// Use this in multi-bot mode to share a single provider across requests.
    /// Alloy's `NonceFiller` manages nonces per-provider, so a shared provider
    /// serializes nonce allocation and prevents duplicates from concurrent requests.
    pub fn with_shared_chain_client(
        vault_address: &str,
        rpc_url: &str,
        chain_id: u64,
        chain_client: ChainClient,
    ) -> Self {
        let vault_client =
            VaultClient::new(vault_address.to_string(), rpc_url.to_string(), chain_id);
        let sim_config = crate::simulator::SimulatorConfig::from_env();
        let simulator = crate::simulator::create_simulator(rpc_url.to_string(), &sim_config);
        Self {
            vault_client,
            chain_client,
            simulator: Some(simulator),
        }
    }

    /// Get a reference to the underlying chain client.
    pub fn chain_client(&self) -> &ChainClient {
        &self.chain_client
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
        self.execute_validated_trade_with_supported_assets(intent, validation, None)
            .await
    }

    /// Execute a validated trade with a caller-provided asset universe.
    ///
    /// Multi-bot HTTP execution uses this to enforce each bot's configured
    /// assets instead of falling back to the legacy global WETH/USDC list.
    pub async fn execute_validated_trade_with_supported_assets(
        &self,
        intent: &TradeIntent,
        validation: &ValidationResult,
        supported_assets: Option<&[SupportedAsset]>,
    ) -> Result<TransactionOutcome, TradingError> {
        // 1. Get the right adapter
        let adapter = get_adapter(&intent.target_protocol, Some(self.vault_client.chain_id))?;

        // 2. Build ActionParams from the intent
        let token_in: Address =
            intent
                .token_in
                .parse()
                .map_err(|e| TradingError::AdapterError {
                    protocol: intent.target_protocol.clone(),
                    message: format!("Invalid token_in address: {e}"),
                })?;

        let token_out: Address =
            intent
                .token_out
                .parse()
                .map_err(|e| TradingError::AdapterError {
                    protocol: intent.target_protocol.clone(),
                    message: format!("Invalid token_out address: {e}"),
                })?;

        validate_supported_execution_tokens(intent, supported_assets)?;

        // Convert Decimal amounts to U256 (treating as raw token units)
        let amount = decimal_to_u256(&intent.amount_in)?;
        let min_output = decimal_to_u256(&intent.min_amount_out)?;

        // Resolve vault address from the vault client
        let vault_address: Address = self
            .vault_client
            .vault_address
            .parse()
            .map_err(|e| TradingError::VaultError(format!("Invalid vault address: {e}")))?;

        let params = ActionParams {
            action: intent.action.clone(),
            token_in,
            token_out,
            amount,
            min_output,
            extra: metadata_with_execution_deadline(
                &intent.metadata,
                intent.deadline.timestamp().max(0) as u64,
            ),
            vault_address,
        };

        // 3. Encode the action
        let encoded: EncodedAction = adapter.encode_action(&params)?;
        let simulation_tokens = {
            let mut tokens = vec![token_in, token_out, encoded.output_token];
            if let Some(debt_reduction) = &encoded.debt_reduction {
                tokens.push(debt_reduction.input_token);
                tokens.push(debt_reduction.debt_token);
            }
            tokens.sort();
            tokens.dedup();
            tokens
        };

        // 4. Collect validator signatures and scores before simulation so the
        // simulated payload matches the final submitted transaction.
        let (signatures, scores) = collect_validator_data(validation)?;

        // 5. Parse intent_hash → [u8; 32]
        let intent_hash = parse_intent_hash(&validation.intent_hash)?;

        let intent_hash_b256 = B256::from(intent_hash);

        // 6. Compute deadline as U256
        let deadline = U256::from(intent.deadline.timestamp().max(0) as u64);

        let expected_execution_hash = hash_execution_payload(
            &encoded,
            intent_hash_b256,
            deadline,
            self.vault_client.chain_id,
        );
        let expected_execution_hash_hex = format_b256(expected_execution_hash);
        if !validation
            .execution_hash
            .eq_ignore_ascii_case(&expected_execution_hash_hex)
        {
            return Err(TradingError::ValidatorError(format!(
                "execution_hash mismatch: validation {}, expected {}",
                validation.execution_hash, expected_execution_hash_hex
            )));
        }

        // 7. Encode the final vault transaction, with approvals folded into the
        // same on-chain call when the adapter requires them.
        let tx = build_execution_tx(
            &self.vault_client,
            &encoded,
            intent_hash,
            signatures,
            scores,
            deadline,
        )?;
        let tx_value = parse_tx_value(&tx.value);

        // 8. Simulate the final transaction before execution.
        if let Some(ref simulator) = self.simulator {
            let sim_request = SimulationRequest {
                from: self.chain_client.from_address,
                to: vault_address,
                data: alloy::primitives::Bytes::from(tx.data.clone()),
                value: tx_value,
                block_number: None,
                token_addresses: simulation_tokens,
                balance_check_account: Some(vault_address),
            };

            match simulator.simulate(sim_request).await {
                Ok(sim_result) => {
                    let mut known_protocol_addresses = adapter.known_addresses();
                    if intent.target_protocol == "morpho_vault" {
                        known_protocol_addresses.push(encoded.target);
                    }

                    let risk = analyze_simulation(
                        &sim_result,
                        &TradeContext {
                            vault_address,
                            token_in,
                            token_out: encoded.output_token,
                            amount_in: params.amount,
                            min_output: encoded.min_output,
                            known_protocol_addresses,
                        },
                    );

                    if !risk.safe {
                        tracing::error!(
                            risk_score = risk.risk_score,
                            warnings = ?risk.warnings,
                            "Transaction simulation detected suspicious behavior — rejecting trade"
                        );
                        return Err(TradingError::SimulationRejected {
                            risk_score: risk.risk_score,
                            warnings: risk.warnings.iter().map(|w| w.to_string()).collect(),
                        });
                    }

                    tracing::info!(
                        risk_score = risk.risk_score,
                        gas_used = sim_result.gas_used,
                        "Simulation passed — proceeding with execution"
                    );
                }
                Err(e) => {
                    tracing::error!("Transaction simulation failed — rejecting trade: {e}");
                    return Err(TradingError::SimulationUnavailable(format!(
                        "final transaction simulation failed: {e}"
                    )));
                }
            }
        }

        // 9. Submit via ChainClient
        let to_addr: Address = tx
            .to
            .parse()
            .map_err(|e| TradingError::VaultError(format!("Invalid vault address in tx: {e}")))?;

        let tx_request = alloy::rpc::types::TransactionRequest::default()
            .to(to_addr)
            .input(alloy::primitives::Bytes::from(tx.data).into())
            .value(tx_value)
            .gas_limit(gas_limit_from_env(
                "TRADING_EXECUTION_GAS_LIMIT",
                DEFAULT_EXECUTION_GAS_LIMIT,
            ));

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

        let (output_token, output_gained) =
            parse_trade_executed_event(&receipt).unwrap_or((None, None));

        Ok(TransactionOutcome {
            tx_hash,
            block_number: Some(receipt.block_number.unwrap_or(0)),
            gas_used: Some(receipt.gas_used.into()),
            output_token,
            output_gained,
        })
    }
}

fn validate_supported_execution_tokens(
    intent: &TradeIntent,
    supported_assets: Option<&[SupportedAsset]>,
) -> Result<(), TradingError> {
    let Some(strategy_type) = strategy_type_for_protocol(&intent.target_protocol) else {
        return Ok(());
    };
    for (token, role) in [
        (&intent.token_in, TradeAssetRole::Input),
        (&intent.token_out, TradeAssetRole::Output),
    ] {
        if !execution_token_is_supported(intent, strategy_type, token, role, supported_assets) {
            return Err(TradingError::AdapterError {
                protocol: intent.target_protocol.clone(),
                message: format!(
                    "Token {token} is not supported for {} bots on chain {}",
                    strategy_type.to_ascii_uppercase(),
                    intent.chain_id
                ),
            });
        }
    }
    Ok(())
}

fn execution_token_is_supported(
    intent: &TradeIntent,
    strategy_type: &str,
    token: &str,
    role: TradeAssetRole,
    supported_assets: Option<&[SupportedAsset]>,
) -> bool {
    if let Some(assets) = supported_assets {
        let key = token.trim().to_ascii_lowercase();
        return assets.iter().any(|asset| {
            asset.strategy_type == strategy_type
                && asset.protocol == intent.target_protocol
                && asset.chain_id == intent.chain_id
                && asset.roles.contains(&role)
                && (asset.address.trim().eq_ignore_ascii_case(token)
                    || asset.symbol.trim().to_ascii_lowercase() == key)
        });
    }

    is_supported_trade_asset(
        strategy_type,
        intent.chain_id,
        &intent.target_protocol,
        token,
        role,
    )
    .is_some()
}

fn strategy_type_for_protocol(protocol: &str) -> Option<&'static str> {
    match protocol {
        "uniswap_v3" | "aerodrome" => Some("dex"),
        "aave_v3" => Some("yield"),
        "polymarket_clob" => Some("prediction"),
        "hyperliquid" => Some("perp"),
        _ => None,
    }
}

fn parse_trade_executed_event(
    receipt: &alloy::rpc::types::TransactionReceipt,
) -> Option<(Option<Address>, Option<U256>)> {
    let trade_signature =
        keccak256("TradeExecuted(address,uint256,uint256,address,bytes32)".as_bytes());
    let debt_signature = keccak256(
        "DebtReductionExecuted(address,uint256,address,uint256,address,bytes32)".as_bytes(),
    );
    for log in receipt.inner.logs() {
        let topics = log.topics();
        match topics.first().copied() {
            Some(signature) if signature == trade_signature => {
                let data = log.data().data.as_ref();
                if data.len() < 96 {
                    return None;
                }
                let output_gained = U256::from_be_slice(&data[32..64]);
                let output_token = Address::from_word(B256::from_slice(&data[64..96]));
                return Some((Some(output_token), Some(output_gained)));
            }
            Some(signature) if signature == debt_signature => {
                let data = log.data().data.as_ref();
                if data.len() < 64 || topics.len() < 4 {
                    return None;
                }
                let debt_decreased = U256::from_be_slice(&data[32..64]);
                let debt_token = Address::from_word(topics[3]);
                return Some((Some(debt_token), Some(debt_decreased)));
            }
            _ => continue,
        }
    }
    None
}

fn build_execution_tx(
    vault_client: &VaultClient,
    encoded: &EncodedAction,
    intent_hash: [u8; 32],
    signatures: Vec<Vec<u8>>,
    scores: Vec<U256>,
    deadline: U256,
) -> Result<EncodedTransaction, TradingError> {
    let approvals = encoded
        .approvals
        .iter()
        .map(|approval| VaultApproval {
            token: format!("{}", approval.token),
            spender: format!("{}", approval.spender),
            amount: approval.amount.to_string(),
        })
        .collect::<Vec<_>>();

    if let Some(debt_reduction) = &encoded.debt_reduction {
        return vault_client.encode_execute_debt_reduction_with_approvals(
            &format!("{}", encoded.target),
            &encoded.calldata,
            &encoded.value.to_string(),
            &format!("{}", debt_reduction.input_token),
            &debt_reduction.max_input.to_string(),
            &format!("{}", debt_reduction.debt_token),
            &debt_reduction.min_debt_decrease.to_string(),
            intent_hash,
            &approvals,
            signatures,
            scores,
            deadline,
        );
    }

    if let Some(health_factor) = &encoded.health_factor {
        return vault_client.encode_execute_health_factor_with_approvals(
            &format!("{}", encoded.target),
            &encoded.calldata,
            &encoded.value.to_string(),
            &encoded.min_output.to_string(),
            &format!("{}", encoded.output_token),
            &format!("{}", health_factor.pool),
            &format!("{}", health_factor.account),
            &health_factor.min_health_factor.to_string(),
            intent_hash,
            &approvals,
            signatures,
            scores,
            deadline,
        );
    }

    if encoded.approvals.is_empty() {
        vault_client.encode_execute(
            &format!("{}", encoded.target),
            &encoded.calldata,
            &encoded.value.to_string(),
            &encoded.min_output.to_string(),
            &format!("{}", encoded.output_token),
            intent_hash,
            signatures,
            scores,
            deadline,
        )
    } else {
        vault_client.encode_execute_with_approvals(
            &format!("{}", encoded.target),
            &encoded.calldata,
            &encoded.value.to_string(),
            &encoded.min_output.to_string(),
            &format!("{}", encoded.output_token),
            intent_hash,
            &approvals,
            signatures,
            scores,
            deadline,
        )
    }
}

fn parse_tx_value(value: &str) -> U256 {
    U256::from_str_radix(value.trim_start_matches("0x"), 10).unwrap_or_default()
}

fn metadata_with_execution_deadline(
    metadata: &serde_json::Value,
    deadline: u64,
) -> serde_json::Value {
    let mut extra = metadata.clone();
    match extra {
        serde_json::Value::Object(ref mut map) => {
            map.entry("execution_deadline".to_string())
                .or_insert_with(|| serde_json::json!(deadline));
            extra
        }
        _ => serde_json::json!({ "execution_deadline": deadline }),
    }
}

fn canonicalize_adapter_chain_id(protocol: &str, chain_id: Option<u64>) -> Option<u64> {
    if protocol != "aave_v3" {
        return chain_id;
    }

    if let Some(protocol_chain_id) = configured_protocol_chain_id(chain_id) {
        return Some(protocol_chain_id);
    }

    match chain_id {
        // Keep the synthetic fork id for signing/execution, but resolve Aave
        // protocol addresses against canonical Ethereum deployments.
        Some(local_id) if LOCAL_ETHEREUM_FORK_CHAIN_IDS.contains(&local_id) => Some(1),
        _ => chain_id,
    }
}

fn configured_protocol_chain_id(chain_id: Option<u64>) -> Option<u64> {
    let execution_chain_id = chain_id?;
    let protocol_chain_id = ["PROTOCOL_CHAIN_ID", "FORK_BASE_CHAIN_ID"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)?;

    if protocol_chain_id != execution_chain_id
        && LOCAL_ETHEREUM_FORK_CHAIN_IDS.contains(&execution_chain_id)
    {
        Some(protocol_chain_id)
    } else {
        None
    }
}

/// Registry: map protocol name → adapter instance.
pub fn get_adapter(
    protocol: &str,
    chain_id: Option<u64>,
) -> Result<Box<dyn ProtocolAdapter + Send>, TradingError> {
    let chain_id = canonicalize_adapter_chain_id(protocol, chain_id);

    match protocol {
        "uniswap_v3" => Ok(Box::new(UniswapV3Adapter::new())),
        "aave_v3" => Ok(Box::new(AaveV3Adapter::for_chain(chain_id.unwrap_or(1))?)),
        "gmx_v2" => Ok(Box::new(GmxV2Adapter::new())),
        "morpho" => Err(TradingError::AdapterError {
            protocol: "morpho".into(),
            message:
                "Protocol 'morpho' is ambiguous and disabled for execution; use 'morpho_vault'"
                    .into(),
        }),
        "morpho_vault" => Ok(Box::new(MorphoVaultAdapter::new())),
        "vertex" => Ok(Box::new(VertexAdapter::new())),
        "hyperliquid" => Ok(Box::new(HyperliquidAdapter::new())),
        "aerodrome" => Ok(Box::new(AerodromeAdapter::new())),
        "polymarket" => Ok(Box::new(PolymarketAdapter::new())),
        "twap_uniswap_v3" => {
            let inner = Box::new(UniswapV3Adapter::new());
            // Default: 4 slices, 60s interval. Callers can override via metadata.
            let num_slices = 4;
            let interval_secs = 60;
            Ok(Box::new(TwapAdapter::new(inner, num_slices, interval_secs)))
        }
        "polymarket_clob" => Err(TradingError::AdapterError {
            protocol: "polymarket_clob".into(),
            message: "CLOB trades bypass the vault executor — route through execute_clob_trade()"
                .into(),
        }),
        other => Err(TradingError::AdapterError {
            protocol: other.to_string(),
            message: "Unknown protocol".to_string(),
        }),
    }
}

/// Convert `rust_decimal::Decimal` to `U256`.
///
/// Treats the decimal value as a raw integer (truncates fractional part).
/// Logs a warning if non-zero fractional digits are dropped.
fn decimal_to_u256(d: &rust_decimal::Decimal) -> Result<U256, TradingError> {
    let truncated = d.trunc();
    if *d != truncated {
        tracing::warn!(
            original = %d,
            truncated = %truncated,
            "Decimal→U256 truncated fractional part"
        );
    }
    let int_str = truncated.to_string();
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
    use crate::contracts::ITradingVault;
    use crate::intent::{TradeIntentBuilder, hash_intent};
    use crate::simulator::SimulationResult;
    use crate::types::{Action, ValidationResult, ValidatorResponse};
    use alloy::primitives::{Address, Bytes};
    use alloy::sol_types::SolCall;
    use rust_decimal::Decimal;

    struct FailingSimulator;

    #[async_trait::async_trait]
    impl TransactionSimulator for FailingSimulator {
        async fn simulate(
            &self,
            _request: SimulationRequest,
        ) -> Result<SimulationResult, TradingError> {
            Err(TradingError::SimulationUnavailable(
                "test simulator unavailable".into(),
            ))
        }
    }

    #[test]
    fn test_get_adapter_known() {
        assert!(get_adapter("uniswap_v3", None).is_ok());
        assert!(get_adapter("aave_v3", Some(1)).is_ok());
        assert!(get_adapter("aave_v3", Some(31339)).is_ok());
        assert!(get_adapter("aave_v3", Some(42161)).is_ok());
        assert!(get_adapter("gmx_v2", None).is_ok());
        assert!(get_adapter("twap_uniswap_v3", None).is_ok());
    }

    #[test]
    fn test_canonicalize_adapter_chain_id_maps_local_ethereum_fork_for_aave() {
        assert_eq!(
            canonicalize_adapter_chain_id("aave_v3", Some(31339)),
            Some(1)
        );
        assert_eq!(
            canonicalize_adapter_chain_id("aave_v3", Some(31338)),
            Some(1)
        );
        assert_eq!(
            canonicalize_adapter_chain_id("aave_v3", Some(42161)),
            Some(42161)
        );
        assert_eq!(
            canonicalize_adapter_chain_id("uniswap_v3", Some(31339)),
            Some(31339)
        );
    }

    #[test]
    fn test_get_adapter_clob_rejected() {
        let err = get_adapter("polymarket_clob", None)
            .err()
            .expect("should error");
        assert!(err.to_string().contains("bypass"), "{err}");
    }

    #[test]
    fn test_get_adapter_unknown() {
        assert!(get_adapter("does_not_exist", None).is_err());
    }

    #[test]
    fn test_get_adapter_rejects_unsupported_aave_chain() {
        let err = get_adapter("aave_v3", Some(31337))
            .err()
            .expect("should reject unsupported chain");
        assert!(err.to_string().contains("Unsupported chain_id"), "{err}");
    }

    #[test]
    fn test_get_adapter_uses_ethereum_pool_for_local_aave_fork() {
        let adapter = get_adapter("aave_v3", Some(31339)).expect("local fork should resolve");

        assert_eq!(
            adapter.known_addresses()[0],
            "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
                .parse::<Address>()
                .unwrap()
        );
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
            execution_hash: format!("0x{}", "dd".repeat(32)),
        };

        let (sigs, scores) = collect_validator_data(&validation).unwrap();
        assert_eq!(sigs.len(), 2);
        assert_eq!(scores.len(), 2);
        assert_eq!(sigs[0].len(), 65);
        assert_eq!(scores[0], U256::from(85u32));
        assert_eq!(scores[1], U256::from(90u32));
    }

    #[tokio::test]
    async fn test_execute_rejects_final_simulation_error() {
        let vault_address = "0x0000000000000000000000000000000000000001";
        let rpc_url = "http://127.0.0.1:8545";
        let private_key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let chain_id = 1;

        let vault_client = VaultClient::new(vault_address.into(), rpc_url.into(), chain_id);
        let chain_client = ChainClient::new(rpc_url, private_key, chain_id).unwrap();
        let executor = TradeExecutor {
            vault_client,
            chain_client,
            simulator: Some(Box::new(FailingSimulator)),
        };

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
            .token_out("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
            .amount_in(Decimal::new(1_000_000_000_000_000_000, 0))
            .min_amount_out(Decimal::new(2_500_000_000, 0))
            .target_protocol("uniswap_v3")
            .chain_id(chain_id)
            .build()
            .unwrap();

        let adapter = get_adapter(&intent.target_protocol, Some(chain_id)).unwrap();
        let vault_address: Address = vault_address.parse().unwrap();
        let encoded = adapter
            .encode_action(&ActionParams {
                action: intent.action.clone(),
                token_in: intent.token_in.parse().unwrap(),
                token_out: intent.token_out.parse().unwrap(),
                amount: decimal_to_u256(&intent.amount_in).unwrap(),
                min_output: decimal_to_u256(&intent.min_amount_out).unwrap(),
                extra: metadata_with_execution_deadline(
                    &intent.metadata,
                    intent.deadline.timestamp().max(0) as u64,
                ),
                vault_address,
            })
            .unwrap();
        let intent_hash = hash_intent(&intent);
        let intent_hash_b256 = B256::from(parse_intent_hash(&intent_hash).unwrap());
        let deadline = U256::from(intent.deadline.timestamp().max(0) as u64);
        let execution_hash = format_b256(hash_execution_payload(
            &encoded,
            intent_hash_b256,
            deadline,
            chain_id,
        ));

        let validation = ValidationResult {
            approved: true,
            aggregate_score: 85,
            validator_responses: vec![ValidatorResponse {
                validator: "0xValidator1".into(),
                score: 85,
                signature: format!("0x{}", "aa".repeat(65)),
                reasoning: "ok".into(),
                chain_id: None,
                verifying_contract: None,
                validated_at: None,
            }],
            intent_hash,
            execution_hash,
        };

        let err = executor
            .execute_validated_trade(&intent, &validation)
            .await
            .unwrap_err();
        assert!(matches!(err, TradingError::SimulationUnavailable(_)));
    }

    #[test]
    fn test_build_execution_tx_without_approvals_uses_execute() {
        let vault_client = VaultClient::new(
            "0x0000000000000000000000000000000000000001".into(),
            "http://localhost:8545".into(),
            42161,
        );
        let encoded = EncodedAction {
            target: "0x0000000000000000000000000000000000000002"
                .parse::<Address>()
                .unwrap(),
            calldata: Bytes::from(vec![1, 2, 3]),
            value: U256::ZERO,
            min_output: U256::from(10u64),
            output_token: "0x0000000000000000000000000000000000000003"
                .parse::<Address>()
                .unwrap(),
            approvals: vec![],
            debt_reduction: None,
            health_factor: None,
        };

        let tx = build_execution_tx(
            &vault_client,
            &encoded,
            [0x11; 32],
            vec![vec![0xaa; 65]],
            vec![U256::from(80u64)],
            U256::from(123u64),
        )
        .unwrap();

        assert_eq!(&tx.data[..4], &ITradingVault::executeCall::SELECTOR[..]);
    }

    #[test]
    fn test_build_execution_tx_with_approvals_uses_atomic_path() {
        let vault_client = VaultClient::new(
            "0x0000000000000000000000000000000000000001".into(),
            "http://localhost:8545".into(),
            42161,
        );
        let encoded = EncodedAction {
            target: "0x0000000000000000000000000000000000000002"
                .parse::<Address>()
                .unwrap(),
            calldata: Bytes::from(vec![1, 2, 3]),
            value: U256::ZERO,
            min_output: U256::from(10u64),
            output_token: "0x0000000000000000000000000000000000000003"
                .parse::<Address>()
                .unwrap(),
            approvals: vec![crate::adapters::Approval {
                token: "0x0000000000000000000000000000000000000004"
                    .parse::<Address>()
                    .unwrap(),
                spender: "0x0000000000000000000000000000000000000005"
                    .parse::<Address>()
                    .unwrap(),
                amount: U256::from(42u64),
            }],
            debt_reduction: None,
            health_factor: None,
        };

        let tx = build_execution_tx(
            &vault_client,
            &encoded,
            [0x11; 32],
            vec![vec![0xaa; 65]],
            vec![U256::from(80u64)],
            U256::from(123u64),
        )
        .unwrap();

        assert_eq!(
            &tx.data[..4],
            &ITradingVault::executeWithApprovalsCall::SELECTOR[..]
        );
    }

    #[test]
    fn test_build_execution_tx_with_debt_reduction_uses_debt_path() {
        let vault_client = VaultClient::new(
            "0x0000000000000000000000000000000000000001".into(),
            "http://localhost:8545".into(),
            42161,
        );
        let encoded = EncodedAction {
            target: "0x0000000000000000000000000000000000000002"
                .parse::<Address>()
                .unwrap(),
            calldata: Bytes::from(vec![1, 2, 3]),
            value: U256::ZERO,
            min_output: U256::ZERO,
            output_token: "0x0000000000000000000000000000000000000003"
                .parse::<Address>()
                .unwrap(),
            approvals: vec![crate::adapters::Approval {
                token: "0x0000000000000000000000000000000000000004"
                    .parse::<Address>()
                    .unwrap(),
                spender: "0x0000000000000000000000000000000000000002"
                    .parse::<Address>()
                    .unwrap(),
                amount: U256::from(42u64),
            }],
            debt_reduction: Some(crate::adapters::DebtReductionPostcondition {
                input_token: "0x0000000000000000000000000000000000000004"
                    .parse::<Address>()
                    .unwrap(),
                max_input: U256::from(42u64),
                debt_token: "0x0000000000000000000000000000000000000005"
                    .parse::<Address>()
                    .unwrap(),
                min_debt_decrease: U256::from(40u64),
            }),
            health_factor: None,
        };

        let tx = build_execution_tx(
            &vault_client,
            &encoded,
            [0x11; 32],
            vec![vec![0xaa; 65]],
            vec![U256::from(80u64)],
            U256::from(123u64),
        )
        .unwrap();

        assert_eq!(
            &tx.data[..4],
            &ITradingVault::executeDebtReductionWithApprovalsCall::SELECTOR[..]
        );
    }

    #[test]
    fn test_build_execution_tx_with_health_factor_uses_health_path() {
        let vault_client = VaultClient::new(
            "0x0000000000000000000000000000000000000001".into(),
            "http://localhost:8545".into(),
            42161,
        );
        let encoded = EncodedAction {
            target: "0x0000000000000000000000000000000000000002"
                .parse::<Address>()
                .unwrap(),
            calldata: Bytes::from(vec![1, 2, 3]),
            value: U256::ZERO,
            min_output: U256::from(10u64),
            output_token: "0x0000000000000000000000000000000000000003"
                .parse::<Address>()
                .unwrap(),
            approvals: vec![],
            debt_reduction: None,
            health_factor: Some(crate::adapters::HealthFactorPostcondition {
                pool: "0x0000000000000000000000000000000000000002"
                    .parse::<Address>()
                    .unwrap(),
                account: "0x0000000000000000000000000000000000000001"
                    .parse::<Address>()
                    .unwrap(),
                min_health_factor: U256::from(1_500_000_000_000_000_000u128),
            }),
        };

        let tx = build_execution_tx(
            &vault_client,
            &encoded,
            [0x11; 32],
            vec![vec![0xaa; 65]],
            vec![U256::from(80u64)],
            U256::from(123u64),
        )
        .unwrap();

        assert_eq!(
            &tx.data[..4],
            &ITradingVault::executeHealthFactorWithApprovalsCall::SELECTOR[..]
        );
    }

    #[test]
    fn test_parse_tx_value_decimal_string() {
        assert_eq!(parse_tx_value("42"), U256::from(42u64));
    }
}
