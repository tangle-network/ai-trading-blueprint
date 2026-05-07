// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A6 — Calldata corruption: wrong fee tier.
///
/// `swapParams.fee = 100` while `enforcement.feeTier = 3000`. Vault check
/// `uint256(s.fee) != enf.feeTier` MUST revert `EnvelopeCheckFailed`.
contract Attack_A6_CalldataCorruptionFeeTier is RedTeamBase {
    function test_A6_wrongFeeTier_revertsEnvelopeCheckFailed() public {
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

        uint256 amountIn = 5 ether;
        uint256 minOut = (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;

        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(100), // <-- WRONG: enforcement says 3000
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
            intentHash: keccak256("a6-fee"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault))
            .executeUniswapV3SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);
    }
}
