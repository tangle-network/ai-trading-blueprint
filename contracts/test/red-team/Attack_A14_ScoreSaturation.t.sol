// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A14 — Score saturation.
///
/// Submit signatures with `score = type(uint256).max`. Probe two cases:
///   (a) ONE signature with max score: validator returns approved=true,
///       avgScore = max / 1 = max ≥ threshold (0..100). Score check passes
///       trivially. The score field is signed-into the digest in the
///       `validateWithSignatures` overload, but for the envelope path scores
///       are NOT inside the digest — they're a separate input. So a single
///       sig with max score is structurally valid; but the *vault's*
///       configured signers must still have signed something matching, and
///       since min sigs = 2 a single sig won't approve.
///   (b) TWO sigs both with `type(uint256).max` score: `scoreSum` overflow
///       MUST panic (0x11) under Solidity 0.8.20 checked arithmetic. Critical
///       property: panic reverts the entire tx, so the envelope is NOT
///       consumed and no executedIntents flag is set. This is the
///       conservative outcome — overflow does NOT silently approve.
contract Attack_A14_ScoreSaturation is RedTeamBase {
    bytes4 internal constant ARITH_PANIC = 0x4e487b71;

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

    function test_A14_twoMaxScores_arithmeticPanicReverts() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _v3();
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        sigs[0] = _signEnvelope(validator1Key, env);
        sigs[1] = _signEnvelope(validator2Key, env);
        scores[0] = type(uint256).max;
        scores[1] = type(uint256).max;

        // Solidity 0.8.20 checked arithmetic: scoreSum overflow → Panic(0x11).
        // The whole call reverts; no silent approval, no envelope consumption.
        vm.expectRevert(abi.encodeWithSelector(bytes4(0x4e487b71), uint256(0x11)));
        tradeValidator.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    /// @dev Single max-score sig: scoreSum stays at max (no add), avgScore = max,
    ///      approved=false because validCount (1) < required (2) — never reaches
    ///      the score branch. Sanity-check that the call returns gracefully.
    function test_A14_oneMaxScore_returnsBelowThresholdGracefully() public view {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _v3();
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);
        sigs[0] = _signEnvelope(validator1Key, env);
        scores[0] = type(uint256).max;

        (bool approved, uint256 validCount) =
            tradeValidator.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertFalse(approved, "A14: one sig must be below 2-of-3 threshold");
        assertEq(validCount, 1, "A14: validCount==1 with single max-score sig");
    }
}
