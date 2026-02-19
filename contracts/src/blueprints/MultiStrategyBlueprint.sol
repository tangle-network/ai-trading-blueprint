// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradingBlueprint.sol";

/// @title MultiStrategyBlueprint
/// @notice Blueprint for multi-strategy portfolio management
contract MultiStrategyBlueprint is TradingBlueprint {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    string public constant BLUEPRINT_NAME = "multi-strategy-blueprint";
    string public constant BLUEPRINT_VERSION = "0.1.0";

    /// @notice Job ID for defining a new strategy within the multi-strategy portfolio
    uint8 public constant JOB_DEFINE_STRATEGY = 10;

    /// @notice Job ID for executing a trade within a defined strategy
    uint8 public constant JOB_EXECUTE = 11;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event StrategyDefined(uint64 indexed serviceId, uint64 jobCallId, address operator);
    event StrategyExecuted(uint64 indexed serviceId, uint64 jobCallId, address operator);

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

        if (job == JOB_DEFINE_STRATEGY) {
            require(instanceProvisioned[serviceId], "Not provisioned");
        } else if (job == JOB_EXECUTE) {
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
        } else if (job == JOB_DEFINE_STRATEGY) {
            emit StrategyDefined(serviceId, jobCallId, operator);
        } else if (job == JOB_EXECUTE) {
            emit StrategyExecuted(serviceId, jobCallId, operator);
        }
    }
}
