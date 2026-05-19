// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/HyperliquidVault.sol";
import "../../src/HyperliquidVaultDeployer.sol";
import "../../src/HyperliquidVaultFactory.sol";
import "../../src/HyperliquidTradeValidator.sol";
import "../../src/VaultShare.sol";
import "../../src/VaultShareDeployer.sol";
import "../helpers/Setup.sol";

/// @notice HyperEVM fork smoke tests. These intentionally avoid mocked
///         precompiles/CoreWriter and should be run with:
///         forge test --match-path contracts/test/fork/HyperliquidVaultFork.t.sol \
///           --fork-url https://rpc.hyperliquid-testnet.xyz/evm
contract HyperliquidVaultForkTest is Test {
    uint256 internal constant HYPEREVM_TESTNET_CHAIN_ID = 998;

    function test_hyperevmForkDeploysVaultAndTouchesRealCoreWriter() public {
        if (block.chainid != HYPEREVM_TESTNET_CHAIN_ID) return;

        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        HyperliquidVault implementation = new HyperliquidVault();
        HyperliquidTradeValidator tradeValidator = new HyperliquidTradeValidator();
        HyperliquidVaultFactory factory = new HyperliquidVaultFactory(tradeValidator);
        HyperliquidVaultDeployer vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));
        tradeValidator.transferOwnership(address(factory));
        factory.acceptDependencyOwnership();
        factory.setVaultDeployers(vaultDeployer, shareDeployer);

        address admin = makeAddr("admin");
        address operator = makeAddr("operator");
        address[] memory signers = new address[](3);
        signers[0] = makeAddr("validator1");
        signers[1] = makeAddr("validator2");
        signers[2] = makeAddr("validator3");

        (address vaultAddr, address shareAddr) = factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            signers,
            2,
            "Hyperliquid Bot Shares",
            "hlSHARE",
            bytes32("hyperevm-fork"),
            HyperliquidVaultFactory.PolicyConfig({leverageCap: 50_000, maxTradesPerHour: 100, maxSlippageBps: 500}),
            HyperliquidVaultFactory.FeeConfig({
                performanceFeeBps: 2_000, managementFeeBps: 200, validatorFeeShareBps: 3_000
            })
        );

        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.share(), shareAddr);
        assertEq(address(vault.tradeValidator()), address(tradeValidator));
        assertEq(tradeValidator.getRequiredSignatures(vaultAddr), 2);
        assertTrue(tradeValidator.isVaultSigner(vaultAddr, signers[0]));

        // Real HyperEVM CoreWriter precompile path. A revert here means the
        // encoded action or system contract assumption no longer matches HyperEVM.
        vm.prank(admin);
        vault.approveHyperliquidApiWallet(makeAddr("api-wallet"), "fork-smoke");
    }
}
