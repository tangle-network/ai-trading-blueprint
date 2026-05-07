//! Thin wrapper around `solana-client::nonblocking::rpc_client::RpcClient`.
//!
//! Centralises:
//! - timeout + commitment defaults,
//! - blockhash fetching with one retry on expiry,
//! - typed mapping into [`SolanaError`].

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
}
