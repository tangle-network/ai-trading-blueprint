// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradingBlueprint.sol";

/// @title PredictionMarketBlueprint
/// @notice Blueprint for prediction market strategies
contract PredictionMarketBlueprint is TradingBlueprint {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    string public constant BLUEPRINT_NAME = "prediction-market-blueprint";
    string public constant BLUEPRINT_VERSION = "0.1.0";

    /// @notice Job ID for placing a bet on a prediction market
    uint8 public constant JOB_PLACE_BET = 10;

    /// @notice Job ID for exiting a prediction market position
    uint8 public constant JOB_EXIT_POSITION = 11;

    /// @notice Job ID for listing available markets
    uint8 public constant JOB_LIST_MARKETS = 12;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event BetPlaceRequested(uint64 indexed serviceId, uint64 jobCallId);
    event BetPlaced(uint64 indexed serviceId, uint64 jobCallId, address operator);
    event PositionExited(uint64 indexed serviceId, uint64 jobCallId, address operator);
    event MarketsListed(uint64 indexed serviceId, uint64 jobCallId, address operator);

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

        if (job == JOB_PLACE_BET) {
            require(instanceProvisioned[serviceId], "Not provisioned");
            emit BetPlaceRequested(serviceId, jobCallId);
        } else if (job == JOB_EXIT_POSITION) {
            require(instanceProvisioned[serviceId], "Not provisioned");
        } else if (job == JOB_LIST_MARKETS) {
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
        } else if (job == JOB_PLACE_BET) {
            emit BetPlaced(serviceId, jobCallId, operator);
        } else if (job == JOB_EXIT_POSITION) {
            emit PositionExited(serviceId, jobCallId, operator);
        } else if (job == JOB_LIST_MARKETS) {
            emit MarketsListed(serviceId, jobCallId, operator);
        }
    }
}
