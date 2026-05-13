// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A13 — Future-dated `issuedAt` (post-L-2 regression).
///
/// Sign with `issuedAt = block.timestamp + 1 hour`.
///
/// Expected:
///   - Executor: `block.timestamp < env.issuedAt` → `EnvelopeNotYetActive`.
///   - Validator (view-only): L-2 makes future-dated envelopes revert
///     `InvalidEnvelope`.
contract Attack_A13_FutureIssuedAt is RedTeamBase {
    function test_A13_executorRejectsFutureIssuedAt_EnvelopeNotYetActive() public {
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
        env.issuedAt = uint64(block.timestamp + 1 hours);

        uint256 amountIn = 5 ether;
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
            intentHash: keccak256("a13-issuedat"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(VaultTypes.EnvelopeNotYetActive.selector);
        TradingVault(payable(vault))
            .executeUniswapV3SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);
    }

    function test_A13_validatorRejectsFutureIssuedAt_InvalidEnvelope() public {
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
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);
        env.issuedAt = uint64(block.timestamp + 30 minutes);

        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tradeValidator.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }
}
