// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PolicyEngine.sol";
import "../TradeValidator.sol";
import "./VaultStorage.sol";
import "./VaultTypes.sol";
import "./ExecutionLib.sol";
import "./ValuationLib.sol";

/// @title EnvelopeExecLib
/// @notice Protocol-bound envelope dispatchers (Uniswap V3/V4, Aerodrome,
///         PancakeSwap V3, Curve, Aave V3, Morpho). Each dispatcher decodes
///         the protocol's calldata, binds the result to the validator-signed
///         enforcement struct, consumes the per-envelope budget, and hands
///         off to `ExecutionLib` for the actual execution + accounting.
///
///         Moved out of `TradingVault` to drop runtime bytecode below the
///         EIP-170 24,576 B cap. State access goes through
///         `VaultStorage.load()`; DELEGATECALL semantics keep writes on
///         the calling vault.
library EnvelopeExecLib {
    // ═══════════════════════════════════════════════════════════════════════════
    // SHARED ENVELOPE HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function checkEnvelopeBasics(TradeValidator.Envelope calldata env) external view {
        if (env.vault != address(this)) revert VaultTypes.EnvelopeWrongVault();
        if (env.chainId != block.chainid) revert VaultTypes.EnvelopeWrongChain();
        if (block.timestamp < env.issuedAt) revert VaultTypes.EnvelopeNotYetActive();
        if (block.timestamp > env.expiresAt) revert VaultTypes.EnvelopeExpired();
    }

    function consumeEnvelope(bytes32 envelopeHash, uint256 amount, uint256 maxSingle, uint256 maxTotal) external {
        if (amount > maxSingle) revert VaultTypes.EnvelopeAmountExceeded(amount, maxSingle);
        VaultStorage.Data storage $ = VaultStorage.load();
        uint256 consumed = $.envelopeConsumedAmount[envelopeHash];
        uint256 remaining = maxTotal > consumed ? maxTotal - consumed : 0;
        if (amount > remaining) revert VaultTypes.EnvelopeTotalExceeded(amount, remaining);
        $.envelopeConsumedAmount[envelopeHash] = consumed + amount;
        emit VaultTypes.EnvelopeConsumed(envelopeHash, amount, consumed + amount);
    }

    /// @dev Envelope-mode prepare for trade-shape executions. Skips
    ///      _checkValidators since envelope sigs were validated upstream.
    function prepareEnvelopeTrade(
        PolicyEngine policyEngine,
        address depositAsset,
        VaultTypes.ExecuteParams calldata params
    ) external view {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (params.target == address(0)) revert VaultTypes.ZeroAddress();
        if (params.minOutput == 0) revert VaultTypes.ZeroAmount();
        ValuationLib.requireValuableOutputToken(params.outputToken, depositAsset);
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }
        if (!policyEngine.checkTrade(address(this), params.outputToken, params.minOutput, params.target)) {
            revert VaultTypes.PolicyCheckFailed();
        }
    }

    function prepareEnvelopeDebtReduction(PolicyEngine policyEngine, VaultTypes.DebtReductionParams calldata params)
        external
        view
    {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (params.target == address(0) || params.inputToken == address(0) || params.debtToken == address(0)) {
            revert VaultTypes.ZeroAddress();
        }
        if (params.maxInput == 0 || params.minDebtDecrease == 0) revert VaultTypes.ZeroAmount();
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }
        if (!policyEngine.checkTrade(address(this), params.inputToken, params.maxInput, params.target)) {
            revert VaultTypes.PolicyCheckFailed();
        }
    }

    function prepareEnvelopeHealthFactor(
        PolicyEngine policyEngine,
        address depositAsset,
        VaultTypes.HealthFactorParams calldata params
    ) external view {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (
            params.target == address(0) || params.outputToken == address(0) || params.pool == address(0)
                || params.account == address(0)
        ) revert VaultTypes.ZeroAddress();
        if (params.minOutput == 0 || params.minHealthFactor == 0) revert VaultTypes.ZeroAmount();
        ValuationLib.requireValuableOutputToken(params.outputToken, depositAsset);
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }
        if (!policyEngine.checkTrade(address(this), params.outputToken, params.minOutput, params.target)) {
            revert VaultTypes.PolicyCheckFailed();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CALLDATA DECODERS (pure)
    // ═══════════════════════════════════════════════════════════════════════════

    function _expectSelector(bytes calldata data, bytes4 expected) internal pure {
        if (data.length < 4 || bytes4(data[:4]) != expected) revert VaultTypes.EnvelopeWrongSelector();
    }

    function decodeExactInputSingle(bytes calldata data)
        external
        pure
        returns (VaultTypes.ExactInputSingleParams memory p)
    {
        _expectSelector(data, VaultTypes.SELECTOR_UNI_V3_EXACT_INPUT_SINGLE);
        p = abi.decode(data[4:], (VaultTypes.ExactInputSingleParams));
    }

    function decodeUniversalRouterV4SingleSwap(bytes calldata data)
        external
        pure
        returns (VaultTypes.V4ExactInputSingleParams memory p, uint256 deadline)
    {
        _expectSelector(data, VaultTypes.SELECTOR_UR_EXECUTE);
        (bytes memory commands, bytes[] memory inputs, uint256 ddl) = abi.decode(data[4:], (bytes, bytes[], uint256));
        deadline = ddl;
        if (commands.length != 1 || inputs.length != 1) revert VaultTypes.EnvelopeCheckFailed();
        if (uint8(commands[0]) != VaultTypes.UR_COMMAND_V4_SWAP) revert VaultTypes.EnvelopeCheckFailed();
        (bytes memory actions, bytes[] memory v4Params) = abi.decode(inputs[0], (bytes, bytes[]));
        if (actions.length != 1 || v4Params.length != 1) revert VaultTypes.EnvelopeCheckFailed();
        if (uint8(actions[0]) != VaultTypes.V4_ACTION_SWAP_EXACT_IN_SINGLE) revert VaultTypes.EnvelopeCheckFailed();
        p = abi.decode(v4Params[0], (VaultTypes.V4ExactInputSingleParams));
    }

    function decodeAerodromeSwap(bytes calldata data) external pure returns (VaultTypes.AerodromeSwapParams memory p) {
        _expectSelector(data, VaultTypes.SELECTOR_AERODROME_EXACT_INPUT_SINGLE);
        p = abi.decode(data[4:], (VaultTypes.AerodromeSwapParams));
    }

    function decodeCurveExchange(bytes calldata data)
        external
        pure
        returns (int128 i, int128 j, uint256 dx, uint256 minDy)
    {
        _expectSelector(data, VaultTypes.SELECTOR_CURVE_EXCHANGE);
        (i, j, dx, minDy) = abi.decode(data[4:], (int128, int128, uint256, uint256));
    }

    function decodeAaveSupply(bytes calldata data)
        external
        pure
        returns (address aaveAsset, uint256 amount, address onBehalfOf, uint16 referralCode)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_SUPPLY);
        (aaveAsset, amount, onBehalfOf, referralCode) = abi.decode(data[4:], (address, uint256, address, uint16));
    }

    function decodeAaveWithdraw(bytes calldata data)
        external
        pure
        returns (address aaveAsset, uint256 amount, address to)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_WITHDRAW);
        (aaveAsset, amount, to) = abi.decode(data[4:], (address, uint256, address));
    }

    function decodeAaveBorrow(bytes calldata data)
        external
        pure
        returns (address aaveAsset, uint256 amount, uint256 rateMode, uint16 refCode, address onBehalfOf)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_BORROW);
        (aaveAsset, amount, rateMode, refCode, onBehalfOf) =
            abi.decode(data[4:], (address, uint256, uint256, uint16, address));
    }

    function decodeAaveRepay(bytes calldata data)
        external
        pure
        returns (address aaveAsset, uint256 amount, uint256 rateMode, address onBehalfOf)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_REPAY);
        (aaveAsset, amount, rateMode, onBehalfOf) = abi.decode(data[4:], (address, uint256, uint256, address));
    }

    function decodeMorphoSupply(bytes calldata data)
        external
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            bytes memory extra
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_SUPPLY);
        (mp, assets, shares, onBehalf, extra) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, bytes));
    }

    function decodeMorphoWithdraw(bytes calldata data)
        external
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            address receiver
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_WITHDRAW);
        (mp, assets, shares, onBehalf, receiver) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, address));
    }

    function decodeMorphoBorrow(bytes calldata data)
        external
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            address receiver
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_BORROW);
        (mp, assets, shares, onBehalf, receiver) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, address));
    }

    function decodeMorphoRepay(bytes calldata data)
        external
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            bytes memory extra
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_REPAY);
        (mp, assets, shares, onBehalf, extra) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, bytes));
    }

    function morphoMarketIdOf(VaultTypes.MorphoMarketParams memory mp) external pure returns (bytes32) {
        return keccak256(abi.encode(mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE DISPATCHERS — DEX (output-token-gain shape)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Bundles the policy / trade-validator / asset trio passed to every
    ///      dispatcher. Avoids stack-too-deep when adding new envelope kinds.
    struct DispatcherCtx {
        PolicyEngine policyEngine;
        TradeValidator tradeValidator;
        address depositAsset;
    }

    function executeUniswapV3Swap(
        DispatcherCtx calldata ctx,
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        VaultTypes.ExactInputSingleParams memory s = _decodeExactInputSingle(params.data);
        if (
            params.target != enf.router || s.tokenIn != enf.tokenIn || s.tokenOut != enf.tokenOut
                || uint256(s.fee) != enf.feeTier || s.recipient != address(this) || params.outputToken != enf.tokenOut
                || s.deadline < block.timestamp || params.deadline < block.timestamp
                || s.sqrtPriceLimitX96 != enf.sqrtPriceLimitX96 || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        uint256 reqMinOut = (s.amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (s.amountOutMinimum < reqMinOut || params.minOutput < reqMinOut) {
            revert VaultTypes.EnvelopeRateTooLow(s.amountOutMinimum, reqMinOut);
        }
        ValuationLib.assertSlippageCap(
            ctx.policyEngine, ctx.depositAsset, s.tokenIn, s.amountIn, params.outputToken, params.minOutput
        );
        (bool ok,) = ctx.tradeValidator.validateUniswapV3SwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        bytes32 envHash = ctx.tradeValidator.hashEnvelope(env);
        _consume(envHash, s.amountIn, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepTrade(ctx.policyEngine, ctx.depositAsset, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: s.tokenIn, spender: params.target, amount: s.amountIn});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeTrade(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    function executeUniswapV4Swap(
        DispatcherCtx calldata ctx,
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV4SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (VaultTypes.V4ExactInputSingleParams memory s, uint256 urDeadline) =
            _decodeUniversalRouterV4SingleSwap(params.data);
        address tokenIn = s.zeroForOne ? s.poolKey.currency0 : s.poolKey.currency1;
        address tokenOut = s.zeroForOne ? s.poolKey.currency1 : s.poolKey.currency0;
        if (
            params.target != enf.universalRouter || s.poolKey.currency0 != enf.currency0
                || s.poolKey.currency1 != enf.currency1 || uint256(s.poolKey.fee) != enf.fee
                || int256(s.poolKey.tickSpacing) != enf.tickSpacing || s.poolKey.hooks != enf.hooks
                || s.zeroForOne != enf.zeroForOne || params.outputToken != tokenOut || urDeadline < block.timestamp
                || params.deadline < block.timestamp || keccak256(s.hookData) != enf.hookDataHash
                || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        uint256 reqMinOut = (uint256(s.amountIn) * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (uint256(s.amountOutMinimum) < reqMinOut || params.minOutput < reqMinOut) {
            revert VaultTypes.EnvelopeRateTooLow(uint256(s.amountOutMinimum), reqMinOut);
        }
        ValuationLib.assertSlippageCap(
            ctx.policyEngine, ctx.depositAsset, tokenIn, uint256(s.amountIn), params.outputToken, params.minOutput
        );
        (bool ok,) = ctx.tradeValidator.validateUniswapV4SwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), uint256(s.amountIn), enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepTrade(ctx.policyEngine, ctx.depositAsset, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: tokenIn, spender: params.target, amount: uint256(s.amountIn)});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeTrade(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    function executeAerodromeSwap(
        DispatcherCtx calldata ctx,
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AerodromeSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        VaultTypes.AerodromeSwapParams memory s = _decodeAerodromeSwap(params.data);
        if (
            params.target != enf.router || s.tokenIn != enf.tokenIn || s.tokenOut != enf.tokenOut
                || int256(s.tickSpacing) != enf.tickSpacing || s.recipient != address(this)
                || params.outputToken != enf.tokenOut || s.deadline < block.timestamp
                || params.deadline < block.timestamp || s.sqrtPriceLimitX96 != enf.sqrtPriceLimitX96
                || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        uint256 reqMinOut = (s.amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (s.amountOutMinimum < reqMinOut || params.minOutput < reqMinOut) {
            revert VaultTypes.EnvelopeRateTooLow(s.amountOutMinimum, reqMinOut);
        }
        ValuationLib.assertSlippageCap(
            ctx.policyEngine, ctx.depositAsset, s.tokenIn, s.amountIn, params.outputToken, params.minOutput
        );
        (bool ok,) = ctx.tradeValidator.validateAerodromeSwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        bytes32 envHash = ctx.tradeValidator.hashEnvelope(env);
        _consume(envHash, s.amountIn, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepTrade(ctx.policyEngine, ctx.depositAsset, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: s.tokenIn, spender: params.target, amount: s.amountIn});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeTrade(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    function executePancakeswapV3Swap(
        DispatcherCtx calldata ctx,
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.PancakeswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        VaultTypes.ExactInputSingleParams memory s = _decodeExactInputSingle(params.data);
        if (
            params.target != enf.router || s.tokenIn != enf.tokenIn || s.tokenOut != enf.tokenOut
                || uint256(s.fee) != enf.feeTier || s.recipient != address(this) || params.outputToken != enf.tokenOut
                || s.deadline < block.timestamp || params.deadline < block.timestamp
                || s.sqrtPriceLimitX96 != enf.sqrtPriceLimitX96 || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        uint256 reqMinOut = (s.amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (s.amountOutMinimum < reqMinOut || params.minOutput < reqMinOut) {
            revert VaultTypes.EnvelopeRateTooLow(s.amountOutMinimum, reqMinOut);
        }
        ValuationLib.assertSlippageCap(
            ctx.policyEngine, ctx.depositAsset, s.tokenIn, s.amountIn, params.outputToken, params.minOutput
        );
        (bool ok,) = ctx.tradeValidator.validatePancakeswapV3SwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        bytes32 envHash = ctx.tradeValidator.hashEnvelope(env);
        _consume(envHash, s.amountIn, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepTrade(ctx.policyEngine, ctx.depositAsset, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: s.tokenIn, spender: params.target, amount: s.amountIn});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeTrade(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    function executeCurveStableSwap(
        DispatcherCtx calldata ctx,
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.CurveStableSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (int128 ci, int128 cj, uint256 dx, uint256 minDy) = _decodeCurveExchange(params.data);
        if (
            params.target != enf.pool || ci != enf.i || cj != enf.j || params.outputToken != enf.tokenOut
                || params.deadline < block.timestamp || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        uint256 reqMinOut = (dx * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (minDy < reqMinOut || params.minOutput < reqMinOut) {
            revert VaultTypes.EnvelopeRateTooLow(minDy, reqMinOut);
        }
        ValuationLib.assertSlippageCap(
            ctx.policyEngine, ctx.depositAsset, enf.tokenIn, dx, params.outputToken, params.minOutput
        );
        (bool ok,) = ctx.tradeValidator.validateCurveStableSwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        bytes32 envHash = ctx.tradeValidator.hashEnvelope(env);
        _consume(envHash, dx, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepTrade(ctx.policyEngine, ctx.depositAsset, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: enf.tokenIn, spender: params.target, amount: dx});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeTrade(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE DISPATCHERS — Aave V3
    // ═══════════════════════════════════════════════════════════════════════════

    function executeAaveSupply(
        DispatcherCtx calldata ctx,
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (address aaveAsset, uint256 amount, address onBehalfOf,) = _decodeAaveSupply(params.data);
        if (params.target != enf.pool || aaveAsset != enf.asset || onBehalfOf != address(this)) {
            revert VaultTypes.EnvelopeCheckFailed();
        }
        if (params.deadline < block.timestamp) revert VaultTypes.EnvelopeCheckFailed();
        if (params.value > enf.maxValue) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateAaveSupplyEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepTrade(ctx.policyEngine, ctx.depositAsset, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: aaveAsset, spender: params.target, amount: amount});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeTrade(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    function executeAaveWithdraw(
        DispatcherCtx calldata ctx,
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (address aaveAsset, uint256 amount, address to) = _decodeAaveWithdraw(params.data);
        if (
            params.target != enf.pool || params.pool != enf.pool || aaveAsset != enf.asset || to != address(this)
                || params.account != address(this) || params.minHealthFactor < enf.minHealthFactor
                || params.deadline < block.timestamp || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateAaveWithdrawEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepHealth(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.executeHealthFactor(ctx.policyEngine, ctx.depositAsset, params);
    }

    function executeAaveBorrow(
        DispatcherCtx calldata ctx,
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (address aaveAsset, uint256 amount, uint256 rateMode,, address onBehalfOf) = _decodeAaveBorrow(params.data);
        if (
            params.target != enf.pool || params.pool != enf.pool || aaveAsset != enf.asset
                || rateMode != enf.interestRateMode || onBehalfOf != address(this) || params.account != address(this)
                || params.minHealthFactor < enf.minHealthFactor || params.deadline < block.timestamp
                || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateAaveBorrowEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepHealth(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.executeHealthFactor(ctx.policyEngine, ctx.depositAsset, params);
    }

    function executeAaveRepay(
        DispatcherCtx calldata ctx,
        VaultTypes.DebtReductionParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (address aaveAsset, uint256 amount, uint256 rateMode, address onBehalfOf) = _decodeAaveRepay(params.data);
        if (
            params.target != enf.pool || params.inputToken != enf.asset || params.debtToken != enf.debtToken
                || aaveAsset != enf.asset || rateMode != enf.interestRateMode || onBehalfOf != address(this)
                || params.deadline < block.timestamp || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateAaveRepayEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepDebt(ctx.policyEngine, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: aaveAsset, spender: params.target, amount: amount});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeDebtReduction(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE DISPATCHERS — Morpho
    // ═══════════════════════════════════════════════════════════════════════════

    function executeMorphoSupply(
        DispatcherCtx calldata ctx,
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (VaultTypes.MorphoMarketParams memory mp, uint256 assets,, address onBehalf,) = _decodeMorphoSupply(params.data);
        if (
            params.target != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId || onBehalf != address(this)
                || params.deadline < block.timestamp || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateMorphoSupplyEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepTrade(ctx.policyEngine, ctx.depositAsset, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: mp.loanToken, spender: params.target, amount: assets});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeTrade(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    function executeMorphoWithdraw(
        DispatcherCtx calldata ctx,
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (VaultTypes.MorphoMarketParams memory mp, uint256 assets,, address onBehalf, address receiver) =
            _decodeMorphoWithdraw(params.data);
        if (
            params.target != enf.morpho || params.pool != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId
                || onBehalf != address(this) || receiver != address(this) || params.account != address(this)
                || params.minHealthFactor < enf.minCollateralRatio || params.deadline < block.timestamp
                || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateMorphoWithdrawEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepHealth(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.executeHealthFactor(ctx.policyEngine, ctx.depositAsset, params);
    }

    function executeMorphoBorrow(
        DispatcherCtx calldata ctx,
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (VaultTypes.MorphoMarketParams memory mp, uint256 assets,, address onBehalf, address receiver) =
            _decodeMorphoBorrow(params.data);
        if (
            params.target != enf.morpho || params.pool != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId
                || onBehalf != address(this) || receiver != address(this) || params.account != address(this)
                || params.minHealthFactor < enf.minCollateralRatio || params.deadline < block.timestamp
                || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateMorphoBorrowEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepHealth(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.executeHealthFactor(ctx.policyEngine, ctx.depositAsset, params);
    }

    function executeMorphoRepay(
        DispatcherCtx calldata ctx,
        VaultTypes.DebtReductionParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external {
        _basics(env);
        (VaultTypes.MorphoMarketParams memory mp, uint256 assets,, address onBehalf,) = _decodeMorphoRepay(params.data);
        if (
            params.target != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId || params.inputToken != mp.loanToken
                || onBehalf != address(this) || params.deadline < block.timestamp || params.value > enf.maxValue
        ) revert VaultTypes.EnvelopeCheckFailed();
        (bool ok,) = ctx.tradeValidator.validateMorphoRepayEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
        _consume(ctx.tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepDebt(ctx.policyEngine, params);
        VaultTypes.ApprovalCall[] memory approvals = new VaultTypes.ApprovalCall[](1);
        approvals[0] = VaultTypes.ApprovalCall({token: mp.loanToken, spender: params.target, amount: assets});
        ExecutionLib.applyApprovalsMemory(approvals, params.target);
        ExecutionLib.executeDebtReduction(ctx.policyEngine, ctx.depositAsset, params);
        ExecutionLib.resetApprovalsMemory(approvals);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL FORWARDERS (collapse the dispatcher boilerplate via internal calls
    // to other library functions so the per-dispatcher bytecode stays small)
    // ═══════════════════════════════════════════════════════════════════════════

    function _basics(TradeValidator.Envelope calldata env) internal view {
        if (env.vault != address(this)) revert VaultTypes.EnvelopeWrongVault();
        if (env.chainId != block.chainid) revert VaultTypes.EnvelopeWrongChain();
        if (block.timestamp < env.issuedAt) revert VaultTypes.EnvelopeNotYetActive();
        if (block.timestamp > env.expiresAt) revert VaultTypes.EnvelopeExpired();
    }

    function _consume(bytes32 envelopeHash, uint256 amount, uint256 maxSingle, uint256 maxTotal) internal {
        if (amount > maxSingle) revert VaultTypes.EnvelopeAmountExceeded(amount, maxSingle);
        VaultStorage.Data storage $ = VaultStorage.load();
        uint256 consumed = $.envelopeConsumedAmount[envelopeHash];
        uint256 remaining = maxTotal > consumed ? maxTotal - consumed : 0;
        if (amount > remaining) revert VaultTypes.EnvelopeTotalExceeded(amount, remaining);
        $.envelopeConsumedAmount[envelopeHash] = consumed + amount;
        emit VaultTypes.EnvelopeConsumed(envelopeHash, amount, consumed + amount);
    }

    function _prepTrade(PolicyEngine policyEngine, address depositAsset, VaultTypes.ExecuteParams calldata params)
        internal
        view
    {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (params.target == address(0)) revert VaultTypes.ZeroAddress();
        if (params.minOutput == 0) revert VaultTypes.ZeroAmount();
        ValuationLib.requireValuableOutputToken(params.outputToken, depositAsset);
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }
        if (!policyEngine.checkTrade(address(this), params.outputToken, params.minOutput, params.target)) {
            revert VaultTypes.PolicyCheckFailed();
        }
    }

    function _prepDebt(PolicyEngine policyEngine, VaultTypes.DebtReductionParams calldata params) internal view {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (params.target == address(0) || params.inputToken == address(0) || params.debtToken == address(0)) {
            revert VaultTypes.ZeroAddress();
        }
        if (params.maxInput == 0 || params.minDebtDecrease == 0) revert VaultTypes.ZeroAmount();
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }
        if (!policyEngine.checkTrade(address(this), params.inputToken, params.maxInput, params.target)) {
            revert VaultTypes.PolicyCheckFailed();
        }
    }

    function _prepHealth(PolicyEngine policyEngine, address depositAsset, VaultTypes.HealthFactorParams calldata params)
        internal
        view
    {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (
            params.target == address(0) || params.outputToken == address(0) || params.pool == address(0)
                || params.account == address(0)
        ) revert VaultTypes.ZeroAddress();
        if (params.minOutput == 0 || params.minHealthFactor == 0) revert VaultTypes.ZeroAmount();
        ValuationLib.requireValuableOutputToken(params.outputToken, depositAsset);
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }
        if (!policyEngine.checkTrade(address(this), params.outputToken, params.minOutput, params.target)) {
            revert VaultTypes.PolicyCheckFailed();
        }
    }

    // ── Internal decoders (inlined into dispatcher bytecode; the external versions
    //    above are kept as a public ABI surface for tooling) ───────────────────

    function _decodeExactInputSingle(bytes calldata data)
        internal
        pure
        returns (VaultTypes.ExactInputSingleParams memory p)
    {
        _expectSelector(data, VaultTypes.SELECTOR_UNI_V3_EXACT_INPUT_SINGLE);
        p = abi.decode(data[4:], (VaultTypes.ExactInputSingleParams));
    }

    function _decodeUniversalRouterV4SingleSwap(bytes calldata data)
        internal
        pure
        returns (VaultTypes.V4ExactInputSingleParams memory p, uint256 deadline)
    {
        _expectSelector(data, VaultTypes.SELECTOR_UR_EXECUTE);
        (bytes memory commands, bytes[] memory inputs, uint256 ddl) = abi.decode(data[4:], (bytes, bytes[], uint256));
        deadline = ddl;
        if (commands.length != 1 || inputs.length != 1) revert VaultTypes.EnvelopeCheckFailed();
        if (uint8(commands[0]) != VaultTypes.UR_COMMAND_V4_SWAP) revert VaultTypes.EnvelopeCheckFailed();
        (bytes memory actions, bytes[] memory v4Params) = abi.decode(inputs[0], (bytes, bytes[]));
        if (actions.length != 1 || v4Params.length != 1) revert VaultTypes.EnvelopeCheckFailed();
        if (uint8(actions[0]) != VaultTypes.V4_ACTION_SWAP_EXACT_IN_SINGLE) revert VaultTypes.EnvelopeCheckFailed();
        p = abi.decode(v4Params[0], (VaultTypes.V4ExactInputSingleParams));
    }

    function _decodeAerodromeSwap(bytes calldata data) internal pure returns (VaultTypes.AerodromeSwapParams memory p) {
        _expectSelector(data, VaultTypes.SELECTOR_AERODROME_EXACT_INPUT_SINGLE);
        p = abi.decode(data[4:], (VaultTypes.AerodromeSwapParams));
    }

    function _decodeCurveExchange(bytes calldata data)
        internal
        pure
        returns (int128 i, int128 j, uint256 dx, uint256 minDy)
    {
        _expectSelector(data, VaultTypes.SELECTOR_CURVE_EXCHANGE);
        (i, j, dx, minDy) = abi.decode(data[4:], (int128, int128, uint256, uint256));
    }

    function _decodeAaveSupply(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, address onBehalfOf, uint16 referralCode)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_SUPPLY);
        (aaveAsset, amount, onBehalfOf, referralCode) = abi.decode(data[4:], (address, uint256, address, uint16));
    }

    function _decodeAaveWithdraw(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, address to)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_WITHDRAW);
        (aaveAsset, amount, to) = abi.decode(data[4:], (address, uint256, address));
    }

    function _decodeAaveBorrow(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, uint256 rateMode, uint16 refCode, address onBehalfOf)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_BORROW);
        (aaveAsset, amount, rateMode, refCode, onBehalfOf) =
            abi.decode(data[4:], (address, uint256, uint256, uint16, address));
    }

    function _decodeAaveRepay(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, uint256 rateMode, address onBehalfOf)
    {
        _expectSelector(data, VaultTypes.SELECTOR_AAVE_REPAY);
        (aaveAsset, amount, rateMode, onBehalfOf) = abi.decode(data[4:], (address, uint256, uint256, address));
    }

    function _decodeMorphoSupply(bytes calldata data)
        internal
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            bytes memory extra
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_SUPPLY);
        (mp, assets, shares, onBehalf, extra) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, bytes));
    }

    function _decodeMorphoWithdraw(bytes calldata data)
        internal
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            address receiver
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_WITHDRAW);
        (mp, assets, shares, onBehalf, receiver) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, address));
    }

    function _decodeMorphoBorrow(bytes calldata data)
        internal
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            address receiver
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_BORROW);
        (mp, assets, shares, onBehalf, receiver) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, address));
    }

    function _decodeMorphoRepay(bytes calldata data)
        internal
        pure
        returns (
            VaultTypes.MorphoMarketParams memory mp,
            uint256 assets,
            uint256 shares,
            address onBehalf,
            bytes memory extra
        )
    {
        _expectSelector(data, VaultTypes.SELECTOR_MORPHO_REPAY);
        (mp, assets, shares, onBehalf, extra) =
            abi.decode(data[4:], (VaultTypes.MorphoMarketParams, uint256, uint256, address, bytes));
    }

    function _morphoMarketIdOf(VaultTypes.MorphoMarketParams memory mp) internal pure returns (bytes32) {
        return keccak256(abi.encode(mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv));
    }
}
