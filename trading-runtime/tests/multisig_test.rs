//! Validator fan-out test — spawns multiple validator HTTP servers,
//! sends a validation request to all, and verifies that 2-of-3
//! signatures pass on-chain verification.
//!
//! Requires `forge build` to have been run first (reads bytecode from contracts/out/).

use alloy::node_bindings::Anvil;
use alloy::primitives::{Address, Bytes, FixedBytes, TxKind, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::network::EthereumWallet;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use trading_runtime::validator_client::ValidatorClient;

/// Read compiled contract bytecode from forge output artifacts.
fn load_bytecode(contract_name: &str) -> Vec<u8> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let out_dir = format!("{manifest_dir}/../contracts/out");

    let primary = format!("{out_dir}/{contract_name}.sol/{contract_name}.json");
    let fallback = format!("{out_dir}/Setup.sol/{contract_name}.json");

    let path = if std::path::Path::new(&primary).exists() {
        primary
    } else if std::path::Path::new(&fallback).exists() {
        fallback
    } else {
        panic!("Cannot find artifact for {contract_name} in {out_dir}. Run `forge build` first.");
    };

    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let bytecode_hex = json["bytecode"]["object"]
        .as_str()
        .expect("bytecode.object missing")
        .strip_prefix("0x")
        .expect("bytecode should start with 0x");
    hex::decode(bytecode_hex).expect("invalid bytecode hex")
}

sol! {
    #[sol(rpc)]
    interface TradeValidator {
        function transferOwnership(address newOwner) external;
        function acceptOwnership() external;
        function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external;
        function validateWithSignatures(
            bytes32 intentHash, address vault, bytes[] calldata signatures,
            uint256[] calldata scores, uint256 deadline
        ) external view returns (bool approved, uint256 validCount);
        function getRequiredSignatures(address vault) external view returns (uint256);
    }
}

async fn deploy_contract(
    provider: &impl Provider,
    bytecode: Vec<u8>,
    constructor_args: Vec<u8>,
) -> Address {
    let mut deploy_data = bytecode;
    deploy_data.extend_from_slice(&constructor_args);
    let mut tx = alloy::rpc::types::TransactionRequest::default()
        .input(alloy::rpc::types::TransactionInput::both(Bytes::from(deploy_data)));
    tx.to = Some(TxKind::Create);
    let pending = provider.send_transaction(tx).await.expect("deploy tx send failed");
    let receipt = pending.get_receipt().await.expect("deploy tx receipt failed");
    receipt.contract_address.expect("no contract address in receipt")
}

#[tokio::test]
async fn test_multisig_validator_fanout() {
    // ── 1. Start Anvil ──────────────────────────────────────────────────────
    let anvil = Anvil::new().try_spawn().expect("Failed to spawn Anvil");
    let rpc_url = anvil.endpoint();

    let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
    let _deployer_addr = deployer_key.address();

    // 3 validator keys
    let val1_key: PrivateKeySigner = anvil.keys()[3].clone().into();
    let val2_key: PrivateKeySigner = anvil.keys()[4].clone().into();
    let val3_key: PrivateKeySigner = anvil.keys()[5].clone().into();

    let val1_addr = val1_key.address();
    let val2_addr = val2_key.address();
    let val3_addr = val3_key.address();

    let deployer_wallet = EthereumWallet::from(deployer_key.clone());
    let deployer_provider = ProviderBuilder::new()
        .wallet(deployer_wallet)
        .connect_http(rpc_url.parse().unwrap());

    // ── 2. Deploy TradeValidator ────────────────────────────────────────────
    let tv_addr = deploy_contract(
        &deployer_provider,
        load_bytecode("TradeValidator"),
        vec![],
    ).await;

    let tv = TradeValidator::new(tv_addr, &deployer_provider);

    // Configure vault signers (using deployer_addr as a mock vault)
    let mock_vault_addr = Address::from([0xAA; 20]);
    tv.configureVault(
        mock_vault_addr,
        vec![val1_addr, val2_addr, val3_addr],
        U256::from(2),
    )
    .send()
    .await
    .unwrap()
    .get_receipt()
    .await
    .unwrap();

    let req_sigs = tv.getRequiredSignatures(mock_vault_addr).call().await.unwrap();
    assert_eq!(req_sigs, U256::from(2), "Should require 2-of-3");

    // ── 3. Spawn 3 validator HTTP servers on random ports ────────────────────
    let val1_hex = hex::encode(anvil.keys()[3].to_bytes());
    let val2_hex = hex::encode(anvil.keys()[4].to_bytes());
    let val3_hex = hex::encode(anvil.keys()[5].to_bytes());

    let mut endpoints = Vec::new();

    for (key_hex, _addr) in [
        (val1_hex.as_str(), val1_addr),
        (val2_hex.as_str(), val2_addr),
        (val3_hex.as_str(), val3_addr),
    ] {
        let server = trading_validator_lib::server::ValidatorServer::new(0)
            .without_ai()
            .with_signer(key_hex, 31337, tv_addr)
            .expect("Signer creation should succeed");

        let router = server.router();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let port = listener.local_addr().unwrap().port();
        endpoints.push(format!("http://127.0.0.1:{port}"));

        tokio::spawn(async move {
            axum::serve(listener, router).await.ok();
        });
    }

    // Small delay to let servers start
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // ── 4. Fan out validation request ───────────────────────────────────────
    let client = ValidatorClient::new(endpoints, 50);

    let intent = trading_runtime::TradeIntentBuilder::new()
        .strategy_id("test-multisig")
        .action(trading_runtime::Action::Swap)
        .token_in("0x0000000000000000000000000000000000000001")
        .token_out("0x0000000000000000000000000000000000000002")
        .amount_in(rust_decimal::Decimal::new(1000, 0))
        .min_amount_out(rust_decimal::Decimal::new(950, 0))
        .target_protocol("uniswap_v3")
        .build()
        .unwrap();

    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;

    let result = client
        .validate(&intent, &format!("{mock_vault_addr}"), deadline)
        .await
        .expect("Validation should succeed");

    assert_eq!(result.validator_responses.len(), 3, "All 3 validators should respond");

    // All validators should have produced real (non-zero) signatures
    for resp in &result.validator_responses {
        assert!(resp.signature.starts_with("0x"), "Signature should be hex");
        let zero_sig = format!("0x{}", "00".repeat(65));
        assert_ne!(resp.signature, zero_sig, "Signature should not be all zeros");
        assert_eq!(
            resp.signature.len(),
            2 + 65 * 2,
            "Signature should be 65 bytes (130 hex chars + 0x)"
        );
    }

    // ── 5. Submit signatures to on-chain TradeValidator for verification ─────
    let intent_hash_hex = &result.intent_hash;
    let intent_hash_stripped = intent_hash_hex.strip_prefix("0x").unwrap_or(intent_hash_hex);
    let intent_hash_bytes = hex::decode(intent_hash_stripped).unwrap();
    let mut intent_hash = [0u8; 32];
    intent_hash.copy_from_slice(&intent_hash_bytes);
    let intent_hash_fixed = FixedBytes::<32>::from(intent_hash);

    // Take first 2 signatures (2-of-3 should be enough)
    let mut signatures = Vec::new();
    let mut scores = Vec::new();
    for resp in result.validator_responses.iter().take(2) {
        let sig_hex = resp.signature.strip_prefix("0x").unwrap_or(&resp.signature);
        let sig_bytes = hex::decode(sig_hex).unwrap();
        signatures.push(Bytes::from(sig_bytes));
        scores.push(U256::from(resp.score));
    }

    let on_chain_result = tv
        .validateWithSignatures(
            intent_hash_fixed,
            mock_vault_addr,
            signatures,
            scores,
            U256::from(deadline),
        )
        .call()
        .await
        .unwrap();

    assert!(on_chain_result.approved, "On-chain validation should pass with 2-of-3 sigs");
    assert_eq!(
        on_chain_result.validCount,
        U256::from(2),
        "Should have 2 valid signatures"
    );
}
