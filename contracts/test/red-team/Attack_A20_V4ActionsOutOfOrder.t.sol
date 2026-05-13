// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A20 — Out-of-order / multi-action V4 buffer.
///
/// V4 envelope expects exactly one action: `SWAP_EXACT_IN_SINGLE` (0x06). Try
/// multiple actions in sequence (e.g. SWAP_EXACT_IN_SINGLE + SETTLE_ALL=0x0c).
/// `_decodeUniversalRouterV4SingleSwap` enforces `actions.length != 1` →
/// revert `EnvelopeCheckFailed`.
contract Attack_A20_V4ActionsOutOfOrder is RedTeamBase {
    function _enforcement() internal view returns (TradeValidator.UniswapV4SwapEnforcement memory) {
        return TradeValidator.UniswapV4SwapEnforcement({
            currency0: address(tokenA),
            currency1: address(tokenB),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0),
            zeroForOne: true,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            universalRouter: address(0xCafe3),
            hookDataHash: keccak256("")
        });
    }

    function _v4ParamBytes() internal view returns (bytes memory) {
        VaultTypes.V4PoolKey memory poolKey = VaultTypes.V4PoolKey({
            currency0: address(tokenA), currency1: address(tokenB), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        VaultTypes.V4ExactInputSingleParams memory v4 = VaultTypes.V4ExactInputSingleParams({
            poolKey: poolKey, zeroForOne: true, amountIn: 5 ether, amountOutMinimum: 5 ether, hookData: ""
        });
        return abi.encode(v4);
    }

    function test_A20_twoActions_revertsEnvelopeCheckFailed() public {
        TradeValidator.UniswapV4SwapEnforcement memory enf = _enforcement();
        _whitelistTokensAndTarget(enf.universalRouter);
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV4Swap(enf), vault);

        // actions = [SWAP_EXACT_IN_SINGLE=0x06, SETTLE_ALL=0x0c]
        bytes memory actions = abi.encodePacked(uint8(0x06), uint8(0x0c));
        bytes[] memory v4Params = new bytes[](2);
        v4Params[0] = _v4ParamBytes();
        v4Params[1] = abi.encode(address(tokenA), uint256(5 ether)); // dummy SETTLE_ALL params
        bytes memory v4SwapInput = abi.encode(actions, v4Params);
        bytes[] memory urInputs = new bytes[](1);
        urInputs[0] = v4SwapInput;
        bytes memory commands = abi.encodePacked(uint8(0x10));
        uint256 ddl = block.timestamp + 600;
        bytes memory urCalldata =
            abi.encodeWithSelector(bytes4(keccak256("execute(bytes,bytes[],uint256)")), commands, urInputs, ddl);

        VaultTypes.ExecuteParams memory params = VaultTypes.ExecuteParams({
            target: enf.universalRouter,
            data: urCalldata,
            value: 0,
            minOutput: 5 ether,
            outputToken: address(tokenB),
            intentHash: keccak256("a20-actions"),
            deadline: ddl
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(VaultTypes.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault))
            .executeUniswapV4SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);
    }

    /// @dev Out-of-order single action (e.g. SETTLE_ALL=0x0c instead of SWAP) MUST revert.
    function test_A20_wrongSingleAction_revertsEnvelopeCheckFailed() public {
        TradeValidator.UniswapV4SwapEnforcement memory enf = _enforcement();
        _whitelistTokensAndTarget(enf.universalRouter);
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV4Swap(enf), vault);

        bytes memory actions = abi.encodePacked(uint8(0x0c)); // SETTLE_ALL — not SWAP
        bytes[] memory v4Params = new bytes[](1);
        v4Params[0] = abi.encode(address(tokenA), uint256(5 ether));
        bytes memory v4SwapInput = abi.encode(actions, v4Params);
        bytes[] memory urInputs = new bytes[](1);
        urInputs[0] = v4SwapInput;
        bytes memory commands = abi.encodePacked(uint8(0x10));
        uint256 ddl = block.timestamp + 600;
        bytes memory urCalldata =
            abi.encodeWithSelector(bytes4(keccak256("execute(bytes,bytes[],uint256)")), commands, urInputs, ddl);

        VaultTypes.ExecuteParams memory params = VaultTypes.ExecuteParams({
            target: enf.universalRouter,
            data: urCalldata,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenB),
            intentHash: keccak256("a20-action-wrong"),
            deadline: ddl
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(VaultTypes.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault))
            .executeUniswapV4SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);
    }
}
