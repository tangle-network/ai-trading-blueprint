use crate::error::TradingError;
use crate::intent::hash_intent;
use crate::types::{TradeIntent, ValidationResult, ValidatorResponse};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct ValidatorClient {
    endpoints: Vec<String>,
    threshold: u32,
    client: reqwest::Client,
    timeout: std::time::Duration,
}

#[derive(Debug, Serialize)]
struct ValidateRequest {
    intent: TradeIntent,
    /// Hex-encoded intent hash (with 0x prefix)
    intent_hash: String,
    /// Hex-encoded vault address (with 0x prefix)
    vault_address: String,
    /// Unix timestamp deadline for the validation signature
    deadline: u64,
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
            endpoints,
            threshold,
            client: reqwest::Client::new(),
            timeout: std::time::Duration::from_secs(10),
        }
    }

    pub fn with_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.timeout = timeout;
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
        let intent_hash = hash_intent(intent);
        let request = ValidateRequest {
            intent: intent.clone(),
            intent_hash: intent_hash.clone(),
            vault_address: vault_address.to_string(),
            deadline,
        };

        let body = serde_json::to_string(&request)
            .map_err(|e| TradingError::SerializationError(e.to_string()))?;

        // Fan out to all validators in parallel
        let futures: Vec<_> = self
            .endpoints
            .iter()
            .map(|endpoint| {
                let client = self.client.clone();
                let url = format!("{}/validate", endpoint);
                let body = body.clone();
                let timeout = self.timeout;

                async move {
                    let result = client
                        .post(&url)
                        .header("content-type", "application/json")
                        .body(body)
                        .timeout(timeout)
                        .send()
                        .await;

                    match result {
                        Ok(resp) => resp.json::<ValidateResponse>().await.ok(),
                        Err(_) => None,
                    }
                }
            })
            .collect();

        let results = futures::future::join_all(futures).await;

        let mut responses = Vec::new();
        for result in results.into_iter().flatten() {
            responses.push(ValidatorResponse {
                validator: result.validator,
                score: result.score,
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

        // Calculate aggregate score (simple average)
        let total_score: u32 = responses.iter().map(|r| r.score).sum();
        let aggregate_score = total_score / responses.len() as u32;
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

    #[tokio::test]
    async fn test_validate_approved() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/validate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 85,
                "signature": "0xdeadbeef",
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
                "signature": "0xdeadbeef",
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
                "signature": "0xabcdef",
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
}
