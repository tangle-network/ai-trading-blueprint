// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A9 — `params.value` drain (post-M-3 regression).
///
/// `params.value = 1 ether` while `enforcement.maxValue = 0`. M-3 bound the
/// native-ETH spend per envelope so this MUST revert `EnvelopeCheckFailed`.
contract Attack_A9_ParamsValueDrain is RedTeamBase {
    function test_A9_paramsValueExceedsMaxValue_revertsEnvelopeCheckFailed() public {
        MockUniV3Router router = new MockUniV3Router();
        _whitelistTokensAndTarget(address(router));

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0, // <-- no native ETH allowed
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
            value: 1 ether, // <-- ATTACK: spend 1 ETH from vault
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a9-value"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        vm.deal(vault, 5 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        uint256 vaultEthBefore = address(vault).balance;

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );

        // Native balance must be untouched.
        assertEq(address(vault).balance, vaultEthBefore, "A9: vault ETH must not move");
    }
}
