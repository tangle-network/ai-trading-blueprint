use alloy::primitives::{Address, B256};
use axum::extract::State;
use axum::routing::post;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::risk_evaluator::AiProvider;
use crate::scoring;
use crate::signer::ValidatorSigner;

#[derive(Debug, Clone)]
pub struct ValidatorServer {
    pub port: u16,
    pub ai_provider: Option<AiProvider>,
    pub signer: Option<Arc<ValidatorSigner>>,
}

#[derive(Debug, Deserialize)]
pub struct ValidateRequest {
    pub intent: trading_runtime::TradeIntent,
    /// Hex-encoded keccak256 hash of the intent (with 0x prefix)
    pub intent_hash: String,
    /// Hex-encoded vault address (with 0x prefix)
    pub vault_address: String,
    /// Unix timestamp deadline for the validation signature
    pub deadline: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateResponse {
    pub score: u32,
    /// Hex-encoded 65-byte EIP-712 signature (with 0x prefix)
    pub signature: String,
    pub reasoning: String,
    /// Hex-encoded validator address (with 0x prefix)
    pub validator: String,
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

        Self {
            port,
            ai_provider,
            signer: None,
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
    Json(request): Json<ValidateRequest>,
) -> Json<ValidateResponse> {
    // Run policy checks + AI scoring
    let score_result = scoring::compute_score(
        &request.intent,
        server.ai_provider.as_ref(),
    )
    .await;

    let (score, reasoning) = match score_result {
        Ok(result) => (result.score, result.reasoning),
        Err(e) => {
            tracing::warn!("Scoring failed: {e}");
            (50, format!("Scoring error: {e}"))
        }
    };

    // If we have a signer, produce a real EIP-712 signature
    if let Some(ref signer) = server.signer {
        // Parse intent_hash from hex string
        let intent_hash = match parse_b256(&request.intent_hash) {
            Ok(h) => h,
            Err(e) => {
                tracing::error!("Invalid intent_hash: {e}");
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", "00".repeat(65)),
                    reasoning: format!("{reasoning}; signature error: invalid intent_hash"),
                    validator: format!("0x{}", hex::encode(signer.address().as_slice())),
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
                });
            }
        };

        match signer.sign_validation(intent_hash, vault, score as u64, request.deadline) {
            Ok((sig_bytes, addr)) => {
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", hex::encode(sig_bytes)),
                    reasoning,
                    validator: format!("{addr}"),
                });
            }
            Err(e) => {
                tracing::error!("Signing failed: {e}");
                return Json(ValidateResponse {
                    score,
                    signature: format!("0x{}", "00".repeat(65)),
                    reasoning: format!("{reasoning}; signing error: {e}"),
                    validator: format!("{}", signer.address()),
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
        use alloy::primitives::keccak256;
        use trading_runtime::intent::TradeIntentBuilder;
        use trading_runtime::Action;

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

        let intent_hash = keccak256("test-intent");
        let vault_address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        let req_body = serde_json::json!({
            "intent": intent,
            "intent_hash": format!("0x{}", hex::encode(intent_hash)),
            "vault_address": vault_address,
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

        // Should have a real signature (not all zeros)
        assert!(resp.signature.starts_with("0x"));
        assert_eq!(resp.signature.len(), 2 + 65 * 2); // "0x" + 130 hex chars
        assert_ne!(resp.signature, format!("0x{}", "00".repeat(65)));

        // Validator address should match the signer
        assert_eq!(
            resp.validator.to_lowercase(),
            "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
        );
    }

    #[tokio::test]
    async fn test_validate_without_signer() {
        use trading_runtime::intent::TradeIntentBuilder;
        use trading_runtime::Action;

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
    }
}
