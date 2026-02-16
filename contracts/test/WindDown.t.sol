// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @title WindDownTest
/// @notice Tests for the wind-down mode and permissionless unwind() function
contract WindDownTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;
    MockTarget public mockTarget;
    MockUnwindTarget public unwindTarget;
    address public creator;

    function setUp() public override {
        super.setUp();

        creator = makeAddr("creator");

        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Grant CREATOR_ROLE to the creator (simulates what BSM does in onServiceInitialized)
        // Must use startPrank because vault.CREATOR_ROLE() staticcall consumes vm.prank
        vm.startPrank(owner);
        vault.grantRole(vault.CREATOR_ROLE(), creator);
        vm.stopPrank();

        // Deploy mock targets
        mockTarget = new MockTarget(tokenB);
        unwindTarget = new MockUnwindTarget(tokenA);

        // Approve vault for deposits
        vm.prank(user);
        tokenA.approve(address(vault), type(uint256).max);

        // Configure policy — whitelist both targets and tokens
        vm.startPrank(address(vaultFactory));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](2);
        targets[0] = address(mockTarget);
        targets[1] = address(unwindTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);

        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);

        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTIVATION / DEACTIVATION
    // ═══════════════════════════════════════════════════════════════════════════

    function test_activateWindDown() public {
        assertFalse(vault.windDownActive());
        assertEq(vault.windDownStartedAt(), 0);

        vm.prank(owner);
        vault.activateWindDown();

        assertTrue(vault.windDownActive());
        assertEq(vault.windDownStartedAt(), block.timestamp);
    }

    function test_activateWindDown_emitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit TradingVault.WindDownActivated(block.timestamp);
        vault.activateWindDown();
    }

    function test_activateWindDown_onlyAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        vault.activateWindDown();
    }

    function test_activateWindDown_cannotDoubleActivate() public {
        vm.prank(owner);
        vault.activateWindDown();

        vm.prank(owner);
        vm.expectRevert(TradingVault.WindDownAlreadyActive.selector);
        vault.activateWindDown();
    }

    function test_deactivateWindDown() public {
        vm.prank(owner);
        vault.activateWindDown();
        assertTrue(vault.windDownActive());

        vm.prank(owner);
        vault.deactivateWindDown();
        assertFalse(vault.windDownActive());
        assertEq(vault.windDownStartedAt(), 0);
    }

    function test_deactivateWindDown_onlyAdmin() public {
        vm.prank(owner);
        vault.activateWindDown();

        vm.prank(user);
        vm.expectRevert();
        vault.deactivateWindDown();
    }

    function test_deactivateWindDown_revertsIfNotActive() public {
        vm.prank(owner);
        vm.expectRevert(TradingVault.WindDownNotActive.selector);
        vault.deactivateWindDown();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTE BLOCKED DURING WIND-DOWN
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_blockedDuringWindDown() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        bytes32 intentHash = keccak256("blocked trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 500 ether),
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.WindDownBlocksExecute.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_worksAfterDeactivation() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        // Activate then deactivate
        vm.prank(owner);
        vault.activateWindDown();
        vm.prank(owner);
        vault.deactivateWindDown();

        // Execute should work again
        bytes32 intentHash = keccak256("resumed trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 500 ether),
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        vm.prank(operator);
        vault.execute(params, sigs, scores);

        assertEq(vault.getBalance(address(tokenB)), 500 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UNWIND — HAPPY PATH
    // ═══════════════════════════════════════════════════════════════════════════

    function test_unwind_permissionless() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        uint256 balBefore = vault.totalAssets();

        // Anyone can call unwind — here a random user does it
        vm.prank(user);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 200 ether),
            0
        );

        // Deposit asset balance increased
        assertEq(vault.totalAssets(), balBefore + 200 ether);
    }

    function test_unwind_operatorCanCall() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        vm.prank(operator);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 100 ether),
            0
        );

        assertEq(vault.totalAssets(), 1100 ether);
    }

    function test_unwind_emitsEvent() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        vm.prank(user);
        vm.expectEmit(true, true, false, true);
        emit TradingVault.PositionUnwound(user, address(unwindTarget), 200 ether);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 200 ether),
            0
        );
    }

    function test_unwind_multipleCallsAccumulate() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        // Three separate unwind calls
        vm.prank(user);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 100 ether),
            0
        );
        vm.prank(operator);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 200 ether),
            0
        );
        vm.prank(user);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 50 ether),
            0
        );

        assertEq(vault.totalAssets(), 1350 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UNWIND — SAFETY CHECKS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_unwind_revertsIfNotWindDown() public {
        vm.prank(user);
        vm.expectRevert(TradingVault.WindDownNotActive.selector);
        vault.unwind(address(unwindTarget), "", 0);
    }

    function test_unwind_revertsOnAssetDecrease() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        // Try to call a target that would drain deposit asset
        vm.prank(user);
        vm.expectRevert();  // MockUnwindTarget.drain transfers tokens OUT, balance decreases
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.drain.selector, address(vault), address(tokenA)),
            0
        );
    }

    function test_unwind_revertsOnNonWhitelistedTarget() public {
        vm.prank(owner);
        vault.activateWindDown();

        address rando = makeAddr("rando-contract");

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.TargetNotWhitelisted.selector, rando));
        vault.unwind(rando, "", 0);
    }

    function test_unwind_revertsOnZeroTarget() public {
        vm.prank(owner);
        vault.activateWindDown();

        vm.prank(user);
        vm.expectRevert(TradingVault.ZeroAddress.selector);
        vault.unwind(address(0), "", 0);
    }

    function test_unwind_revertsOnFailedCall() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        vm.prank(user);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.alwaysFails.selector),
            0
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAWALS STILL WORK DURING WIND-DOWN
    // ═══════════════════════════════════════════════════════════════════════════

    function test_withdraw_stillWorksDuringWindDown() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        uint256 balBefore = tokenA.balanceOf(user);

        vm.prank(user);
        vault.withdraw(500 ether, user, user);

        assertEq(tokenA.balanceOf(user) - balBefore, 500 ether);
    }

    function test_deposit_stillWorksDuringWindDown() public {
        vm.prank(owner);
        vault.activateWindDown();

        vm.prank(user);
        vault.deposit(1000 ether, user);

        assertEq(vault.totalAssets(), 1000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UNWIND WITH ZERO GAIN (no-op close, balance unchanged)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_unwind_zeroGainAllowed() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.activateWindDown();

        // Call that succeeds but returns 0 tokens (position was already closed)
        vm.prank(user);
        vault.unwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 0),
            0
        );

        // Balance unchanged, no revert
        assertEq(vault.totalAssets(), 1000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CREATOR ROLE
    // ═══════════════════════════════════════════════════════════════════════════

    function test_creator_canActivateWindDown() public {
        vm.prank(creator);
        vault.activateWindDown();
        assertTrue(vault.windDownActive());
    }

    function test_creator_canDeactivateWindDown() public {
        vm.prank(creator);
        vault.activateWindDown();

        vm.prank(creator);
        vault.deactivateWindDown();
        assertFalse(vault.windDownActive());
    }

    function test_randomUser_cannotActivateWindDown() public {
        vm.prank(user);
        vm.expectRevert();
        vault.activateWindDown();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN UNWIND (creator-only, no balance invariant)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_adminUnwind_creatorCanCall() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(creator);
        vault.activateWindDown();

        // Creator performs admin unwind (e.g. initiating a withdrawal queue request)
        vm.prank(creator);
        vault.adminUnwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 100 ether),
            0
        );

        assertEq(vault.totalAssets(), 1100 ether);
    }

    function test_adminUnwind_nonCreatorReverts() public {
        vm.prank(creator);
        vault.activateWindDown();

        vm.prank(user);
        vm.expectRevert();
        vault.adminUnwind(address(unwindTarget), "", 0);
    }

    function test_adminUnwind_operatorCannotCall() public {
        vm.prank(creator);
        vault.activateWindDown();

        vm.prank(operator);
        vm.expectRevert();
        vault.adminUnwind(address(unwindTarget), "", 0);
    }

    function test_adminUnwind_revertsIfNotWindDown() public {
        vm.prank(creator);
        vm.expectRevert(TradingVault.WindDownNotActive.selector);
        vault.adminUnwind(address(unwindTarget), "", 0);
    }

    function test_adminUnwind_revertsOnNonWhitelistedTarget() public {
        vm.prank(creator);
        vault.activateWindDown();

        address rando = makeAddr("rando");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.TargetNotWhitelisted.selector, rando));
        vault.adminUnwind(rando, "", 0);
    }

    function test_adminUnwind_allowsAssetDecrease() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Vault needs to approve unwindTarget to spend its tokens.
        // Simulate the vault approving the target (in practice, calldata would handle this).
        vm.startPrank(address(vault));
        tokenA.approve(address(unwindTarget), type(uint256).max);
        vm.stopPrank();

        vm.prank(creator);
        vault.activateWindDown();

        // Admin unwind that spends deposit asset (e.g. paying a fee to initiate withdrawal)
        // This would revert in permissionless unwind() but is allowed in adminUnwind()
        vm.prank(creator);
        vault.adminUnwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.spendAsset.selector, address(vault), address(tokenA), 50 ether),
            0
        );

        // Balance decreased — allowed for admin unwind
        assertEq(vault.totalAssets(), 950 ether);
    }

    function test_adminUnwind_emitsEvent() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(creator);
        vault.activateWindDown();

        vm.prank(creator);
        vm.expectEmit(true, true, false, true);
        emit TradingVault.PositionUnwound(creator, address(unwindTarget), 0);
        vault.adminUnwind(
            address(unwindTarget),
            abi.encodeWithSelector(MockUnwindTarget.closePosition.selector, address(vault), 100 ether),
            0
        );
    }
}

/// @title MockUnwindTarget
/// @notice Simulates a protocol that returns deposit asset tokens on position close
contract MockUnwindTarget {
    MockERC20 public depositAsset;

    constructor(MockERC20 _depositAsset) {
        depositAsset = _depositAsset;
    }

    /// @notice Simulate closing a position — mints deposit asset back to the vault
    function closePosition(address vault, uint256 amount) external {
        if (amount > 0) {
            depositAsset.mint(vault, amount);
        }
    }

    /// @notice Simulate a malicious drain — transfers tokens OUT of the caller
    /// @dev This should be caught by the asset balance check in unwind()
    function drain(address vault, address token) external {
        uint256 bal = IERC20(token).balanceOf(vault);
        // This will fail because the vault hasn't approved this contract
        // But even if it somehow succeeded, the balance check would catch it
        IERC20(token).transferFrom(vault, address(this), bal);
    }

    /// @notice Simulate spending deposit asset (e.g. fee payment for withdrawal queue)
    /// @dev Requires the vault to have approved this contract first.
    ///      In tests we use a mock that can transfer from the vault.
    function spendAsset(address vault, address token, uint256 amount) external {
        // Use a direct burn-like approach: transfer tokens from vault to this contract
        // This requires the vault to have approved us, which we'll set up in tests
        MockERC20(token).transferFrom(vault, address(this), amount);
    }

    /// @notice Always reverts
    function alwaysFails() external pure {
        revert("intentional failure");
    }

    receive() external payable {}
}
