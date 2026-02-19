// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradingBlueprint.sol";

/// @title DexTradingBlueprint
/// @notice Blueprint for DEX trading strategies including TWAP and arbitrage
contract DexTradingBlueprint is TradingBlueprint {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    string public constant BLUEPRINT_NAME = "dex-trading-blueprint";
    string public constant BLUEPRINT_VERSION = "0.1.0";

    /// @notice Job ID for executing a TWAP order
    uint8 public constant JOB_EXECUTE_TWAP = 10;

    /// @notice Job ID for configuring an arbitrage strategy
    uint8 public constant JOB_CONFIGURE_ARB = 11;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event TwapRequested(uint64 indexed serviceId, uint64 jobCallId);
    event TwapCompleted(uint64 indexed serviceId, uint64 jobCallId, address operator);
    event ArbConfigured(uint64 indexed serviceId, uint64 jobCallId, address operator);

    // ═══════════════════════════════════════════════════════════════════════════
    // JOB HOOKS
    // ═══════════════════════════════════════════════════════════════════════════

    function onJobCall(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        bytes calldata inputs
    ) external payable override onlyFromTangle {
        // Delegate payment checks + dynamic pricing to TradingBlueprint
        _onJobCallDynamic(serviceId, job, jobCallId, inputs);

        // Strategy-specific preconditions
        if (job == JOB_EXECUTE_TWAP) {
            require(instanceProvisioned[serviceId], "Not provisioned");
            emit TwapRequested(serviceId, jobCallId);
        } else if (job == JOB_CONFIGURE_ARB) {
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
        if (job <= JOB_EXTEND) {
            // Delegate common jobs to base
            _handleCommonJobResult(serviceId, job, jobCallId, operator, inputs, outputs);
        } else if (job == JOB_EXECUTE_TWAP) {
            emit TwapCompleted(serviceId, jobCallId, operator);
        } else if (job == JOB_CONFIGURE_ARB) {
            emit ArbConfigured(serviceId, jobCallId, operator);
        }
    }
}
