// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract ClobCollateralTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;

    function setUp() public override {
        super.setUp();

        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Approve vault for deposits
        vm.prank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vm.prank(owner);
        tokenA.approve(address(vault), type(uint256).max);
        vm.prank(operator);
        tokenA.approve(address(vault), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _enableCollateral(uint256 bps) internal {
        vm.prank(owner);
        vault.setMaxCollateralBps(bps);
    }

    function _depositAndEnable(uint256 depositAmount, uint256 bps) internal {
        vm.prank(user);
        vault.deposit(depositAmount, user);
        _enableCollateral(bps);
    }

    function _createCollateralSigs(bytes32 intentHash, uint256 deadline)
        internal
        view
        returns (bytes[] memory signatures, uint256[] memory scores)
    {
        signatures = new bytes[](2);
        scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        signatures[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        signatures[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);
    }

    function _releaseCollateral(uint256 amount, bytes32 intentHash)
        internal
        returns (uint256 deadline)
    {
        deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);
        vm.prank(operator);
        vault.releaseCollateral(amount, operator, intentHash, deadline, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HAPPY PATH
    // ═══════════════════════════════════════════════════════════════════════════

    function test_releaseAndReturn_happyPath() public {
        _depositAndEnable(10000 ether, 5000); // 50% cap

        uint256 operatorBalBefore = tokenA.balanceOf(operator);

        // Release 1000
        bytes32 intentHash = keccak256("release-1");
        _releaseCollateral(1000 ether, intentHash);

        assertEq(vault.totalOutstandingCollateral(), 1000 ether);
        assertEq(vault.operatorCollateral(operator), 1000 ether);
        assertEq(tokenA.balanceOf(operator) - operatorBalBefore, 1000 ether);

        // Return 1000
        vm.prank(operator);
        vault.returnCollateral(1000 ether);

        assertEq(vault.totalOutstandingCollateral(), 0);
        assertEq(vault.operatorCollateral(operator), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCESS CONTROL
    // ═══════════════════════════════════════════════════════════════════════════

    function test_release_requiresOperatorRole() public {
        _depositAndEnable(10000 ether, 5000);

        bytes32 intentHash = keccak256("no-role");
        uint256 deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);

        bytes32 operatorRole = vault.OPERATOR_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, operatorRole
        ));
        vault.releaseCollateral(1000 ether, operator, intentHash, deadline, sigs, scores);
    }

    function test_release_requiresValidatorSigs() public {
        _depositAndEnable(10000 ether, 5000);

        bytes32 intentHash = keccak256("bad-sigs");
        uint256 deadline = block.timestamp + 1 hours;

        // Only 1 sig when 2-of-3 required
        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);
        scores[0] = 80;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ValidatorCheckFailed.selector);
        vault.releaseCollateral(1000 ether, operator, intentHash, deadline, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BPS CAP
    // ═══════════════════════════════════════════════════════════════════════════

    function test_release_respectsMaxBps() public {
        _depositAndEnable(10000 ether, 1000); // 10% cap = 1000 max

        bytes32 intentHash = keccak256("over-cap");
        uint256 deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);

        // Try to release 2000 (exceeds 10% of 10000)
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(
            TradingVault.ExceedsCollateralLimit.selector, 2000 ether, 1000 ether
        ));
        vault.releaseCollateral(2000 ether, operator, intentHash, deadline, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTENT DEDUP
    // ═══════════════════════════════════════════════════════════════════════════

    function test_release_intentDedup() public {
        _depositAndEnable(10000 ether, 5000);

        bytes32 intentHash = keccak256("dedup-collateral");
        _releaseCollateral(500 ether, intentHash);

        // Same intentHash again
        uint256 deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.IntentAlreadyExecuted.selector, intentHash));
        vault.releaseCollateral(500 ether, operator, intentHash, deadline, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RETURN SCENARIOS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_returnWithProfit() public {
        _depositAndEnable(10000 ether, 5000);

        _releaseCollateral(1000 ether, keccak256("profit-release"));

        uint256 totalBefore = vault.totalAssets();

        // Return 1200 (200 profit)
        vm.prank(operator);
        vault.returnCollateral(1200 ether);

        assertEq(vault.totalOutstandingCollateral(), 0);
        assertEq(vault.operatorCollateral(operator), 0);
        // NAV increased by 200 (profit)
        assertEq(vault.totalAssets(), totalBefore + 200 ether);
    }

    function test_partialReturn() public {
        _depositAndEnable(10000 ether, 5000);

        _releaseCollateral(1000 ether, keccak256("partial-release"));

        // Return only 500
        vm.prank(operator);
        vault.returnCollateral(500 ether);

        assertEq(vault.totalOutstandingCollateral(), 500 ether);
        assertEq(vault.operatorCollateral(operator), 500 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WRITE-DOWN
    // ═══════════════════════════════════════════════════════════════════════════

    function test_writeDown() public {
        _depositAndEnable(10000 ether, 5000);

        _releaseCollateral(1000 ether, keccak256("writedown-release"));

        uint256 totalBefore = vault.totalAssets();

        // Admin writes down the full 1000
        vm.prank(owner);
        vault.writeDownCollateral(operator, 1000 ether);

        assertEq(vault.totalOutstandingCollateral(), 0);
        assertEq(vault.operatorCollateral(operator), 0);
        // totalAssets dropped by 1000 (loss absorbed by LPs)
        assertEq(vault.totalAssets(), totalBefore - 1000 ether);
    }

    function test_writeDown_cappedAtOutstanding() public {
        _depositAndEnable(10000 ether, 5000);

        _releaseCollateral(1000 ether, keccak256("cap-writedown"));

        // Try to write down 5000 (more than 1000 outstanding)
        vm.prank(owner);
        vault.writeDownCollateral(operator, 5000 ether);

        // Only 1000 was actually written down
        assertEq(vault.totalOutstandingCollateral(), 0);
        assertEq(vault.operatorCollateral(operator), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCOUNTING INVARIANTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_totalAssets_includesOutstanding() public {
        _depositAndEnable(10000 ether, 5000);

        uint256 totalBefore = vault.totalAssets();
        assertEq(totalBefore, 10000 ether);

        _releaseCollateral(1000 ether, keccak256("accounting"));

        // totalAssets unchanged (collateral tracked in outstanding)
        assertEq(vault.totalAssets(), 10000 ether);
        // liquid balance dropped by 1000
        assertEq(vault.liquidAssets(), 9000 ether);
    }

    function test_sharePriceStable_onReleaseReturn() public {
        _depositAndEnable(10000 ether, 5000);

        uint256 priceBefore = vault.convertToAssets(1 ether);

        _releaseCollateral(1000 ether, keccak256("price-stable"));

        uint256 priceAfterRelease = vault.convertToAssets(1 ether);
        assertEq(priceAfterRelease, priceBefore, "Share price should not change on release");

        vm.prank(operator);
        vault.returnCollateral(1000 ether);

        uint256 priceAfterReturn = vault.convertToAssets(1 ether);
        assertEq(priceAfterReturn, priceBefore, "Share price should not change on return");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PERMISSIONLESS RETURN
    // ═══════════════════════════════════════════════════════════════════════════

    function test_return_permissionless() public {
        _depositAndEnable(10000 ether, 5000);

        _releaseCollateral(1000 ether, keccak256("permissionless"));

        // Random address returns funds (not the operator)
        address random = makeAddr("random");
        tokenA.mint(random, 1000 ether);
        vm.startPrank(random);
        tokenA.approve(address(vault), 1000 ether);
        vault.returnCollateral(1000 ether);
        vm.stopPrank();

        // Credited against random's outstanding (0), so no credit — but vault received funds
        // random has no outstanding, so credited = 0. The 1000 becomes pure profit.
        assertEq(vault.totalOutstandingCollateral(), 1000 ether, "Operator outstanding unchanged");
        assertEq(vault.operatorCollateral(operator), 1000 ether, "Operator outstanding unchanged");
        // But vault balance went up by 1000 → totalAssets up by 1000
        assertEq(vault.totalAssets(), 11000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EDGE CASES
    // ═══════════════════════════════════════════════════════════════════════════

    function test_release_whenPaused() public {
        _depositAndEnable(10000 ether, 5000);

        vm.prank(owner);
        vault.pause();

        bytes32 intentHash = keccak256("paused");
        uint256 deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.releaseCollateral(1000 ether, operator, intentHash, deadline, sigs, scores);
    }

    function test_release_zeroAmount() public {
        _depositAndEnable(10000 ether, 5000);

        bytes32 intentHash = keccak256("zero");
        uint256 deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ZeroAmount.selector);
        vault.releaseCollateral(0, operator, intentHash, deadline, sigs, scores);
    }

    function test_release_notEnabled() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        // maxCollateralBps is 0 (default)

        bytes32 intentHash = keccak256("not-enabled");
        uint256 deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.CollateralNotEnabled.selector);
        vault.releaseCollateral(1000 ether, operator, intentHash, deadline, sigs, scores);
    }

    function test_release_blockedDuringWindDown() public {
        _depositAndEnable(10000 ether, 5000);

        vm.prank(owner);
        vault.activateWindDown();

        bytes32 intentHash = keccak256("winddown");
        uint256 deadline = block.timestamp + 1 hours;
        (bytes[] memory sigs, uint256[] memory scores) = _createCollateralSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.WindDownBlocksExecute.selector);
        vault.releaseCollateral(1000 ether, operator, intentHash, deadline, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_availableCollateral_view() public {
        _depositAndEnable(10000 ether, 5000); // 50% cap = 5000 max

        // Before any release: available = min(5000, 10000) = 5000
        assertEq(vault.availableCollateral(), 5000 ether);

        _releaseCollateral(2000 ether, keccak256("avail-1"));

        // After releasing 2000: headroom = 5000 - 2000 = 3000, liquid = 8000
        assertEq(vault.availableCollateral(), 3000 ether);
    }

    function test_maxWithdraw_afterRelease() public {
        _depositAndEnable(10000 ether, 5000);

        _releaseCollateral(1000 ether, keccak256("maxwithdraw"));

        // LP maxWithdraw capped at liquid balance (9000, not 10000)
        uint256 maxW = vault.maxWithdraw(user);
        assertEq(maxW, 9000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FULL ROUND-TRIP: LP DEPOSITS → COLLATERAL → PROFIT → LP WITHDRAWS MORE
    // ═══════════════════════════════════════════════════════════════════════════

    function test_lpWithdrawsProfit_afterCollateralRoundTrip() public {
        _depositAndEnable(10000 ether, 5000);

        uint256 userBalBefore = tokenA.balanceOf(user);
        uint256 userShares = shareToken.balanceOf(user);

        // Operator releases 2000 for CLOB trading
        _releaseCollateral(2000 ether, keccak256("roundtrip-release"));

        // Operator makes 500 profit and returns 2500
        tokenA.mint(operator, 500 ether); // simulate CLOB profits
        vm.prank(operator);
        vault.returnCollateral(2500 ether);

        // Outstanding is clear, vault has 10500 (10000 original + 500 profit)
        assertEq(vault.totalOutstandingCollateral(), 0);
        assertEq(vault.totalAssets(), 10500 ether);

        // Share price increased: user's shares are worth more than 10000 now
        uint256 userEntitled = vault.convertToAssets(userShares);
        assertGt(userEntitled, 10000 ether, "User should be entitled to more than deposited");

        // User redeems ALL shares
        vm.prank(user);
        uint256 assetsReceived = vault.redeem(userShares, user, user);

        // User received their deposit + their share of the 500 profit
        // (user is sole depositor so they get all of it, minus virtual offset rounding)
        assertApproxEqAbs(assetsReceived, 10500 ether, 1, "User should receive deposit + profit");
        assertGt(tokenA.balanceOf(user) - userBalBefore, 10000 ether, "User has more than they deposited");
    }

    function test_multipleOperators_independentCollateral() public {
        _depositAndEnable(10000 ether, 5000);

        // Grant a second operator
        address operator2 = makeAddr("operator2");
        tokenA.mint(operator2, 1_000_000 ether);
        bytes32 opRole = vault.OPERATOR_ROLE();
        vm.prank(owner);
        vault.grantRole(opRole, operator2);
        vm.prank(operator2);
        tokenA.approve(address(vault), type(uint256).max);

        // Operator 1 releases 1000
        _releaseCollateral(1000 ether, keccak256("op1-release"));

        // Operator 2 releases 500
        bytes32 hash2 = keccak256("op2-release");
        uint256 deadline2 = block.timestamp + 1 hours;
        (bytes[] memory sigs2, uint256[] memory scores2) = _createCollateralSigs(hash2, deadline2);
        vm.prank(operator2);
        vault.releaseCollateral(500 ether, operator2, hash2, deadline2, sigs2, scores2);

        assertEq(vault.totalOutstandingCollateral(), 1500 ether);
        assertEq(vault.operatorCollateral(operator), 1000 ether);
        assertEq(vault.operatorCollateral(operator2), 500 ether);

        // Operator 2 returns their full amount
        vm.prank(operator2);
        vault.returnCollateral(500 ether);

        assertEq(vault.totalOutstandingCollateral(), 1000 ether);
        assertEq(vault.operatorCollateral(operator), 1000 ether);
        assertEq(vault.operatorCollateral(operator2), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PROVISION — collateral cap set at vault creation
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Simulates the blueprint provision flow: admin creates vault then sets collateral cap.
    function test_provision_setsCollateralBps() public {
        // Create a fresh vault (admin = owner, simulating BSM)
        (address freshVault,) = _createTestVaultWithId(99);
        TradingVault v = TradingVault(payable(freshVault));

        // Before: collateral not enabled
        assertEq(v.maxCollateralBps(), 0);

        // Admin (BSM) sets collateral cap — mirrors _handleProvisionResult / _createInstanceVault
        vm.prank(owner);
        v.setMaxCollateralBps(2000); // 20%

        assertEq(v.maxCollateralBps(), 2000);

        // Deposit funds and verify available collateral reflects the cap
        vm.prank(user);
        tokenA.approve(address(v), type(uint256).max);
        vm.prank(user);
        v.deposit(10000 ether, user);

        uint256 available = v.availableCollateral();
        // 20% of 10000 = 2000
        assertEq(available, 2000 ether);
    }
}
