// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/HyperliquidTradeValidator.sol";
import "../src/HyperliquidVault.sol";
import "../src/HyperliquidVaultDeployer.sol";
import "../src/HyperliquidVaultFactory.sol";
import "../src/VaultShareDeployer.sol";
import "./helpers/Setup.sol";

contract HyperliquidVaultRoleCompatTest is Test {
    MockERC20 internal usdc;
    HyperliquidTradeValidator internal tradeValidator;
    HyperliquidVaultFactory internal factory;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal validator1 = makeAddr("validator1");
    address internal validator2 = makeAddr("validator2");
    address internal validator3 = makeAddr("validator3");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        HyperliquidVault implementation = new HyperliquidVault();
        tradeValidator = new HyperliquidTradeValidator();
        factory = new HyperliquidVaultFactory(tradeValidator);
        HyperliquidVaultDeployer vaultDeployer =
            new HyperliquidVaultDeployer(address(factory), address(implementation));
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));
        tradeValidator.transferOwnership(address(factory));
        factory.acceptDependencyOwnership();
        factory.setVaultDeployers(vaultDeployer, shareDeployer);
    }

    function test_roleManagementPreservesAccessControlCompatibleSurface() public {
        (address vaultAddr,) = factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            _signers(),
            2,
            "Hyperliquid Bot Shares",
            "hlSHARE",
            bytes32("role-compat-salt"),
            HyperliquidVaultFactory.PolicyConfig({leverageCap: 50_000, maxTradesPerHour: 100, maxSlippageBps: 500}),
            HyperliquidVaultFactory.FeeConfig({
                performanceFeeBps: 2_000, managementFeeBps: 200, validatorFeeShareBps: 3_000
            })
        );
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        address newOperator = makeAddr("newOperator");
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();

        assertEq(vault.getRoleAdmin(operatorRole), adminRole);
        assertTrue(vault.supportsInterface(0x01ffc9a7));
        assertTrue(vault.supportsInterface(0x7965db0b));

        vm.prank(newOperator);
        vm.expectRevert(
            abi.encodeWithSelector(
                HyperliquidVault.AccessControlUnauthorizedAccount.selector, newOperator, adminRole
            )
        );
        vault.grantRole(operatorRole, newOperator);

        vm.prank(admin);
        vault.grantRole(operatorRole, newOperator);
        assertTrue(vault.hasRole(operatorRole, newOperator));

        vm.prank(newOperator);
        vault.renounceRole(operatorRole, newOperator);
        assertFalse(vault.hasRole(operatorRole, newOperator));

        vm.prank(admin);
        vault.grantRole(operatorRole, newOperator);
        vm.prank(admin);
        vault.revokeRole(operatorRole, newOperator);
        assertFalse(vault.hasRole(operatorRole, newOperator));
    }

    function _signers() internal view returns (address[] memory signers) {
        signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
    }
}
