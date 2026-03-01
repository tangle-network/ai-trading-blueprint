// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

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

        // Now NAV = 2000, supply = 1000, so 1 share ~= 2 tokens
        // Virtual offset introduces up to 1 wei rounding (favors vault - prevents donation attacks)
        uint256 assetsPerShare = vault.convertToAssets(1 ether);
        assertApproxEqAbs(assetsPerShare, 2 ether, 1);

        // New deposit should get fewer shares: ~1000 (within 1 wei due to virtual offset)
        vm.prank(owner);
        uint256 newShares = vault.deposit(2000 ether, owner);
        assertApproxEqAbs(newShares, 1000 ether, 1);
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

        // Deposits blocked — no external call in selector, safe with prank
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
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
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, operatorRole
        ));
        vault.execute(params, sigs, scores);
    }

    function test_onlyAdminCanEmergencyWithdraw() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, adminRole
        ));
        vault.emergencyWithdraw(address(tokenA), user);
    }

    function test_depositWhenPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
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
        uint256 unlockTime = vault.lastDepositTime(user) + vault.depositLockupDuration();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, unlockTime));
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
        uint256 ownerUnlock = vault.lastDepositTime(owner) + vault.depositLockupDuration();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, ownerUnlock));
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

        // User A tries to immediately withdraw profit using B's liquidity.
        // A deposited at t=1, lockup is 1 day — still active.
        uint256 userUnlock2 = vault.lastDepositTime(user) + vault.depositLockupDuration();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, userUnlock2));
        vault.withdraw(500 ether, user, user);

        // After lockup expires, withdrawal is allowed
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
    }

    function test_depositLockup_onlyAdminCanSet() public {
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, adminRole
        ));
        vault.setDepositLockup(1 days);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LOCKUP: GRIEFING PREVENTION + ERC-4626 COMPLIANCE
    // ═══════════════════════════════════════════════════════════════════════════

    function test_depositLockup_thirdPartyDepositDoesNotGriefReceiver() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // User deposits for themselves first
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(1000 ether, user);
        vm.stopPrank();

        // Warp past lockup
        vm.warp(block.timestamp + 1 days + 1);

        // Attacker deposits 1 wei to user's address (third-party deposit)
        address attacker = makeAddr("attacker");
        tokenA.mint(attacker, 1 ether);
        vm.startPrank(attacker);
        tokenA.approve(address(vault), 1 ether);
        vault.deposit(1 ether, user); // msg.sender != receiver
        vm.stopPrank();

        // User should STILL be able to withdraw (lockup not reset by third-party deposit)
        vm.prank(user);
        vault.redeem(100 ether, user, user); // should not revert
    }

    function test_depositLockup_maxWithdraw_returnsZeroDuringLockup() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(1000 ether, user);
        vm.stopPrank();

        // During lockup period
        assertEq(vault.maxWithdraw(user), 0, "maxWithdraw should return 0 during lockup");
        assertEq(vault.maxRedeem(user), 0, "maxRedeem should return 0 during lockup");

        // After lockup expires
        vm.warp(block.timestamp + 1 days + 1);
        assertTrue(vault.maxWithdraw(user) > 0, "maxWithdraw should be positive after lockup");
        assertTrue(vault.maxRedeem(user) > 0, "maxRedeem should be positive after lockup");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAW ROUNDING (ERC-4626 COMPLIANCE)
    // ═══════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════════
    // THIRD-PARTY WITHDRAWAL VIA SHARE ALLOWANCE (ERC-4626 _spendShareAllowance)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_thirdPartyWithdraw_viaShareAllowance() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // User approves a third-party spender on the share token
        address spender = makeAddr("spender");
        vm.prank(user);
        shareToken.approve(spender, 500 ether);

        uint256 userSharesBefore = shareToken.balanceOf(user);
        uint256 spenderTokensBefore = tokenA.balanceOf(spender);

        // Spender calls withdraw on behalf of user, assets sent to spender
        vm.prank(spender);
        uint256 sharesBurned = vault.withdraw(500 ether, spender, user);

        assertEq(sharesBurned, 500 ether, "Should burn exact shares for first-deposit ratio");
        assertEq(shareToken.balanceOf(user), userSharesBefore - sharesBurned, "Shares burned from owner");
        assertEq(tokenA.balanceOf(spender) - spenderTokensBefore, 500 ether, "Assets sent to spender");
        // Allowance should be decremented
        assertEq(shareToken.allowance(user, spender), 0, "Allowance fully consumed");
    }

    function test_thirdPartyRedeem_viaShareAllowance() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        address spender = makeAddr("spender");
        vm.prank(user);
        shareToken.approve(spender, 300 ether);

        uint256 spenderTokensBefore = tokenA.balanceOf(spender);

        // Spender redeems shares on behalf of user
        vm.prank(spender);
        uint256 assets = vault.redeem(300 ether, spender, user);

        assertEq(assets, 300 ether, "First-deposit 1:1 ratio");
        assertEq(tokenA.balanceOf(spender) - spenderTokensBefore, 300 ether);
        assertEq(shareToken.allowance(user, spender), 0, "Allowance fully consumed");
    }

    function test_thirdPartyWithdraw_insufficientAllowance_reverts() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        address spender = makeAddr("spender");
        vm.prank(user);
        shareToken.approve(spender, 100 ether); // only 100 approved

        // Spender tries to withdraw 500 (needs 500 shares) — should revert with ERC20InsufficientAllowance
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(
            IERC20Errors.ERC20InsufficientAllowance.selector, spender, 100 ether, 500 ether
        ));
        vault.withdraw(500 ether, spender, user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTE WHEN PAUSED
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_whenPaused_reverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        vm.prank(owner);
        vault.pause();

        bytes32 intentHash = keccak256("paused trade");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.ExecuteParams memory params =
            _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NATIVE ETH EXECUTION PATH
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_nativeETH_output() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        // Deploy an ETH-returning target
        MockETHTarget ethTarget = new MockETHTarget();
        vm.deal(address(ethTarget), 100 ether);

        // Whitelist the ETH target and address(0) as output token
        vm.startPrank(address(vaultFactory));
        address[] memory targets = new address[](1);
        targets[0] = address(ethTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);
        // Whitelist address(0) as token for ETH output
        policyEngine.whitelistToken(address(vault), address(0), true);
        policyEngine.setPositionLimit(address(vault), address(0), 100 ether);
        vm.stopPrank();

        bytes32 intentHash = keccak256("eth trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(ethTarget),
            data: abi.encodeWithSelector(MockETHTarget.sendETH.selector, address(vault), 5 ether),
            value: 0,
            minOutput: 5 ether,
            outputToken: address(0), // ETH output path
            intentHash: intentHash,
            deadline: deadline
        });

        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        uint256 vaultETHBefore = address(vault).balance;

        vm.prank(operator);
        vault.execute(params, sigs, scores);

        assertEq(address(vault).balance - vaultETHBefore, 5 ether, "Vault should receive ETH");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // KEY EVENT TESTS — TradeExecuted
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_emitsTradeExecuted() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 outputAmount = 500 ether;
        bytes32 intentHash = keccak256("event trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params =
            _buildExecuteParams(outputAmount, outputAmount, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit TradingVault.TradeExecuted(address(mockTarget), 0, outputAmount, address(tokenB), intentHash);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAW ROUNDING (ERC-4626 COMPLIANCE)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_withdraw_roundsSharesUp() public {
        // Deposit to establish share ratio
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(1000 ether, user);
        vm.stopPrank();

        // Simulate gains to make share ratio non-trivial
        tokenA.mint(address(vault), 500 ether);

        // Calculate: shares for 1 wei of assets should round up
        uint256 previewShares = vault.previewWithdraw(1);
        uint256 convertShares = vault.convertToShares(1);

        // previewWithdraw rounds UP, convertToShares rounds DOWN
        // For amounts that don't divide evenly, previewWithdraw >= convertToShares
        assertTrue(previewShares >= convertShares, "previewWithdraw must be >= convertToShares (rounding up)");

        // Verify actual withdraw burns the right (rounded up) amount
        uint256 withdrawAmount = 333 ether; // unlikely to divide evenly
        uint256 sharesBefore = shareToken.balanceOf(user);

        vm.prank(user);
        uint256 sharesBurned = vault.withdraw(withdrawAmount, user, user);

        uint256 sharesAfter = shareToken.balanceOf(user);
        assertEq(sharesBefore - sharesAfter, sharesBurned, "Burned shares should match return value");

        // The shares burned should be >= what convertToShares would give (rounded UP)
        // This protects the vault from rounding exploits
        assertTrue(sharesBurned >= vault.convertToShares(withdrawAmount), "withdraw must burn >= convertToShares (round UP)");
    }
}

/// @title MockETHTarget
/// @notice Mock target that sends ETH back to a vault (for testing native ETH execution path)
contract MockETHTarget {
    function sendETH(address to, uint256 amount) external {
        (bool success,) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
