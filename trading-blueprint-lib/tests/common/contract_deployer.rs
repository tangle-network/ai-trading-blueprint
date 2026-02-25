//! Deploy on-chain contracts to an Anvil instance.
//!
//! Provides both minimal TradeValidator-only deployment (for tests that just
//! need signature verification) and full trade stack deployment (for tests
//! that exercise vault.execute(), fee settlement, etc.).

use alloy::primitives::{Address, Bytes, FixedBytes, TxKind, U256};
use alloy::providers::Provider;
use alloy::sol;
use alloy::sol_types::SolValue;

// ── TradeValidator interface ────────────────────────────────────────────────

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
        function computeDigest(bytes32 intentHash, address vault, uint256 score, uint256 deadline) external view returns (bytes32);
    }
}

// ── PolicyEngine interface ──────────────────────────────────────────────────

sol! {
    #[sol(rpc)]
    interface PolicyEngine {
        function initializeVault(address vault, uint256 leverageCap, uint256 maxTrades, uint256 maxSlippage) external;
        function setWhitelist(address vault, address[] calldata tokens, bool allowed) external;
        function setTargetWhitelist(address vault, address[] calldata targets, bool allowed) external;
        function setPositionLimit(address vault, address token, uint256 maxAmount) external;
        function setLeverageCap(address vault, uint256 cap) external;
        function validateTrade(address vault, address token, uint256 amount, address target, uint256 leverage) external returns (bool);
        function isInitialized(address vault) external view returns (bool);
    }
}

// ── FeeDistributor interface ────────────────────────────────────────────────

sol! {
    #[sol(rpc)]
    interface FeeDistributor {
        function settleFees(address vault, address feeToken) external returns (uint256 perfFee, uint256 mgmtFee);
        function highWaterMark(address vault) external view returns (uint256);
        function lastSettled(address vault) external view returns (uint256);
        function accumulatedFees(address token) external view returns (uint256);
        function validatorFees(address token) external view returns (uint256);
        function performanceFeeBps() external view returns (uint256);
        function managementFeeBps() external view returns (uint256);
        function validatorFeeShareBps() external view returns (uint256);
        function withdrawFees(address token, uint256 amount) external;
    }
}

// ── TradingVault interface ──────────────────────────────────────────────────

sol! {
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
        function withdraw(uint256 assets, address receiver, address owner_) external returns (uint256 shares);
        function redeem(uint256 shares, address receiver, address owner_) external returns (uint256 assets);
        function execute(ExecuteParams calldata params, bytes[] calldata signatures, uint256[] calldata scores) external;
        function totalAssets() external view returns (uint256);
        function asset() external view returns (address);
        function getBalance(address token) external view returns (uint256);
        function emergencyWithdraw(address token, address to) external;
        function pause() external;
        function unpause() external;
        function convertToShares(uint256 assets) external view returns (uint256);
        function convertToAssets(uint256 shares) external view returns (uint256);
    }
}

// ── VaultShare interface ────────────────────────────────────────────────────

sol! {
    #[sol(rpc)]
    interface VaultShare {
        function grantRole(bytes32 role, address account) external;
        function linkVault(address vault) external;
        function balanceOf(address account) external view returns (uint256);
        function totalSupply() external view returns (uint256);
    }
}

// ── MockERC20 interface ─────────────────────────────────────────────────────

sol! {
    #[sol(rpc)]
    interface MockERC20 {
        function mint(address to, uint256 amount) external;
        function balanceOf(address account) external view returns (uint256);
        function approve(address spender, uint256 amount) external returns (bool);
    }
}

// ── MockTarget interface ────────────────────────────────────────────────────

sol! {
    #[sol(rpc)]
    interface MockTarget {
        function swap(address to, uint256 outputAmount) external payable;
    }
}

// ── Role constants ──────────────────────────────────────────────────────────

/// `keccak256("MINTER_ROLE")` — VaultShare role for minting shares.
pub fn minter_role() -> FixedBytes<32> {
    alloy::primitives::keccak256(b"MINTER_ROLE")
}

// ── Bytecode loading ────────────────────────────────────────────────────────

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

// ── Contract deployment ─────────────────────────────────────────────────────

/// Deploy a contract to the provider, returning its address.
pub async fn deploy_contract(
    provider: &impl Provider,
    bytecode: Vec<u8>,
    constructor_args: Vec<u8>,
) -> Address {
    let mut deploy_data = bytecode;
    deploy_data.extend_from_slice(&constructor_args);
    // Use `new()` instead of `both()` to avoid duplicate `data`/`input` fields
    // in the JSON — some Anvil versions (e.g. Docker container) reject `both()`.
    let mut tx = alloy::rpc::types::TransactionRequest::default().input(
        alloy::rpc::types::TransactionInput::new(Bytes::from(deploy_data)),
    );
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

// ── Minimal TradeValidator deployment ───────────────────────────────────────

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
    tv.configureVault(vault_address, signers, U256::from(required_sigs))
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

// ── Full Trade Stack deployment ─────────────────────────────────────────────

/// All deployed contract addresses from a full trade stack deployment.
#[derive(Debug, Clone)]
pub struct FullTradeStack {
    pub token_a: Address,
    pub token_b: Address,
    pub policy_engine: Address,
    pub trade_validator: Address,
    pub fee_distributor: Address,
    pub vault_share: Address,
    pub vault: Address,
    pub mock_target: Address,
    pub deployer: Address,
    pub operator: Address,
}

/// Deploy the complete trade stack manually (without VaultFactory).
///
/// By deploying manually, the deployer retains ownership of PolicyEngine and
/// TradeValidator, enabling direct configuration without Anvil impersonation.
///
/// Deployment order:
///  1. MockERC20 tokenA (deposit asset) + tokenB (output token)
///  2. PolicyEngine (deployer = owner)
///  3. TradeValidator (deployer = owner)
///  4. FeeDistributor(treasury = deployer)
///  5. VaultShare("E2E Shares", "e2eSHR", admin = deployer)
///  6. TradingVault(tokenA, shareToken, pe, tv, fd, admin = deployer, operator)
///  7. VaultShare.grantRole(MINTER_ROLE, vault)
///  8. VaultShare.linkVault(vault)
///  9. TradeValidator.configureVault(vault, validators, required_sigs)
/// 10. PolicyEngine.initializeVault(vault, 50000, 100, 500)
/// 11. PolicyEngine.setWhitelist(vault, [tokenA, tokenB], true)
/// 12. Deploy MockTarget(tokenB)
/// 13. PolicyEngine.setTargetWhitelist(vault, [mockTarget], true)
/// 14. PolicyEngine.setPositionLimit(vault, tokenA/tokenB, 100000e18)
pub async fn deploy_full_trade_stack(
    provider: &impl Provider,
    deployer_addr: Address,
    operator_addr: Address,
    validator_addrs: Vec<Address>,
    required_sigs: u64,
) -> FullTradeStack {
    // 1. Deploy mock tokens
    let token_a_addr = deploy_contract(
        provider,
        load_bytecode("MockERC20"),
        ("Token A".to_string(), "TKA".to_string(), U256::from(18)).abi_encode_params(),
    )
    .await;
    let token_b_addr = deploy_contract(
        provider,
        load_bytecode("MockERC20"),
        ("Token B".to_string(), "TKB".to_string(), U256::from(18)).abi_encode_params(),
    )
    .await;

    // 2. Deploy PolicyEngine (no constructor args — deployer is owner)
    let pe_addr = deploy_contract(provider, load_bytecode("PolicyEngine"), vec![]).await;

    // 3. Deploy TradeValidator (no constructor args — deployer is owner)
    let tv_addr = deploy_contract(provider, load_bytecode("TradeValidator"), vec![]).await;

    // 4. Deploy FeeDistributor(treasury = deployer)
    let fd_addr = deploy_contract(
        provider,
        load_bytecode("FeeDistributor"),
        (deployer_addr,).abi_encode_params(),
    )
    .await;

    // 5. Deploy VaultShare("E2E Shares", "e2eSHR", admin = deployer)
    let vs_addr = deploy_contract(
        provider,
        load_bytecode("VaultShare"),
        (
            "E2E Shares".to_string(),
            "e2eSHR".to_string(),
            deployer_addr,
        )
            .abi_encode_params(),
    )
    .await;

    // 6. Deploy TradingVault(tokenA, shareToken, pe, tv, fd, admin, operator)
    let vault_addr = deploy_contract(
        provider,
        load_bytecode("TradingVault"),
        (
            token_a_addr,
            vs_addr,
            pe_addr,
            tv_addr,
            fd_addr,
            deployer_addr,
            operator_addr,
        )
            .abi_encode_params(),
    )
    .await;

    // 7. VaultShare.grantRole(MINTER_ROLE, vault)
    let vs = VaultShare::new(vs_addr, provider);
    vs.grantRole(minter_role(), vault_addr)
        .send()
        .await
        .expect("grantRole MINTER send")
        .get_receipt()
        .await
        .expect("grantRole MINTER receipt");

    // 8. VaultShare.linkVault(vault)
    vs.linkVault(vault_addr)
        .send()
        .await
        .expect("linkVault send")
        .get_receipt()
        .await
        .expect("linkVault receipt");

    // 9. TradeValidator.configureVault(vault, validators, required_sigs)
    let tv = TradeValidator::new(tv_addr, provider);
    tv.configureVault(vault_addr, validator_addrs, U256::from(required_sigs))
        .send()
        .await
        .expect("tv configureVault send")
        .get_receipt()
        .await
        .expect("tv configureVault receipt");

    // 10. PolicyEngine.initializeVault(vault, leverageCap=50000, maxTrades=100, maxSlippage=500)
    let pe = PolicyEngine::new(pe_addr, provider);
    pe.initializeVault(
        vault_addr,
        U256::from(50_000u64),
        U256::from(100u64),
        U256::from(500u64),
    )
    .send()
    .await
    .expect("pe initializeVault send")
    .get_receipt()
    .await
    .expect("pe initializeVault receipt");

    // 11. PolicyEngine.setWhitelist(vault, [tokenA, tokenB], true)
    pe.setWhitelist(vault_addr, vec![token_a_addr, token_b_addr], true)
        .send()
        .await
        .expect("pe setWhitelist send")
        .get_receipt()
        .await
        .expect("pe setWhitelist receipt");

    // 12. Deploy MockTarget(tokenB)
    let mt_addr = deploy_contract(
        provider,
        load_bytecode("MockTarget"),
        (token_b_addr,).abi_encode_params(),
    )
    .await;

    // 13. PolicyEngine.setTargetWhitelist(vault, [mockTarget], true)
    pe.setTargetWhitelist(vault_addr, vec![mt_addr], true)
        .send()
        .await
        .expect("pe setTargetWhitelist send")
        .get_receipt()
        .await
        .expect("pe setTargetWhitelist receipt");

    // 14. PolicyEngine.setPositionLimit for both tokens (100_000e18)
    let max_position = U256::from(100_000u64) * U256::from(10u64).pow(U256::from(18u64));
    pe.setPositionLimit(vault_addr, token_a_addr, max_position)
        .send()
        .await
        .expect("pe setPositionLimit tokenA send")
        .get_receipt()
        .await
        .expect("pe setPositionLimit tokenA receipt");
    pe.setPositionLimit(vault_addr, token_b_addr, max_position)
        .send()
        .await
        .expect("pe setPositionLimit tokenB send")
        .get_receipt()
        .await
        .expect("pe setPositionLimit tokenB receipt");

    FullTradeStack {
        token_a: token_a_addr,
        token_b: token_b_addr,
        policy_engine: pe_addr,
        trade_validator: tv_addr,
        fee_distributor: fd_addr,
        vault_share: vs_addr,
        vault: vault_addr,
        mock_target: mt_addr,
        deployer: deployer_addr,
        operator: operator_addr,
    }
}

/// Encode `MockTarget.swap(to, outputAmount)` calldata.
pub fn encode_mock_swap(to: Address, output_amount: U256) -> Vec<u8> {
    use alloy::sol_types::SolCall;
    MockTarget::swapCall {
        to,
        outputAmount: output_amount,
    }
    .abi_encode()
}
