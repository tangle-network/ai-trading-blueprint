// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A3 — Cross-protocol envelope confusion.
///
/// Sign a UniswapV3 envelope and try to execute it via
/// `executePancakeswapV3SwapEnvelope`. The on-chain calldata layouts are
/// byte-identical (`exactInputSingle((address,address,uint24,...))`), so the
/// only thing standing between the operator and confusion is the
/// per-protocol enforcement typehash baked into the enforcement hash.
///
/// Expected:
///   - Type-system level: caller passes a UniswapV3SwapEnforcement struct to
///     a function that wants a PancakeswapV3SwapEnforcement struct — the
///     compiler refuses (covered by the negative-compilation note below).
///   - Runtime level: passing a Pancake enforcement struct copy of the V3
///     fields produces a DIFFERENT enforcement hash, so the envelope's
///     enforcementHash will not match → `EnvelopeEnforcementMismatch`.
contract Attack_A3_CrossProtocolConfusion is RedTeamBase {
    function _v3Enforcement() internal view returns (TradeValidator.UniswapV3SwapEnforcement memory) {
        return TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xdeadbeef),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
    }

    function _pancakeWithSameFields(TradeValidator.UniswapV3SwapEnforcement memory u)
        internal
        pure
        returns (TradeValidator.PancakeswapV3SwapEnforcement memory)
    {
        return TradeValidator.PancakeswapV3SwapEnforcement({
            feeTier: u.feeTier,
            maxSingleAmountIn: u.maxSingleAmountIn,
            maxTotalAmountIn: u.maxTotalAmountIn,
            maxValue: u.maxValue,
            minOutputPerInput: u.minOutputPerInput,
            router: u.router,
            tokenIn: u.tokenIn,
            tokenOut: u.tokenOut,
            sqrtPriceLimitX96: u.sqrtPriceLimitX96
        });
    }

    /// @notice Even with byte-identical fields, V3 vs Pancake enforcement hashes
    ///         must be distinct because the typehash is part of each hash. This
    ///         is the structural property that prevents cross-protocol replay.
    function test_A3_v3VsPancake_enforcementHashesDistinct() public view {
        TradeValidator.UniswapV3SwapEnforcement memory u = _v3Enforcement();
        TradeValidator.PancakeswapV3SwapEnforcement memory p = _pancakeWithSameFields(u);
        bytes32 hu = tradeValidator.hashUniswapV3Swap(u);
        bytes32 hp = tradeValidator.hashPancakeswapV3Swap(p);
        assertTrue(hu != hp, "A3: same fields, different protocols MUST hash differently");
    }

    /// @notice Submit a V3-signed envelope to Pancake executor — the envelope
    ///         was signed with `enforcementHash = hashUniswapV3Swap(...)`, but
    ///         Pancake's executor recomputes `hashPancakeswapV3Swap(...)` and
    ///         compares. Mismatch → `EnvelopeEnforcementMismatch`.
    function test_A3_pancakeExecutorRejectsV3SignedEnvelope() public {
        TradeValidator.UniswapV3SwapEnforcement memory u = _v3Enforcement();
        TradeValidator.PancakeswapV3SwapEnforcement memory p = _pancakeWithSameFields(u);

        // Envelope's enforcementHash is the V3 hash — but we'll dispatch to Pancake.
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(u), vault);

        _whitelistTokensAndTarget(u.router);

        uint256 amountIn = 5 ether;
        uint256 minOut = (amountIn * u.minOutputPerInput + 1e18 - 1) / 1e18;
        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(u.feeTier),
            vault,
            uint256(block.timestamp + 600),
            amountIn,
            minOut,
            uint160(0)
        );
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: u.router,
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a3-cross"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        // The Pancake executor will compute `hashPancakeswapV3Swap(p)` and compare
        // to env.enforcementHash (= V3 hash). They MUST mismatch.
        vm.expectRevert(TradeValidator.EnvelopeEnforcementMismatch.selector);
        TradingVault(payable(vault))
            .executePancakeswapV3SwapEnvelope(params, env, p, _sortedThreeValidators(), sigs, scores);
    }
}
