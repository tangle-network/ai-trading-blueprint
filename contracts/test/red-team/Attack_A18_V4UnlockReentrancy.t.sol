// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @dev V4 swap goes through a Universal Router, which calls PoolManager.unlock
///      → hook callback. A malicious UR (the address the vault is configured to
///      call) can re-enter the vault inside `execute(commands, inputs, ddl)`.
contract MaliciousUniversalRouter {
    TradingVault public vault;
    TradingVault.ExecuteParams public reentrantParams;
    TradeValidator.Envelope public reentrantEnv;
    TradeValidator.UniswapV4SwapEnforcement public reentrantEnf;
    address[] public reentrantSigners;
    bytes[] public reentrantSigs;
    uint256[] public reentrantScores;
    bool public attemptedReentry;

    function setVault(TradingVault v) external {
        vault = v;
    }

    function arm(
        TradingVault.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV4SwapEnforcement calldata enf,
        address[] calldata signers,
        bytes[] calldata sigs,
        uint256[] calldata scores
    ) external {
        reentrantParams = params;
        reentrantEnv = env;
        reentrantEnf = enf;
        delete reentrantSigners;
        delete reentrantSigs;
        delete reentrantScores;
        for (uint256 i = 0; i < signers.length; ++i) {
            reentrantSigners.push(signers[i]);
        }
        for (uint256 i = 0; i < sigs.length; ++i) {
            reentrantSigs.push(sigs[i]);
            reentrantScores.push(scores[i]);
        }
    }

    /// @notice Universal Router 2.0 selector `execute(bytes,bytes[],uint256)`.
    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        attemptedReentry = true;
        vault.executeUniswapV4SwapEnvelope(
            reentrantParams, reentrantEnv, reentrantEnf, reentrantSigners, reentrantSigs, reentrantScores
        );
    }

    receive() external payable {}
}

/// @notice A18 — V4 universal-router / unlock-callback reentrancy.
///
/// Build a malicious "universal router" that, on `execute(...)`, re-enters
/// `executeUniswapV4SwapEnvelope`. The vault's `nonReentrant` modifier MUST
/// trip the inner call, the outer `target.call` returns false, outer reverts
/// `ExecutionFailed`.
contract Attack_A18_V4UnlockReentrancy is RedTeamBase {
    function test_A18_v4MaliciousUnlock_revertsExecutionFailed() public {
        MaliciousUniversalRouter ur = new MaliciousUniversalRouter();
        ur.setVault(TradingVault(payable(vault)));

        _whitelistTokensAndTarget(address(ur));

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
            universalRouter: address(ur),
            hookDataHash: keccak256("")
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV4Swap(enf), vault);

        // Build minimal valid V4 calldata: 1 command (V4_SWAP=0x10), 1 input, 1
        // action (SWAP_EXACT_IN_SINGLE=0x06), 1 v4 param.
        TradingVault.V4PoolKey memory poolKey = TradingVault.V4PoolKey({
            currency0: address(tokenA), currency1: address(tokenB), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        uint128 amountIn = 5 ether;
        uint128 amountOutMinimum = 5 ether;
        TradingVault.V4ExactInputSingleParams memory v4 = TradingVault.V4ExactInputSingleParams({
            poolKey: poolKey, zeroForOne: true, amountIn: amountIn, amountOutMinimum: amountOutMinimum, hookData: ""
        });
        bytes[] memory v4Params = new bytes[](1);
        v4Params[0] = abi.encode(v4);
        bytes memory actions = abi.encodePacked(uint8(0x06));
        bytes memory v4SwapInput = abi.encode(actions, v4Params);
        bytes[] memory urInputs = new bytes[](1);
        urInputs[0] = v4SwapInput;
        bytes memory commands = abi.encodePacked(uint8(0x10));
        uint256 ddl = block.timestamp + 600;
        bytes memory urCalldata =
            abi.encodeWithSelector(bytes4(keccak256("execute(bytes,bytes[],uint256)")), commands, urInputs, ddl);

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(ur),
            data: urCalldata,
            value: 0,
            minOutput: amountOutMinimum,
            outputToken: address(tokenB),
            intentHash: keccak256("a18-v4-reentrant"),
            deadline: ddl
        });

        tokenA.mint(vault, uint256(amountIn) * 2);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        ur.arm(params, env, enf, _sortedThreeValidators(), sigs, scores);

        bytes32 envHash = tradeValidator.hashEnvelope(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        TradingVault(payable(vault))
            .executeUniswapV4SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);

        // `ur.attemptedReentry()` storage write rolls back with the reverted tx.
        assertEq(
            TradingVault(payable(vault)).envelopeConsumedAmount(envHash),
            0,
            "A18: envelope consumed must not increase on reverted reentrancy"
        );
        assertFalse(
            TradingVault(payable(vault)).executedIntents(params.intentHash),
            "A18: intent must not be marked executed on reverted reentrancy"
        );
    }
}
