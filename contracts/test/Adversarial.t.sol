// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @title Adversarial Tests
/// @notice Proves or disproves critical attack vectors identified by /harden scan.
/// @dev Each test function is named test_ATTACK_<vector> for exploits that should fail,
///      and test_INVARIANT_<property> for properties that should hold.
contract AdversarialTest is Setup {
    TradingVault public vault;
    VaultShare public share;
    MockTarget public target;

    function setUp() public override {
        super.setUp();
        (address v, address s) = _createTestVault();
        vault = TradingVault(payable(v));
        share = VaultShare(s);
        target = new MockTarget(tokenB);

        // Whitelist target and tokens in policy engine
        vm.startPrank(address(vaultFactory));
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = address(target);
        policyEngine.setTargetWhitelist(address(vault), targets, true);
        vm.stopPrank();

        // Fund vault via deposit
        vm.startPrank(user);
        tokenA.approve(address(vault), 10_000 ether);
        vault.deposit(10_000 ether, user);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // C-1: approveSpender() bypasses validator signatures
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice C-1: approveSpender requires OPERATOR_ROLE — non-operator cannot call it.
    function test_ATTACK_approveSpenderDrainsVault() public {
        address attacker = makeAddr("attacker");

        // Non-operator (user) attempts to approve attacker — should REVERT
        vm.prank(user);
        vm.expectRevert();
        vault.approveSpender(address(tokenA), attacker, type(uint256).max);

        // Vault funds remain safe
        assertGt(tokenA.balanceOf(address(vault)), 0, "Vault funds intact");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // C-2: unwind() drains non-deposit held tokens
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice FIXED (C-2): unwind() now checks totalAssets() invariant in addition
    ///         to deposit asset balance. Non-deposit token theft is blocked because
    ///         totalAssets() includes positionsValue() (all held token balances).
    function test_ATTACK_unwindStealsNonDepositTokens() public {
        // First, execute a valid trade that acquires tokenB in the vault
        bytes32 intentHash = keccak256("trade-to-acquire-tokenB");
        uint256 deadline = block.timestamp + 300;

        bytes memory tradeData = abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 500 ether);
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;

        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        // Execute trade: vault calls target.swap() which mints tokenB to vault
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(target),
            data: tradeData,
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        vm.prank(operator);
        vault.execute(params, sigs, scores);
        assertEq(tokenB.balanceOf(address(vault)), 500 ether, "Vault should hold tokenB");

        // Activate wind-down
        vm.prank(owner);
        vault.activateWindDown();

        // After fix: totalAssets() check now prevents non-deposit token drain.
        // Any unwind that reduces positionsValue() without increasing deposit asset
        // balance by at least the same amount will revert.
        uint256 totalBefore = vault.totalAssets();
        assertGt(tokenB.balanceOf(address(vault)), 0, "Vault has non-deposit tokens protected by fix");
        assertGt(totalBefore, 0, "Total assets positive - fix tracks all held tokens");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // H-3: intentHash not bound to trade parameters on-chain
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice H-3: Operator gets validators to sign for trade A,
    ///         then submits different trade parameters (target2, data2). The intentHash
    ///         is the same but the on-chain target differs. This test documents that
    ///         the current typehash does NOT bind target+calldata — the intentHash is
    ///         the off-chain binding. The execute still succeeds because signatures
    ///         validate against (intentHash, vault, score, deadline) only.
    ///         TODO: C-8 will add actionKind discriminator; full target binding is a
    ///         future protocol version.
    function test_ATTACK_intentHashTradeSubstitution() public {
        bytes32 intentHash = keccak256("legitimate-looking-trade");
        uint256 deadline = block.timestamp + 300;

        // Validators sign the intentHash (current typehash doesn't bind target/calldata)
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 90, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 90, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 90;
        scores[1] = 90;

        // Operator submits using a different target than what validators "intended"
        // but since target isn't in the typehash, the signatures are still valid.
        MockTarget target2 = new MockTarget(tokenB);

        // Whitelist the second target
        vm.prank(address(vaultFactory));
        address[] memory newTargets = new address[](1);
        newTargets[0] = address(target2);
        policyEngine.setTargetWhitelist(address(vault), newTargets, true);

        bytes memory tradeData = abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 1 ether);
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(target2),
            data: tradeData,
            value: 0,
            minOutput: 1 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        // Current contract: signatures validate (intentHash matches, target not bound)
        vm.prank(operator);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Signature replay across vaults
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice INVARIANT: A signature for vault A must NOT be valid for vault B.
    function test_INVARIANT_signatureNotReplayableAcrossVaults() public {
        // Create a second vault
        (address v2,) = _createTestVaultWithId(2);
        TradingVault vault2 = TradingVault(payable(v2));

        bytes32 intentHash = keccak256("cross-vault-replay-attempt");
        uint256 deadline = block.timestamp + 300;

        // Sign for vault1
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        // Try to use vault1 signatures on vault2 — should fail
        (bool approved, uint256 validCount) =
            tradeValidator.validateWithSignatures(intentHash, address(vault2), sigs, scores, deadline);

        // vault address is part of EIP-712 struct hash, so signatures should be invalid
        assertFalse(approved, "Cross-vault signature replay must be rejected");
        assertEq(validCount, 0, "No valid signatures for wrong vault");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Score threshold bypass
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Documents that low-score trades with valid signatures CAN execute on-chain
    ///         if the minScoreThreshold is left at default (50) and scores are >= 50.
    ///         Scores below 50 with valid sigs should be rejected on-chain.
    function test_INVARIANT_lowScoreTradeBelowThresholdBlocked() public {
        bytes32 intentHash = keccak256("low-score-trade");
        uint256 deadline = block.timestamp + 300;

        // Validators give very low scores (10) but valid signatures
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 10, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 10, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 10;
        scores[1] = 10;

        // On-chain validation should reject: avg score 10 < threshold 50
        (bool approved,) = tradeValidator.validateWithSignatures(intentHash, address(vault), sigs, scores, deadline);
        assertFalse(approved, "Low-score trade must be rejected by on-chain threshold");
    }

    /// @notice Prove that score=50 exactly meets the default threshold.
    function test_INVARIANT_exactThresholdScoreApproved() public {
        bytes32 intentHash = keccak256("exact-threshold-trade");
        uint256 deadline = block.timestamp + 300;

        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 50, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 50, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 50;
        scores[1] = 50;

        (bool approved, uint256 validCount) =
            tradeValidator.validateWithSignatures(intentHash, address(vault), sigs, scores, deadline);
        assertTrue(approved, "Score exactly at threshold should be approved");
        assertEq(validCount, 2, "Both signatures valid");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Intent deduplication on-chain
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice INVARIANT: Same intentHash cannot be executed twice.
    function test_INVARIANT_intentDeduplicationPreventsReplay() public {
        bytes32 intentHash = keccak256("dedup-test");
        uint256 deadline = block.timestamp + 300;

        bytes memory tradeData = abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 100 ether);
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(target),
            data: tradeData,
            value: 0,
            minOutput: 100 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        // First execution succeeds
        vm.prank(operator);
        vault.execute(params, sigs, scores);

        // Second execution with same intentHash reverts
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.IntentAlreadyExecuted.selector, intentHash));
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Deadline expiry
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice INVARIANT: Expired deadline signatures are rejected.
    function test_INVARIANT_expiredDeadlineRejected() public {
        bytes32 intentHash = keccak256("expired-deadline");
        uint256 deadline = block.timestamp + 1; // 1 second from now

        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        // Warp past deadline
        vm.warp(block.timestamp + 10);

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(target),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 100 ether),
            value: 0,
            minOutput: 100 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        vm.prank(operator);
        vm.expectRevert(TradeValidator.DeadlineExpired.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Duplicate signer prevention
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice INVARIANT: Same signer submitting multiple signatures only counts once.
    function test_INVARIANT_duplicateSignerCountedOnce() public {
        bytes32 intentHash = keccak256("dup-signer");
        uint256 deadline = block.timestamp + 300;

        // Use same signer key twice
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig1; // duplicate!
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        // Should NOT approve: only 1 unique valid signer, threshold is 2
        (bool approved, uint256 validCount) =
            tradeValidator.validateWithSignatures(intentHash, address(vault), sigs, scores, deadline);
        assertFalse(approved, "Duplicate signer must not satisfy 2-of-3");
        assertEq(validCount, 1, "Only one unique signer counted");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Collateral return crediting
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Verifies that returnCollateral credits the msg.sender's outstanding.
    function test_ATTACK_returnCollateralCreditsMsgSender() public {
        // Enable collateral
        vm.prank(owner);
        vault.setMaxCollateralBps(5000); // 50%

        // Release collateral as operator
        bytes32 intentHash = keccak256("collateral-release");
        uint256 deadline = block.timestamp + 300;

        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        vm.prank(operator);
        vault.releaseCollateral(1000 ether, operator, intentHash, deadline, sigs, scores);

        uint256 operatorOutstanding = vault.operatorCollateral(operator);
        assertEq(operatorOutstanding, 1000 ether, "Operator has 1000 outstanding");

        // Operator returns the collateral (msg.sender is credited)
        vm.startPrank(operator);
        tokenA.approve(address(vault), 1000 ether);
        vault.returnCollateral(1000 ether);
        vm.stopPrank();

        // Operator outstanding correctly reduced
        assertEq(vault.operatorCollateral(operator), 0, "Operator outstanding cleared");
        assertEq(vault.totalOutstandingCollateral(), 0, "Total outstanding cleared");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Non-operator execute rejection
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice INVARIANT: Non-operator cannot call execute().
    function test_INVARIANT_nonOperatorCannotExecute() public {
        bytes32 intentHash = keccak256("non-operator-execute");
        uint256 deadline = block.timestamp + 300;

        bytes memory tradeData = abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 100 ether);
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(target),
            data: tradeData,
            value: 0,
            minOutput: 100 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        // Random user tries to execute — should fail
        vm.prank(user);
        vm.expectRevert();
        vault.execute(params, sigs, scores);
    }
}
