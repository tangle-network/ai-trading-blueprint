// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "tnt-core/BlueprintServiceManagerBase.sol";

/// @title ValidatorBlueprint
/// @notice Blueprint for the trading validator network with on-chain reputation,
///         slashing hooks, and QoS-aware result counting.
/// @dev Extends BlueprintServiceManagerBase directly (not TradingBlueprint).
///      Each operator in the service runs a validator node that scores trade
///      intents and signs EIP-712 approvals.
///
///      Operator lifecycle is managed by the Tangle protocol:
///        - Registration: `onRegister()` — called when operator joins via
///          `registerOperator(blueprintId, ecdsaKey, rpcAddress)`.  We initialize
///          reputation here.
///        - Unregistration: `onUnregister()` — cleanup.
///        - Slashing: `onSlash()` — called when a finalized slash is applied.
///          Slash proposals originate from `proposeSlash()` on the protocol.
///
///      Jobs are for operational tasks only (reputation updates, config changes,
///      liveness heartbeats).
contract ValidatorBlueprint is BlueprintServiceManagerBase {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    string public constant BLUEPRINT_NAME = "trading-validator-blueprint";
    string public constant BLUEPRINT_VERSION = "0.2.0";

    // Jobs for operational tasks (NOT registration/slashing — those use protocol hooks)
    uint8 public constant JOB_UPDATE_REPUTATION = 0;
    uint8 public constant JOB_UPDATE_CONFIG = 1;
    uint8 public constant JOB_LIVENESS = 2;

    int256 public constant INITIAL_REPUTATION = 100;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Whether a validator is registered for a given service
    mapping(uint64 => mapping(address => bool)) public validatorRegistered;

    /// @notice Count of registered validators per service
    mapping(uint64 => uint256) public validatorCount;

    /// @notice On-chain reputation score per (service, operator).  Starts at
    ///         INITIAL_REPUTATION on registration; modified by reputation
    ///         updates and slashing.
    mapping(uint64 => mapping(address => int256)) public validatorReputation;

    /// @notice Total validations completed per (service, operator)
    mapping(uint64 => mapping(address => uint256)) public totalValidations;

    /// @notice Last heartbeat timestamp per (service, operator)
    mapping(uint64 => mapping(address => uint256)) public lastHeartbeat;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event ValidatorRegisteredEvent(uint64 indexed serviceId, address indexed validator);
    event ValidatorDeregistered(uint64 indexed serviceId, address indexed validator);
    event ReputationUpdated(uint64 indexed serviceId, address indexed operator, int256 newReputation);
    event SlashApplied(uint64 indexed serviceId, address indexed operator, uint8 slashPercent, int256 newReputation);
    event ConfigUpdated(uint64 indexed serviceId, uint64 jobCallId, address operator);
    event LivenessRecorded(uint64 indexed serviceId, address indexed operator, uint256 timestamp);

    // ═══════════════════════════════════════════════════════════════════════════
    // OPERATOR LIFECYCLE (protocol hooks — NOT jobs)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Called by the Tangle protocol when an operator registers via
    ///         `registerOperator(blueprintId, ecdsaKey, rpcAddress)`.
    /// @dev The operator's RPC endpoint is stored on-chain by the protocol
    ///      itself — we just need to track registration state and init reputation.
    ///      The `inputs` may contain the serviceId as context.
    function onRegister(
        address operator,
        bytes calldata inputs
    ) external payable override onlyFromTangle {
        // The protocol calls this per-operator.  We need the serviceId to
        // scope the registration.  If inputs encode a serviceId, use it;
        // otherwise use 0 as a global scope.
        uint64 serviceId = 0;
        if (inputs.length >= 8) {
            serviceId = abi.decode(inputs, (uint64));
        }

        if (!validatorRegistered[serviceId][operator]) {
            validatorRegistered[serviceId][operator] = true;
            validatorCount[serviceId]++;
            validatorReputation[serviceId][operator] = INITIAL_REPUTATION;
            emit ValidatorRegisteredEvent(serviceId, operator);
        }
    }

    /// @notice Called by the Tangle protocol when an operator unregisters.
    function onUnregister(address operator) external override onlyFromTangle {
        // Unregister from all known services is not practical in a mapping.
        // The protocol only allows unregistration from specific services,
        // so we rely on the service-scoped cleanup happening at the protocol
        // level.  For the global scope:
        if (validatorRegistered[0][operator]) {
            validatorRegistered[0][operator] = false;
            validatorCount[0]--;
            emit ValidatorDeregistered(0, operator);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // QoS — REQUIRED RESULT COUNT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice How many operator results are required for a job to be considered
    ///         complete.  Liveness requires ALL operators; other jobs need one.
    function getRequiredResultCount(
        uint64 serviceId,
        uint8 jobIndex
    ) external view override returns (uint32) {
        if (jobIndex == JOB_LIVENESS) {
            // ALL operators must submit a heartbeat
            uint256 count = validatorCount[serviceId];
            return count > 0 ? uint32(count) : 1;
        }
        return 1;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SLASHING HOOKS (called by Tangle protocol — NOT jobs)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Called when a slash is queued but not yet applied (dispute window).
    function onUnappliedSlash(
        uint64 serviceId,
        bytes calldata offender,
        uint8 slashPercent
    ) external override onlyFromTangle {
        // No-op: let the dispute window play out.
    }

    /// @notice Called when a slash is finalized and applied by the Tangle protocol.
    /// @dev Reduces the operator's on-chain reputation by `slashPercent` points.
    function onSlash(
        uint64 serviceId,
        bytes calldata offender,
        uint8 slashPercent
    ) external override onlyFromTangle {
        address operator = abi.decode(offender, (address));
        int256 penalty = int256(uint256(slashPercent));
        validatorReputation[serviceId][operator] -= penalty;
        emit SlashApplied(serviceId, operator, slashPercent, validatorReputation[serviceId][operator]);
    }

    /// @notice Returns the address authorized to propose slashes for this service.
    function querySlashingOrigin(uint64) external view override returns (address) {
        return address(this);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // JOB HOOKS (operational tasks only)
    // ═══════════════════════════════════════════════════════════════════════════

    function onJobCall(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        bytes calldata inputs
    ) external payable override onlyFromTangle {
        // No precondition checks needed for operational jobs
    }

    function onJobResult(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        address operator,
        bytes calldata inputs,
        bytes calldata outputs
    ) external payable override onlyFromTangle {
        if (job == JOB_UPDATE_REPUTATION) {
            // Outputs encode: (uint256 validationCount, int256 reputationDelta)
            if (outputs.length >= 64) {
                (uint256 validationCount, int256 reputationDelta) = abi.decode(outputs, (uint256, int256));
                totalValidations[serviceId][operator] += validationCount;
                validatorReputation[serviceId][operator] += reputationDelta;
                emit ReputationUpdated(serviceId, operator, validatorReputation[serviceId][operator]);
            }
        } else if (job == JOB_UPDATE_CONFIG) {
            emit ConfigUpdated(serviceId, jobCallId, operator);
        } else if (job == JOB_LIVENESS) {
            lastHeartbeat[serviceId][operator] = block.timestamp;
            emit LivenessRecorded(serviceId, operator, block.timestamp);
        }
    }
}
