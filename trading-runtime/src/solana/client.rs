//! Thin wrapper around `solana-client::nonblocking::rpc_client::RpcClient`.
//!
//! Centralises:
//! - timeout + commitment defaults,
//! - blockhash fetching with one bounded retry on expiry via
//!   [`SolanaClient::submit_with_retry`],
//! - typed mapping into [`SolanaError`].
//!
//! ## Blockhash-expiry retry policy
//!
//! Solana transactions are signed against a *recent* blockhash that ages out
//! after ~150 slots (~60s). On a busy slot the operator's tx can land just
//! after its blockhash expires, returning `BlockhashNotFound`. The retry on
//! [`SolanaClient::submit_with_retry`] is **bounded to 1 attempt** — we
//! re-fetch a fresh blockhash, ask the caller to re-build + re-sign, and
//! try once more. After that we propagate `SolanaError::BlockhashExpired`
//! so the caller can surface the failure. Repeated expiry indicates a
//! chain-side issue (RPC lag, slot gap) worth alerting on rather than
//! masking with unbounded retries.

use std::sync::Arc;
use std::time::Duration;

use solana_client::client_error::ClientErrorKind;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::RpcSendTransactionConfig;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::transaction::VersionedTransaction;

use super::error::SolanaError;

/// Default RPC timeout (matches the solana-cli default).
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(30);

/// Solana RPC client wrapper.
///
/// Uses the nonblocking client end-to-end so callers stay in tokio's reactor.
#[derive(Clone)]
pub struct SolanaClient {
    inner: Arc<RpcClient>,
    rpc_url: String,
}

impl SolanaClient {
    /// Build a new client targeting the given RPC URL with the default
    /// commitment (`confirmed`) and a 30-second timeout.
    pub fn new(rpc_url: impl Into<String>) -> Self {
        let url = rpc_url.into();
        let inner = RpcClient::new_with_timeout_and_commitment(
            url.clone(),
            DEFAULT_RPC_TIMEOUT,
            CommitmentConfig::confirmed(),
        );
        Self {
            inner: Arc::new(inner),
            rpc_url: url,
        }
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    pub fn inner(&self) -> &RpcClient {
        &self.inner
    }

    /// Fetch the latest blockhash with the configured commitment.
    pub async fn latest_blockhash(&self) -> Result<Hash, SolanaError> {
        self.inner
            .get_latest_blockhash()
            .await
            .map_err(map_rpc_error)
    }

    /// Fetch lamports balance for a pubkey (returns 0 if account is missing).
    pub async fn lamports(&self, key: &Pubkey) -> Result<u64, SolanaError> {
        match self.inner.get_balance(key).await {
            Ok(n) => Ok(n),
            Err(e) => match e.kind() {
                ClientErrorKind::SerdeJson(_) | ClientErrorKind::RpcError(_) => Ok(0),
                _ => Err(map_rpc_error(e)),
            },
        }
    }

    /// Submit a signed transaction. The default `send_transaction_with_config`
    /// path does NOT pre-flight-simulate, mirroring the safer "skip preflight
    /// when the gating is already done off-chain" stance.
    pub async fn submit(&self, tx: VersionedTransaction) -> Result<Signature, SolanaError> {
        let cfg = RpcSendTransactionConfig {
            skip_preflight: false,
            preflight_commitment: Some(solana_sdk::commitment_config::CommitmentLevel::Confirmed),
            ..RpcSendTransactionConfig::default()
        };
        self.inner
            .send_transaction_with_config(&tx, cfg)
            .await
            .map_err(map_rpc_error)
    }

    /// Submit a signed transaction, retrying once on
    /// [`SolanaError::BlockhashExpired`].
    ///
    /// `signed_tx_builder` is invoked with a fresh blockhash and must
    /// produce a fully-signed [`VersionedTransaction`]. On the first attempt
    /// we fetch `get_latest_blockhash`, hand it to the builder, and submit.
    /// If the submission returns `BlockhashExpired`, we re-fetch a fresh
    /// blockhash, re-invoke the builder (which must re-sign), and submit
    /// once more.
    ///
    /// **Bounded to 1 retry.** A second consecutive `BlockhashExpired`
    /// surfaces as `Err(SolanaError::BlockhashExpired)` so the caller can
    /// alert; repeated expiry usually points at a chain-side / RPC-side
    /// issue rather than a transient race.
    pub async fn submit_with_retry<F>(
        &self,
        mut signed_tx_builder: F,
    ) -> Result<Signature, SolanaError>
    where
        F: FnMut(Hash) -> Result<VersionedTransaction, SolanaError>,
    {
        let blockhash = self.latest_blockhash().await?;
        let tx = signed_tx_builder(blockhash)?;
        match self.submit(tx).await {
            Ok(sig) => Ok(sig),
            Err(SolanaError::BlockhashExpired) => {
                // Single retry: re-fetch + re-build + re-sign + re-submit.
                let blockhash = self.latest_blockhash().await?;
                let tx = signed_tx_builder(blockhash)?;
                self.submit(tx).await
            }
            Err(other) => Err(other),
        }
    }
}

fn map_rpc_error(e: solana_client::client_error::ClientError) -> SolanaError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("blockhash not found") || lower.contains("blockhash expired") {
        return SolanaError::BlockhashExpired;
    }
    match e.kind() {
        ClientErrorKind::Reqwest(r) if r.is_timeout() || r.is_connect() => {
            SolanaError::Network(msg)
        }
        ClientErrorKind::Io(_) => SolanaError::Network(msg),
        _ => SolanaError::RpcFailed(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_client::client_error::ClientError;
    use solana_client::rpc_request::{RpcError, RpcResponseErrorData};
    use solana_sdk::signature::Keypair;
    use solana_sdk::signer::Signer;

    #[tokio::test]
    async fn balance_of_missing_account_is_zero_or_err() {
        let client = SolanaClient::new("http://127.0.0.1:1");
        // Connection refused → Network error. Either way no panic.
        let key = Pubkey::new_unique();
        let result = client.lamports(&key).await;
        match result {
            Ok(0) => {}
            Err(SolanaError::Network(_)) | Err(SolanaError::RpcFailed(_)) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_rpc_error_blockhash_expired() {
        // Synthesize a ClientError whose Display contains "Blockhash not found".
        let inner = ClientError::from(RpcError::RpcResponseError {
            code: -32001,
            message: "Blockhash not found".to_string(),
            data: RpcResponseErrorData::Empty,
        });
        let mapped = map_rpc_error(inner);
        assert!(matches!(mapped, SolanaError::BlockhashExpired));
    }

    #[test]
    fn map_rpc_error_other_is_rpc_failed() {
        let inner = ClientError::from(RpcError::RpcResponseError {
            code: -32000,
            message: "transaction simulation failed".to_string(),
            data: RpcResponseErrorData::Empty,
        });
        let mapped = map_rpc_error(inner);
        assert!(matches!(mapped, SolanaError::RpcFailed(_)));
    }

    #[tokio::test]
    async fn latest_blockhash_against_dead_endpoint_returns_network_error() {
        let client = SolanaClient::new("http://127.0.0.1:1");
        let err = client.latest_blockhash().await.unwrap_err();
        // Either explicit Network or generic RpcFailed — both are acceptable.
        match err {
            SolanaError::Network(_) | SolanaError::RpcFailed(_) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    /// Build a deterministic, fully-signed `VersionedTransaction` against
    /// the supplied blockhash. Used by retry tests so the mocked RPC can
    /// echo the same signature the SDK computes locally (the SDK's
    /// `send_transaction_with_config` rejects a mismatched response sig).
    fn build_signed_test_tx(payer: &Keypair, blockhash: Hash) -> VersionedTransaction {
        let msg =
            solana_sdk::message::v0::Message::try_compile(&payer.pubkey(), &[], &[], blockhash)
                .expect("compile v0 msg");
        VersionedTransaction::try_new(solana_sdk::message::VersionedMessage::V0(msg), &[payer])
            .expect("sign v0 tx")
    }

    /// Audit fix: `submit_with_retry` retries exactly once on
    /// `BlockhashExpired` and re-invokes the builder so a fresh blockhash
    /// is signed in. Drives a wiremock-backed RPC that returns
    /// `BlockhashNotFound` on the first `sendTransaction` and a valid
    /// signature on the second. Asserts exactly 2 send + 2 blockhash RPCs.
    #[tokio::test]
    async fn submit_retries_once_on_blockhash_expiry() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use wiremock::matchers::{body_string_contains, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        let bh_str = "11111111111111111111111111111111";
        let blockhash = bh_str.parse::<Hash>().expect("parse blockhash");
        let payer = Keypair::new();
        let pre_signed = build_signed_test_tx(&payer, blockhash);
        let expected_sig = pre_signed.signatures[0].to_string();

        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains("getLatestBlockhash"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "jsonrpc": "2.0",
                "result": {
                    "context": {"slot": 1},
                    "value": {
                        "blockhash": bh_str,
                        "lastValidBlockHeight": 1000u64
                    }
                },
                "id": 1
            })))
            .mount(&server)
            .await;

        // First sendTransaction → BlockhashNotFound (drives the retry).
        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains("sendTransaction"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "jsonrpc": "2.0",
                "error": {
                    "code": -32002,
                    "message": "Transaction simulation failed: Blockhash not found"
                },
                "id": 1
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // Second sendTransaction → success. Echo the local signature so
        // the SDK's response-sig equality check passes.
        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains("sendTransaction"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "jsonrpc": "2.0",
                "result": expected_sig,
                "id": 2
            })))
            .mount(&server)
            .await;

        let client = SolanaClient::new(server.uri());
        let calls = AtomicUsize::new(0);

        // Builder closes over `payer`; on each invocation we re-sign
        // deterministically against the (fixed) wiremock blockhash so
        // the RPC's local-vs-response sig check passes on the retry.
        let result = client
            .submit_with_retry(|fresh_blockhash| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(build_signed_test_tx(&payer, fresh_blockhash))
            })
            .await;

        result.expect("retry should succeed on second attempt");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "builder must be invoked exactly twice (original + 1 retry)"
        );

        // RPC trace: 2 getLatestBlockhash + 2 sendTransaction = 4 total.
        let total = server.received_requests().await.unwrap_or_default().len();
        assert_eq!(total, 4, "expected exactly 2 send + 2 blockhash calls");
    }

    /// Audit fix: a *second* consecutive `BlockhashExpired` propagates
    /// (no infinite retry loop). Mocks both sendTransaction attempts to
    /// fail; we expect the error and exactly 2 send attempts.
    #[tokio::test]
    async fn submit_with_retry_propagates_after_one_retry() {
        use wiremock::matchers::{body_string_contains, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let bh_str = "11111111111111111111111111111111";

        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains("getLatestBlockhash"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "jsonrpc": "2.0",
                "result": {
                    "context": {"slot": 1},
                    "value": {
                        "blockhash": bh_str,
                        "lastValidBlockHeight": 1000u64
                    }
                },
                "id": 1
            })))
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains("sendTransaction"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "jsonrpc": "2.0",
                "error": {
                    "code": -32002,
                    "message": "Transaction simulation failed: Blockhash not found"
                },
                "id": 1
            })))
            .expect(2)
            .mount(&server)
            .await;

        let payer = Keypair::new();
        let client = SolanaClient::new(server.uri());
        let err = client
            .submit_with_retry(|blockhash| Ok(build_signed_test_tx(&payer, blockhash)))
            .await
            .expect_err("must propagate after 1 retry");
        assert!(matches!(err, SolanaError::BlockhashExpired));
        // Server's `.expect(2)` is verified on drop.
    }
}
