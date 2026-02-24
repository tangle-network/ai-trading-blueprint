// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @title EdgeCaseTests
/// @notice Edge case and boundary condition tests for production hardening
contract EdgeCaseTests is Setup {
    TradingVault public vault;
    VaultShare public shareToken;
    MockTarget public mockTarget;

    function setUp() public override {
        super.setUp();
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);
        mockTarget = new MockTarget(tokenB);

        vm.prank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vm.prank(owner);
        tokenA.approve(address(vault), type(uint256).max);
    }

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
    // MISMATCHED SIGNATURE / SCORE ARRAYS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_mismatchedSigScoreArrayLengths() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("mismatch test");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);

        // 2 sigs but 1 score — TradeValidator reverts with InvalidSignatureCount
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](1);
        scores[0] = 80;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), 75, deadline);

        vm.prank(operator);
        vm.expectRevert(TradeValidator.InvalidSignatureCount.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_emptySignaturesReverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("empty sigs");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);

        bytes[] memory sigs = new bytes[](0);
        uint256[] memory scores = new uint256[](0);

        vm.prank(operator);
        vm.expectRevert(TradeValidator.InvalidSignatureCount.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_moreSigsThanScoresReverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("more sigs");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);

        // 1 sig, 3 scores
        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](3);
        scores[0] = 80;
        scores[1] = 75;
        scores[2] = 90;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);

        vm.prank(operator);
        vm.expectRevert(TradeValidator.InvalidSignatureCount.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ZERO-AMOUNT DEPOSITS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_deposit_zeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(TradingVault.ZeroAmount.selector);
        vault.deposit(0, user);
    }

    function test_withdraw_zeroAmountReverts() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(user);
        vm.expectRevert(TradingVault.ZeroAmount.selector);
        vault.withdraw(0, user, user);
    }

    function test_redeem_zeroSharesReverts() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(user);
        vm.expectRevert(TradingVault.ZeroShares.selector);
        vault.redeem(0, user, user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTE BOUNDARY CONDITIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_zeroMinOutputReverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("zero min");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 0, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ZeroAmount.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_zeroTargetReverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("zero target");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(0),
            data: hex"",
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ZeroAddress.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_expiredDeadlineReverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("expired deadline");
        uint256 deadline = block.timestamp - 1; // already expired

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        // Sign with the expired deadline
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        vm.prank(operator);
        vm.expectRevert(TradeValidator.DeadlineExpired.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_failedTargetCallReverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("failed call");
        uint256 deadline = block.timestamp + 1 hours;

        // Point to failingSwap() which always reverts
        bytes memory data = abi.encodeWithSelector(MockTarget.failingSwap.selector);
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: data,
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FEE SETTLEMENT WITH ZERO AUM
    // ═══════════════════════════════════════════════════════════════════════════

    function test_settleFees_zeroAUM_noFees() public {
        // Settle fees on vault with 0 deposited — should emit 0 fees
        vm.prank(address(this)); // FeeDistributor owner is this test contract
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));

        assertEq(perfFee, 0);
        assertEq(mgmtFee, 0);
    }

    function test_settleFees_afterDeposit_noGains_noPerformanceFee() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // First settlement initializes HWM — no fees
        vm.prank(address(this));
        (uint256 perfFee1, uint256 mgmtFee1) = feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(perfFee1, 0);
        assertEq(mgmtFee1, 0);

        // Advance time 1 year, no gains
        vm.warp(block.timestamp + 365 days);

        // Second settlement: management fee should accrue, but no performance fee
        vm.prank(address(this));
        (uint256 perfFee2, uint256 mgmtFee2) = feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(perfFee2, 0); // No gains above HWM
        assertGt(mgmtFee2, 0); // Management fee accrued over 1 year
    }

    function test_settleFees_gainsBelowHWM_noPerformanceFee() public {
        vm.prank(user);
        vault.deposit(2000 ether, user);

        // First settlement — initializes HWM at 2000
        vm.prank(address(this));
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains to 3000 (1000 profit)
        tokenA.mint(address(vault), 1000 ether);

        vm.warp(block.timestamp + 1 days);
        vm.prank(address(this));
        feeDistributor.settleFees(address(vault), address(tokenA));
        // HWM now at ~3000 (minus fees taken)

        // Simulate loss: user withdraws 1500, vault balance drops
        vm.prank(user);
        vault.withdraw(1500 ether, user, user);

        // Vault balance is now < HWM
        uint256 vaultBalance = tokenA.balanceOf(address(vault));
        uint256 hwm = feeDistributor.highWaterMark(address(vault));
        assertTrue(vaultBalance < hwm, "Vault should be below HWM");

        vm.warp(block.timestamp + 30 days);
        vm.prank(address(this));
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));

        // Below HWM → no performance fee
        assertEq(perfFee, 0, "No perf fee below HWM");
        // Management fee still accrues on remaining AUM
        assertGt(mgmtFee, 0, "Management fee should accrue");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // COMBINED POLICY VIOLATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_nonWhitelistedToken_reverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        // Configure policy WITHOUT tokenB in whitelist
        vm.startPrank(address(vaultFactory));
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA); // only tokenA whitelisted
        policyEngine.setWhitelist(address(vault), tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = address(mockTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);
        vm.stopPrank();

        bytes32 intentHash = keccak256("non-whitelisted token");
        uint256 deadline = block.timestamp + 1 hours;

        // Trade outputs tokenB which is NOT whitelisted
        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.PolicyCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_nonWhitelistedTarget_reverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        // Configure policy WITH tokens but WITHOUT target
        vm.startPrank(address(vaultFactory));
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);
        // No targets whitelisted
        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);
        vm.stopPrank();

        bytes32 intentHash = keccak256("non-whitelisted target");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.PolicyCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    function test_execute_exceedsPositionLimit_reverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        // Configure policy with tiny position limit
        vm.startPrank(address(vaultFactory));
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = address(mockTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);
        policyEngine.setPositionLimit(address(vault), address(tokenB), 100 ether); // Only 100 allowed
        vm.stopPrank();

        bytes32 intentHash = keccak256("exceeds position");
        uint256 deadline = block.timestamp + 1 hours;

        // Try to acquire 500 tokenB, exceeds 100 limit
        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.PolicyCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIRTUAL OFFSET / DONATION ATTACK RESISTANCE
    // ═══════════════════════════════════════════════════════════════════════════

    function test_donationAttack_mitigated() public {
        // Classic inflation attack:
        // 1. Attacker deposits 1 wei to get 1 share
        // 2. Attacker donates 10000e18 tokens directly to vault
        // 3. Victim deposits 10000e18, gets 0 shares (all rounding goes to attacker)
        // Virtual offset prevents this.

        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        tokenA.mint(attacker, 20_000 ether);
        tokenA.mint(victim, 10_000 ether);

        // Step 1: Attacker deposits 1 wei
        vm.startPrank(attacker);
        tokenA.approve(address(vault), type(uint256).max);
        uint256 attackerShares = vault.deposit(1, attacker);
        vm.stopPrank();
        assertEq(attackerShares, 1); // Gets 1 share for 1 wei

        // Step 2: Attacker donates 10000 ether directly to vault (not via deposit)
        vm.prank(attacker);
        tokenA.transfer(address(vault), 10_000 ether);
        // Vault now has 10000e18 + 1 wei of assets, but only 1 share outstanding

        // Step 3: Victim deposits 10000 ether
        vm.startPrank(victim);
        tokenA.approve(address(vault), type(uint256).max);
        uint256 victimShares = vault.deposit(10_000 ether, victim);
        vm.stopPrank();

        // WITHOUT virtual offset: victim gets 0 shares (catastrophic)
        // WITH virtual offset: victim gets ~1 share (near 1:1 with attacker)
        // The key: victim MUST get > 0 shares
        assertGt(victimShares, 0, "Victim must receive shares despite donation attack");

        // Victim should be able to redeem back a significant portion
        vm.prank(victim);
        uint256 redeemed = vault.redeem(victimShares, victim, victim);
        // Victim won't get back ALL 10000 (attacker inflated the price) but should get a fair share
        assertGt(redeemed, 0, "Victim must be able to redeem non-zero assets");
    }

    function test_firstDeposit_exactlyOneToOne() public {
        // With virtual offset, first deposit should still be 1:1
        // supply=0+1=1, nav=0+1=1 → shares = (assets * 1) / 1 = assets
        vm.prank(user);
        uint256 shares = vault.deposit(1000 ether, user);
        assertEq(shares, 1000 ether, "First deposit should be exactly 1:1");
    }

    function test_convertToShares_emptyVault_oneToOne() public {
        // When vault is empty: supply=0+1=1, nav=0+1=1
        uint256 shares = vault.convertToShares(1000 ether);
        assertEq(shares, 1000 ether, "Empty vault conversion should be 1:1");
    }

    function test_convertToAssets_emptyVault_oneToOne() public {
        uint256 assets = vault.convertToAssets(1000 ether);
        assertEq(assets, 1000 ether, "Empty vault conversion should be 1:1");
    }

    function test_convertRoundTrip_minimalRounding() public {
        vm.prank(user);
        vault.deposit(5000 ether, user);

        // Simulate 50% gains
        tokenA.mint(address(vault), 2500 ether);

        // Convert assets → shares → assets should have at most 1 wei rounding
        uint256 assets = 1000 ether;
        uint256 shares = vault.convertToShares(assets);
        uint256 recoveredAssets = vault.convertToAssets(shares);

        // Recovery within 2 wei is acceptable (rounding in both convertToShares and convertToAssets)
        assertApproxEqAbs(recoveredAssets, assets, 2, "Round-trip conversion should be within 2 wei");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WIND-DOWN + EXECUTE INTERACTION
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_duringWindDown_reverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        // Activate wind-down
        vm.prank(owner);
        vault.activateWindDown();

        bytes32 intentHash = keccak256("winddown execute");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(intentHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.WindDownBlocksExecute.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT TO ZERO-ADDRESS RECEIVER
    // ═══════════════════════════════════════════════════════════════════════════

    function test_deposit_toZeroAddressReverts() public {
        vm.prank(user);
        vm.expectRevert(TradingVault.ZeroAddress.selector);
        vault.deposit(1000 ether, address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VALIDATOR: DUPLICATE SIGNER ATTACK
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_duplicateSignerCountedOnce() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("dup signer");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);

        // Submit 3 sigs but 2 are from the same validator — only 2 unique, need 2-of-3
        // However, one of them is the same signer, so effectively 2 unique signers
        bytes[] memory sigs = new bytes[](3);
        uint256[] memory scores = new uint256[](3);
        scores[0] = 80;
        scores[1] = 80; // Same score as scores[0] but signed by same key
        scores[2] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator1Key, intentHash, address(vault), scores[1], deadline); // dup of validator1
        sigs[2] = _signValidation(validator2Key, intentHash, address(vault), scores[2], deadline);

        // This should pass: 2 unique signers (validator1 + validator2) >= required 2
        vm.prank(operator);
        vault.execute(params, sigs, scores);
        assertEq(vault.getBalance(address(tokenB)), 500 ether);
    }

    function test_execute_allDuplicateSignersFails() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("all dup");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);

        // 2 sigs but both from validator1 — only 1 unique, need 2-of-3
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 85;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator1Key, intentHash, address(vault), scores[1], deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ValidatorCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }
}
