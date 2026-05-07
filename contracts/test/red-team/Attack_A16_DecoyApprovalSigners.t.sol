// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A16 — Decoy approval signers.
///
/// Submit envelope sigs from addresses NOT in the vault's signer config. The
/// validator's `config.signers.contains(signer)` filter MUST drop them so they
/// don't count toward the threshold. To trip the structural check we put the
/// decoys in `approvalSigners` (passing the signersHash gate) but the
/// recovered EOAs aren't on the vault's authorized set.
///
/// Expected: validator returns approved=false (validCount=0).
contract Attack_A16_DecoyApprovalSigners is RedTeamBase {
    function test_A16_decoySigners_doNotCountTowardThreshold() public {
        // Build 3 fresh decoy keypairs (not configured on the vault).
        (address decoy1, uint256 decoy1Pk) = makeAddrAndKey("decoy1");
        (address decoy2, uint256 decoy2Pk) = makeAddrAndKey("decoy2");
        (address decoy3, uint256 decoy3Pk) = makeAddrAndKey("decoy3");

        address[] memory decoys = new address[](3);
        decoys[0] = decoy1;
        decoys[1] = decoy2;
        decoys[2] = decoy3;
        // sort ascending
        for (uint256 i = 0; i < decoys.length; ++i) {
            for (uint256 j = i + 1; j < decoys.length; ++j) {
                if (uint160(decoys[j]) < uint160(decoys[i])) {
                    address t = decoys[i];
                    decoys[i] = decoys[j];
                    decoys[j] = t;
                }
            }
        }

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
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

        // Build envelope with signersHash matching the DECOY set so the
        // _hashApprovalSigners gate passes; the per-sig recovery still
        // produces decoy addresses, which fail config.signers.contains(...).
        TradeValidator.Envelope memory env = TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: vault,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("a16-protocol"),
            policyHash: keccak256("a16-policy"),
            enforcementHash: tradeValidator.hashUniswapV3Swap(enf),
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: _signersHash(decoys),
            minSignatures: 2
        });

        // Sign with decoys.
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(decoy1Pk, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(decoy2Pk, digest);
        sigs[0] = abi.encodePacked(r1, s1, v1);
        sigs[1] = abi.encodePacked(r2, s2, v2);
        scores[0] = 90;
        scores[1] = 90;
        // suppress unused-var warning for decoy3Pk (only address is in set)
        decoy3Pk;

        (bool approved, uint256 validCount) =
            tradeValidator.validateUniswapV3SwapEnvelope(env, enf, decoys, sigs, scores);
        assertFalse(approved, "A16: decoy sigs must NOT approve");
        assertEq(validCount, 0, "A16: decoy sigs must contribute 0 valid signatures");
    }
}
