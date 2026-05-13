// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../PolicyEngine.sol";
import "../TradeValidator.sol";
import "./VaultStorage.sol";
import "./VaultTypes.sol";
import "./ValuationLib.sol";

interface IAavePoolHealth {
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @title ExecutionLib
/// @notice Trade-execution primitives shared by the regular execute paths and
///         every envelope dispatcher. Lives in its own external library so
///         the vault keeps a single copy of policy checks, validator-sig
///         verification, post-call balance accounting, and EIP-712 typed-hash
///         computation — and so the cumulative bytecode lands outside the
///         24 KB EIP-170 cap.
///
///         Storage access goes through `VaultStorage.load()` against the
///         ERC-7201 slot. DELEGATECALL semantics mean writes hit the caller.
library ExecutionLib {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // PREPARE (pre-call gating)
    // ═══════════════════════════════════════════════════════════════════════════

    function prepareExecution(
        PolicyEngine policyEngine,
        TradeValidator tradeValidator,
        address depositAsset,
        VaultTypes.ExecuteParams calldata params,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        bytes32 approvalsHash
    ) external view {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (params.target == address(0)) revert VaultTypes.ZeroAddress();
        if (params.minOutput == 0) revert VaultTypes.ZeroAmount();
        ValuationLib.requireValuableOutputToken(params.outputToken, depositAsset);

        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }

        _checkPolicy(policyEngine, params.outputToken, params.minOutput, params.target);

        bytes32 executionHash = _computeExecutionHash(params, approvalsHash);
        _checkValidators(
            tradeValidator,
            params.intentHash,
            executionHash,
            signatures,
            scores,
            params.deadline,
            VaultTypes.ACTION_KIND_EXECUTE
        );
    }

    function prepareDebtReduction(
        PolicyEngine policyEngine,
        TradeValidator tradeValidator,
        VaultTypes.DebtReductionParams calldata params,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        bytes32 approvalsHash
    ) external view {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (params.target == address(0) || params.inputToken == address(0) || params.debtToken == address(0)) {
            revert VaultTypes.ZeroAddress();
        }
        if (params.maxInput == 0 || params.minDebtDecrease == 0) revert VaultTypes.ZeroAmount();
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }

        _checkPolicy(policyEngine, params.inputToken, params.maxInput, params.target);

        bytes32 executionHash = _computeDebtReductionHash(params, approvalsHash);
        _checkValidators(
            tradeValidator,
            params.intentHash,
            executionHash,
            signatures,
            scores,
            params.deadline,
            VaultTypes.ACTION_KIND_EXECUTE
        );
    }

    function prepareHealthFactor(
        PolicyEngine policyEngine,
        TradeValidator tradeValidator,
        address depositAsset,
        VaultTypes.HealthFactorParams calldata params,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        bytes32 approvalsHash
    ) external view {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (
            params.target == address(0) || params.outputToken == address(0) || params.pool == address(0)
                || params.account == address(0)
        ) {
            revert VaultTypes.ZeroAddress();
        }
        if (params.minOutput == 0 || params.minHealthFactor == 0) revert VaultTypes.ZeroAmount();
        ValuationLib.requireValuableOutputToken(params.outputToken, depositAsset);
        if ($.executedIntents[params.intentHash]) {
            revert VaultTypes.IntentAlreadyExecuted(params.intentHash);
        }

        _checkPolicy(policyEngine, params.outputToken, params.minOutput, params.target);

        bytes32 executionHash = _computeHealthFactorHash(params, approvalsHash);
        _checkValidators(
            tradeValidator,
            params.intentHash,
            executionHash,
            signatures,
            scores,
            params.deadline,
            VaultTypes.ACTION_KIND_EXECUTE
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTE (the actual external call + post-condition checks)
    // ═══════════════════════════════════════════════════════════════════════════

    function executeTrade(PolicyEngine policyEngine, address depositAsset, VaultTypes.ExecuteParams calldata params)
        external
    {
        uint256 balanceBefore;
        if (params.outputToken == address(0)) {
            balanceBefore = address(this).balance - params.value;
        } else {
            balanceBefore = IERC20(params.outputToken).balanceOf(address(this));
        }

        // CEI: register the output token before the external call.
        ValuationLib.addHeldToken(params.outputToken, depositAsset);

        (bool success,) = params.target.call{value: params.value}(params.data);
        if (!success) revert VaultTypes.ExecutionFailed();

        uint256 balanceAfter;
        if (params.outputToken == address(0)) {
            balanceAfter = address(this).balance;
        } else {
            balanceAfter = IERC20(params.outputToken).balanceOf(address(this));
        }

        uint256 outputGained = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (outputGained < params.minOutput) revert VaultTypes.MinOutputNotMet(outputGained, params.minOutput);

        _checkFinalPositionLimit(policyEngine, params.outputToken);

        _checkDepositAssetReserve(depositAsset);

        _commitIntent(policyEngine, params.intentHash);
        emit VaultTypes.TradeExecuted(params.target, params.value, outputGained, params.outputToken, params.intentHash);
    }

    function executeDebtReduction(
        PolicyEngine policyEngine,
        address depositAsset,
        VaultTypes.DebtReductionParams calldata params
    ) external {
        uint256 debtBefore = IERC20(params.debtToken).balanceOf(address(this));

        (bool success,) = params.target.call{value: params.value}(params.data);
        if (!success) revert VaultTypes.ExecutionFailed();

        uint256 debtAfter = IERC20(params.debtToken).balanceOf(address(this));
        uint256 debtDecreased = debtBefore > debtAfter ? debtBefore - debtAfter : 0;
        if (debtDecreased < params.minDebtDecrease) {
            revert VaultTypes.DebtDecreaseNotMet(debtDecreased, params.minDebtDecrease);
        }

        _checkDepositAssetReserve(depositAsset);

        _commitIntent(policyEngine, params.intentHash);
        emit VaultTypes.DebtReductionExecuted(
            params.target, params.value, params.inputToken, debtDecreased, params.debtToken, params.intentHash
        );
    }

    function executeHealthFactor(
        PolicyEngine policyEngine,
        address depositAsset,
        VaultTypes.HealthFactorParams calldata params
    ) external {
        uint256 balanceBefore = IERC20(params.outputToken).balanceOf(address(this));

        ValuationLib.addHeldToken(params.outputToken, depositAsset);

        (bool success,) = params.target.call{value: params.value}(params.data);
        if (!success) revert VaultTypes.ExecutionFailed();

        uint256 balanceAfter = IERC20(params.outputToken).balanceOf(address(this));
        uint256 outputGained = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (outputGained < params.minOutput) revert VaultTypes.MinOutputNotMet(outputGained, params.minOutput);

        _checkFinalPositionLimit(policyEngine, params.outputToken);

        (uint256 totalCollateralBase, uint256 totalDebtBase,,,, uint256 healthFactor) =
            IAavePoolHealth(params.pool).getUserAccountData(params.account);
        if (healthFactor < params.minHealthFactor) {
            revert VaultTypes.HealthFactorTooLow(healthFactor, params.minHealthFactor);
        }

        (, uint256 leverageCap,,,) = policyEngine.policies(address(this));
        if (leverageCap > 0 && totalCollateralBase > 0) {
            if (totalDebtBase >= totalCollateralBase) {
                revert VaultTypes.LeverageCapExceeded(type(uint256).max, leverageCap);
            }
            uint256 equity = totalCollateralBase - totalDebtBase;
            uint256 leverageBps = totalCollateralBase * 10000 / equity;
            if (leverageBps > leverageCap) {
                revert VaultTypes.LeverageCapExceeded(leverageBps, leverageCap);
            }
        }

        _checkDepositAssetReserve(depositAsset);

        _commitIntent(policyEngine, params.intentHash);
        emit VaultTypes.TradeExecuted(params.target, params.value, outputGained, params.outputToken, params.intentHash);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // APPROVALS
    // ═══════════════════════════════════════════════════════════════════════════

    function applyApprovals(VaultTypes.ApprovalCall[] calldata approvals, address target) external {
        for (uint256 i = 0; i < approvals.length; ++i) {
            VaultTypes.ApprovalCall calldata approval = approvals[i];
            if (approval.token == address(0) || approval.spender == address(0)) revert VaultTypes.ZeroAddress();
            if (approval.spender != target) {
                revert VaultTypes.ApprovalSpenderMismatch(approval.spender, target);
            }
            IERC20(approval.token).forceApprove(approval.spender, approval.amount);
            emit VaultTypes.SpenderApprovalUpdated(approval.token, approval.spender, approval.amount);
        }
    }

    function resetApprovals(VaultTypes.ApprovalCall[] calldata approvals) external {
        for (uint256 i = 0; i < approvals.length; ++i) {
            VaultTypes.ApprovalCall calldata approval = approvals[i];
            IERC20(approval.token).forceApprove(approval.spender, 0);
            emit VaultTypes.SpenderApprovalUpdated(approval.token, approval.spender, 0);
        }
    }

    function applyApprovalsMemory(VaultTypes.ApprovalCall[] memory approvals, address target) external {
        for (uint256 i = 0; i < approvals.length; ++i) {
            VaultTypes.ApprovalCall memory a = approvals[i];
            if (a.token == address(0) || a.spender == address(0)) revert VaultTypes.ZeroAddress();
            if (a.spender != target) revert VaultTypes.ApprovalSpenderMismatch(a.spender, target);
            IERC20(a.token).forceApprove(a.spender, a.amount);
            emit VaultTypes.SpenderApprovalUpdated(a.token, a.spender, a.amount);
        }
    }

    function resetApprovalsMemory(VaultTypes.ApprovalCall[] memory approvals) external {
        for (uint256 i = 0; i < approvals.length; ++i) {
            VaultTypes.ApprovalCall memory a = approvals[i];
            IERC20(a.token).forceApprove(a.spender, 0);
            emit VaultTypes.SpenderApprovalUpdated(a.token, a.spender, 0);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HASH HELPERS (pure, used by both envelope and non-envelope paths)
    // ═══════════════════════════════════════════════════════════════════════════

    function hashApprovals(VaultTypes.ApprovalCall[] calldata approvals) external pure returns (bytes32) {
        return _hashApprovals(approvals);
    }

    function computeExecutionHash(VaultTypes.ExecuteParams calldata params, bytes32 approvalsHash)
        external
        view
        returns (bytes32)
    {
        return _computeExecutionHash(params, approvalsHash);
    }

    function computeDebtReductionHash(VaultTypes.DebtReductionParams calldata params, bytes32 approvalsHash)
        external
        view
        returns (bytes32)
    {
        return _computeDebtReductionHash(params, approvalsHash);
    }

    function computeHealthFactorHash(VaultTypes.HealthFactorParams calldata params, bytes32 approvalsHash)
        external
        view
        returns (bytes32)
    {
        return _computeHealthFactorHash(params, approvalsHash);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _checkPolicy(PolicyEngine policyEngine, address outputToken, uint256 minOutput, address target)
        internal
        view
    {
        if (!policyEngine.checkTrade(address(this), outputToken, minOutput, target)) {
            revert VaultTypes.PolicyCheckFailed();
        }
    }

    function _checkValidators(
        TradeValidator tradeValidator,
        bytes32 intentHash,
        bytes32 executionHash,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 deadline,
        uint256 actionKind
    ) internal view {
        (bool ok,) = tradeValidator.validateWithSignatures(
            intentHash, executionHash, address(this), signatures, scores, deadline, actionKind
        );
        if (!ok) revert VaultTypes.ValidatorCheckFailed();
    }

    function _commitIntent(PolicyEngine policyEngine, bytes32 intentHash) internal {
        VaultStorage.Data storage $ = VaultStorage.load();
        $.executedIntents[intentHash] = true;
        policyEngine.recordTrade(address(this));
    }

    function _checkFinalPositionLimit(PolicyEngine policyEngine, address token) internal view {
        uint256 limit = policyEngine.positionLimit(address(this), token);
        if (limit == 0) return;
        uint256 exposure = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (exposure > limit) revert VaultTypes.PositionLimitExceeded(token, exposure, limit);
    }

    function _checkDepositAssetReserve(address depositAsset) internal view {
        VaultStorage.Data storage $ = VaultStorage.load();
        uint256 reserveBps = $.depositAssetReserveBps;
        if (reserveBps == 0) return;
        uint256 depositBalance = IERC20(depositAsset).balanceOf(address(this));
        uint256 totalCol = $.totalOutstandingCollateral;
        uint256 positions = ValuationLib.positionsValue(depositAsset);
        uint256 total = depositBalance + positions + totalCol;
        if (depositBalance * 10000 < total * reserveBps) revert VaultTypes.DepositAssetBelowReserve();
    }

    function _hashApprovals(VaultTypes.ApprovalCall[] calldata approvals) internal pure returns (bytes32) {
        bytes memory packed = new bytes(0);
        uint256 n = approvals.length;
        for (uint256 i = 0; i < n; ++i) {
            VaultTypes.ApprovalCall calldata approval = approvals[i];
            packed = bytes.concat(
                packed,
                abi.encodePacked(
                    keccak256(
                        abi.encode(VaultTypes.APPROVAL_CALL_TYPEHASH, approval.token, approval.spender, approval.amount)
                    )
                )
            );
        }
        return keccak256(packed);
    }

    function _computeExecutionHash(VaultTypes.ExecuteParams calldata params, bytes32 approvalsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                VaultTypes.EXECUTION_PAYLOAD_TYPEHASH,
                params.target,
                keccak256(params.data),
                params.value,
                params.minOutput,
                params.outputToken,
                params.intentHash,
                params.deadline,
                block.chainid,
                approvalsHash
            )
        );
    }

    function _computeDebtReductionHash(VaultTypes.DebtReductionParams calldata params, bytes32 approvalsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                VaultTypes.DEBT_REDUCTION_PAYLOAD_TYPEHASH,
                params.target,
                keccak256(params.data),
                params.value,
                params.inputToken,
                params.maxInput,
                params.debtToken,
                params.minDebtDecrease,
                params.intentHash,
                params.deadline,
                block.chainid,
                approvalsHash
            )
        );
    }

    function _computeHealthFactorHash(VaultTypes.HealthFactorParams calldata params, bytes32 approvalsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                VaultTypes.HEALTH_FACTOR_PAYLOAD_TYPEHASH,
                params.target,
                keccak256(params.data),
                params.value,
                params.minOutput,
                params.outputToken,
                params.pool,
                params.account,
                params.minHealthFactor,
                params.intentHash,
                params.deadline,
                block.chainid,
                approvalsHash
            )
        );
    }
}
