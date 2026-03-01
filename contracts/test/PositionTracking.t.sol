// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Tests for TradingVault position tracking, reserve BPS, and drawdown limits
contract PositionTrackingTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;
    MockTarget public mockTarget;

    function setUp() public override {
        super.setUp();
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);
        mockTarget = new MockTarget(tokenB);

        // Configure policy for trades
        vm.startPrank(address(vaultFactory));
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = address(mockTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);

        policyEngine.setPositionLimit(address(vault), address(tokenA), 100_000 ether);
        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);
        vm.stopPrank();

        // User deposits
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 ether, user);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELD TOKEN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    function test_updateHeldTokens() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenB);
        tokens[1] = makeAddr("tokenC");

        vm.prank(operator);
        vault.updateHeldTokens(tokens);

        assertEq(vault.heldTokenCount(), 2);
        address[] memory held = vault.getHeldTokens();
        assertEq(held[0], address(tokenB));
        assertEq(held[1], makeAddr("tokenC"));
    }

    function test_updateHeldTokens_skipsDepositAsset() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA); // deposit asset — should be skipped
        tokens[1] = address(tokenB);

        vm.prank(operator);
        vault.updateHeldTokens(tokens);

        assertEq(vault.heldTokenCount(), 1);
        assertEq(vault.getHeldTokens()[0], address(tokenB));
    }

    function test_updateHeldTokens_onlyOperator() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);

        bytes32 operatorRole = vault.OPERATOR_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, operatorRole
        ));
        vault.updateHeldTokens(tokens);
    }

    function test_removeHeldToken() public {
        // First add a token
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        vm.prank(operator);
        vault.updateHeldTokens(tokens);
        assertEq(vault.heldTokenCount(), 1);

        // Remove it
        vm.prank(operator);
        vault.removeHeldToken(address(tokenB));
        assertEq(vault.heldTokenCount(), 0);
    }

    function test_positionsValue() public {
        // Mint tokenB to the vault
        tokenB.mint(address(vault), 500 ether);

        // Add tokenB as held token
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        vm.prank(operator);
        vault.updateHeldTokens(tokens);

        // positionsValue should include tokenB balance
        assertEq(vault.positionsValue(), 500 ether);

        // totalAssets = deposit asset balance + positionsValue
        assertEq(vault.totalAssets(), 10_000 ether + 500 ether);
    }

    function test_liquidAssets() public view {
        assertEq(vault.liquidAssets(), 10_000 ether);
    }

    function test_maxWithdraw_cappedByLiquidAssets() public {
        // Mint tokenB to vault and add as held token
        tokenB.mint(address(vault), 5000 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        vm.prank(operator);
        vault.updateHeldTokens(tokens);

        // totalAssets = 10000 + 5000 = 15000, but liquidAssets = 10000
        // maxWithdraw should be capped by liquid assets
        uint256 maxW = vault.maxWithdraw(user);
        assertTrue(maxW <= vault.liquidAssets(), "maxWithdraw should not exceed liquid assets");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT ASSET RESERVE
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setDepositAssetReserveBps() public {
        vm.prank(owner);
        vault.setDepositAssetReserveBps(5000); // 50%
        assertEq(vault.depositAssetReserveBps(), 5000);
    }

    function test_setDepositAssetReserveBps_invalidBps() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.InvalidBps.selector));
        vault.setDepositAssetReserveBps(10001);
    }

    function test_setDepositAssetReserveBps_onlyAdmin() public {
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, adminRole
        ));
        vault.setDepositAssetReserveBps(5000);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN UNWIND MAX DRAWDOWN
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setAdminUnwindMaxDrawdownBps() public {
        vm.prank(owner);
        vault.setAdminUnwindMaxDrawdownBps(500); // 5%
        assertEq(vault.adminUnwindMaxDrawdownBps(), 500);
    }

    function test_setAdminUnwindMaxDrawdownBps_invalidBps() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.InvalidBps.selector));
        vault.setAdminUnwindMaxDrawdownBps(10001);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PREVIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_previewDeposit() public view {
        uint256 shares = vault.previewDeposit(1000 ether);
        assertEq(shares, vault.convertToShares(1000 ether));
    }

    function test_previewRedeem() public view {
        uint256 assets = vault.previewRedeem(1000 ether);
        assertEq(assets, vault.convertToAssets(1000 ether));
    }

    function test_maxDeposit_whenPaused() public {
        vm.prank(owner);
        vault.pause();
        assertEq(vault.maxDeposit(user), 0);
    }

    function test_maxDeposit_whenUnpaused() public view {
        assertEq(vault.maxDeposit(user), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERROR PATHS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_deposit_zeroAddressReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.ZeroAddress.selector));
        vault.deposit(100 ether, address(0));
    }

    function test_deposit_zeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.ZeroAmount.selector));
        vault.deposit(0, user);
    }

    function test_withdraw_zeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.ZeroAmount.selector));
        vault.withdraw(0, user, user);
    }

    function test_withdraw_zeroAddressReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.ZeroAddress.selector));
        vault.withdraw(100 ether, address(0), user);
    }

    function test_redeem_zeroSharesReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.ZeroShares.selector));
        vault.redeem(0, user, user);
    }

    function test_redeem_zeroAddressReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.ZeroAddress.selector));
        vault.redeem(100 ether, address(0), user);
    }

    function test_emergencyWithdraw_zeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.ZeroAddress.selector));
        vault.emergencyWithdraw(address(tokenA), address(0));
    }

    function test_emergencyWithdraw_eth() public {
        vm.deal(address(vault), 5 ether);
        uint256 ownerBalBefore = owner.balance;

        vm.prank(owner);
        vault.emergencyWithdraw(address(0), owner);

        assertEq(owner.balance - ownerBalBefore, 5 ether);
        assertEq(address(vault).balance, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENT EMISSION
    // ═══════════════════════════════════════════════════════════════════════════

    function test_deposit_emitsEvent() public {
        vm.startPrank(user);
        tokenA.approve(address(vault), 100 ether);

        vm.expectEmit(true, true, true, true);
        uint256 expectedShares = vault.convertToShares(100 ether);
        emit IERC7575.Deposit(user, user, 100 ether, expectedShares);
        vault.deposit(100 ether, user);
        vm.stopPrank();
    }

    function test_emergencyWithdraw_emitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit TradingVault.EmergencyWithdraw(address(tokenA), owner, 10_000 ether);
        vault.emergencyWithdraw(address(tokenA), owner);
    }

    function test_depositLockup_emitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit TradingVault.DepositLockupUpdated(1 days);
        vault.setDepositLockup(1 days);
    }
}
