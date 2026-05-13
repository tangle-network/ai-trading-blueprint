// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @dev Malicious "router" used by A1: when the vault calls `exactInputSingle`,
///      it tries to re-enter `executeUniswapV3SwapEnvelope` on the same vault
///      with the same envelope before the outer call has finished. The vault's
///      `nonReentrant` modifier MUST cause the inner call to revert; the outer
///      executor sees `success=false` from `target.call` and reverts
///      `ExecutionFailed`.
contract MaliciousReentrantRouter {
    TradingVault public vault;
    VaultTypes.ExecuteParams public reentrantParams;
    TradeValidator.Envelope public reentrantEnv;
    TradeValidator.UniswapV3SwapEnforcement public reentrantEnf;
    address[] public reentrantSigners;
    bytes[] public reentrantSigs;
    uint256[] public reentrantScores;
    bool public attemptedReentry;

    function setVault(TradingVault v) external {
        vault = v;
    }

    function arm(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV3SwapEnforcement calldata enf,
        address[] calldata signers,
        bytes[] calldata sigs,
        uint256[] calldata scores
    ) external {
        reentrantParams = params;
        reentrantEnv = env;
        reentrantEnf = enf;
        delete reentrantSigners;
        delete reentrantSigs;
        delete reentrantScores;
        for (uint256 i = 0; i < signers.length; ++i) {
            reentrantSigners.push(signers[i]);
        }
        for (uint256 i = 0; i < sigs.length; ++i) {
            reentrantSigs.push(sigs[i]);
            reentrantScores.push(scores[i]);
        }
    }

    /// @notice Mimics Uniswap V3 router selector (0x414bf389) but the body
    ///         re-enters the vault before honouring the swap.
    function exactInputSingle(MockUniV3Router.ExactInputSingleParams calldata) external returns (uint256) {
        attemptedReentry = true;
        // Re-enter with the SAME envelope. The vault's nonReentrant guard MUST trip.
        vault.executeUniswapV3SwapEnvelope(
            reentrantParams, reentrantEnv, reentrantEnf, reentrantSigners, reentrantSigs, reentrantScores
        );
        return 0;
    }

    receive() external payable {}
}

/// @notice A1 — Reentrant router on `executeUniswapV3SwapEnvelope`.
///
/// Goal: spend the envelope twice in a single transaction.
/// Expected: `nonReentrant` modifier reverts the inner call, the outer call's
/// `target.call` returns false, outer reverts `ExecutionFailed`.
contract Attack_A1_ReentrantRouter is RedTeamBase {
    function test_A1_reentrantRouter_revertsExecutionFailed() public {
        MaliciousReentrantRouter router = new MaliciousReentrantRouter();
        router.setVault(TradingVault(payable(vault)));

        _whitelistTokensAndTarget(address(router));

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(router),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        uint256 amountIn = 10 ether;
        uint256 minOut = (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(enf.feeTier),
            vault,
            uint256(block.timestamp + 600),
            amountIn,
            minOut,
            uint160(0)
        );
        VaultTypes.ExecuteParams memory params = VaultTypes.ExecuteParams({
            target: address(router),
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a1-reentrant"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn * 2);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        // Arm the malicious router with the SAME params/env so it tries to
        // double-spend the envelope inside the call.
        router.arm(params, env, enf, _sortedThreeValidators(), sigs, scores);

        bytes32 envHash = tradeValidator.hashEnvelope(env);
        uint256 consumedBefore = TradingVault(payable(vault)).envelopeConsumedAmount(envHash);

        vm.prank(operator);
        // Outer call sees inner revert → target.call returns false → ExecutionFailed.
        vm.expectRevert(VaultTypes.ExecutionFailed.selector);
        TradingVault(payable(vault))
            .executeUniswapV3SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);

        // NOTE: `router.attemptedReentry()` is NOT asserted because the storage
        //       write happened inside the reverted top-level tx and is rolled
        //       back along with everything else — that's actually the property
        //       we want.

        // Critical: envelope consumed amount and intent flag must be unchanged.
        assertEq(
            TradingVault(payable(vault)).envelopeConsumedAmount(envHash),
            consumedBefore,
            "A1: envelope consumed must not increase on reverted reentrancy"
        );
        assertFalse(
            TradingVault(payable(vault)).executedIntents(params.intentHash),
            "A1: intent must not be marked executed on reverted reentrancy"
        );
    }
}
