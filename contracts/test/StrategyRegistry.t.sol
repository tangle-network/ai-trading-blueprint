// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract StrategyRegistryTest is Setup {
    TradingVault public vault;

    function setUp() public override {
        super.setUp();
        // Create a vault so we can test linked-vault registration
        (address v,) = _createTestVault();
        vault = TradingVault(payable(v));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REGISTRATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_registerStrategy_unlinked() public {
        vm.prank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "My Yield Strategy", "defi-yield", "QmHash123");

        assertEq(strategyId, 1);

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertEq(info.serviceId, 1);
        assertEq(info.owner, owner);
        assertEq(info.linkedVault, address(0));
        assertEq(info.name, "My Yield Strategy");
        assertEq(info.strategyType, "defi-yield");
        assertEq(info.ipfsHash, "QmHash123");
        assertEq(info.aum, 0);
        assertEq(info.totalPnl, 0);
        assertTrue(info.active);
        assertEq(info.createdAt, block.timestamp);
    }

    function test_registerStrategy_linked_vaultAdmin() public {
        // owner has DEFAULT_ADMIN_ROLE on the vault
        vm.prank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(vault), "Linked Strategy", "defi-yield", "QmHash");

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertEq(info.linkedVault, address(vault));
        assertEq(info.owner, owner);
    }

    function test_registerStrategy_linked_revertsForNonAdmin() public {
        // user does NOT have DEFAULT_ADMIN_ROLE on the vault
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.NotVaultAdmin.selector, address(vault), user));
        strategyRegistry.registerStrategy(1, address(vault), "Spoof", "defi-yield", "QmHash");
    }

    function test_registerStrategy_incrementsId() public {
        vm.startPrank(owner);
        uint256 id1 = strategyRegistry.registerStrategy(1, address(0), "Strategy 1", "type1", "hash1");
        uint256 id2 = strategyRegistry.registerStrategy(2, address(0), "Strategy 2", "type2", "hash2");
        uint256 id3 = strategyRegistry.registerStrategy(3, address(0), "Strategy 3", "type1", "hash3");
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
    }

    function test_registerStrategy_revertsWithEmptyName() public {
        vm.prank(owner);
        vm.expectRevert(StrategyRegistry.EmptyName.selector);
        strategyRegistry.registerStrategy(1, address(0), "", "defi-yield", "hash");
    }

    function test_registerStrategy_emitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit StrategyRegistry.StrategyRegistered(1, 1, owner, address(0), "Test");
        strategyRegistry.registerStrategy(1, address(0), "Test", "defi-yield", "hash");
    }

    function test_registerStrategy_anyoneCanRegisterUnlinked() public {
        vm.prank(user);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "User Strategy", "dex-trading", "hash");

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertEq(info.owner, user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UPDATE TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_updateStrategy() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "oldHash");
        strategyRegistry.updateStrategy(strategyId, "newHash");
        vm.stopPrank();

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertEq(info.ipfsHash, "newHash");
    }

    function test_updateStrategy_revertsForNonOwner() public {
        vm.prank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");

        vm.prank(user);
        vm.expectRevert(StrategyRegistry.OnlyStrategyOwner.selector);
        strategyRegistry.updateStrategy(strategyId, "newHash");
    }

    function test_updateStrategy_revertsForDeactivated() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");
        strategyRegistry.deactivateStrategy(strategyId);

        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.StrategyNotActive.selector, strategyId));
        strategyRegistry.updateStrategy(strategyId, "newHash");
        vm.stopPrank();
    }

    function test_updateStrategy_revertsForNonExistent() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.StrategyNotFound.selector, 999));
        strategyRegistry.updateStrategy(999, "hash");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEACTIVATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_deactivateStrategy() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");
        strategyRegistry.deactivateStrategy(strategyId);
        vm.stopPrank();

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertFalse(info.active);
    }

    function test_deactivateStrategy_revertsForNonOwner() public {
        vm.prank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");

        vm.prank(user);
        vm.expectRevert(StrategyRegistry.OnlyStrategyOwner.selector);
        strategyRegistry.deactivateStrategy(strategyId);
    }

    function test_deactivateStrategy_revertsIfAlreadyInactive() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");
        strategyRegistry.deactivateStrategy(strategyId);

        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.StrategyNotActive.selector, strategyId));
        strategyRegistry.deactivateStrategy(strategyId);
        vm.stopPrank();
    }

    function test_deactivateStrategy_emitsEvent() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");

        vm.expectEmit(true, false, false, true);
        emit StrategyRegistry.StrategyDeactivated(strategyId);
        strategyRegistry.deactivateStrategy(strategyId);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // METRICS TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_updateMetrics() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");
        strategyRegistry.updateMetrics(strategyId, 5000 ether, 100 ether);
        vm.stopPrank();

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertEq(info.aum, 5000 ether);
        assertEq(info.totalPnl, 100 ether);
    }

    function test_updateMetrics_negativePnl() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");
        strategyRegistry.updateMetrics(strategyId, 5000 ether, -200 ether);
        vm.stopPrank();

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertEq(info.totalPnl, -200 ether);
    }

    function test_updateMetrics_revertsForNonOwner() public {
        vm.prank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");

        vm.prank(user);
        vm.expectRevert(StrategyRegistry.OnlyStrategyOwner.selector);
        strategyRegistry.updateMetrics(strategyId, 1000, 50);
    }

    function test_updateMetrics_emitsEvent() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Test", "type", "hash");

        vm.expectEmit(true, false, false, true);
        emit StrategyRegistry.MetricsUpdated(strategyId, 5000, 100);
        strategyRegistry.updateMetrics(strategyId, 5000, 100);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RECORD METRICS (vault-linked) TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_recordMetrics_revertsForUnlinked() public {
        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(0), "Unlinked", "type", "hash");
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.StrategyNotLinked.selector, strategyId));
        strategyRegistry.recordMetrics(strategyId, 100 ether);
        vm.stopPrank();
    }

    function test_recordMetrics_readsFromVault() public {
        // Fund vault so totalAssets > 0
        vm.startPrank(user);
        tokenA.approve(address(vault), 5000 ether);
        vault.deposit(5000 ether, user);
        vm.stopPrank();

        vm.startPrank(owner);
        uint256 strategyId = strategyRegistry.registerStrategy(1, address(vault), "Linked", "type", "hash");
        strategyRegistry.recordMetrics(strategyId, 200 ether);
        vm.stopPrank();

        StrategyRegistry.StrategyInfo memory info = strategyRegistry.getStrategy(strategyId);
        assertEq(info.aum, vault.totalAssets());
        assertEq(info.totalPnl, 200 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_getStrategiesByType() public {
        vm.startPrank(owner);
        strategyRegistry.registerStrategy(1, address(0), "A", "defi-yield", "h1");
        strategyRegistry.registerStrategy(2, address(0), "B", "dex-trading", "h2");
        strategyRegistry.registerStrategy(3, address(0), "C", "defi-yield", "h3");
        vm.stopPrank();

        uint256[] memory defiYieldIds = strategyRegistry.getStrategiesByType("defi-yield");
        assertEq(defiYieldIds.length, 2);
        assertEq(defiYieldIds[0], 1);
        assertEq(defiYieldIds[1], 3);

        uint256[] memory dexIds = strategyRegistry.getStrategiesByType("dex-trading");
        assertEq(dexIds.length, 1);
        assertEq(dexIds[0], 2);
    }

    function test_getStrategiesByType_emptyForUnknownType() public view {
        uint256[] memory ids = strategyRegistry.getStrategiesByType("unknown");
        assertEq(ids.length, 0);
    }

    function test_getStrategy_revertsForNonExistent() public {
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.StrategyNotFound.selector, 999));
        strategyRegistry.getStrategy(999);
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new StrategyRegistry(address(0));
    }
}
