// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A10 — Approval residue (post-M-1 regression).
///
/// Verify the M-1 fix neutralizes the residual-allowance vector: after a
/// completed envelope swap, the vault MUST have allowance(vault, router) == 0.
/// If a follow-up call (which would simulate an upgraded malicious router at
/// the same address via CREATE2) tries to `transferFrom(vault, ...)` it MUST
/// fail because the allowance is 0.
contract Attack_A10_ApprovalResidue is RedTeamBase {
    function test_A10_postM1_residualAllowanceIsZero() public {
        MockUniV3Router router = new MockUniV3Router();
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
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(router),
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a10-residue"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn * 5); // leave residual balance to prove allowance is the binder
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );

        // M-1: residual allowance MUST be 0.
        assertEq(
            tokenA.allowance(vault, address(router)),
            0,
            "A10: M-1 fix must zero allowance after envelope swap"
        );

        // A follow-up `transferFrom(vault, attacker, X)` from the router itself
        // (no fresh approval) MUST fail.
        vm.prank(address(router));
        (bool ok,) = address(tokenA).call(
            abi.encodeWithSelector(0x23b872dd, vault, address(router), uint256(1 ether))
        );
        assertFalse(ok, "A10: residual-allowance pull MUST fail post-M-1");
    }
}
