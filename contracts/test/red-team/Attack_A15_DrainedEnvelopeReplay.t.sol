// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A15 — Drained envelope replay.
///
/// Consume `maxTotalAmountIn` via a series of swaps using the same envelope.
/// Then try one more trade. Vault MUST revert `EnvelopeTotalExceeded`.
contract Attack_A15_DrainedEnvelopeReplay is RedTeamBase {
    function test_A15_drainedEnvelope_revertsTotalExceeded() public {
        MockUniV3Router router = new MockUniV3Router();
        _whitelistTokensAndTarget(address(router));

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 10 ether,
            maxTotalAmountIn: 10 ether, // <-- single trade exhausts the envelope
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

        // First trade: consume the entire envelope.
        bytes memory data1 = abi.encodeWithSelector(
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
        TradingVault.ExecuteParams memory p1 = TradingVault.ExecuteParams({
            target: address(router),
            data: data1,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a15-first"),
            deadline: block.timestamp + 600
        });
        tokenA.mint(vault, amountIn * 4);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(p1, env, enf, _sortedThreeValidators(), sigs, scores);

        // Second trade: SAME envelope, fresh intentHash and a positive amountIn.
        // Must revert TotalExceeded because all maxTotalAmountIn was consumed.
        bytes memory data2 = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(enf.feeTier),
            vault,
            uint256(block.timestamp + 600),
            uint256(1), // 1 wei still > remaining (0)
            uint256(1),
            uint160(0)
        );
        TradingVault.ExecuteParams memory p2 = TradingVault.ExecuteParams({
            target: address(router),
            data: data2,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenB),
            intentHash: keccak256("a15-second"),
            deadline: block.timestamp + 600
        });

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.EnvelopeTotalExceeded.selector, uint256(1), uint256(0)));
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(p2, env, enf, _sortedThreeValidators(), sigs, scores);
    }
}
