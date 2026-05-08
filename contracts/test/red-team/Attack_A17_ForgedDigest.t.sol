// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A17 — Forged digest.
///
/// Sign a valid envelope, then mutate one byte of the signature `r` value.
/// `ECDSA.recover` returns a different (or zero) address that fails the
/// trusted-set check.
///
/// Expected: validator returns approved=false (validCount=0). The tx does NOT
/// revert — `config.signers.contains(signer)` filters silently.
contract Attack_A17_ForgedDigest is RedTeamBase {
    function _v3() internal pure returns (TradeValidator.UniswapV3SwapEnforcement memory) {
        return TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 1e18,
            maxTotalAmountIn: 10e18,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xdeadbeef),
            tokenIn: address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2),
            tokenOut: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            sqrtPriceLimitX96: 0
        });
    }

    function test_A17_mutatedSignature_doesNotApprove() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _v3();
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest);

        // Mutate one byte of validator1's r — flip the lowest byte.
        bytes32 r1Tampered = bytes32(uint256(r1) ^ uint256(0x01));

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        sigs[0] = abi.encodePacked(r1Tampered, s1, v1); // tampered
        sigs[1] = abi.encodePacked(r2, s2, v2); // valid
        scores[0] = 80;
        scores[1] = 90;

        // The tampered signature may either:
        //   (a) recover to a non-trusted address — call returns approved=false
        //       with validCount=1 (only validator2 valid), or
        //   (b) trigger ECDSA's malleability guard — entire call reverts
        //       `ECDSAInvalidSignature`. Either is an acceptable safe outcome;
        //       what's NOT acceptable is silent approval.
        try tradeValidator.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores) returns (
            bool approved, uint256 validCount
        ) {
            assertFalse(approved, "A17: tampered sig + 1 valid must not reach quorum");
            assertEq(validCount, 1, "A17: tampered sig must not count");
        } catch {
            assertTrue(true, "A17: tampered sig caused ECDSA revert (also safe)");
        }
    }

    /// @dev Variant: also tamper s. Recovery either returns a non-trusted
    ///      address or reverts inside ECDSA. Either way, no approval.
    function test_A17_tamperedS_doesNotApprove() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _v3();
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest);

        bytes32 s1Tampered = bytes32(uint256(s1) ^ uint256(0x80));

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        sigs[0] = abi.encodePacked(r1, s1Tampered, v1);
        sigs[1] = abi.encodePacked(r2, s2, v2);
        scores[0] = 80;
        scores[1] = 90;

        // ECDSA may revert on a high-S value (malleability check). Either way the
        // call MUST NOT silently approve. We accept either revert or below-quorum.
        try tradeValidator.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores) returns (
            bool approved, uint256 validCount
        ) {
            assertFalse(approved, "A17: tampered s must not approve");
            // validator1 sig is tampered → contributes 0; only validator2 valid → 1.
            assertEq(validCount, 1, "A17: tampered s must not count for validator1");
        } catch {
            // ECDSA malleability revert is also an acceptable outcome.
            assertTrue(true);
        }
    }
}
