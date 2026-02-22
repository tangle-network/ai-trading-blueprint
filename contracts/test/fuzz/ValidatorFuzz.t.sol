// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../helpers/Setup.sol";

contract ValidatorFuzzTest is Setup {
    TradeValidator public tv;
    address public testVault;

    function setUp() public override {
        super.setUp();

        // Deploy a standalone TradeValidator owned by this test contract
        tv = new TradeValidator();
        testVault = makeAddr("fuzzVault");

        // Configure vault with 3 signers, 2-of-3
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
        tv.configureVault(testVault, signers, 2);
    }

    /// @notice Fuzz score values: sign with one score, submit with different score -> always rejected
    function testFuzz_scoreManipulation(uint256 signedScore, uint256 submittedScore) public view {
        // Bound scores to reasonable range
        signedScore = bound(signedScore, 0, 100);
        submittedScore = bound(submittedScore, 0, 100);

        // Skip if scores happen to be the same (that would pass correctly)
        if (signedScore == submittedScore) return;

        bytes32 intentHash = keccak256("fuzz trade");
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with signedScore
        bytes32 digest1 = tv.computeDigest(intentHash, testVault, signedScore, deadline);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest1);
        bytes memory sig1 = abi.encodePacked(r1, s1, v1);

        bytes32 digest2 = tv.computeDigest(intentHash, testVault, signedScore, deadline);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest2);
        bytes memory sig2 = abi.encodePacked(r2, s2, v2);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;

        // Submit with submittedScore (different from signedScore)
        uint256[] memory scores = new uint256[](2);
        scores[0] = submittedScore;
        scores[1] = submittedScore;

        (bool approved, uint256 validCount) = tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);

        // Should always be rejected because the recovered signers won't match
        assertFalse(approved, "Manipulated score should never pass");
        assertEq(validCount, 0, "No valid signatures with wrong score");
    }

    /// @notice Fuzz deadline: expired deadlines always rejected
    function testFuzz_deadlineExpired(uint256 elapsed) public {
        // Warp to a reasonable base timestamp first
        vm.warp(1_700_000_000);

        // Elapsed time between 1 second and 10 years
        elapsed = bound(elapsed, 1, 365 days * 10);

        bytes32 intentHash = keccak256("deadline fuzz");
        uint256 deadline = block.timestamp - elapsed; // Always in the past

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;

        // Sign with the expired deadline (signatures are technically valid, but deadline has passed)
        bytes32 digest1 = tv.computeDigest(intentHash, testVault, scores[0], deadline);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest1);
        sigs[0] = abi.encodePacked(r1, s1, v1);

        bytes32 digest2 = tv.computeDigest(intentHash, testVault, scores[1], deadline);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest2);
        sigs[1] = abi.encodePacked(r2, s2, v2);

        vm.expectRevert(TradeValidator.DeadlineExpired.selector);
        tv.validateWithSignatures(intentHash, testVault, sigs, scores, deadline);
    }
}
