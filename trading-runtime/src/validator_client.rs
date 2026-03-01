use crate::error::TradingError;
use crate::intent::hash_intent;
use crate::types::{TradeIntent, ValidationResult, ValidatorResponse};
use serde::{Deserialize, Serialize};

/// Execution context passed to validators for calldata + simulation verification.
/// Re-exported from trading-validator-lib's types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionContext {
    pub target: String,
    pub calldata: String,
    pub calldata_decoded: String,
    pub value: String,
    #[serde(default)]
    pub simulation_result: Option<SimulationSummary>,
}

/// Simulation summary for validator communication.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationSummary {
    pub success: bool,
    pub gas_used: u64,
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

#[derive(Debug, Clone)]
pub struct ValidatorClient {
    endpoints: Vec<String>,
    threshold: u32,
    /// Minimum number of validators that must respond for a valid result.
    min_validators: usize,
    client: reqwest::Client,
    timeout: std::time::Duration,
}

/// Maximum valid validator score.
const MAX_SCORE: u32 = 100;

/// Expected length of a hex-encoded EIP-712 signature (0x + 130 hex chars = 65 bytes).
const EXPECTED_SIG_LEN: usize = 132;

#[derive(Debug, Serialize)]
struct ValidateRequest {
    intent: TradeIntent,
    /// Hex-encoded intent hash (with 0x prefix)
    intent_hash: String,
    /// Hex-encoded vault address (with 0x prefix)
    vault_address: String,
    /// Unix timestamp deadline for the validation signature
    deadline: u64,
    /// Optional execution context (target, calldata, simulation results)
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_context: Option<ExecutionContext>,
}

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    score: u32,
    /// Hex-encoded 65-byte EIP-712 signature (with 0x prefix)
    signature: String,
    reasoning: String,
    /// Hex-encoded validator address (with 0x prefix)
    validator: String,
    /// Chain ID from the EIP-712 domain (if signer configured)
    #[serde(default)]
    chain_id: Option<u64>,
    /// TradeValidator contract address from the EIP-712 domain
    #[serde(default)]
    verifying_contract: Option<String>,
    /// ISO 8601 timestamp of when this validation was produced
    #[serde(default)]
    validated_at: Option<String>,
}

impl ValidatorClient {
    pub fn new(endpoints: Vec<String>, threshold: u32) -> Self {
        Self {
            min_validators: 1,
            endpoints,
            threshold,
            client: reqwest::Client::new(),
            timeout: std::time::Duration::from_secs(
                std::env::var("VALIDATOR_TIMEOUT_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(120),
            ),
        }
    }

    pub fn with_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Set the minimum number of validators that must respond.
    pub fn with_min_validators(mut self, min: usize) -> Self {
        self.min_validators = min;
        self
    }

    /// Fan out validation request to all validator endpoints, collect responses.
    ///
    /// `vault_address`: Hex-encoded vault address (with 0x prefix)
    /// `deadline`: Unix timestamp deadline for the EIP-712 signatures
    pub async fn validate(
        &self,
        intent: &TradeIntent,
        vault_address: &str,
        deadline: u64,
    ) -> Result<ValidationResult, TradingError> {
        self.validate_with_context(intent, vault_address, deadline, None)
            .await
    }

    /// Fan out validation request with execution context to all validator endpoints.
    ///
    /// When `execution_context` is provided, validators can verify that the
    /// calldata matches the stated intent and apply simulation-based scoring.
    pub async fn validate_with_context(
        &self,
        intent: &TradeIntent,
        vault_address: &str,
        deadline: u64,
        execution_context: Option<ExecutionContext>,
    ) -> Result<ValidationResult, TradingError> {
        let intent_hash = hash_intent(intent);
        let request = ValidateRequest {
            intent: intent.clone(),
            intent_hash: intent_hash.clone(),
            vault_address: vault_address.to_string(),
            deadline,
            execution_context,
        };

        let body = serde_json::to_string(&request)
            .map_err(|e| TradingError::SerializationError(e.to_string()))?;

        // Fan out to all validators in parallel
        let futures: Vec<_> = self
            .endpoints
            .iter()
            .map(|endpoint| {
                let client = self.client.clone();
                let url = format!("{endpoint}/validate");
                let body = body.clone();
                let timeout = self.timeout;
                let endpoint = endpoint.clone();

                async move {
                    let result = client
                        .post(&url)
                        .header("content-type", "application/json")
                        .body(body)
                        .timeout(timeout)
                        .send()
                        .await;

                    match result {
                        Ok(resp) => match resp.json::<ValidateResponse>().await {
                            Ok(v) => Some(v),
                            Err(e) => {
                                tracing::warn!(
                                    endpoint = %endpoint,
                                    error = %e,
                                    "Validator response deserialization failed"
                                );
                                None
                            }
                        },
                        Err(e) => {
                            tracing::warn!(
                                endpoint = %endpoint,
                                error = %e,
                                "Validator request failed"
                            );
                            None
                        }
                    }
                }
            })
            .collect();

        let results = futures::future::join_all(futures).await;

        let mut responses = Vec::new();
        for result in results.into_iter().flatten() {
            // Validate signature format: must be 0x-prefixed hex, 65 bytes.
            if !result.signature.starts_with("0x") || result.signature.len() != EXPECTED_SIG_LEN {
                tracing::warn!(
                    validator = %result.validator,
                    sig_len = result.signature.len(),
                    "Validator signature has invalid format (expected 0x + 130 hex chars), skipping"
                );
                continue;
            }

            // Clamp score to valid range [0, 100].
            let score = result.score.min(MAX_SCORE);
            if result.score > MAX_SCORE {
                tracing::warn!(
                    validator = %result.validator,
                    raw_score = result.score,
                    clamped_score = score,
                    "Validator score out of range, clamped to {MAX_SCORE}"
                );
            }

            responses.push(ValidatorResponse {
                validator: result.validator,
                score,
                signature: result.signature,
                reasoning: result.reasoning,
                chain_id: result.chain_id,
                verifying_contract: result.verifying_contract,
                validated_at: result.validated_at,
            });
        }

        if responses.is_empty() {
            return Err(TradingError::ValidatorError(
                "No validators responded".into(),
            ));
        }

        // Check minimum validator count.
        if responses.len() < self.min_validators {
            return Err(TradingError::ValidatorError(format!(
                "Insufficient validators: got {}, need at least {}",
                responses.len(),
                self.min_validators,
            )));
        }

        // Calculate aggregate score (simple average).
        // Division is safe: we checked `!responses.is_empty()` above.
        let count = responses.len() as u32;
        let total_score: u32 = responses.iter().map(|r| r.score).sum();
        let aggregate_score = total_score.checked_div(count).unwrap_or(0);
        let approved = aggregate_score >= self.threshold;

        Ok(ValidationResult {
            approved,
            aggregate_score,
            validator_responses: responses,
            intent_hash,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::TradeIntentBuilder;
    use crate::types::Action;
    use rust_decimal::Decimal;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Valid-format 65-byte EIP-712 signature (0x + 130 hex chars) for tests.
    const TEST_SIG: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[tokio::test]
    async fn test_validate_approved() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/validate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 85,
                "signature": TEST_SIG,
                "reasoning": "Trade looks safe",
                "validator": "0xValidator1"
            })))
            .mount(&mock_server)
            .await;

        let client = ValidatorClient::new(vec![mock_server.uri()], 70);

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = client
            .validate(
                &intent,
                "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                9999999999,
            )
            .await
            .unwrap();
        assert!(result.approved);
        assert_eq!(result.aggregate_score, 85);
    }

    #[tokio::test]
    async fn test_validate_rejected() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/validate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 30,
                "signature": TEST_SIG,
                "reasoning": "Too risky",
                "validator": "0xValidator1"
            })))
            .mount(&mock_server)
            .await;

        let client = ValidatorClient::new(vec![mock_server.uri()], 70);

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = client
            .validate(
                &intent,
                "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                9999999999,
            )
            .await
            .unwrap();
        assert!(!result.approved);
    }

    #[tokio::test]
    async fn test_no_validators_error() {
        let client = ValidatorClient::new(vec!["http://localhost:1".into()], 70)
            .with_timeout(std::time::Duration::from_millis(100));

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = client
            .validate(
                &intent,
                "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                9999999999,
            )
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_validate_sends_vault_and_deadline() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/validate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 90,
                "signature": TEST_SIG,
                "reasoning": "Looks good",
                "validator": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = ValidatorClient::new(vec![mock_server.uri()], 70);

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let vault = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        let deadline = 1234567890u64;

        let result = client.validate(&intent, vault, deadline).await.unwrap();
        assert!(result.approved);
        assert_eq!(result.aggregate_score, 90);

        // The mock expectation of 1 call verifies the request was sent
    }

    #[tokio::test]
    async fn test_score_clamped_to_100() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/validate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 99999,
                "signature": TEST_SIG,
                "reasoning": "Inflated score",
                "validator": "0xValidator1"
            })))
            .mount(&mock_server)
            .await;

        let client = ValidatorClient::new(vec![mock_server.uri()], 50);

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = client
            .validate(&intent, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 9999999999)
            .await
            .unwrap();
        // Score should be clamped to 100, not 99999.
        assert_eq!(result.aggregate_score, 100);
        assert_eq!(result.validator_responses[0].score, 100);
    }

    #[tokio::test]
    async fn test_invalid_signature_rejected() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/validate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 85,
                "signature": "0xshort",
                "reasoning": "Bad sig",
                "validator": "0xValidator1"
            })))
            .mount(&mock_server)
            .await;

        let client = ValidatorClient::new(vec![mock_server.uri()], 50);

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = client
            .validate(&intent, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 9999999999)
            .await;
        // Should fail — only response had invalid signature, so 0 valid responses.
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_min_validators_check() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/validate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 85,
                "signature": TEST_SIG,
                "reasoning": "OK",
                "validator": "0xValidator1"
            })))
            .mount(&mock_server)
            .await;

        // Require 2 validators but only provide 1 endpoint.
        let client = ValidatorClient::new(vec![mock_server.uri()], 50)
            .with_min_validators(2);

        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = client
            .validate(&intent, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 9999999999)
            .await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("Insufficient validators"), "Error: {err_msg}");
    }
}
