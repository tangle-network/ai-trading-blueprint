// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/VaultFactory.sol";
import "../src/PolicyEngine.sol";
import "../src/TradeValidator.sol";
import "../src/FeeDistributor.sol";
import "../src/StrategyRegistry.sol";
import "../test/helpers/Setup.sol"; // MockERC20

/**
 * @title DeployLocal
 * @notice Deploys the full trading arena stack to a local Anvil instance.
 *
 * Usage:
 *   anvil &
 *   forge script contracts/script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract DeployLocal is Script {
    function run() external {
        // Use Anvil's default deployer key (account 0)
        uint256 deployerKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        address deployer = vm.addr(deployerKey);

        // User's test account to fund
        address userAccount = 0x68FF20459d48917748CA13afCbDA3B265a449D48;

        vm.startBroadcast(deployerKey);

        // ── Deploy Mock Tokens ──────────────────────────────────────────
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);

        console.log("USDC:", address(usdc));
        console.log("WETH:", address(weth));

        // ── Deploy Core Contracts ───────────────────────────────────────
        PolicyEngine policyEngine = new PolicyEngine();
        TradeValidator tradeValidator = new TradeValidator();
        FeeDistributor feeDistributor = new FeeDistributor(deployer);
        VaultFactory vaultFactory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);

        console.log("PolicyEngine:", address(policyEngine));
        console.log("TradeValidator:", address(tradeValidator));
        console.log("FeeDistributor:", address(feeDistributor));
        console.log("VaultFactory:", address(vaultFactory));

        // ── Transfer ownership to VaultFactory ──────────────────────────
        policyEngine.transferOwnership(address(vaultFactory));
        tradeValidator.transferOwnership(address(vaultFactory));

        // ── Deploy StrategyRegistry ─────────────────────────────────────
        StrategyRegistry strategyRegistry = new StrategyRegistry(deployer);
        console.log("StrategyRegistry:", address(strategyRegistry));

        // ── Fund user account ───────────────────────────────────────────
        // ETH
        payable(userAccount).transfer(100 ether);

        // USDC (1M USDC = 1_000_000 * 1e6)
        usdc.mint(userAccount, 1_000_000 * 1e6);
        usdc.mint(deployer, 1_000_000 * 1e6);

        // WETH (100 WETH)
        weth.mint(userAccount, 100 ether);
        weth.mint(deployer, 100 ether);

        console.log("Funded user account:", userAccount);
        console.log("  ETH: 100");
        console.log("  USDC: 1,000,000");
        console.log("  WETH: 100");

        // ── Create a sample vault (service 0) ───────────────────────────
        // First, VaultFactory needs to accept ownership of PolicyEngine and TradeValidator.
        // On Anvil we can impersonate — but in a broadcast script we need a different approach.
        // The factory's createVault calls policyEngine.configureVault (onlyOwner).
        // Since ownership was transferred but not yet accepted, we'll need to do that separately.

        vm.stopBroadcast();

        // Accept ownership using impersonation (Anvil only)
        vm.startPrank(address(vaultFactory));
        policyEngine.acceptOwnership();
        tradeValidator.acceptOwnership();
        vm.stopPrank();

        vm.startBroadcast(deployerKey);

        // Create vault for service 0
        address[] memory signers = new address[](1);
        signers[0] = deployer; // deployer is also a validator signer for testing
        (address vault0Raw, address share0) = vaultFactory.createVault(
            0,                  // serviceId
            address(usdc),      // asset token (USDC)
            deployer,           // admin
            deployer,           // operator
            signers,
            1,                  // 1-of-1 sigs for testing
            "Arena Vault Shares",
            "avSHARE",
            bytes32("arena-vault-0")
        );
        address payable vault0 = payable(vault0Raw);

        console.log("Vault (service 0):", vault0);
        console.log("VaultShare:", share0);

        // Deposit some USDC into the vault as initial TVL
        usdc.approve(vault0, type(uint256).max);
        TradingVault(vault0).deposit(50_000 * 1e6, deployer); // 50K USDC
        console.log("Deposited 50,000 USDC into vault 0");

        vm.stopBroadcast();

        // ── Print summary ───────────────────────────────────────────────
        console.log("\n=== DEPLOYMENT SUMMARY ===");
        console.log("USDC:", address(usdc));
        console.log("WETH:", address(weth));
        console.log("VaultFactory:", address(vaultFactory));
        console.log("PolicyEngine:", address(policyEngine));
        console.log("TradeValidator:", address(tradeValidator));
        console.log("FeeDistributor:", address(feeDistributor));
        console.log("StrategyRegistry:", address(strategyRegistry));
        console.log("Vault (service 0):", vault0);
        console.log("VaultShare (service 0):", share0);
        console.log("User account:", userAccount);
    }
}
