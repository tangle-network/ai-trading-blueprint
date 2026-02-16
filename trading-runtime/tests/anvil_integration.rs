//! Anvil integration test — full lifecycle against a local Anvil instance.
//!
//! Deploys all contracts, creates vault, deposits, encodes a trade via adapter,
//! signs with validator keys, submits via vault.execute(), verifies balances.
//!
//! Requires `forge build` to have been run first (reads bytecode from contracts/out/).

use alloy::node_bindings::Anvil;
use alloy::primitives::{Address, Bytes, FixedBytes, TxKind, U256, keccak256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::network::EthereumWallet;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolCall;

/// Read compiled contract bytecode from forge output artifacts.
///
/// Searches `contracts/out/<SolFile>.sol/<ContractName>.json` — handles
/// contracts defined in their own file (e.g. `TradingVault.sol/TradingVault.json`)
/// and helpers defined in `Setup.sol` (e.g. `Setup.sol/MockERC20.json`).
fn load_bytecode(contract_name: &str) -> Vec<u8> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let out_dir = format!("{manifest_dir}/../contracts/out");

    // Try <ContractName>.sol/<ContractName>.json first
    let primary = format!("{out_dir}/{contract_name}.sol/{contract_name}.json");
    // Then try Setup.sol/<ContractName>.json (for test helpers)
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

// ABI-only bindings for contracts we deploy via raw bytecode
sol! {
    #[sol(rpc)]
    interface MockERC20 {
        function mint(address to, uint256 amount) external;
        function approve(address spender, uint256 amount) external returns (bool);
        function balanceOf(address account) external view returns (uint256);
    }

    #[sol(rpc)]
    interface MockTarget {
        function swap(address to, uint256 outputAmount) external payable;
    }

    #[sol(rpc)]
    interface PolicyEngine {
        function transferOwnership(address newOwner) external;
        function acceptOwnership() external;
        function setWhitelist(address vault, address[] calldata tokens, bool allowed) external;
        function setTargetWhitelist(address vault, address[] calldata targets, bool allowed) external;
        function setPositionLimit(address vault, address token, uint256 maxAmount) external;
        function isInitialized(address vault) external view returns (bool);
    }

    #[sol(rpc)]
    interface TradeValidator {
        function transferOwnership(address newOwner) external;
        function acceptOwnership() external;
        function getRequiredSignatures(address vault) external view returns (uint256);
        function computeDigest(
            bytes32 intentHash, address vault, uint256 score, uint256 deadline
        ) external view returns (bytes32);
    }

    #[sol(rpc)]
    interface VaultFactory {
        function createVault(
            uint64 serviceId, address assetToken, address admin, address operator,
            address[] calldata signers, uint256 requiredSigs,
            string calldata name, string calldata symbol, bytes32 salt
        ) external returns (address vault, address shareToken);
    }

    #[sol(rpc)]
    interface TradingVault {
        struct ExecuteParams {
            address target;
            bytes data;
            uint256 value;
            uint256 minOutput;
            address outputToken;
            bytes32 intentHash;
            uint256 deadline;
        }

        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
        function execute(ExecuteParams calldata params, bytes[] calldata signatures, uint256[] calldata scores) external;
        function totalAssets() external view returns (uint256);
        function getBalance(address token) external view returns (uint256);
    }

    #[sol(rpc)]
    interface VaultShare {
        function balanceOf(address account) external view returns (uint256);
    }
}

/// Deploy a contract from forge artifacts. Returns the deployed address.
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
async fn test_full_lifecycle_on_anvil() {
    // ── 1. Start Anvil ──────────────────────────────────────────────────────
    let anvil = Anvil::new().try_spawn().expect("Failed to spawn Anvil — is it installed?");
    let rpc_url = anvil.endpoint();

    // Anvil provides 10 funded accounts. We'll use:
    // [0] = deployer/owner, [1] = user, [2] = operator
    // [3..6] = validator keys
    let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
    let user_key: PrivateKeySigner = anvil.keys()[1].clone().into();
    let operator_key: PrivateKeySigner = anvil.keys()[2].clone().into();
    let validator1_key: PrivateKeySigner = anvil.keys()[3].clone().into();
    let validator2_key: PrivateKeySigner = anvil.keys()[4].clone().into();
    let _validator3_key: PrivateKeySigner = anvil.keys()[5].clone().into();

    let deployer_addr = deployer_key.address();
    let user_addr = user_key.address();
    let operator_addr = operator_key.address();
    let val1_addr = validator1_key.address();
    let val2_addr = validator2_key.address();
    let val3_addr = _validator3_key.address();

    let deployer_wallet = EthereumWallet::from(deployer_key.clone());
    let deployer_provider = ProviderBuilder::new()
        .wallet(deployer_wallet)
        .connect_http(rpc_url.parse().unwrap());

    // ── 2. Deploy MockERC20 tokens ──────────────────────────────────────────
    // MockERC20 constructor: (string name, string symbol, uint8 decimals)
    // Note: uint8 is ABI-encoded as uint256
    let mock_erc20_bytecode = load_bytecode("MockERC20");

    let token_a_args = alloy::sol_types::SolValue::abi_encode(&(
        "Token A".to_string(),
        "TKA".to_string(),
        U256::from(18u8), // decimals as uint256
    ));
    let token_a_addr = deploy_contract(&deployer_provider, mock_erc20_bytecode.clone(), token_a_args).await;

    let token_b_args = alloy::sol_types::SolValue::abi_encode(&(
        "Token B".to_string(),
        "TKB".to_string(),
        U256::from(18u8),
    ));
    let token_b_addr = deploy_contract(&deployer_provider, mock_erc20_bytecode, token_b_args).await;

    let token_a = MockERC20::new(token_a_addr, &deployer_provider);

    // Mint tokens
    let million = U256::from(1_000_000u64) * U256::from(10u64).pow(U256::from(18));
    token_a.mint(deployer_addr, million).send().await.unwrap().get_receipt().await.unwrap();
    token_a.mint(user_addr, million).send().await.unwrap().get_receipt().await.unwrap();
    token_a.mint(operator_addr, million).send().await.unwrap().get_receipt().await.unwrap();

    let token_b = MockERC20::new(token_b_addr, &deployer_provider);
    token_b.mint(deployer_addr, million).send().await.unwrap().get_receipt().await.unwrap();

    // ── 3. Deploy MockTarget ────────────────────────────────────────────────
    let mock_target_bytecode = load_bytecode("MockTarget");
    let target_args = alloy::sol_types::SolValue::abi_encode(&(token_b_addr,));
    let mock_target_addr = deploy_contract(&deployer_provider, mock_target_bytecode, target_args).await;

    // ── 4. Deploy core contracts ────────────────────────────────────────────
    let policy_engine_addr = deploy_contract(
        &deployer_provider,
        load_bytecode("PolicyEngine"),
        vec![],
    ).await;

    let trade_validator_addr = deploy_contract(
        &deployer_provider,
        load_bytecode("TradeValidator"),
        vec![],
    ).await;

    let fd_args = alloy::sol_types::SolValue::abi_encode(&(deployer_addr,));
    let fee_distributor_addr = deploy_contract(
        &deployer_provider,
        load_bytecode("FeeDistributor"),
        fd_args,
    ).await;

    let vf_args = alloy::sol_types::SolValue::abi_encode(&(
        policy_engine_addr,
        trade_validator_addr,
        fee_distributor_addr,
    ));
    let vault_factory_addr = deploy_contract(
        &deployer_provider,
        load_bytecode("VaultFactory"),
        vf_args,
    ).await;

    // ── 5. Transfer ownership to factory ────────────────────────────────────
    let policy = PolicyEngine::new(policy_engine_addr, &deployer_provider);
    let validator_contract = TradeValidator::new(trade_validator_addr, &deployer_provider);

    policy.transferOwnership(vault_factory_addr).send().await.unwrap().get_receipt().await.unwrap();

    // Factory needs to accept ownership — impersonate factory via anvil
    // Fund the factory address so it can pay gas for impersonated transactions
    let _: () = deployer_provider
        .raw_request("anvil_setBalance".into(), &[
            serde_json::to_value(vault_factory_addr).unwrap(),
            serde_json::to_value(U256::from(10u64).pow(U256::from(18)).to_string()).unwrap(),
        ])
        .await
        .unwrap();
    let _: () = deployer_provider
        .raw_request("anvil_impersonateAccount".into(), &[serde_json::to_value(vault_factory_addr).unwrap()])
        .await
        .unwrap();

    let factory_provider = ProviderBuilder::new()
        .connect_http(rpc_url.parse().unwrap());

    let accept_call = PolicyEngine::acceptOwnershipCall {};
    let tx = alloy::rpc::types::TransactionRequest::default()
        .to(policy_engine_addr)
        .from(vault_factory_addr)
        .input(Bytes::from(accept_call.abi_encode()).into());
    factory_provider.send_transaction(tx).await.unwrap().get_receipt().await.unwrap();

    validator_contract.transferOwnership(vault_factory_addr).send().await.unwrap().get_receipt().await.unwrap();

    let accept_call2 = TradeValidator::acceptOwnershipCall {};
    let tx2 = alloy::rpc::types::TransactionRequest::default()
        .to(trade_validator_addr)
        .from(vault_factory_addr)
        .input(Bytes::from(accept_call2.abi_encode()).into());
    factory_provider.send_transaction(tx2).await.unwrap().get_receipt().await.unwrap();

    let _: () = deployer_provider
        .raw_request("anvil_stopImpersonatingAccount".into(), &[serde_json::to_value(vault_factory_addr).unwrap()])
        .await
        .unwrap();

    // ── 6. Create vault via factory ─────────────────────────────────────────
    let factory = VaultFactory::new(vault_factory_addr, &deployer_provider);
    let salt = FixedBytes::<32>::from(keccak256("test-lifecycle-salt"));

    // Use call() to get return values, then send() to actually deploy
    let call_result = factory
        .createVault(
            1u64,
            token_a_addr,
            deployer_addr,
            operator_addr,
            vec![val1_addr, val2_addr, val3_addr],
            U256::from(2),
            "Test Vault Shares".to_string(),
            "tvSHR".to_string(),
            salt,
        )
        .call()
        .await
        .unwrap();

    let vault_addr: Address = call_result.vault;
    let share_addr: Address = call_result.shareToken;

    // Actually deploy
    let deploy_receipt = factory
        .createVault(
            1u64,
            token_a_addr,
            deployer_addr,
            operator_addr,
            vec![val1_addr, val2_addr, val3_addr],
            U256::from(2),
            "Test Vault Shares".to_string(),
            "tvSHR".to_string(),
            salt,
        )
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();

    assert!(deploy_receipt.status(), "createVault should succeed");
    assert_ne!(vault_addr, Address::ZERO, "vault address should be non-zero");
    assert_ne!(share_addr, Address::ZERO, "share address should be non-zero");

    // Verify setup
    let initialized = PolicyEngine::new(policy_engine_addr, &deployer_provider)
        .isInitialized(vault_addr)
        .call()
        .await
        .unwrap();
    assert!(initialized, "Policy should be initialized for vault");

    let req_sigs = TradeValidator::new(trade_validator_addr, &deployer_provider)
        .getRequiredSignatures(vault_addr)
        .call()
        .await
        .unwrap();
    assert_eq!(req_sigs, U256::from(2), "Should require 2-of-3 signatures");

    // ── 7. Configure policy — whitelist tokens and target ────────────────────
    let _: () = deployer_provider
        .raw_request("anvil_impersonateAccount".into(), &[serde_json::to_value(vault_factory_addr).unwrap()])
        .await
        .unwrap();

    // Fresh provider to avoid stale nonce cache from first impersonation block
    let factory_provider2 = ProviderBuilder::new()
        .connect_http(rpc_url.parse().unwrap());

    let whitelist_call = PolicyEngine::setWhitelistCall {
        vault: vault_addr,
        tokens: vec![token_a_addr, token_b_addr],
        allowed: true,
    };
    let tx = alloy::rpc::types::TransactionRequest::default()
        .to(policy_engine_addr)
        .from(vault_factory_addr)
        .input(Bytes::from(whitelist_call.abi_encode()).into());
    factory_provider2.send_transaction(tx).await.unwrap().get_receipt().await.unwrap();

    let target_call = PolicyEngine::setTargetWhitelistCall {
        vault: vault_addr,
        targets: vec![mock_target_addr],
        allowed: true,
    };
    let tx = alloy::rpc::types::TransactionRequest::default()
        .to(policy_engine_addr)
        .from(vault_factory_addr)
        .input(Bytes::from(target_call.abi_encode()).into());
    factory_provider2.send_transaction(tx).await.unwrap().get_receipt().await.unwrap();

    let e18 = U256::from(10u64).pow(U256::from(18));
    for token in [token_a_addr, token_b_addr] {
        let limit_call = PolicyEngine::setPositionLimitCall {
            vault: vault_addr,
            token,
            maxAmount: U256::from(100_000u64) * e18,
        };
        let tx = alloy::rpc::types::TransactionRequest::default()
            .to(policy_engine_addr)
            .from(vault_factory_addr)
            .input(Bytes::from(limit_call.abi_encode()).into());
        factory_provider2.send_transaction(tx).await.unwrap().get_receipt().await.unwrap();
    }

    let _: () = deployer_provider
        .raw_request("anvil_stopImpersonatingAccount".into(), &[serde_json::to_value(vault_factory_addr).unwrap()])
        .await
        .unwrap();

    // ── 8. User deposits via ERC-4626 ───────────────────────────────────────
    let user_wallet = EthereumWallet::from(user_key.clone());
    let user_provider = ProviderBuilder::new()
        .wallet(user_wallet)
        .connect_http(rpc_url.parse().unwrap());

    let deposit_amount = U256::from(10_000u64) * e18;

    let user_token_a = MockERC20::new(token_a_addr, &user_provider);
    user_token_a.approve(vault_addr, deposit_amount).send().await.unwrap().get_receipt().await.unwrap();

    let vault_as_user = TradingVault::new(vault_addr, &user_provider);
    let deposit_receipt = vault_as_user.deposit(deposit_amount, user_addr).send().await.unwrap().get_receipt().await.unwrap();
    assert!(deposit_receipt.status(), "deposit should succeed");

    let vault_read = TradingVault::new(vault_addr, &deployer_provider);
    let total_assets: U256 = vault_read.totalAssets().call().await.unwrap();
    assert_eq!(total_assets, deposit_amount, "Vault should hold deposited assets");

    let share_token = VaultShare::new(share_addr, &deployer_provider);
    let user_shares: U256 = share_token.balanceOf(user_addr).call().await.unwrap();
    assert_eq!(user_shares, deposit_amount, "First deposit should be 1:1");

    // ── 9. Execute trade with EIP-712 signatures ────────────────────────────
    let expected_output = U256::from(950u64) * e18;

    let intent_hash = keccak256(
        alloy::sol_types::SolValue::abi_encode(&(
            token_a_addr,
            U256::from(1000u64) * e18,
            mock_target_addr,
            U256::from(20000u64),
        ))
    );

    let block_num = deployer_provider.get_block_number().await.unwrap();
    let block_info = deployer_provider.get_block_by_number(block_num.into()).await.unwrap().unwrap();
    let deadline = U256::from(block_info.header.timestamp + 3600);

    let scores = vec![U256::from(85u64), U256::from(75u64)];

    // Compute EIP-712 digest using on-chain computeDigest
    let tv = TradeValidator::new(trade_validator_addr, &deployer_provider);
    let digest1: FixedBytes<32> = tv.computeDigest(intent_hash, vault_addr, scores[0], deadline).call().await.unwrap();
    let digest2: FixedBytes<32> = tv.computeDigest(intent_hash, vault_addr, scores[1], deadline).call().await.unwrap();

    // Sign digests with validator private keys
    use alloy::signers::SignerSync;
    let sig1 = validator1_key.sign_hash_sync(&digest1).unwrap();
    let sig2 = validator2_key.sign_hash_sync(&digest2).unwrap();

    let sig1_bytes = Bytes::from(sig1.as_bytes().to_vec());
    let sig2_bytes = Bytes::from(sig2.as_bytes().to_vec());

    // Build swap calldata: MockTarget.swap(vault_addr, expectedOutput)
    let swap_call = MockTarget::swapCall {
        to: vault_addr,
        outputAmount: expected_output,
    };
    let swap_data = Bytes::from(swap_call.abi_encode());

    let params = TradingVault::ExecuteParams {
        target: mock_target_addr,
        data: swap_data,
        value: U256::ZERO,
        minOutput: U256::from(900u64) * e18,
        outputToken: token_b_addr,
        intentHash: intent_hash,
        deadline,
    };

    // Execute as operator
    let operator_wallet = EthereumWallet::from(operator_key.clone());
    let operator_provider = ProviderBuilder::new()
        .wallet(operator_wallet)
        .connect_http(rpc_url.parse().unwrap());

    let vault_as_operator = TradingVault::new(vault_addr, &operator_provider);
    let exec_receipt = vault_as_operator
        .execute(params, vec![sig1_bytes, sig2_bytes], scores)
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();

    assert!(exec_receipt.status(), "execute should succeed");

    // Verify trade output
    let token_b_balance: U256 = vault_read.getBalance(token_b_addr).call().await.unwrap();
    assert_eq!(token_b_balance, expected_output, "Vault should hold output tokens");

    // ── 10. Redeem shares ───────────────────────────────────────────────────
    let shares_to_redeem = user_shares / U256::from(2);
    let user_bal_before: U256 = MockERC20::new(token_a_addr, &user_provider)
        .balanceOf(user_addr).call().await.unwrap();

    let redeem_receipt = vault_as_user
        .redeem(shares_to_redeem, user_addr, user_addr)
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    assert!(redeem_receipt.status(), "redeem should succeed");

    let user_bal_after: U256 = MockERC20::new(token_a_addr, &user_provider)
        .balanceOf(user_addr).call().await.unwrap();
    assert!(user_bal_after > user_bal_before, "User should have received assets back");

    let remaining_shares: U256 = share_token.balanceOf(user_addr).call().await.unwrap();
    assert_eq!(remaining_shares, user_shares - shares_to_redeem, "Shares should be burned");
}
