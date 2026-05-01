use alloy::primitives::{Address, B256, Bytes, U256};
use axum::Json;
use axum::extract::State;
use axum::routing::post;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::risk_evaluator::AiProvider;
use crate::scoring;
use crate::signer::ValidatorSigner;
use trading_runtime::execution_hash::{format_b256, hash_approvals, hash_execution_payload_parts};
use trading_runtime::intent::hash_intent;

#[derive(Debug, Clone)]
pub struct ValidatorServer {
    pub port: u16,
    pub ai_provider: Option<AiProvider>,
    pub signer: Option<Arc<ValidatorSigner>>,
    /// JSON-RPC URL for independent transaction simulation.
    /// When set, the validator runs its own `eth_call` simulation
    /// to verify calldata independently (even if the HTTP API already
    /// provided simulation results).
    pub rpc_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ValidateRequest {
    pub intent: trading_runtime::TradeIntent,
    /// Hex-encoded keccak256 hash of the intent (with 0x prefix)
    pub intent_hash: String,
    /// Hex-encoded canonical hash of the exact executable payload (with 0x prefix)
    pub execution_hash: String,
    /// Hex-encoded vault address (with 0x prefix)
    pub vault_address: String,
    /// Unix timestamp deadline for the validation signature
    pub deadline: u64,
    /// Optional strategy type for protocol-aware scoring context.
    /// When set, the AI evaluator gets strategy-specific context (e.g.
    /// valid protocols, expected metadata fields).
    #[serde(default)]
    pub strategy_type: Option<String>,
    /// Require a successful simulation before producing a positive approval.
    #[serde(default)]
    pub require_simulation: bool,
    /// Optional execution context (target, calldata, simulation results).
    /// Provided by the HTTP API after adapter encoding + simulation.
    #[serde(default)]
    pub execution_context: Option<ExecutionContext>,
}

/// Execution details for a trade — the actual target and calldata that
/// will be submitted on-chain. Enables validators to verify that the
/// calldata matches the stated intent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionContext {
    /// Chain ID the execution payload is bound to
    #[serde(default)]
    pub chain_id: u64,
    /// Hex-encoded target contract address
    pub target: String,
    /// Hex-encoded calldata
    pub calldata: String,
    /// Human-readable decoded calldata (e.g. "exactInputSingle(tokenIn=0x..., ...)")
    pub calldata_decoded: String,
    /// ETH value sent with the call
    pub value: String,
    /// Minimum output bound encoded in the executable payload
    #[serde(default)]
    pub min_output: String,
    /// Output token bound in the executable payload
    #[serde(default)]
    pub output_token: String,
    /// Approval calls folded into the final execution
    #[serde(default)]
    pub approvals: Vec<ExecutionApproval>,
    /// Pre-computed simulation results from the HTTP API
    #[serde(default)]
    pub simulation_result: Option<SimulationSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionApproval {
    pub token: String,
    pub spender: String,
    pub amount: String,
}

/// Summary of a simulation result, serializable for transmission to validators.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationSummary {
    pub success: bool,
    pub gas_used: u64,
    /// Simulated output amount (decimal string)
    pub output_amount: String,
    pub balance_changes: Vec<BalanceChangeSummary>,
    pub warnings: Vec<String>,
    pub risk_score: u32,
}

/// Simplified balance change for serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceChangeSummary {
    pub token: String,
    pub account: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateResponse {
    pub score: u32,
    /// Hex-encoded 65-byte EIP-712 signature (with 0x prefix)
    pub signature: String,
    pub reasoning: String,
    /// Hex-encoded validator address (with 0x prefix)
    pub validator: String,
    /// Chain ID from the EIP-712 domain (if signer configured)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<u64>,
    /// TradeValidator contract address from the EIP-712 domain (if signer configured)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verifying_contract: Option<String>,
    /// ISO 8601 timestamp of when this validation was produced
    pub validated_at: String,
}

impl ValidatorServer {
    /// Create a new ValidatorServer, reading AI config from environment.
    ///
    /// Env vars:
    /// - `AI_PROVIDER`: `"anthropic"` or `"zai-coding-plan"` (default: `"zai-coding-plan"`)
    /// - `AI_API_KEY`: API key for the chosen provider
    /// - `AI_MODEL`: Model name (default: `"glm-4.7"`)
    /// - `AI_API_ENDPOINT`: Base URL for Z.ai PaaS API (default: `"https://api.z.ai/api/coding/paas/v4"`)
    pub fn new(port: u16) -> Self {
        let ai_provider = std::env::var("AI_API_KEY").ok().map(|api_key| {
            let model = std::env::var("AI_MODEL").unwrap_or_else(|_| "glm-4.7".into());
            let provider_type =
                std::env::var("AI_PROVIDER").unwrap_or_else(|_| "zai-coding-plan".into());

            match provider_type.as_str() {
                "anthropic" => AiProvider::Anthropic { api_key, model },
                _ => {
                    let endpoint = std::env::var("AI_API_ENDPOINT")
                        .unwrap_or_else(|_| "https://api.z.ai/api/coding/paas/v4".into());
                    AiProvider::Zai {
                        api_key,
                        model,
                        endpoint,
                    }
                }
            }
        });

        let rpc_url = std::env::var("VALIDATOR_RPC_URL").ok();

        Self {
            port,
            ai_provider,
            signer: None,
            rpc_url,
        }
    }

    /// Set an AI provider explicitly (useful for tests).
    pub fn with_ai_provider(mut self, provider: AiProvider) -> Self {
        self.ai_provider = Some(provider);
        self
    }

    /// Disable AI scoring (policy-only). Useful for tests that need fast,
    /// deterministic scoring without AI latency.
    pub fn without_ai(mut self) -> Self {
        self.ai_provider = None;
        self
    }

    /// Set an RPC URL for independent transaction simulation.
    pub fn with_rpc_url(mut self, rpc_url: String) -> Self {
        self.rpc_url = Some(rpc_url);
        self
    }

    /// Create a ValidatorServer with an EIP-712 signer.
    ///
    /// `private_key`: Hex-encoded private key (64 hex chars, optionally 0x-prefixed)
    /// `chain_id`: The chain ID for the EIP-712 domain
    /// `verifying_contract`: The TradeValidator contract address
    pub fn with_signer(
        mut self,
        private_key: &str,
        chain_id: u64,
        verifying_contract: Address,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let signer = ValidatorSigner::new(private_key, chain_id, verifying_contract)?;
        self.signer = Some(Arc::new(signer));
        Ok(self)
    }

    pub fn router(self) -> axum::Router {
        let state = Arc::new(self);
        axum::Router::new()
            .route("/validate", post(handle_validate))
            .route("/health", axum::routing::get(handle_health))
            .with_state(state)
    }
}

async fn handle_validate(
    State(server): State<Arc<ValidatorServer>>,
    Json(mut request): Json<ValidateRequest>,
) -> Json<ValidateResponse> {
    // Independent simulation: if we have an RPC URL and execution context
    // with target+calldata but no simulation result, run our own eth_call.
    if let (Some(rpc_url), Some(ctx)) =
        (server.rpc_url.as_ref(), request.execution_context.as_mut())
        && ctx.simulation_result.is_none()
        && let Some(sim) = run_independent_simulation(rpc_url, ctx).await
    {
        ctx.simulation_result = Some(sim);
    }

    // Look up strategy context for protocol-aware scoring
    let strategy_context = request
        .strategy_type
        .as_deref()
        .and_then(crate::risk_evaluator::strategy_context_for);

    // Run policy checks + AI scoring + simulation scoring
    let score_result = scoring::compute_score(
        &request.intent,
        server.ai_provider.as_ref(),
        strategy_context.as_deref(),
        request.execution_context.as_ref(),
        request.require_simulation,
    )
    .await;

    let (score, reasoning) = match score_result {
        Ok(result) => (result.score, result.reasoning),
        Err(e) => {
            tracing::warn!("Scoring failed: {e}");
            (50, format!("Scoring error: {e}"))
        }
    };

    let validated_at = chrono::Utc::now().to_rfc3339();

    // Extract EIP-712 domain metadata from the signer (if present)
    let (signer_chain_id, signer_contract) = server.signer.as_ref().map_or((None, None), |s| {
        (
            Some(s.chain_id()),
            Some(format!("{}", s.verifying_contract())),
        )
    });

    let validator_address = server.signer.as_ref().map_or_else(
        || "0x0000000000000000000000000000000000000000".to_string(),
        |signer| format!("0x{}", hex::encode(signer.address().as_slice())),
    );

    let canonical_intent = match intent_with_deadline(&request.intent, request.deadline) {
        Ok(intent) => intent,
        Err(e) => {
            tracing::warn!(error = %e, "Rejecting validation request with invalid deadline");
            return Json(ValidateResponse {
                score: 0,
                signature: format!("0x{}", "00".repeat(65)),
                reasoning: format!("{reasoning}; signature error: invalid deadline: {e}"),
                validator: validator_address,
                chain_id: signer_chain_id,
                verifying_contract: signer_contract,
                validated_at,
            });
        }
    };
    request.intent = canonical_intent;
    let expected_intent_hash = hash_intent(&request.intent);
    if !hashes_match(&request.intent_hash, &expected_intent_hash) {
        tracing::warn!(
            supplied = %request.intent_hash,
            expected = %expected_intent_hash,
            "Rejecting validation request with mismatched intent_hash"
        );
        return Json(ValidateResponse {
            score: 0,
            signature: format!("0x{}", "00".repeat(65)),
            reasoning: format!(
                "{reasoning}; signature error: intent_hash mismatch, expected {expected_intent_hash}"
            ),
            validator: validator_address,
            chain_id: signer_chain_id,
            verifying_contract: signer_contract,
            validated_at,
        });
    }

    let expected_execution_hash = match expected_execution_hash(
        &request,
        expected_intent_hash.as_str(),
    ) {
        Ok(hash) => hash,
        Err(e) => {
            tracing::warn!(error = %e, "Rejecting validation request with invalid execution context");
            return Json(ValidateResponse {
                score: 0,
                signature: format!("0x{}", "00".repeat(65)),
                reasoning: format!("{reasoning}; signature error: invalid execution context: {e}"),
                validator: validator_address,
                chain_id: signer_chain_id,
                verifying_contract: signer_contract,
                validated_at,
            });
        }
    };
    if !hashes_match(&request.execution_hash, &expected_execution_hash) {
        tracing::warn!(
            supplied = %request.execution_hash,
            expected = %expected_execution_hash,
            "Rejecting validation request with mismatched execution_hash"
        );
        return Json(ValidateResponse {
            score: 0,
            signature: format!("0x{}", "00".repeat(65)),
            reasoning: format!(
                "{reasoning}; signature error: execution_hash mismatch, expected {expected_execution_hash}"
            ),
            validator: validator_address,
            chain_id: signer_chain_id,
            verifying_contract: signer_contract,
            validated_at,
        });
    }

    // If we have a signer, produce a real EIP-712 signature
    if let Some(ref signer) = server.signer {
        // Parse intent_hash and execution_hash from hex strings
        let intent_hash = match parse_b256(&request.intent_hash) {
            Ok(h) => h,
            Err(e) => {
                tracing::error!("Invalid intent_hash: {e}");
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", "00".repeat(65)),
                    reasoning: format!("{reasoning}; signature error: invalid intent_hash"),
                    validator: format!("0x{}", hex::encode(signer.address().as_slice())),
                    chain_id: signer_chain_id,
                    verifying_contract: signer_contract,
                    validated_at,
                });
            }
        };

        let execution_hash = match parse_b256(&request.execution_hash) {
            Ok(h) => h,
            Err(e) => {
                tracing::error!("Invalid execution_hash: {e}");
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", "00".repeat(65)),
                    reasoning: format!("{reasoning}; signature error: invalid execution_hash"),
                    validator: format!("0x{}", hex::encode(signer.address().as_slice())),
                    chain_id: signer_chain_id,
                    verifying_contract: signer_contract,
                    validated_at,
                });
            }
        };

        // Parse vault address from hex string
        let vault = match request.vault_address.parse::<Address>() {
            Ok(a) => a,
            Err(e) => {
                tracing::error!("Invalid vault_address: {e}");
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", "00".repeat(65)),
                    reasoning: format!("{reasoning}; signature error: invalid vault_address"),
                    validator: format!("0x{}", hex::encode(signer.address().as_slice())),
                    chain_id: signer_chain_id,
                    verifying_contract: signer_contract,
                    validated_at,
                });
            }
        };

        // action_kind=0 (execute) — the validate endpoint only signs for trade executions.
        // Collateral releases use a separate signing flow.
        match signer.sign_validation(
            intent_hash,
            execution_hash,
            vault,
            score as u64,
            request.deadline,
            0,
        ) {
            Ok((sig_bytes, addr)) => {
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", hex::encode(sig_bytes)),
                    reasoning,
                    validator: format!("{addr}"),
                    chain_id: signer_chain_id,
                    verifying_contract: signer_contract,
                    validated_at,
                });
            }
            Err(e) => {
                tracing::error!("Signing failed: {e}");
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", "00".repeat(65)),
                    reasoning: format!("{reasoning}; signing error: {e}"),
                    validator: format!("{}", signer.address()),
                    chain_id: signer_chain_id,
                    verifying_contract: signer_contract,
                    validated_at,
                });
            }
        }
    }

    // No signer configured, return placeholder
    Json(ValidateResponse {
        score,
        signature: format!("0x{}", "00".repeat(65)),
        reasoning,
        validator: "0x0000000000000000000000000000000000000000".into(),
        chain_id: None,
        verifying_contract: None,
        validated_at,
    })
}

/// Parse a hex-encoded B256 value (with or without 0x prefix).
fn parse_b256(hex_str: &str) -> Result<B256, String> {
    let stripped = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    let bytes = hex::decode(stripped).map_err(|e| format!("hex decode error: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected 32 bytes, got {}", bytes.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(B256::from(arr))
}

fn hashes_match(supplied: &str, expected: &str) -> bool {
    supplied.eq_ignore_ascii_case(expected)
}

fn zero_hash() -> String {
    format!("0x{}", "00".repeat(32))
}

fn intent_with_deadline(
    intent: &trading_runtime::TradeIntent,
    deadline: u64,
) -> Result<trading_runtime::TradeIntent, String> {
    if deadline > i64::MAX as u64 {
        return Err(format!("deadline out of range: {deadline}"));
    }
    let mut intent = intent.clone();
    intent.deadline = chrono::DateTime::<chrono::Utc>::from_timestamp(deadline as i64, 0)
        .ok_or_else(|| format!("deadline out of range: {deadline}"))?;
    Ok(intent)
}

fn parse_u256_decimal(value: &str, field_name: &str) -> Result<U256, String> {
    U256::from_str_radix(value, 10).map_err(|e| format!("invalid {field_name}: {e}"))
}

fn expected_execution_hash(request: &ValidateRequest, intent_hash: &str) -> Result<String, String> {
    let Some(ctx) = request.execution_context.as_ref() else {
        return Ok(zero_hash());
    };

    let target: Address = ctx
        .target
        .parse()
        .map_err(|e| format!("invalid execution target: {e}"))?;
    let calldata = hex::decode(ctx.calldata.trim_start_matches("0x"))
        .map_err(|e| format!("invalid calldata hex: {e}"))?;
    let calldata = Bytes::from(calldata);
    let value = parse_u256_decimal(&ctx.value, "execution value")?;
    let min_output = parse_u256_decimal(&ctx.min_output, "min_output")?;
    let output_token: Address = ctx
        .output_token
        .parse()
        .map_err(|e| format!("invalid output_token: {e}"))?;
    let intent_hash = parse_b256(intent_hash)?;
    let deadline = U256::from(request.deadline);
    let chain_id = if ctx.chain_id == 0 {
        request.intent.chain_id
    } else {
        ctx.chain_id
    };

    let approvals = ctx
        .approvals
        .iter()
        .map(|approval| {
            Ok(trading_runtime::adapters::Approval {
                token: approval
                    .token
                    .parse()
                    .map_err(|e| format!("invalid approval token: {e}"))?,
                spender: approval
                    .spender
                    .parse()
                    .map_err(|e| format!("invalid approval spender: {e}"))?,
                amount: parse_u256_decimal(&approval.amount, "approval amount")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let hash = hash_execution_payload_parts(
        target,
        &calldata,
        value,
        min_output,
        output_token,
        intent_hash,
        deadline,
        chain_id,
        hash_approvals(&approvals),
    );

    Ok(format_b256(hash))
}

/// Run an independent eth_call simulation using the validator's own RPC connection.
///
/// Returns a `SimulationSummary` if successful, or `None` on failure.
/// Primary value: independent revert detection without trusting the HTTP API.
async fn run_independent_simulation(
    rpc_url: &str,
    ctx: &ExecutionContext,
) -> Option<SimulationSummary> {
    use trading_runtime::simulator::{SimulationRequest, SimulatorConfig, create_simulator};

    let target: Address = ctx.target.parse().ok()?;
    let calldata_hex = ctx.calldata.strip_prefix("0x").unwrap_or(&ctx.calldata);
    let calldata_bytes = hex::decode(calldata_hex).ok()?;

    let config = SimulatorConfig::default();
    let simulator = create_simulator(rpc_url.to_string(), &config);

    let sim_request = SimulationRequest {
        from: Address::ZERO,
        to: target,
        data: alloy::primitives::Bytes::from(calldata_bytes),
        value: alloy::primitives::U256::ZERO,
        block_number: None,
        token_addresses: Vec::new(),
        balance_check_account: None,
    };

    match simulator.simulate(sim_request).await {
        Ok(sim_result) => {
            let warnings: Vec<String> = sim_result.warnings.iter().map(|w| w.to_string()).collect();
            let risk_score = if sim_result.success { 0 } else { 80 };
            Some(SimulationSummary {
                success: sim_result.success,
                gas_used: sim_result.gas_used,
                output_amount: "0".into(),
                balance_changes: Vec::new(),
                warnings,
                risk_score,
            })
        }
        Err(e) => {
            tracing::warn!("Independent simulation failed: {e}");
            None
        }
    }
}

async fn handle_health() -> &'static str {
    "ok"
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_health_endpoint() {
        let server = ValidatorServer::new(9090);
        let app = server.router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_validate_with_signer() {
        use trading_runtime::Action;
        use trading_runtime::intent::TradeIntentBuilder;

        let contract_addr: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();

        let server = ValidatorServer::new(9090)
            .with_signer(
                "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                31337,
                contract_addr,
            )
            .unwrap();

        let app = server.router();

        let deadline = 9999999999u64;
        let mut intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(rust_decimal::Decimal::new(100, 0))
            .min_amount_out(rust_decimal::Decimal::new(95, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();
        intent.deadline =
            chrono::DateTime::<chrono::Utc>::from_timestamp(deadline as i64, 0).unwrap();

        let intent_hash = trading_runtime::intent::hash_intent(&intent);
        let execution_hash = zero_hash();
        let vault_address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": execution_hash,
            "vault_address": vault_address,
            "deadline": deadline,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/validate")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&req_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let resp: ValidateResponse = serde_json::from_slice(&body_bytes).unwrap();

        // Should have a real signature (not all zeros)
        assert!(resp.signature.starts_with("0x"));
        assert_eq!(resp.signature.len(), 2 + 65 * 2); // "0x" + 130 hex chars
        assert_ne!(resp.signature, format!("0x{}", "00".repeat(65)));

        // Validator address should match the signer
        assert_eq!(
            resp.validator.to_lowercase(),
            "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
        );

        // EIP-712 domain metadata should be present when signer is configured
        assert_eq!(resp.chain_id, Some(31337));
        assert_eq!(
            resp.verifying_contract.as_deref().map(|s| s.to_lowercase()),
            Some("0x5fbdb2315678afecb367f032d93f642f64180aa3".to_string())
        );
        assert!(!resp.validated_at.is_empty());
    }

    #[tokio::test]
    async fn test_validate_rejects_mismatched_intent_hash() {
        use trading_runtime::Action;
        use trading_runtime::intent::TradeIntentBuilder;

        let contract_addr: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();
        let server = ValidatorServer::new(9090)
            .with_signer(
                "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                31337,
                contract_addr,
            )
            .unwrap();
        let app = server.router();

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(rust_decimal::Decimal::new(100, 0))
            .min_amount_out(rust_decimal::Decimal::new(95, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": format!("0x{}", "ab".repeat(32)),
            "execution_hash": zero_hash(),
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": 9999999999u64,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/validate")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&req_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let resp: ValidateResponse = serde_json::from_slice(&body_bytes).unwrap();

        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, format!("0x{}", "00".repeat(65)));
        assert!(resp.reasoning.contains("intent_hash mismatch"));
    }

    #[tokio::test]
    async fn test_validate_without_signer() {
        use trading_runtime::Action;
        use trading_runtime::intent::TradeIntentBuilder;

        let server = ValidatorServer::new(9090);
        let app = server.router();

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(rust_decimal::Decimal::new(100, 0))
            .min_amount_out(rust_decimal::Decimal::new(95, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": format!("0x{}", "ab".repeat(32)),
            "execution_hash": format!("0x{}", "cd".repeat(32)),
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": 9999999999u64,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/validate")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&req_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let resp: ValidateResponse = serde_json::from_slice(&body_bytes).unwrap();

        // Without a signer, should return a zero signature
        assert_eq!(resp.signature, format!("0x{}", "00".repeat(65)));
        assert_eq!(resp.validator, "0x0000000000000000000000000000000000000000");

        // No EIP-712 domain metadata without a signer
        assert_eq!(resp.chain_id, None);
        assert_eq!(resp.verifying_contract, None);
        assert!(!resp.validated_at.is_empty());
    }

    fn make_test_intent_json() -> serde_json::Value {
        use trading_runtime::Action;
        use trading_runtime::intent::TradeIntentBuilder;

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(rust_decimal::Decimal::new(100, 0))
            .min_amount_out(rust_decimal::Decimal::new(95, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        serde_json::to_value(&intent).unwrap()
    }

    #[test]
    fn test_validate_request_with_strategy_type() {
        let json = serde_json::json!({
            "intent": make_test_intent_json(),
            "intent_hash": format!("0x{}", "ab".repeat(32)),
            "execution_hash": format!("0x{}", "cd".repeat(32)),
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": 9999999999u64,
            "strategy_type": "dex",
            "require_simulation": true
        });

        let req: ValidateRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.strategy_type.as_deref(), Some("dex"));
        assert!(req.require_simulation);
    }

    #[test]
    fn test_validate_request_without_strategy_type() {
        let json = serde_json::json!({
            "intent": make_test_intent_json(),
            "intent_hash": format!("0x{}", "ab".repeat(32)),
            "execution_hash": format!("0x{}", "cd".repeat(32)),
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": 9999999999u64
        });

        let req: ValidateRequest = serde_json::from_value(json).unwrap();
        assert!(
            req.strategy_type.is_none(),
            "strategy_type should default to None"
        );
        assert!(
            !req.require_simulation,
            "require_simulation should default to false"
        );
    }
}
