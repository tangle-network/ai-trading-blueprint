// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradingBlueprint.sol";

/// @title PerpTradingBlueprint
/// @notice Blueprint for perpetual futures trading strategies
contract PerpTradingBlueprint is TradingBlueprint {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    string public constant BLUEPRINT_NAME = "perp-trading-blueprint";
    string public constant BLUEPRINT_VERSION = "0.1.0";

    /// @notice Job ID for opening a perpetual position
    uint8 public constant JOB_OPEN_POSITION = 10;

    /// @notice Job ID for closing a perpetual position
    uint8 public constant JOB_CLOSE_POSITION = 11;

    /// @notice Job ID for adjusting leverage on an existing position
    uint8 public constant JOB_ADJUST_LEVERAGE = 12;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event PositionOpenRequested(uint64 indexed serviceId, uint64 jobCallId);
    event PositionOpened(uint64 indexed serviceId, uint64 jobCallId, address operator);
    event PositionClosed(uint64 indexed serviceId, uint64 jobCallId, address operator);
    event LeverageAdjusted(uint64 indexed serviceId, uint64 jobCallId, address operator);

    // ═══════════════════════════════════════════════════════════════════════════
    // JOB HOOKS
    // ═══════════════════════════════════════════════════════════════════════════

    function onJobCall(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        bytes calldata inputs
    ) external payable override onlyFromTangle {
        _onJobCallBase(serviceId, job);

        if (job == JOB_OPEN_POSITION) {
            require(instanceProvisioned[serviceId], "Not provisioned");
            emit PositionOpenRequested(serviceId, jobCallId);
        } else if (job == JOB_CLOSE_POSITION) {
            require(instanceProvisioned[serviceId], "Not provisioned");
        } else if (job == JOB_ADJUST_LEVERAGE) {
            require(instanceProvisioned[serviceId], "Not provisioned");
        }
    }

    function onJobResult(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        address operator,
        bytes calldata inputs,
        bytes calldata outputs
    ) external payable override onlyFromTangle {
        if (job <= JOB_DEPROVISION) {
            _handleCommonJobResult(serviceId, job, jobCallId, operator, inputs, outputs);
        } else if (job == JOB_OPEN_POSITION) {
            emit PositionOpened(serviceId, jobCallId, operator);
        } else if (job == JOB_CLOSE_POSITION) {
            emit PositionClosed(serviceId, jobCallId, operator);
        } else if (job == JOB_ADJUST_LEVERAGE) {
            emit LeverageAdjusted(serviceId, jobCallId, operator);
        }
    }
}
