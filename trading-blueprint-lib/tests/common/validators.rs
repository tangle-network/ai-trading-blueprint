//! Start real `ValidatorServer` instances backed by real EIP-712 signers.
//!
//! No mocking — each server runs the full scoring + signing pipeline. If
//! an `AiProvider` is passed the servers will call real AI scoring, otherwise
//! they fall back to policy-only scoring.

use alloy::primitives::Address;
use alloy::signers::local::PrivateKeySigner;
use trading_runtime::validator_client::ValidatorClient;
use trading_validator_lib::risk_evaluator::AiProvider;

/// A running validator cluster with on-chain contract address and HTTP endpoints.
pub struct ValidatorCluster {
    /// TradeValidator contract address on the Anvil instance.
    pub contract_address: Address,
    /// Mock vault address configured on-chain for multisig.
    pub vault_address: Address,
    /// HTTP endpoints for each validator server (e.g. `http://127.0.0.1:PORT`).
    pub endpoints: Vec<String>,
    /// Validator Ethereum addresses corresponding to each endpoint.
    pub validator_addresses: Vec<Address>,
    /// Pre-configured `ValidatorClient` pointing at all endpoints.
    pub client: ValidatorClient,
}

/// Spawn real `ValidatorServer` instances, each with its own EIP-712 signer.
///
/// `key_bytes` — raw 32-byte private keys for each validator (from
///               `anvil.keys()[3..]` converted via `.to_bytes()`).
/// `contract_address` — deployed TradeValidator contract address.
/// `vault_address` — vault address configured on the contract.
/// `ai_provider` — if `Some`, every server uses real AI scoring.
pub async fn start_validator_cluster(
    key_bytes: &[Vec<u8>],
    contract_address: Address,
    vault_address: Address,
    ai_provider: Option<AiProvider>,
) -> ValidatorCluster {
    let mut endpoints = Vec::new();
    let mut validator_addresses = Vec::new();

    for raw_key in key_bytes {
        let key_hex = hex::encode(raw_key);
        let key: PrivateKeySigner = key_hex.parse().expect("valid private key");
        let addr = key.address();
        validator_addresses.push(addr);

        let mut server = trading_validator_lib::server::ValidatorServer::new(0)
            .with_signer(&key_hex, 31337, contract_address)
            .expect("Signer creation should succeed");

        // Explicitly set AI provider — ValidatorServer::new() reads AI_API_KEY
        // from env, which may be set from .env. Override with what the caller
        // actually wants.
        match &ai_provider {
            Some(provider) => server = server.with_ai_provider(provider.clone()),
            None => server.ai_provider = None,
        }

        let router = server.router();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind validator listener");
        let port = listener.local_addr().unwrap().port();
        endpoints.push(format!("http://127.0.0.1:{port}"));

        tokio::spawn(async move {
            axum::serve(listener, router).await.ok();
        });
    }

    // Let servers start
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Build client with timeout appropriate for AI scoring if enabled
    let timeout_secs = if ai_provider.is_some() { 120 } else { 10 };
    let client = ValidatorClient::new(endpoints.clone(), 50)
        .with_timeout(std::time::Duration::from_secs(timeout_secs));

    ValidatorCluster {
        contract_address,
        vault_address,
        endpoints,
        validator_addresses,
        client,
    }
}
