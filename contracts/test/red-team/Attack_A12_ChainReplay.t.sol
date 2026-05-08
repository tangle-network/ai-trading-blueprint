// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A12 — Cross-chain envelope replay.
///
/// Sign an envelope with `env.chainId = block.chainid + 1` (i.e. another chain)
/// and try to execute on this chain.
///
/// Expected: executor's `_checkEnvelopeBasics` rejects on
/// `env.chainId != block.chainid` → `EnvelopeWrongChain`. (L-1 also adds the
/// validator-side guard `if (env.chainId != block.chainid) revert
/// InvalidEnvelope` but the executor check fires first.)
contract Attack_A12_ChainReplay is RedTeamBase {
    function test_A12_wrongChainId_revertsEnvelopeWrongChain() public {
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
        env.chainId = uint64(block.chainid) + 1; // <-- wrong chain

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
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a12-chain"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeWrongChain.selector);
        TradingVault(payable(vault))
            .executeUniswapV3SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);
    }

    /// @dev L-1: the validator's view-only path also rejects wrong-chain.
    function test_A12_validatorAlsoRejectsWrongChain() public {
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
        env.chainId = uint64(block.chainid) + 7;

        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tradeValidator.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }
}
