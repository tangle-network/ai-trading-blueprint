// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A19 — Universal Router command-buffer manipulation.
///
/// V4 envelope calldata is `UR.execute(commands, inputs, deadline)`. The
/// executor's `_decodeUniversalRouterV4SingleSwap` enforces:
///   commands.length == 1
///   commands[0] == UR_COMMAND_V4_SWAP (0x10)
///
/// Probe with a non-V4_SWAP command (e.g. 0x00 = V3_SWAP_EXACT_IN). MUST revert
/// `EnvelopeCheckFailed`.
contract Attack_A19_URCommandBufferManipulation is RedTeamBase {
    function test_A19_nonV4SwapCommand_revertsEnvelopeCheckFailed() public {
        TradeValidator.UniswapV4SwapEnforcement memory enf = TradeValidator.UniswapV4SwapEnforcement({
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
            universalRouter: address(0xCafe1),
            hookDataHash: keccak256("")
        });
        _whitelistTokensAndTarget(enf.universalRouter);

        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV4Swap(enf), vault);

        // Build calldata with a NON-V4_SWAP command (0x00 = V3_SWAP_EXACT_IN).
        bytes memory commands = abi.encodePacked(uint8(0x00)); // not 0x10
        bytes[] memory urInputs = new bytes[](1);
        urInputs[0] = ""; // input contents irrelevant; the command-byte check fires first
        uint256 ddl = block.timestamp + 600;
        bytes memory urCalldata = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes,bytes[],uint256)")), commands, urInputs, ddl
        );

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: enf.universalRouter,
            data: urCalldata,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenB),
            intentHash: keccak256("a19-cmd"),
            deadline: ddl
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeUniswapV4SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }

    /// @dev Multi-command UR buffer (length != 1) MUST also revert.
    function test_A19_multiCommandBuffer_revertsEnvelopeCheckFailed() public {
        TradeValidator.UniswapV4SwapEnforcement memory enf = TradeValidator.UniswapV4SwapEnforcement({
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
            universalRouter: address(0xCafe2),
            hookDataHash: keccak256("")
        });
        _whitelistTokensAndTarget(enf.universalRouter);
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV4Swap(enf), vault);

        // Two commands: 0x10 V4_SWAP + 0x00 V3_SWAP_EXACT_IN.
        bytes memory commands = abi.encodePacked(uint8(0x10), uint8(0x00));
        bytes[] memory urInputs = new bytes[](2);
        urInputs[0] = "";
        urInputs[1] = "";
        uint256 ddl = block.timestamp + 600;
        bytes memory urCalldata = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes,bytes[],uint256)")), commands, urInputs, ddl
        );
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: enf.universalRouter,
            data: urCalldata,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenB),
            intentHash: keccak256("a19-multi-cmd"),
            deadline: ddl
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeUniswapV4SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }
}
