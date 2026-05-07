// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A8 — sqrtPriceLimitX96 corruption (post-M-2 regression).
///
/// `swapParams.sqrtPriceLimitX96 = type(uint160).max - 1` while
/// `enforcement.sqrtPriceLimitX96 = 0`. M-2 pinned this field so any mismatch
/// MUST revert `EnvelopeCheckFailed`.
contract Attack_A8_SqrtPriceLimitCorruption is RedTeamBase {
    function test_A8_sqrtPriceLimitMismatch_revertsEnvelopeCheckFailed() public {
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
            sqrtPriceLimitX96: 0 // <-- pinned to 0
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

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
            type(uint160).max - 1 // <-- WRONG: enforcement pin = 0
        );
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(router),
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a8-sqrt"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }
}
