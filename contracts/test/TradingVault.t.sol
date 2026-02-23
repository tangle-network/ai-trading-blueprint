// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

contract TradingVaultTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;
    MockTarget public mockTarget;

    function setUp() public override {
        super.setUp();

        // Create vault via factory (handles all wiring)
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Deploy mock target that outputs tokenB
        mockTarget = new MockTarget(tokenB);

        // Approve vault for deposits
        vm.prank(user);
        tokenA.approve(address(vault), type(uint256).max);

        vm.prank(owner);
        tokenA.approve(address(vault), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Configure policy so execute() can pass policy checks
    function _configurePolicyForTrade() internal {
        vm.startPrank(address(vaultFactory));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = address(mockTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);

        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);

        vm.stopPrank();
    }

    /// @dev Build ExecuteParams struct for execute()
    function _buildExecuteParams(uint256 outputAmount, uint256 minOutput, bytes32 intentHash, uint256 deadline)
        internal
        view
        returns (TradingVault.ExecuteParams memory)
    {
        bytes memory data = abi.encodeWithSelector(MockTarget.swap.selector, address(vault), outputAmount);

        return TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: data,
            value: 0,
            minOutput: minOutput,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });
    }

    /// @dev Create validator signatures for a trade
    function _createValidatorSigs(bytes32 intentHash, uint256 deadline)
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

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_deposit() public {
        vm.prank(user);
        uint256 shares = vault.deposit(1000 ether, user);

        // First deposit: 1:1 ratio
        assertEq(shares, 1000 ether);
        assertEq(shareToken.balanceOf(user), 1000 ether);
        assertEq(vault.totalAssets(), 1000 ether);
    }

    function test_withdraw() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        uint256 balBefore = tokenA.balanceOf(user);

        vm.prank(user);
        uint256 shares = vault.withdraw(500 ether, user, user);

        assertEq(shares, 500 ether);
        assertEq(tokenA.balanceOf(user) - balBefore, 500 ether);
        assertEq(vault.totalAssets(), 500 ether);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_redeem() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        uint256 balBefore = tokenA.balanceOf(user);

        vm.prank(user);
        uint256 assets = vault.redeem(500 ether, user, user);

        assertEq(assets, 500 ether);
        assertEq(tokenA.balanceOf(user) - balBefore, 500 ether);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_multipleDepositors() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.deposit(2000 ether, owner);

        assertEq(shareToken.balanceOf(user), 1000 ether);
        assertEq(shareToken.balanceOf(owner), 2000 ether);
        assertEq(vault.totalAssets(), 3000 ether);
    }

    function test_sharePrice() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);
        assertEq(shareToken.balanceOf(user), 1000 ether);

        // Simulate gains: mint more tokens directly to vault (doubling the NAV)
        tokenA.mint(address(vault), 1000 ether);

        // Now NAV = 2000, supply = 1000, so 1 share = 2 tokens
        uint256 assetsPerShare = vault.convertToAssets(1 ether);
        assertEq(assetsPerShare, 2 ether);

        // New deposit should get fewer shares: 2000 * 1000 / 2000 = 1000
        vm.prank(owner);
        uint256 newShares = vault.deposit(2000 ether, owner);
        assertEq(newShares, 1000 ether);
    }

    function test_execute() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        _configurePolicyForTrade();

        uint256 expectedOutput = 500 ether;
        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params =
            _buildExecuteParams(expectedOutput, expectedOutput, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vault.execute(params, sigs, scores);

        assertEq(vault.getBalance(address(tokenB)), expectedOutput);
    }

    function test_executeRevertsWithoutPolicy() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        // Policy is initialized by factory with defaults but no token/target whitelists
        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.PolicyCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    function test_executeRevertsWithoutValidatorSigs() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);

        // Only provide 1 signature (need 2-of-3)
        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);
        scores[0] = 80;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ValidatorCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    function test_executeMinOutputCheck() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 actualOutput = 100 ether;
        uint256 minOutput = 500 ether;
        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(actualOutput, minOutput, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.MinOutputNotMet.selector, actualOutput, minOutput));
        vault.execute(params, sigs, scores);
    }

    function test_emergencyWithdraw() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        uint256 balBefore = tokenA.balanceOf(owner);

        vm.prank(owner);
        vault.emergencyWithdraw(address(tokenA), owner);

        assertEq(tokenA.balanceOf(owner) - balBefore, 1000 ether);
        assertEq(vault.getBalance(address(tokenA)), 0);
    }

    function test_pause() public {
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());

        // Deposits blocked
        vm.prank(user);
        vm.expectRevert();
        vault.deposit(1000 ether, user);

        // Unpause
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());

        // Deposit works again
        vm.prank(user);
        vault.deposit(1000 ether, user);
        assertEq(shareToken.balanceOf(user), 1000 ether);
    }

    function test_onlyOperatorCanExecute() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        // Non-operator (user) tries to execute
        vm.prank(user);
        vm.expectRevert();
        vault.execute(params, sigs, scores);
    }

    function test_onlyAdminCanEmergencyWithdraw() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(user);
        vm.expectRevert();
        vault.emergencyWithdraw(address(tokenA), user);
    }

    function test_depositWhenPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(user);
        vm.expectRevert();
        vault.deposit(1000 ether, user);
    }

    function test_getBalance() public {
        vm.prank(user);
        vault.deposit(123 ether, user);
        assertEq(vault.getBalance(address(tokenA)), 123 ether);

        vm.deal(address(vault), 5 ether);
        assertEq(vault.getBalance(address(0)), 5 ether);
    }

    function test_intentDedup_preventsDoubleExecution() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 expectedOutput = 500 ether;
        bytes32 intentHash = keccak256("dedup test");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params =
            _buildExecuteParams(expectedOutput, expectedOutput, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        // First execution succeeds
        vm.prank(operator);
        vault.execute(params, sigs, scores);
        assertTrue(vault.executedIntents(intentHash));

        // Second execution with same intentHash reverts
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.IntentAlreadyExecuted.selector, intentHash));
        vault.execute(params, sigs, scores);
    }

    function test_intentDedup_differentHashesWork() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 expectedOutput = 500 ether;
        uint256 deadline = block.timestamp + 1 hours;

        // Trade 1
        bytes32 hash1 = keccak256("trade 1");
        TradingVault.ExecuteParams memory params1 = _buildExecuteParams(expectedOutput, expectedOutput, hash1, deadline);
        (bytes[] memory sigs1, uint256[] memory scores1) = _createValidatorSigs(hash1, deadline);

        vm.prank(operator);
        vault.execute(params1, sigs1, scores1);

        // Trade 2 with different hash — should succeed
        bytes32 hash2 = keccak256("trade 2");
        TradingVault.ExecuteParams memory params2 = _buildExecuteParams(expectedOutput, expectedOutput, hash2, deadline);
        (bytes[] memory sigs2, uint256[] memory scores2) = _createValidatorSigs(hash2, deadline);

        vm.prank(operator);
        vault.execute(params2, sigs2, scores2);

        assertTrue(vault.executedIntents(hash1));
        assertTrue(vault.executedIntents(hash2));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT LOCKUP TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_depositLockup_blocksEarlyWithdraw() public {
        // Admin sets 1 day lockup
        vm.prank(owner);
        vault.setDepositLockup(1 days);
        assertEq(vault.depositLockupDuration(), 1 days);

        // User deposits
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Immediate withdraw reverts
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, block.timestamp + 1 days));
        vault.withdraw(500 ether, user, user);

        // Immediate redeem also reverts
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, block.timestamp + 1 days));
        vault.redeem(500 ether, user, user);
    }

    function test_depositLockup_allowsAfterDuration() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Advance past lockup
        vm.warp(block.timestamp + 1 days + 1);

        // Withdraw succeeds
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_depositLockup_resetsOnNewDeposit() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // Start at a known timestamp
        vm.warp(100000);

        vm.prank(user);
        vault.deposit(1000 ether, user);
        // lockup expires at 100000 + 86400 = 186400

        // Advance 23 hours
        vm.warp(100000 + 23 hours);

        // New deposit resets the lockup timer
        vm.prank(user);
        vault.deposit(500 ether, user);
        // lockup now expires at (100000 + 23h) + 86400

        uint256 secondDepositTime = block.timestamp;

        // Advance 23 hours from second deposit
        vm.warp(secondDepositTime + 23 hours);

        // Still locked (second deposit was 23h ago, lockup is 24h)
        vm.prank(user);
        vm.expectRevert();
        vault.withdraw(500 ether, user, user);

        // Advance past lockup from second deposit
        vm.warp(secondDepositTime + 1 days + 1);

        // Now succeeds
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
    }

    function test_depositLockup_zeroMeansNoLockup() public {
        // Default is 0 (no lockup)
        assertEq(vault.depositLockupDuration(), 0);

        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Immediate withdraw works
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_depositLockup_perDepositorIsolation() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // User deposits first
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Advance 2 days
        vm.warp(block.timestamp + 2 days);

        // Owner deposits (starts their own lockup)
        vm.prank(owner);
        vault.deposit(1000 ether, owner);

        // User can withdraw (past lockup)
        vm.prank(user);
        vault.withdraw(500 ether, user, user);

        // Owner cannot (just deposited)
        vm.prank(owner);
        vm.expectRevert();
        vault.withdraw(500 ether, owner, owner);
    }

    function test_depositLockup_fairnessScenario() public {
        // THE EXACT SCENARIO THE USER DESCRIBED:
        // User A deposits, positions taken, User B deposits liquid,
        // User A tries to immediately withdraw B's liquidity

        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // User A deposits 1000
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Simulate trading gains: vault now has 1500 (500 profit)
        tokenA.mint(address(vault), 500 ether);

        // User B (owner) deposits 1000 at the higher share price
        vm.prank(owner);
        vault.deposit(1000 ether, owner);

        // User A tries to immediately withdraw profit using B's liquidity
        // This should FAIL because A's lockup was reset... wait no,
        // A deposited earlier. Let's check: A deposited at t=0, lockup is 1 day.
        // A's lockup is still active because we haven't warped past 1 day.
        vm.prank(user);
        vm.expectRevert();
        vault.withdraw(500 ether, user, user);

        // After lockup expires, withdrawal is allowed
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
    }

    function test_depositLockup_onlyAdminCanSet() public {
        vm.prank(user);
        vm.expectRevert();
        vault.setDepositLockup(1 days);
    }
}
