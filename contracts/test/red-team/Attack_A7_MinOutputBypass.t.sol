// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A7 — Min-output bypass.
///
/// Set `swapParams.amountOutMinimum = 0` regardless of
/// `enforcement.minOutputPerInput`. The executor's
///   `requiredMinOutput = ceil(amountIn * minOutputPerInput / 1e18)`
/// check MUST trip → `EnvelopeRateTooLow`.
contract Attack_A7_MinOutputBypass is RedTeamBase {
    function test_A7_zeroAmountOutMinimum_revertsEnvelopeRateTooLow() public {
        MockUniV3Router router = new MockUniV3Router();
        _whitelistTokensAndTarget(address(router));

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18, // 1:1 floor
            router: address(router),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        uint256 amountIn = 10 ether;
        uint256 reqMinOut = (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;

        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(enf.feeTier),
            vault,
            uint256(block.timestamp + 600),
            amountIn,
            uint256(0), // <-- amountOutMinimum = 0 (attempted bypass)
            uint160(0)
        );
        VaultTypes.ExecuteParams memory params = VaultTypes.ExecuteParams({
            target: address(router),
            data: data,
            value: 0,
            minOutput: reqMinOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a7-zeroout"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(VaultTypes.EnvelopeRateTooLow.selector, uint256(0), reqMinOut));
        TradingVault(payable(vault))
            .executeUniswapV3SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);
    }
}
