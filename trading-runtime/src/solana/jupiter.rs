//! Jupiter aggregator client (https://quote-api.jup.ag/v6).
//!
//! We talk to Jupiter directly over HTTP rather than via
//! `jupiter-swap-api-client` to keep the dep footprint small and to make
//! the integration trivially mockable with `wiremock`.
//!
//! Endpoint is configurable via `JUPITER_API_URL` so operators can point
//! at the public lite tier (`https://lite-api.jup.ag/swap/v1`) or a paid
//! endpoint without recompiling.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::transaction::VersionedTransaction;
use std::str::FromStr;
use std::time::Duration;

use super::client::SolanaClient;
use super::error::SolanaError;
use super::{SolanaQuote, SolanaQuoteRequest, SolanaVenue};

/// Default Jupiter v6 endpoint.
pub const DEFAULT_JUPITER_API_URL: &str = "https://quote-api.jup.ag/v6";

/// Env var that overrides the default endpoint.
pub const JUPITER_API_URL_ENV: &str = "JUPITER_API_URL";

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// Jupiter swap-aggregator venue.
pub struct JupiterVenue {
    rpc: SolanaClient,
    http: reqwest::Client,
    api_base: String,
}

impl JupiterVenue {
    /// Build a Jupiter venue against the given RPC client. The HTTP base
    /// defaults to [`DEFAULT_JUPITER_API_URL`] but is overridable via the
    /// `JUPITER_API_URL` environment variable.
    pub fn new(rpc: SolanaClient) -> Result<Self, SolanaError> {
        let api_base = std::env::var(JUPITER_API_URL_ENV)
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty())
            .unwrap_or_else(|| DEFAULT_JUPITER_API_URL.to_string());
        Self::with_endpoint(rpc, api_base)
    }

    /// Build a Jupiter venue against an explicit HTTP base. Tests use this
    /// to point at a `wiremock::MockServer`.
    pub fn with_endpoint(
        rpc: SolanaClient,
        api_base: impl Into<String>,
    ) -> Result<Self, SolanaError> {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .map_err(SolanaError::from)?;
        Ok(Self {
            rpc,
            http,
            api_base: api_base.into().trim_end_matches('/').to_string(),
        })
    }

    pub fn api_base(&self) -> &str {
        &self.api_base
    }
}

// ── Wire types ────────────────────────────────────────────────────────────────

/// Response shape for `GET /quote`. Fields we don't use are kept in `extra`
/// so we can pass the full payload back into `POST /swap` verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JupiterQuoteResponse {
    #[serde(rename = "inputMint")]
    input_mint: String,
    #[serde(rename = "outputMint")]
    output_mint: String,
    #[serde(rename = "inAmount")]
    in_amount: String,
    #[serde(rename = "outAmount")]
    out_amount: String,
    #[serde(rename = "otherAmountThreshold")]
    other_amount_threshold: String,
    /// May arrive as a number or a string ("0.0023"); accept either.
    #[serde(rename = "priceImpactPct", default)]
    price_impact_pct: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct JupiterSwapRequest {
    /// The full quote response, echoed back unchanged.
    #[serde(rename = "quoteResponse")]
    quote_response: serde_json::Value,
    #[serde(rename = "userPublicKey")]
    user_public_key: String,
    #[serde(rename = "wrapAndUnwrapSol", skip_serializing_if = "Option::is_none")]
    wrap_and_unwrap_sol: Option<bool>,
    /// Auto-allocate compute-unit-price from priority fee market.
    #[serde(
        rename = "computeUnitPriceMicroLamports",
        skip_serializing_if = "Option::is_none"
    )]
    compute_unit_price_micro_lamports: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct JupiterSwapResponse {
    /// Base64-encoded `VersionedTransaction` ready to sign.
    #[serde(rename = "swapTransaction")]
    swap_transaction: String,
}

// ── Trait impl ────────────────────────────────────────────────────────────────

#[async_trait]
impl SolanaVenue for JupiterVenue {
    fn venue_id(&self) -> &'static str {
        "jupiter"
    }

    async fn quote(&self, req: &SolanaQuoteRequest) -> Result<SolanaQuote, SolanaError> {
        let url = format!("{}/quote", self.api_base);
        let resp = self
            .http
            .get(&url)
            .query(&[
                ("inputMint", req.input_mint.to_string()),
                ("outputMint", req.output_mint.to_string()),
                ("amount", req.amount.to_string()),
                ("slippageBps", req.slippage_bps.to_string()),
            ])
            .send()
            .await
            .map_err(SolanaError::from)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SolanaError::RpcFailed(format!(
                "jupiter quote: HTTP {status}: {body}"
            )));
        }

        // Capture the raw value first so we can pass it back into /swap unchanged.
        let raw: serde_json::Value = resp.json().await.map_err(SolanaError::from)?;
        let parsed: JupiterQuoteResponse = serde_json::from_value(raw.clone())
            .map_err(|e| SolanaError::RpcFailed(format!("jupiter quote: malformed JSON: {e}")))?;

        let in_amount = parsed
            .in_amount
            .parse::<u64>()
            .map_err(|e| SolanaError::RpcFailed(format!("invalid inAmount: {e}")))?;
        let out_amount = parsed
            .out_amount
            .parse::<u64>()
            .map_err(|e| SolanaError::RpcFailed(format!("invalid outAmount: {e}")))?;
        let other_amount_threshold = parsed
            .other_amount_threshold
            .parse::<u64>()
            .map_err(|e| SolanaError::RpcFailed(format!("invalid otherAmountThreshold: {e}")))?;
        let price_impact_pct = parse_pct(&parsed.price_impact_pct);

        // Sanity-check the mints round-trip.
        let input_mint = Pubkey::from_str(&parsed.input_mint)
            .map_err(|e| SolanaError::RpcFailed(format!("invalid input mint: {e}")))?;
        let output_mint = Pubkey::from_str(&parsed.output_mint)
            .map_err(|e| SolanaError::RpcFailed(format!("invalid output mint: {e}")))?;

        Ok(SolanaQuote {
            venue: self.venue_id().to_string(),
            input_mint,
            output_mint,
            in_amount,
            out_amount,
            other_amount_threshold,
            price_impact_pct,
            raw,
        })
    }

    async fn build_swap_tx(
        &self,
        quote: &SolanaQuote,
        payer: Pubkey,
    ) -> Result<VersionedTransaction, SolanaError> {
        let url = format!("{}/swap", self.api_base);
        let body = JupiterSwapRequest {
            quote_response: quote.raw.clone(),
            user_public_key: payer.to_string(),
            wrap_and_unwrap_sol: Some(true),
            compute_unit_price_micro_lamports: None,
        };

        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(SolanaError::from)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(SolanaError::RpcFailed(format!(
                "jupiter swap: HTTP {status}: {body}"
            )));
        }

        let parsed: JupiterSwapResponse = resp.json().await.map_err(SolanaError::from)?;
        let bytes = base64_decode(&parsed.swap_transaction)?;
        bincode::deserialize::<VersionedTransaction>(&bytes).map_err(|e| {
            SolanaError::RpcFailed(format!("jupiter swap: invalid VersionedTransaction: {e}"))
        })
    }

    async fn submit(&self, tx: VersionedTransaction) -> Result<Signature, SolanaError> {
        self.rpc.submit(tx).await
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn parse_pct(value: &serde_json::Value) -> f64 {
    match value {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
        serde_json::Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn base64_decode(s: &str) -> Result<Vec<u8>, SolanaError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| SolanaError::RpcFailed(format!("base64: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::pubkey;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // Two well-known mints; we never actually swap, just round-trip them.
    const SOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
    const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    fn quote_payload() -> serde_json::Value {
        serde_json::json!({
            "inputMint": SOL_MINT.to_string(),
            "outputMint": USDC_MINT.to_string(),
            "inAmount": "1000000000",
            "outAmount": "150000000",
            "otherAmountThreshold": "148500000",
            "priceImpactPct": "0.0012",
            "swapMode": "ExactIn",
            "routePlan": []
        })
    }

    #[tokio::test]
    async fn quote_parses_typical_jupiter_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/quote"))
            .respond_with(ResponseTemplate::new(200).set_body_json(quote_payload()))
            .mount(&server)
            .await;

        let rpc = SolanaClient::new("http://127.0.0.1:1");
        let venue = JupiterVenue::with_endpoint(rpc, server.uri()).unwrap();

        let q = venue
            .quote(&SolanaQuoteRequest {
                input_mint: SOL_MINT,
                output_mint: USDC_MINT,
                amount: 1_000_000_000,
                slippage_bps: 50,
                user_public_key: Pubkey::new_unique(),
            })
            .await
            .unwrap();

        assert_eq!(q.venue, "jupiter");
        assert_eq!(q.in_amount, 1_000_000_000);
        assert_eq!(q.out_amount, 150_000_000);
        assert_eq!(q.other_amount_threshold, 148_500_000);
        assert!((q.price_impact_pct - 0.0012).abs() < 1e-9);
        assert_eq!(q.input_mint, SOL_MINT);
        assert_eq!(q.output_mint, USDC_MINT);
    }

    #[tokio::test]
    async fn quote_handles_numeric_price_impact() {
        let server = MockServer::start().await;
        let mut payload = quote_payload();
        payload["priceImpactPct"] = serde_json::json!(0.0007);
        Mock::given(method("GET"))
            .and(path("/quote"))
            .respond_with(ResponseTemplate::new(200).set_body_json(payload))
            .mount(&server)
            .await;

        let rpc = SolanaClient::new("http://127.0.0.1:1");
        let venue = JupiterVenue::with_endpoint(rpc, server.uri()).unwrap();
        let q = venue
            .quote(&SolanaQuoteRequest {
                input_mint: SOL_MINT,
                output_mint: USDC_MINT,
                amount: 1_000_000_000,
                slippage_bps: 50,
                user_public_key: Pubkey::new_unique(),
            })
            .await
            .unwrap();
        assert!((q.price_impact_pct - 0.0007).abs() < 1e-9);
    }

    #[tokio::test]
    async fn quote_propagates_http_errors() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/quote"))
            .respond_with(ResponseTemplate::new(500).set_body_string("upstream boom"))
            .mount(&server)
            .await;

        let rpc = SolanaClient::new("http://127.0.0.1:1");
        let venue = JupiterVenue::with_endpoint(rpc, server.uri()).unwrap();
        let err = venue
            .quote(&SolanaQuoteRequest {
                input_mint: SOL_MINT,
                output_mint: USDC_MINT,
                amount: 1,
                slippage_bps: 1,
                user_public_key: Pubkey::new_unique(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, SolanaError::RpcFailed(_)));
    }

    #[test]
    fn parse_pct_accepts_string_and_number_and_null() {
        assert!((parse_pct(&serde_json::json!("0.0023")) - 0.0023).abs() < 1e-9);
        assert!((parse_pct(&serde_json::json!(0.0023)) - 0.0023).abs() < 1e-9);
        assert_eq!(parse_pct(&serde_json::Value::Null), 0.0);
    }

    #[test]
    fn endpoint_strips_trailing_slash() {
        let rpc = SolanaClient::new("http://127.0.0.1:1");
        let venue = JupiterVenue::with_endpoint(rpc, "https://example.com/api/").unwrap();
        assert_eq!(venue.api_base(), "https://example.com/api");
    }

    #[tokio::test]
    async fn build_swap_tx_reports_invalid_base64() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/swap"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "swapTransaction": "%%%not-base64%%%",
            })))
            .mount(&server)
            .await;
        let rpc = SolanaClient::new("http://127.0.0.1:1");
        let venue = JupiterVenue::with_endpoint(rpc, server.uri()).unwrap();
        let q = SolanaQuote {
            venue: "jupiter".into(),
            input_mint: SOL_MINT,
            output_mint: USDC_MINT,
            in_amount: 1,
            out_amount: 1,
            other_amount_threshold: 1,
            price_impact_pct: 0.0,
            raw: quote_payload(),
        };
        let err = venue
            .build_swap_tx(&q, Pubkey::new_unique())
            .await
            .unwrap_err();
        assert!(matches!(err, SolanaError::RpcFailed(_)));
    }
}
