// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradingBlueprint.sol";

/// @title DefiYieldBlueprint
/// @notice Blueprint for DeFi yield farming strategies
contract DefiYieldBlueprint is TradingBlueprint {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    string public constant BLUEPRINT_NAME = "defi-yield-blueprint";
    string public constant BLUEPRINT_VERSION = "0.1.0";

    /// @notice Job ID for rebalancing yield positions
    uint8 public constant JOB_REBALANCE = 10;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event RebalanceRequested(uint64 indexed serviceId, uint64 jobCallId);
    event RebalanceCompleted(uint64 indexed serviceId, uint64 jobCallId, address operator);

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

        if (job == JOB_REBALANCE) {
            require(instanceProvisioned[serviceId], "Not provisioned");
            emit RebalanceRequested(serviceId, jobCallId);
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
            _handleCommonJobResult(serviceId, job, jobCallId, operator, outputs);
        } else if (job == JOB_REBALANCE) {
            emit RebalanceCompleted(serviceId, jobCallId, operator);
        }
    }
}
