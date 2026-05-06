use alloy::primitives::{Address, B256, Bytes, U256};
use axum::Json;
use axum::extract::State;
use axum::routing::post;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::risk_evaluator::AiProvider;
use crate::scoring;
use crate::signer::ValidatorSigner;
use trading_runtime::execution_hash::{
    ACTION_KIND_CLOB_ORDER, ACTION_KIND_HYPERLIQUID_ORDER, ACTION_KIND_VAULT_EXECUTE, format_b256,
    hash_approvals, hash_clob_order, hash_debt_reduction_payload_parts,
    hash_execution_payload_parts, hash_health_factor_payload_parts, hash_hyperliquid_order,
};
use trading_runtime::hyperliquid::{AssetId, HlOrderType, PlaceOrderRequest};
use trading_runtime::intent::hash_intent;
use trading_runtime::polymarket_clob;
use trading_runtime::types::Action;
use trading_runtime::uniswap_envelope::{
    SignedUniswapEnvelope, UniswapEnvelope, UniswapEnvelopeSignature, approval_signers_hash,
};

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
    /// Action kind signed into the EIP-712 approval.
    #[serde(default)]
    pub action_kind: u64,
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
    /// Execution postcondition kind: output_increase, debt_decrease, or health_factor.
    #[serde(default)]
    pub postcondition_kind: String,
    /// Input token spent by a debt-reduction execution.
    #[serde(default)]
    pub input_token: String,
    /// Maximum input amount signed for a debt-reduction execution.
    #[serde(default)]
    pub max_input: String,
    /// Debt token whose balance must decrease.
    #[serde(default)]
    pub debt_token: String,
    /// Minimum debt-token balance decrease required.
    #[serde(default)]
    pub min_debt_decrease: String,
    /// Aave pool used for a health-factor postcondition.
    #[serde(default)]
    pub health_pool: String,
    /// Account whose health factor must remain above the signed minimum.
    #[serde(default)]
    pub health_account: String,
    /// Minimum health factor signed for a health-factor execution.
    #[serde(default)]
    pub min_health_factor: String,
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

#[derive(Debug, Deserialize)]
pub struct ValidateEnvelopeRequest {
    pub envelope: UniswapEnvelope,
    pub approval_signers: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateEnvelopeResponse {
    pub approved: bool,
    pub score: u32,
    pub signature: String,
    pub reasoning: String,
    pub validator: String,
    pub chain_id: Option<u64>,
    pub verifying_contract: Option<String>,
    pub validated_at: String,
    pub signed_envelope: Option<SignedUniswapEnvelope>,
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
            .route("/envelopes/validate", post(handle_validate_envelope))
            .route("/health", axum::routing::get(handle_health))
            .with_state(state)
    }
}

async fn handle_validate_envelope(
    State(server): State<Arc<ValidatorServer>>,
    Json(request): Json<ValidateEnvelopeRequest>,
) -> Json<ValidateEnvelopeResponse> {
    let validated_at = chrono::Utc::now().to_rfc3339();
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

    let mut reasoning = "Uniswap envelope policy accepted".to_string();
    let mut approved = true;
    if request.envelope.chain_id == 0
        || request.envelope.vault.trim().is_empty()
        || request.envelope.router.trim().is_empty()
        || request.envelope.token_in.trim().is_empty()
        || request.envelope.token_out.trim().is_empty()
        || request.envelope.valid_until <= chrono::Utc::now().timestamp().max(0) as u64
        || request.envelope.min_signatures == 0
        || request.approval_signers.len() < request.envelope.min_signatures as usize
        || request.envelope.action != "swap"
    {
        approved = false;
        reasoning = "Uniswap envelope rejected: invalid or expired envelope bounds".to_string();
    } else if request
        .envelope
        .max_single_amount_in
        .parse::<u128>()
        .unwrap_or(0)
        == 0
        || request
            .envelope
            .max_total_amount_in
            .parse::<u128>()
            .unwrap_or(0)
            == 0
        || request
            .envelope
            .min_output_per_input
            .parse::<u128>()
            .unwrap_or(0)
            == 0
    {
        approved = false;
        reasoning =
            "Uniswap envelope rejected: amount and rate limits must be positive".to_string();
    } else if let Ok(hash) = approval_signers_hash(&request.approval_signers) {
        let expected = format!("0x{}", hex::encode(hash.as_slice()));
        if !request
            .envelope
            .approval_signers_hash
            .eq_ignore_ascii_case(&expected)
        {
            approved = false;
            reasoning =
                "Uniswap envelope rejected: approval_signers_hash does not match approval_signers"
                    .to_string();
        }
    } else {
        approved = false;
        reasoning = "Uniswap envelope rejected: invalid approval signer address".to_string();
    }

    let score = if approved { 80 } else { 0 };
    if !approved {
        return Json(ValidateEnvelopeResponse {
            approved,
            score,
            signature: zero_signature(),
            reasoning,
            validator: validator_address,
            chain_id: signer_chain_id,
            verifying_contract: signer_contract,
            validated_at,
            signed_envelope: None,
        });
    }

    if let Some(ref signer) = server.signer {
        match signer.sign_uniswap_envelope(&request.envelope, score as u64) {
            Ok((sig_bytes, addr)) => {
                let sig = UniswapEnvelopeSignature {
                    signer: format!("{addr}"),
                    score,
                    signature: format!("0x{}", hex::encode(sig_bytes)),
                    chain_id: signer.chain_id(),
                    verifying_contract: format!("{}", signer.verifying_contract()),
                    validated_at: Some(validated_at.clone()),
                };
                let signed_envelope = SignedUniswapEnvelope {
                    envelope: request.envelope,
                    approval_signers: request.approval_signers,
                    signatures: vec![sig.clone()],
                };
                return Json(ValidateEnvelopeResponse {
                    approved: true,
                    score,
                    signature: sig.signature,
                    reasoning,
                    validator: sig.signer,
                    chain_id: signer_chain_id,
                    verifying_contract: signer_contract,
                    validated_at,
                    signed_envelope: Some(signed_envelope),
                });
            }
            Err(error) => {
                reasoning = format!("Uniswap envelope signing error: {error}");
            }
        }
    } else {
        reasoning = "Uniswap envelope accepted, but validator signer is not configured".to_string();
    }

    Json(ValidateEnvelopeResponse {
        approved: false,
        score: 0,
        signature: zero_signature(),
        reasoning,
        validator: validator_address,
        chain_id: signer_chain_id,
        verifying_contract: signer_contract,
        validated_at,
        signed_envelope: None,
    })
}

async fn handle_validate(
    State(server): State<Arc<ValidatorServer>>,
    Json(mut request): Json<ValidateRequest>,
) -> Json<ValidateResponse> {
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

    // Independent simulation: if the validator has its own RPC URL, always run
    // its own eth_call for executable context. A required simulation must fail
    // closed if the validator cannot independently simulate.
    let independent_simulation_rejection = if let (Some(rpc_url), Some(ctx)) =
        (server.rpc_url.as_ref(), request.execution_context.as_mut())
    {
        if should_run_independent_simulation(ctx) {
            match run_independent_simulation(rpc_url, ctx).await {
                Some(sim) => {
                    ctx.simulation_result = Some(sim);
                    None
                }
                None if request.require_simulation => {
                    Some("validator independent simulation failed".to_string())
                }
                None => None,
            }
        } else if request.require_simulation && ctx.simulation_result.is_none() {
            Some(
                "required simulation result is missing for atomically approved execution"
                    .to_string(),
            )
        } else {
            tracing::info!(
                approvals = ctx.approvals.len(),
                "Skipping validator raw simulation for atomically approved vault execution"
            );
            None
        }
    } else {
        None
    };

    if let Some(reason) =
        independent_simulation_rejection.or_else(|| required_simulation_rejection(&request))
    {
        return Json(reject_response(
            0,
            format!("Validation rejected: {reason}"),
            validator_address,
            signer_chain_id,
            signer_contract,
            validated_at,
        ));
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

    let (score, reasoning) = scoring_outcome(score_result);

    let canonical_intent = match intent_with_deadline(&request.intent, request.deadline) {
        Ok(intent) => intent,
        Err(e) => {
            tracing::warn!(error = %e, "Rejecting validation request with invalid deadline");
            return Json(reject_response(
                0,
                format!("{reasoning}; signature error: invalid deadline: {e}"),
                validator_address,
                signer_chain_id,
                signer_contract,
                validated_at,
            ));
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
        return Json(reject_response(
            0,
            format!(
                "{reasoning}; signature error: intent_hash mismatch, expected {expected_intent_hash}"
            ),
            validator_address,
            signer_chain_id,
            signer_contract,
            validated_at,
        ));
    }

    let expected_execution_hash = match expected_execution_hash(
        &request,
        expected_intent_hash.as_str(),
    ) {
        Ok(hash) => hash,
        Err(e) => {
            tracing::warn!(error = %e, "Rejecting validation request with invalid execution context");
            return Json(reject_response(
                0,
                format!("{reasoning}; signature error: invalid execution context: {e}"),
                validator_address,
                signer_chain_id,
                signer_contract,
                validated_at,
            ));
        }
    };
    if !hashes_match(&request.execution_hash, &expected_execution_hash) {
        tracing::warn!(
            supplied = %request.execution_hash,
            expected = %expected_execution_hash,
            "Rejecting validation request with mismatched execution_hash"
        );
        return Json(reject_response(
            0,
            format!(
                "{reasoning}; signature error: execution_hash mismatch, expected {expected_execution_hash}"
            ),
            validator_address,
            signer_chain_id,
            signer_contract,
            validated_at,
        ));
    }

    if score == 0 {
        return Json(reject_response(
            0,
            format!("Validation rejected: {reasoning}"),
            validator_address,
            signer_chain_id,
            signer_contract,
            validated_at,
        ));
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

        match signer.sign_validation(
            intent_hash,
            execution_hash,
            vault,
            score as u64,
            request.deadline,
            request.action_kind,
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

fn zero_signature() -> String {
    format!("0x{}", "00".repeat(65))
}

fn reject_response(
    score: u32,
    reasoning: String,
    validator: String,
    chain_id: Option<u64>,
    verifying_contract: Option<String>,
    validated_at: String,
) -> ValidateResponse {
    ValidateResponse {
        score,
        signature: zero_signature(),
        reasoning,
        validator,
        chain_id,
        verifying_contract,
        validated_at,
    }
}

fn required_simulation_rejection(request: &ValidateRequest) -> Option<String> {
    if !request.require_simulation {
        return None;
    }

    let Some(ctx) = request.execution_context.as_ref() else {
        return Some("required simulation context is missing".to_string());
    };
    let Some(sim) = ctx.simulation_result.as_ref() else {
        return Some("required simulation result is missing".to_string());
    };

    if !sim.success {
        return Some("required simulation did not succeed".to_string());
    }
    if sim.risk_score > 0 {
        return Some(format!(
            "required simulation reported risk score {}",
            sim.risk_score
        ));
    }
    if !sim.warnings.is_empty() {
        return Some(format!(
            "required simulation reported warnings: {}",
            sim.warnings.join("; ")
        ));
    }

    None
}

fn should_run_independent_simulation(ctx: &ExecutionContext) -> bool {
    ctx.approvals.is_empty()
}

fn scoring_outcome(score_result: Result<scoring::ScoringResult, String>) -> (u32, String) {
    match score_result {
        Ok(result) => (result.score, result.reasoning),
        Err(e) => {
            tracing::warn!("Scoring failed: {e}");
            (0, format!("Scoring error rejected: {e}"))
        }
    }
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
    let intent_hash = parse_b256(intent_hash)?;
    let deadline = U256::from(request.deadline);

    if request.action_kind == ACTION_KIND_CLOB_ORDER
        || request.intent.target_protocol == "polymarket_clob"
    {
        let params = polymarket_clob::extract_clob_params(
            &format_action(&request.intent.action),
            &request.intent.amount_in.to_string(),
            &request.intent.metadata,
        )?;
        return Ok(format_b256(hash_clob_order(
            &params,
            intent_hash,
            deadline,
            request.intent.chain_id,
        )));
    }

    if request.action_kind == ACTION_KIND_HYPERLIQUID_ORDER
        || request.intent.target_protocol == "hyperliquid"
    {
        let order = hyperliquid_order_from_intent(&request.intent)?;
        return Ok(format_b256(hash_hyperliquid_order(
            &order,
            intent_hash,
            deadline,
            request.intent.chain_id,
        )));
    }

    if request.action_kind != ACTION_KIND_VAULT_EXECUTE {
        return Err(format!("unsupported action_kind {}", request.action_kind));
    }

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

    let approvals_hash = hash_approvals(&approvals);
    let hash = if ctx.postcondition_kind == "debt_decrease" {
        let input_token: Address = ctx
            .input_token
            .parse()
            .map_err(|e| format!("invalid input_token: {e}"))?;
        let max_input = parse_u256_decimal(&ctx.max_input, "max_input")?;
        let debt_token: Address = ctx
            .debt_token
            .parse()
            .map_err(|e| format!("invalid debt_token: {e}"))?;
        let min_debt_decrease = parse_u256_decimal(&ctx.min_debt_decrease, "min_debt_decrease")?;

        hash_debt_reduction_payload_parts(
            target,
            &calldata,
            value,
            input_token,
            max_input,
            debt_token,
            min_debt_decrease,
            intent_hash,
            deadline,
            chain_id,
            approvals_hash,
        )
    } else if ctx.postcondition_kind == "health_factor" {
        let min_output = parse_u256_decimal(&ctx.min_output, "min_output")?;
        let output_token: Address = ctx
            .output_token
            .parse()
            .map_err(|e| format!("invalid output_token: {e}"))?;
        let pool: Address = ctx
            .health_pool
            .parse()
            .map_err(|e| format!("invalid health_pool: {e}"))?;
        let account: Address = ctx
            .health_account
            .parse()
            .map_err(|e| format!("invalid health_account: {e}"))?;
        let min_health_factor = parse_u256_decimal(&ctx.min_health_factor, "min_health_factor")?;

        hash_health_factor_payload_parts(
            target,
            &calldata,
            value,
            min_output,
            output_token,
            pool,
            account,
            min_health_factor,
            intent_hash,
            deadline,
            chain_id,
            approvals_hash,
        )
    } else {
        let min_output = parse_u256_decimal(&ctx.min_output, "min_output")?;
        let output_token: Address = ctx
            .output_token
            .parse()
            .map_err(|e| format!("invalid output_token: {e}"))?;

        hash_execution_payload_parts(
            target,
            &calldata,
            value,
            min_output,
            output_token,
            intent_hash,
            deadline,
            chain_id,
            approvals_hash,
        )
    };

    Ok(format_b256(hash))
}

fn format_action(action: &Action) -> String {
    match action {
        Action::Swap => "swap",
        Action::Supply => "supply",
        Action::Withdraw => "withdraw",
        Action::Borrow => "borrow",
        Action::Repay => "repay",
        Action::OpenLong => "open_long",
        Action::OpenShort => "open_short",
        Action::CloseLong => "close_long",
        Action::CloseShort => "close_short",
        Action::Buy => "buy",
        Action::Sell => "sell",
        Action::Redeem => "redeem",
        Action::CollateralRelease => "collateral_release",
    }
    .to_string()
}

fn hyperliquid_order_from_intent(
    intent: &trading_runtime::TradeIntent,
) -> Result<PlaceOrderRequest, String> {
    let is_buy = matches!(
        intent.action,
        Action::OpenLong | Action::Buy | Action::CloseShort
    );
    let reduce_only = matches!(intent.action, Action::CloseLong | Action::CloseShort);

    let order_type = if let Some(trigger_px) = intent
        .metadata
        .get("trigger_price")
        .and_then(|v| v.as_str())
    {
        let is_market = intent
            .metadata
            .get("is_market")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let tpsl = intent
            .metadata
            .get("tpsl")
            .and_then(|v| v.as_str())
            .unwrap_or("sl");
        if tpsl == "tp" {
            HlOrderType::TakeProfit {
                trigger_price: trigger_px.to_string(),
                is_market,
            }
        } else {
            HlOrderType::StopLoss {
                trigger_price: trigger_px.to_string(),
                is_market,
            }
        }
    } else if let Some(price) = intent.metadata.get("limit_price").and_then(|v| v.as_str()) {
        HlOrderType::Limit {
            price: price.to_string(),
        }
    } else {
        HlOrderType::Market
    };

    let asset = if let Some(asset_str) = intent.metadata.get("asset").and_then(|v| v.as_str()) {
        AssetId::Symbol(asset_str.to_string())
    } else {
        AssetId::Symbol(intent.token_out.clone())
    };

    Ok(PlaceOrderRequest {
        asset,
        is_buy,
        size: intent.amount_in.to_string(),
        order_type,
        reduce_only,
        cloid: None,
    })
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
    use trading_runtime::TradeIntentBuilder;

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

    fn test_contract_addr() -> Address {
        "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap()
    }

    fn test_signing_server() -> ValidatorServer {
        ValidatorServer::new(9090)
            .with_signer(
                "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                31337,
                test_contract_addr(),
            )
            .unwrap()
    }

    fn test_intent(
        deadline: u64,
        amount_in: rust_decimal::Decimal,
    ) -> trading_runtime::TradeIntent {
        use trading_runtime::Action;
        use trading_runtime::intent::TradeIntentBuilder;

        let mut intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(amount_in)
            .min_amount_out(rust_decimal::Decimal::new(95, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();
        intent.deadline =
            chrono::DateTime::<chrono::Utc>::from_timestamp(deadline as i64, 0).unwrap();
        intent
    }

    fn simulation_summary(
        success: bool,
        risk_score: u32,
        warnings: Vec<String>,
    ) -> SimulationSummary {
        SimulationSummary {
            success,
            gas_used: 21000,
            output_amount: "0".into(),
            balance_changes: Vec::new(),
            warnings,
            risk_score,
        }
    }

    fn execution_context_for(
        intent_hash: &str,
        deadline: u64,
        simulation_result: Option<SimulationSummary>,
    ) -> (String, serde_json::Value) {
        let target: Address = "0x0000000000000000000000000000000000000001"
            .parse()
            .unwrap();
        let calldata = Bytes::from(hex::decode("deadbeef").unwrap());
        let min_output = U256::ZERO;
        let output_token: Address = "0x0000000000000000000000000000000000000000"
            .parse()
            .unwrap();
        let intent_hash_b256 = parse_b256(intent_hash).unwrap();
        let execution_hash = format_b256(hash_execution_payload_parts(
            target,
            &calldata,
            U256::ZERO,
            min_output,
            output_token,
            intent_hash_b256,
            U256::from(deadline),
            31337,
            hash_approvals(&[]),
        ));

        let ctx = serde_json::json!({
            "chain_id": 31337,
            "target": format!("{target}"),
            "calldata": "0xdeadbeef",
            "calldata_decoded": "unknown()",
            "value": "0",
            "min_output": "0",
            "output_token": format!("{output_token}"),
            "approvals": [],
            "simulation_result": simulation_result,
        });

        (execution_hash, ctx)
    }

    #[test]
    fn test_validator_skips_raw_simulation_for_atomic_approvals() {
        let ctx = ExecutionContext {
            chain_id: 31337,
            target: "0x0000000000000000000000000000000000000001".into(),
            calldata: "0xdeadbeef".into(),
            calldata_decoded: "unknown()".into(),
            value: "0".into(),
            min_output: "0".into(),
            output_token: "0x0000000000000000000000000000000000000000".into(),
            postcondition_kind: "output_increase".into(),
            input_token: String::new(),
            max_input: String::new(),
            debt_token: String::new(),
            min_debt_decrease: String::new(),
            health_pool: String::new(),
            health_account: String::new(),
            min_health_factor: String::new(),
            approvals: vec![ExecutionApproval {
                token: "0x0000000000000000000000000000000000000000".into(),
                spender: "0x0000000000000000000000000000000000000001".into(),
                amount: "100".into(),
            }],
            simulation_result: None,
        };

        assert!(!should_run_independent_simulation(&ctx));
    }

    #[test]
    fn test_expected_execution_hash_debt_reduction_context() {
        let deadline = 1_900_000_000;
        let intent = test_intent(deadline, rust_decimal::Decimal::new(100, 0));
        let intent_hash = hash_intent(&intent);
        let intent_hash_b256 = parse_b256(&intent_hash).unwrap();
        let target: Address = "0x0000000000000000000000000000000000000001"
            .parse()
            .unwrap();
        let input_token: Address = "0x0000000000000000000000000000000000000002"
            .parse()
            .unwrap();
        let debt_token: Address = "0x0000000000000000000000000000000000000003"
            .parse()
            .unwrap();
        let calldata = Bytes::from(hex::decode("deadbeef").unwrap());
        let execution_hash = format_b256(hash_debt_reduction_payload_parts(
            target,
            &calldata,
            U256::ZERO,
            input_token,
            U256::from(100u64),
            debt_token,
            U256::from(95u64),
            intent_hash_b256,
            U256::from(deadline),
            31337,
            hash_approvals(&[]),
        ));
        let request = ValidateRequest {
            intent,
            intent_hash: intent_hash.clone(),
            execution_hash: execution_hash.clone(),
            vault_address: format!("{}", test_contract_addr()),
            deadline,
            action_kind: ACTION_KIND_VAULT_EXECUTE,
            strategy_type: None,
            require_simulation: false,
            execution_context: Some(ExecutionContext {
                chain_id: 31337,
                target: format!("{target}"),
                calldata: "0xdeadbeef".into(),
                calldata_decoded: "repay(...)".into(),
                value: "0".into(),
                min_output: "0".into(),
                output_token: "0x0000000000000000000000000000000000000000".into(),
                postcondition_kind: "debt_decrease".into(),
                input_token: format!("{input_token}"),
                max_input: "100".into(),
                debt_token: format!("{debt_token}"),
                min_debt_decrease: "95".into(),
                health_pool: String::new(),
                health_account: String::new(),
                min_health_factor: String::new(),
                approvals: Vec::new(),
                simulation_result: None,
            }),
        };

        assert_eq!(
            expected_execution_hash(&request, &intent_hash).unwrap(),
            execution_hash
        );
    }

    #[test]
    fn test_expected_execution_hash_health_factor_context() {
        let deadline = 1_900_000_000;
        let mut intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Borrow)
            .token_in("0x0000000000000000000000000000000000000002")
            .token_out("0x0000000000000000000000000000000000000003")
            .amount_in(rust_decimal::Decimal::new(100, 0))
            .min_amount_out(rust_decimal::Decimal::new(95, 0))
            .target_protocol("aave_v3")
            .chain_id(31337)
            .build()
            .unwrap();
        intent.deadline =
            chrono::DateTime::<chrono::Utc>::from_timestamp(deadline as i64, 0).unwrap();
        let intent_hash = hash_intent(&intent);
        let intent_hash_b256 = parse_b256(&intent_hash).unwrap();
        let target: Address = "0x0000000000000000000000000000000000000001"
            .parse()
            .unwrap();
        let output_token: Address = "0x0000000000000000000000000000000000000003"
            .parse()
            .unwrap();
        let pool: Address = "0x0000000000000000000000000000000000000004"
            .parse()
            .unwrap();
        let account: Address = "0x0000000000000000000000000000000000000005"
            .parse()
            .unwrap();
        let calldata = Bytes::from(hex::decode("deadbeef").unwrap());
        let execution_hash = format_b256(hash_health_factor_payload_parts(
            target,
            &calldata,
            U256::ZERO,
            U256::from(95u64),
            output_token,
            pool,
            account,
            U256::from(1_500_000_000_000_000_000u128),
            intent_hash_b256,
            U256::from(deadline),
            31337,
            hash_approvals(&[]),
        ));
        let request = ValidateRequest {
            intent,
            intent_hash: intent_hash.clone(),
            execution_hash: execution_hash.clone(),
            vault_address: format!("{}", test_contract_addr()),
            deadline,
            action_kind: ACTION_KIND_VAULT_EXECUTE,
            strategy_type: None,
            require_simulation: false,
            execution_context: Some(ExecutionContext {
                chain_id: 31337,
                target: format!("{target}"),
                calldata: "0xdeadbeef".into(),
                calldata_decoded: "borrow(...)".into(),
                value: "0".into(),
                min_output: "95".into(),
                output_token: format!("{output_token}"),
                postcondition_kind: "health_factor".into(),
                input_token: String::new(),
                max_input: String::new(),
                debt_token: String::new(),
                min_debt_decrease: String::new(),
                health_pool: format!("{pool}"),
                health_account: format!("{account}"),
                min_health_factor: "1500000000000000000".into(),
                approvals: Vec::new(),
                simulation_result: None,
            }),
        };

        assert_eq!(
            expected_execution_hash(&request, &intent_hash).unwrap(),
            execution_hash
        );
    }

    async fn post_validate(app: axum::Router, req_body: serde_json::Value) -> ValidateResponse {
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
        serde_json::from_slice(&body_bytes).unwrap()
    }

    #[tokio::test]
    async fn test_validate_required_simulation_missing_context_returns_zero_signature() {
        let app = test_signing_server().router();
        let deadline = 9999999999u64;
        let intent = test_intent(deadline, rust_decimal::Decimal::new(100, 0));
        let intent_hash = trading_runtime::intent::hash_intent(&intent);

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": zero_hash(),
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": deadline,
            "require_simulation": true,
        });

        let resp = post_validate(app, req_body).await;
        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, zero_signature());
        assert!(resp.reasoning.contains("simulation context is missing"));
    }

    #[tokio::test]
    async fn test_validate_required_simulation_missing_result_returns_zero_signature() {
        let app = test_signing_server().router();
        let deadline = 9999999999u64;
        let intent = test_intent(deadline, rust_decimal::Decimal::new(100, 0));
        let intent_hash = trading_runtime::intent::hash_intent(&intent);
        let (execution_hash, execution_context) =
            execution_context_for(&intent_hash, deadline, None);

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": execution_hash,
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": deadline,
            "require_simulation": true,
            "execution_context": execution_context,
        });

        let resp = post_validate(app, req_body).await;
        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, zero_signature());
        assert!(resp.reasoning.contains("simulation result is missing"));
    }

    #[tokio::test]
    async fn test_validate_required_simulation_failed_result_returns_zero_signature() {
        let app = test_signing_server().router();
        let deadline = 9999999999u64;
        let intent = test_intent(deadline, rust_decimal::Decimal::new(100, 0));
        let intent_hash = trading_runtime::intent::hash_intent(&intent);
        let (execution_hash, execution_context) = execution_context_for(
            &intent_hash,
            deadline,
            Some(simulation_summary(false, 0, Vec::new())),
        );

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": execution_hash,
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": deadline,
            "require_simulation": true,
            "execution_context": execution_context,
        });

        let resp = post_validate(app, req_body).await;
        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, zero_signature());
        assert!(resp.reasoning.contains("did not succeed"));
    }

    #[tokio::test]
    async fn test_validate_required_simulation_warning_returns_zero_signature() {
        let app = test_signing_server().router();
        let deadline = 9999999999u64;
        let intent = test_intent(deadline, rust_decimal::Decimal::new(100, 0));
        let intent_hash = trading_runtime::intent::hash_intent(&intent);
        let (execution_hash, execution_context) = execution_context_for(
            &intent_hash,
            deadline,
            Some(simulation_summary(
                true,
                0,
                vec!["UnexpectedApproval: token=0x1 spender=0x2 amount=3".into()],
            )),
        );

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": execution_hash,
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": deadline,
            "require_simulation": true,
            "execution_context": execution_context,
        });

        let resp = post_validate(app, req_body).await;
        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, zero_signature());
        assert!(resp.reasoning.contains("warnings"));
    }

    #[tokio::test]
    async fn test_validate_required_simulation_risk_returns_zero_signature() {
        let app = test_signing_server().router();
        let deadline = 9999999999u64;
        let intent = test_intent(deadline, rust_decimal::Decimal::new(100, 0));
        let intent_hash = trading_runtime::intent::hash_intent(&intent);
        let (execution_hash, execution_context) = execution_context_for(
            &intent_hash,
            deadline,
            Some(simulation_summary(true, 10, Vec::new())),
        );

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": execution_hash,
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": deadline,
            "require_simulation": true,
            "execution_context": execution_context,
        });

        let resp = post_validate(app, req_body).await;
        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, zero_signature());
        assert!(resp.reasoning.contains("risk score 10"));
    }

    #[tokio::test]
    async fn test_validate_required_independent_simulation_failure_returns_zero_signature() {
        let app = test_signing_server()
            .with_rpc_url("http://127.0.0.1:9".into())
            .router();
        let deadline = 9999999999u64;
        let intent = test_intent(deadline, rust_decimal::Decimal::new(100, 0));
        let intent_hash = trading_runtime::intent::hash_intent(&intent);
        let (execution_hash, execution_context) = execution_context_for(
            &intent_hash,
            deadline,
            Some(simulation_summary(true, 0, Vec::new())),
        );

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": execution_hash,
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": deadline,
            "require_simulation": true,
            "execution_context": execution_context,
        });

        let resp = post_validate(app, req_body).await;
        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, zero_signature());
        assert!(resp.reasoning.contains("independent simulation failed"));
    }

    #[tokio::test]
    async fn test_validate_zero_score_returns_zero_signature() {
        let app = test_signing_server().router();
        let deadline = 9999999999u64;
        let intent = test_intent(deadline, rust_decimal::Decimal::ZERO);
        let intent_hash = trading_runtime::intent::hash_intent(&intent);

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": zero_hash(),
            "vault_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "deadline": deadline,
        });

        let resp = post_validate(app, req_body).await;
        assert_eq!(resp.score, 0);
        assert_eq!(resp.signature, zero_signature());
        assert!(resp.reasoning.contains("Zero trade amount"));
    }

    #[test]
    fn test_scoring_error_returns_zero_score() {
        let (score, reasoning) = scoring_outcome(Err("boom".into()));

        assert_eq!(score, 0);
        assert!(reasoning.contains("Scoring error rejected: boom"));
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
    async fn test_validate_with_signer_uses_direct_action_kind() {
        use trading_runtime::execution_hash::{
            ACTION_KIND_CLOB_ORDER, format_b256, hash_clob_order,
        };
        use trading_runtime::intent::TradeIntentBuilder;
        use trading_runtime::{Action, signature_verify};

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
            .action(Action::Buy)
            .token_in("USDC")
            .token_out("YES")
            .amount_in(rust_decimal::Decimal::new(10, 0))
            .min_amount_out(rust_decimal::Decimal::ZERO)
            .target_protocol("polymarket_clob")
            .chain_id(137)
            .metadata(serde_json::json!({
                "token_id": "123",
                "price": "0.65",
                "order_type": "GTC"
            }))
            .build()
            .unwrap();
        intent.deadline =
            chrono::DateTime::<chrono::Utc>::from_timestamp(deadline as i64, 0).unwrap();

        let intent_hash = trading_runtime::intent::hash_intent(&intent);
        let intent_hash_b256 = parse_b256(&intent_hash).unwrap();
        let params = polymarket_clob::extract_clob_params(
            "buy",
            &intent.amount_in.to_string(),
            &intent.metadata,
        )
        .unwrap();
        let execution_hash = format_b256(hash_clob_order(
            &params,
            intent_hash_b256,
            U256::from(deadline),
            intent.chain_id,
        ));
        let vault_address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": intent_hash,
            "execution_hash": execution_hash,
            "vault_address": vault_address,
            "deadline": deadline,
            "action_kind": ACTION_KIND_CLOB_ORDER,
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
        assert_ne!(resp.signature, format!("0x{}", "00".repeat(65)));

        let response = trading_runtime::ValidatorResponse {
            validator: resp.validator,
            score: resp.score,
            signature: resp.signature,
            reasoning: resp.reasoning,
            chain_id: resp.chain_id,
            verifying_contract: resp.verifying_contract,
            validated_at: Some(resp.validated_at),
        };
        signature_verify::verify_validator_signature(
            &response,
            req_body["intent_hash"].as_str().unwrap(),
            req_body["execution_hash"].as_str().unwrap(),
            vault_address,
            deadline,
            ACTION_KIND_CLOB_ORDER,
        )
        .expect("signature must verify with CLOB action kind");
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
