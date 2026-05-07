// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @dev Malicious Curve-style pool — when the vault calls `exchange(i,j,dx,minDy)`
///      it tries to re-enter `executeCurveStableSwapEnvelope` on the vault before
///      the outer call has finished.
contract MaliciousCurvePool {
    TradingVault public vault;
    TradingVault.ExecuteParams public reentrantParams;
    TradeValidator.Envelope public reentrantEnv;
    TradeValidator.CurveStableSwapEnforcement public reentrantEnf;
    address[] public reentrantSigners;
    bytes[] public reentrantSigs;
    uint256[] public reentrantScores;
    bool public attemptedReentry;

    function setVault(TradingVault v) external {
        vault = v;
    }

    function arm(
        TradingVault.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.CurveStableSwapEnforcement calldata enf,
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

    /// @notice keccak256("exchange(int128,int128,uint256,uint256)") = 0x3df02124...
    function exchange(int128, int128, uint256, uint256) external returns (uint256) {
        attemptedReentry = true;
        vault.executeCurveStableSwapEnvelope(
            reentrantParams, reentrantEnv, reentrantEnf, reentrantSigners, reentrantSigs, reentrantScores
        );
        return 0;
    }

    receive() external payable {}
}

/// @notice A2 — Reentrant Curve callback on `executeCurveStableSwapEnvelope`.
///
/// Curve plain pools have callable fallback paths (and `_use_eth` variants)
/// that can reach external contracts. This attack uses a malicious pool that
/// re-enters the vault during `exchange(...)`.
///
/// Expected: `nonReentrant` blocks the inner call → target.call returns false →
/// outer reverts `ExecutionFailed`.
contract Attack_A2_ReentrantCurve is RedTeamBase {
    function test_A2_reentrantCurve_revertsExecutionFailed() public {
        MaliciousCurvePool pool = new MaliciousCurvePool();
        pool.setVault(TradingVault(payable(vault)));

        _whitelistTokensAndTarget(address(pool));

        TradeValidator.CurveStableSwapEnforcement memory enf = TradeValidator.CurveStableSwapEnforcement({
            i: int128(0),
            j: int128(1),
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            pool: address(pool),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB)
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashCurveStableSwap(enf), vault);

        uint256 dx = 5 ether;
        uint256 minDy = (dx * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("exchange(int128,int128,uint256,uint256)")), int128(0), int128(1), dx, minDy
        );
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(pool),
            data: data,
            value: 0,
            minOutput: minDy,
            outputToken: address(tokenB),
            intentHash: keccak256("a2-curve-reentrant"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, dx * 2);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        pool.arm(params, env, enf, _sortedThreeValidators(), sigs, scores);

        bytes32 envHash = tradeValidator.hashEnvelope(env);
        uint256 consumedBefore = TradingVault(payable(vault)).envelopeConsumedAmount(envHash);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        TradingVault(payable(vault)).executeCurveStableSwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );

        // `pool.attemptedReentry()` storage write rolls back with the reverted tx.
        assertEq(
            TradingVault(payable(vault)).envelopeConsumedAmount(envHash),
            consumedBefore,
            "A2: envelope consumed must not increase on reverted reentrancy"
        );
        assertFalse(
            TradingVault(payable(vault)).executedIntents(params.intentHash),
            "A2: intent must not be marked executed on reverted reentrancy"
        );
    }
}
