// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/TradeValidator.sol";
import "../src/TradingVault.sol";

/**
 * @title VerifyEnvelopeV3
 * @notice Post-deploy sanity script for the v3 envelope architecture. Run against
 *         a deployed TradeValidator + sample TradingVault to confirm:
 *           1. The 11 envelope typehashes match the canonical EIP-712 strings.
 *           2. envelopeDigest(sample) returns a non-zero digest (domain separator wired).
 *           3. envelopeConsumedAmount(bytes32(0)) == 0 — no envelope replay state present
 *              on a fresh deployment.
 *
 * Usage:
 *   TRADE_VALIDATOR=0x... \
 *   SAMPLE_VAULT=0x... \
 *     forge script contracts/script/VerifyEnvelopeV3.s.sol --rpc-url $RPC_URL
 *
 * Logs PASS/FAIL per check, sets exit code 1 if any check fails.
 */
contract VerifyEnvelopeV3 is Script {
    TradeValidator public tv;
    TradingVault public vault;
    uint256 public failed;

    function run() external {
        address tvAddr = vm.envAddress("TRADE_VALIDATOR");
        address vaultAddr = vm.envAddress("SAMPLE_VAULT");
        runChecks(tvAddr, vaultAddr);

        console.log("");
        if (failed > 0) {
            console.log("VERIFICATION FAILED:", failed, "checks failed");
            revert("VerifyEnvelopeV3: one or more checks failed");
        }
        console.log("VERIFICATION PASSED - all envelope checks succeeded");
    }

    /// @notice Test-friendly entry point - explicit arguments, no env reads.
    function runChecks(address tvAddr, address vaultAddr) public {
        tv = TradeValidator(tvAddr);
        vault = TradingVault(payable(vaultAddr));
        failed = 0;

        console.log("=== VerifyEnvelopeV3 ===");
        console.log("TradeValidator: ", tvAddr);
        console.log("Sample Vault:   ", vaultAddr);
        console.log("Chain ID:       ", block.chainid);
        console.log("");

        _checkAllTypehashes();
        _checkEnvelopeDigestNonZero();
        _checkNoEnvelopeConsumed();
    }

    // ── typehash assertions ──

    function _checkAllTypehashes() internal {
        _expect(
            "ENVELOPE_TYPEHASH",
            tv.ENVELOPE_TYPEHASH(),
            keccak256(
                "Envelope(uint64 version,bytes32 botIdHash,address vault,uint64 chainId,bytes32 protocolHash,bytes32 policyHash,bytes32 enforcementHash,uint64 issuedAt,uint64 expiresAt,uint64 nonce,bytes32 signersHash,uint64 minSignatures)"
            )
        );
        _expect(
            "UNISWAP_V3_SWAP_TYPEHASH",
            tv.UNISWAP_V3_SWAP_TYPEHASH(),
            keccak256(
                "UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
            )
        );
        _expect(
            "UNISWAP_V4_SWAP_TYPEHASH",
            tv.UNISWAP_V4_SWAP_TYPEHASH(),
            keccak256(
                "UniswapV4SwapEnforcement(address currency0,address currency1,uint256 fee,int256 tickSpacing,address hooks,bool zeroForOne,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address universalRouter,bytes32 hookDataHash)"
            )
        );
        _expect(
            "AERODROME_SWAP_TYPEHASH",
            tv.AERODROME_SWAP_TYPEHASH(),
            keccak256(
                "AerodromeSwapEnforcement(uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,int256 tickSpacing,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
            )
        );
        _expect(
            "AAVE_SUPPLY_TYPEHASH",
            tv.AAVE_SUPPLY_TYPEHASH(),
            keccak256(
                "AaveSupplyEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
            )
        );
        _expect(
            "AAVE_WITHDRAW_TYPEHASH",
            tv.AAVE_WITHDRAW_TYPEHASH(),
            keccak256(
                "AaveWithdrawEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
            )
        );
        _expect(
            "AAVE_BORROW_TYPEHASH",
            tv.AAVE_BORROW_TYPEHASH(),
            keccak256(
                "AaveBorrowEnforcement(address asset,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
            )
        );
        _expect(
            "AAVE_REPAY_TYPEHASH",
            tv.AAVE_REPAY_TYPEHASH(),
            keccak256(
                "AaveRepayEnforcement(address asset,address debtToken,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
            )
        );
        _expect(
            "MORPHO_SUPPLY_TYPEHASH",
            tv.MORPHO_SUPPLY_TYPEHASH(),
            keccak256(
                "MorphoSupplyEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
            )
        );
        _expect(
            "MORPHO_WITHDRAW_TYPEHASH",
            tv.MORPHO_WITHDRAW_TYPEHASH(),
            keccak256(
                "MorphoWithdrawEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
            )
        );
        _expect(
            "MORPHO_BORROW_TYPEHASH",
            tv.MORPHO_BORROW_TYPEHASH(),
            keccak256(
                "MorphoBorrowEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
            )
        );
        _expect(
            "MORPHO_REPAY_TYPEHASH",
            tv.MORPHO_REPAY_TYPEHASH(),
            keccak256(
                "MorphoRepayEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
            )
        );
    }

    // ── envelope digest non-zero ──

    function _checkEnvelopeDigestNonZero() internal {
        TradeValidator.Envelope memory env = _sampleEnvelope();
        bytes32 digest = tv.envelopeDigest(env);
        if (digest == bytes32(0)) {
            console.log("FAIL envelopeDigest(sample) == 0x0");
            failed++;
            return;
        }
        console.log("PASS envelopeDigest(sample) is non-zero");
        console.logBytes32(digest);
    }

    // ── envelope consumption fresh-state check ──

    function _checkNoEnvelopeConsumed() internal {
        uint256 consumed = vault.envelopeConsumedAmount(bytes32(0));
        if (consumed != 0) {
            console.log("FAIL envelopeConsumedAmount(0x0) != 0:", consumed);
            failed++;
            return;
        }
        console.log("PASS envelopeConsumedAmount(0x0) == 0");
    }

    // ── helpers ──

    function _expect(string memory label, bytes32 actual, bytes32 expected) internal {
        if (actual == expected) {
            console.log(string.concat("PASS ", label));
        } else {
            console.log(string.concat("FAIL ", label, " - actual vs expected:"));
            console.logBytes32(actual);
            console.logBytes32(expected);
            failed++;
        }
    }

    function _sampleEnvelope() internal view returns (TradeValidator.Envelope memory) {
        return TradeValidator.Envelope({
            version: 2,
            botIdHash: keccak256("verify-envelope-v3-sample"),
            vault: address(vault),
            chainId: uint64(block.chainid),
            protocolHash: keccak256("uniswap_v3"),
            policyHash: keccak256("policy"),
            enforcementHash: keccak256("enforcement"),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: keccak256("signers"),
            minSignatures: 2
        });
    }
}
