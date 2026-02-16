//! Deploy on-chain contracts to an Anvil instance.
//!
//! Follows the exact pattern from `trading-runtime/tests/multisig_test.rs`.

use alloy::primitives::{Address, Bytes, TxKind, U256};
use alloy::providers::Provider;
use alloy::sol;

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

/// Read compiled contract bytecode from forge output artifacts.
pub fn load_bytecode(contract_name: &str) -> Vec<u8> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let out_dir = format!("{manifest_dir}/../contracts/out");

    let primary = format!("{out_dir}/{contract_name}.sol/{contract_name}.json");
    let fallback = format!("{out_dir}/Setup.sol/{contract_name}.json");

    let path = if std::path::Path::new(&primary).exists() {
        primary
    } else if std::path::Path::new(&fallback).exists() {
        fallback
    } else {
        panic!(
            "Cannot find artifact for {contract_name} in {out_dir}. Run `forge build` first."
        );
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

/// Deploy a contract to the provider, returning its address.
pub async fn deploy_contract(
    provider: &impl Provider,
    bytecode: Vec<u8>,
    constructor_args: Vec<u8>,
) -> Address {
    let mut deploy_data = bytecode;
    deploy_data.extend_from_slice(&constructor_args);
    let mut tx = alloy::rpc::types::TransactionRequest::default()
        .input(alloy::rpc::types::TransactionInput::both(Bytes::from(
            deploy_data,
        )));
    tx.to = Some(TxKind::Create);
    let pending = provider
        .send_transaction(tx)
        .await
        .expect("deploy tx send failed");
    let receipt = pending
        .get_receipt()
        .await
        .expect("deploy tx receipt failed");
    receipt
        .contract_address
        .expect("no contract address in receipt")
}

/// Deploy TradeValidator and configure a multi-sig vault.
///
/// Returns `(trade_validator_address, vault_address)`.
pub async fn deploy_trade_validator(
    provider: &impl Provider,
    signers: Vec<Address>,
    required_sigs: u64,
) -> (Address, Address) {
    let tv_addr = deploy_contract(provider, load_bytecode("TradeValidator"), vec![]).await;

    let vault_address = Address::from([0xAA; 20]);

    let tv = TradeValidator::new(tv_addr, provider);
    tv.configureVault(
        vault_address,
        signers,
        U256::from(required_sigs),
    )
    .send()
    .await
    .expect("configureVault send")
    .get_receipt()
    .await
    .expect("configureVault receipt");

    // Verify
    let req_sigs = tv
        .getRequiredSignatures(vault_address)
        .call()
        .await
        .expect("getRequiredSignatures");
    assert_eq!(
        req_sigs,
        U256::from(required_sigs),
        "Required signatures mismatch"
    );

    (tv_addr, vault_address)
}
