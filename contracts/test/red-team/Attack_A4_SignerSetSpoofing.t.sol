// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A4 — Signer-set spoofing.
///
/// Two probes:
///   (a) Build an envelope with N=17 approval signers (1 over the
///       MAX_APPROVAL_SIGNERS=16 cap). Validator MUST revert
///       `TooManyApprovalSigners`.
///   (b) Pass the configured 3 signers in DESCENDING order. The validator
///       requires strict ascending order; out-of-order MUST revert
///       `InvalidEnvelope`.
contract Attack_A4_SignerSetSpoofing is RedTeamBase {
    function _v3Enforcement() internal pure returns (TradeValidator.UniswapV3SwapEnforcement memory) {
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

    /// @dev Probe (a): >MAX_APPROVAL_SIGNERS approval-signers triggers the cap.
    function test_A4a_revert_aboveCap_TooManyApprovalSigners() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _v3Enforcement();

        // Build 17 distinct sorted signers. The cap check fires before sig recovery.
        address[] memory many = new address[](17);
        for (uint256 i = 0; i < 17; ++i) {
            many[i] = address(uint160(0x1000 + i));
        }

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        sigs[0] = abi.encodePacked(bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), uint8(27));
        sigs[1] = abi.encodePacked(bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), uint8(27));
        scores[0] = 80;
        scores[1] = 80;

        TradeValidator.Envelope memory env = TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: vault,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("a4-protocol"),
            policyHash: keccak256("a4-policy"),
            enforcementHash: tradeValidator.hashUniswapV3Swap(enf),
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: _signersHash(many),
            minSignatures: 2
        });

        vm.expectRevert(
            abi.encodeWithSelector(TradeValidator.TooManyApprovalSigners.selector, uint256(17), uint256(16))
        );
        tradeValidator.validateUniswapV3SwapEnvelope(env, enf, many, sigs, scores);
    }

    /// @dev Probe (b): unsorted (descending) approval-signers MUST revert
    ///      `InvalidEnvelope`. The validator requires strict ascending order in
    ///      `_hashApprovalSigners`.
    function test_A4b_revert_unsortedSigners_InvalidEnvelope() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _v3Enforcement();
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        // Descending order — strict-ascending check must trip.
        address[] memory sorted = _sortedThreeValidators();
        address[] memory unsorted = new address[](3);
        unsorted[0] = sorted[2];
        unsorted[1] = sorted[1];
        unsorted[2] = sorted[0];

        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tradeValidator.validateUniswapV3SwapEnvelope(env, enf, unsorted, sigs, scores);
    }
}
