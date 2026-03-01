// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @notice Tests for TradeValidator are run with a standalone instance
///         where the test contract is the owner (not the factory).
contract TradeValidatorTest is Setup {
    TradeValidator public tv;
    address public testVault;

    function setUp() public override {
        super.setUp();

        // Deploy a standalone TradeValidator owned by this test contract
        tv = new TradeValidator();
        testVault = makeAddr("testVault");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _configureDefault() internal {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
        tv.configureVault(testVault, signers, 2);
    }

    function _sign(uint256 privateKey, bytes32 intentHash, uint256 score, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = tv.computeDigest(intentHash, testVault, score, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_configureVault() public {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        tv.configureVault(testVault, signers, 2);

        assertEq(tv.getSignerCount(testVault), 3);
        assertEq(tv.getRequiredSignatures(testVault), 2);
        assertTrue(tv.isVaultSigner(testVault, validator1));
        assertTrue(tv.isVaultSigner(testVault, validator2));
        assertTrue(tv.isVaultSigner(testVault, validator3));
    }

    function test_configureVaultRevertsDuplicate() public {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator1; // duplicate

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.DuplicateSigner.selector, validator1));
        tv.configureVault(testVault, signers, 2);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SIGNATURE VERIFICATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_twoOfThreeValid() public {
        _configureDefault();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);

        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        (bool approved, uint256 validCount) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        assertTrue(approved);
        assertEq(validCount, 2);
    }

    function test_oneOfThreeFails() public {
        _configureDefault(); // requires 2-of-3

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);

        scores[0] = 80;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);

        (bool approved, uint256 validCount) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        assertFalse(approved);
        assertEq(validCount, 1);
    }

    function test_wrongSignerFails() public {
        _configureDefault();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        // Use a key that is NOT one of the 3 configured signers
        (address wrongSigner, uint256 wrongKey) = makeAddrAndKey("wrongSigner");
        assertFalse(tv.isVaultSigner(testVault, wrongSigner));

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);

        scores[0] = 80;
        scores[1] = 75;
        // validator1 is valid, wrongKey is not
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);

        // Sign with wrong key
        bytes32 digest = tv.computeDigest(intentHash, testVault, scores[1], deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, digest);
        sigs[1] = abi.encodePacked(r, s, v);

        (bool approved, uint256 validCount) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        // Only 1 valid signature (validator1), need 2
        assertFalse(approved);
        assertEq(validCount, 1);
    }

    function test_scoreManipulation() public {
        _configureDefault();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with score=80
        bytes memory sig1 = _sign(validator1Key, intentHash, 80, deadline);
        bytes memory sig2 = _sign(validator2Key, intentHash, 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;

        // Submit with score=50 (manipulated)
        uint256[] memory manipulatedScores = new uint256[](2);
        manipulatedScores[0] = 50;
        manipulatedScores[1] = 50;

        (bool approved, uint256 validCount) =
            tv.validateWithSignatures(intentHash, testVault, sigs, manipulatedScores, deadline);

        // Recovered signers won't match any authorized signer because the
        // digest was computed with score=80 but validation uses score=50
        assertFalse(approved);
        assertEq(validCount, 0);
    }

    function test_deadlineExpired() public {
        _configureDefault();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp - 1; // Already expired

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        vm.expectRevert(TradeValidator.DeadlineExpired.selector);
        tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);
    }

    function test_duplicateSignerPrevented() public {
        _configureDefault();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        // Submit the SAME signer's signature twice
        bytes memory sig1 = _sign(validator1Key, intentHash, 80, deadline);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig1; // duplicate

        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        (bool approved, uint256 validCount) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        // Only counts as 1 valid (duplicate is ignored), need 2
        assertFalse(approved);
        assertEq(validCount, 1);
    }

    function test_addRemoveSigner() public {
        _configureDefault();

        // Add a new signer
        address newSigner = makeAddr("newSigner");
        tv.addSigner(testVault, newSigner);
        assertTrue(tv.isVaultSigner(testVault, newSigner));
        assertEq(tv.getSignerCount(testVault), 4);

        // Remove a signer
        tv.removeSigner(testVault, validator3);
        assertFalse(tv.isVaultSigner(testVault, validator3));
        assertEq(tv.getSignerCount(testVault), 3);
    }

    function test_setRequiredSignatures() public {
        _configureDefault(); // 2-of-3

        tv.setRequiredSignatures(testVault, 3);
        assertEq(tv.getRequiredSignatures(testVault), 3);

        // Now 2-of-3 should fail
        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        (bool approved,) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);
        assertFalse(approved);

        // But 3-of-3 should pass
        bytes[] memory sigs3 = new bytes[](3);
        uint256[] memory scores3 = new uint256[](3);
        scores3[0] = 80;
        scores3[1] = 75;
        scores3[2] = 90;
        sigs3[0] = _sign(validator1Key, intentHash, scores3[0], deadline);
        sigs3[1] = _sign(validator2Key, intentHash, scores3[1], deadline);
        sigs3[2] = _sign(validator3Key, intentHash, scores3[2], deadline);

        (bool approved3,) = tv.validateWithSignatures(intentHash, testVault, sigs3, scores3, deadline);
        assertTrue(approved3);
    }

    function test_computeDigest() public view {
        bytes32 intentHash = keccak256("test trade");
        uint256 score = 80;
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = tv.computeDigest(intentHash, testVault, score, deadline);
        assertTrue(digest != bytes32(0));

        // Same inputs should produce same digest
        bytes32 digest2 = tv.computeDigest(intentHash, testVault, score, deadline);
        assertEq(digest, digest2);

        // Different inputs should produce different digest
        bytes32 digest3 = tv.computeDigest(intentHash, testVault, score + 1, deadline);
        assertTrue(digest != digest3);
    }

    function test_domainSeparator() public view {
        bytes32 domain = tv.getDomainSeparator();
        assertTrue(domain != bytes32(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PER-VAULT CONFIG OWNER TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_vaultConfigOwnerCanSetScoreThreshold() public {
        _configureDefault();

        // vaultConfigOwner is set to this contract (the owner who called configureVault)
        assertEq(tv.vaultConfigOwner(testVault), address(this));

        // Transfer config ownership to user
        tv.setVaultConfigOwner(testVault, user);
        assertEq(tv.vaultConfigOwner(testVault), user);

        // User can now set score threshold
        vm.prank(user);
        tv.setMinScoreThreshold(testVault, 75);
        assertEq(tv.minScoreThreshold(testVault), 75);
    }

    function test_nonConfigOwnerCannotSetScoreThreshold() public {
        _configureDefault();

        // Transfer config ownership to owner (not user)
        tv.setVaultConfigOwner(testVault, owner);

        // User cannot set score threshold
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradeValidator.NotVaultConfigOwnerOrOwner.selector));
        tv.setMinScoreThreshold(testVault, 75);
    }

    function test_contractOwnerAlwaysCanSetThreshold() public {
        _configureDefault();

        // Transfer config ownership to user
        tv.setVaultConfigOwner(testVault, user);

        // Contract owner (this) can still set threshold
        tv.setMinScoreThreshold(testVault, 30);
        assertEq(tv.minScoreThreshold(testVault), 30);
    }

    function test_transferVaultConfigOwner() public {
        _configureDefault();

        // Transfer to user
        tv.setVaultConfigOwner(testVault, user);

        // Old owner (this) can still transfer (as contract owner)
        tv.setVaultConfigOwner(testVault, owner);

        // User can no longer transfer
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradeValidator.NotVaultConfigOwnerOrOwner.selector));
        tv.setVaultConfigOwner(testVault, user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SCORE THRESHOLD VALIDATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_scoreThreshold_blocksBelowThreshold() public {
        _configureDefault();

        // Default threshold is 50 — set it to 80 to test rejection
        tv.setMinScoreThreshold(testVault, 80);

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        // Both validators score 60 — above 50 but below 80 threshold
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 60;
        scores[1] = 60;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        (bool approved, uint256 validCount) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        // Has enough signatures (2 of 3) but avg score (60) < threshold (80)
        assertFalse(approved, "Should be rejected: avg score below threshold");
        assertEq(validCount, 2, "Both signatures should be valid");
    }

    function test_scoreThreshold_passesAboveThreshold() public {
        _configureDefault();

        tv.setMinScoreThreshold(testVault, 70);

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        (bool approved, uint256 validCount) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        // avg score (77.5 → 77 integer division) >= threshold (70)
        assertTrue(approved, "Should be approved: avg score above threshold");
        assertEq(validCount, 2);
    }

    function test_scoreThreshold_zeroAllowsAll() public {
        _configureDefault();

        // Setting threshold to 0 disables score checking
        tv.setMinScoreThreshold(testVault, 0);

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 1; // very low score
        scores[1] = 1;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        (bool approved,) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        assertTrue(approved, "Score check should be disabled when threshold=0");
    }

    function test_scoreThreshold_hundredRejectsAll() public {
        _configureDefault();

        tv.setMinScoreThreshold(testVault, 100);

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 99;
        scores[1] = 99;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        (bool approved,) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        assertFalse(approved, "avg score 99 < threshold 100");

        // But perfect 100 scores should pass
        scores[0] = 100;
        scores[1] = 100;
        sigs[0] = _sign(validator1Key, intentHash, scores[0], deadline);
        sigs[1] = _sign(validator2Key, intentHash, scores[1], deadline);

        (approved,) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);
        assertTrue(approved, "Perfect 100 avg should pass threshold 100");
    }

    function test_defaultThreshold_isInitializedTo50() public {
        _configureDefault();

        assertEq(tv.minScoreThreshold(testVault), 50, "Default threshold should be 50");
    }

    function test_reconfigure_preservesIntentionalZeroThreshold() public {
        _configureDefault(); // threshold initialized to 50

        // Admin intentionally sets threshold to 0
        tv.setMinScoreThreshold(testVault, 0);
        assertEq(tv.minScoreThreshold(testVault), 0);

        // Re-configure vault with new signers — threshold should NOT reset to 50
        address[] memory newSigners = new address[](2);
        newSigners[0] = validator1;
        newSigners[1] = validator2;
        tv.configureVault(testVault, newSigners, 1);

        // Threshold should remain 0 (not reset to 50)
        assertEq(tv.minScoreThreshold(testVault), 0, "Intentional 0 threshold must survive reconfiguration");
    }

    function test_removeSigner_revertsWithCustomError() public {
        _configureDefault();

        // Try to remove a signer that doesn't exist
        address nonSigner = makeAddr("nonSigner");
        vm.expectRevert(abi.encodeWithSelector(TradeValidator.SignerNotInSet.selector, nonSigner));
        tv.removeSigner(testVault, nonSigner);
    }
}
