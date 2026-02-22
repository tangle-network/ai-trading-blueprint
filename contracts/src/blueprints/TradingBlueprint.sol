// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "tnt-core/BlueprintServiceManagerBase.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title TradingBlueprint
/// @notice Single trading blueprint for all strategy types.
/// @dev Extends BlueprintServiceManagerBase with:
///   - Automatic vault deployment via VaultFactory on service initialization
///   - Multi-operator support (all operators get OPERATOR_ROLE on the vault)
///   - Intent deduplication happens at the vault level (TradingVault.executedIntents)
///   - Protocol-native pricing via EIP-712 signed quotes (subscription or per-job)
///
///   Lifecycle:
///     1. Consumer calls requestService() → onRequest() stores vault config
///     2. Operators approve → service initialized → onServiceInitialized() stores config + operators
///     3. Each operator joins → onOperatorJoined() grants OPERATOR_ROLE on all bot vaults
///     4. Consumer submits JOB_PROVISION → operators bootstrap off-chain infra (sidecars)
///     5. onJobResult(PROVISION) → creates per-bot vault via VaultFactory.createBotVault()
///     6. Trading begins — multiple operators independently generate trade intents
///     7. Validator network scores intents, vault executes approved ones (deduped by intentHash)
contract TradingBlueprint is BlueprintServiceManagerBase {
    string public constant BLUEPRINT_NAME = "trading-blueprint";
    string public constant BLUEPRINT_VERSION = "0.1.0";

    // ═══════════════════════════════════════════════════════════════════════════
    // COMMON JOB IDS
    // ═══════════════════════════════════════════════════════════════════════════

    uint8 public constant JOB_PROVISION = 0;
    uint8 public constant JOB_CONFIGURE = 1;
    uint8 public constant JOB_START_TRADING = 2;
    uint8 public constant JOB_STOP_TRADING = 3;
    uint8 public constant JOB_STATUS = 4;
    uint8 public constant JOB_DEPROVISION = 5;
    uint8 public constant JOB_EXTEND = 6;
    uint8 public constant JOB_WORKFLOW_TICK = 30;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice OPERATOR_ROLE hash matching TradingVault's AccessControl role
    bytes32 public constant VAULT_OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice CREATOR_ROLE hash matching TradingVault's AccessControl role
    bytes32 public constant VAULT_CREATOR_ROLE = keccak256("CREATOR_ROLE");

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Whether the service has been initialized
    mapping(uint64 => bool) public instanceProvisioned;

    /// @notice Legacy: single vault per service (kept for backwards compat reads)
    mapping(uint64 => address) public instanceVault;

    /// @notice Legacy: share token per service
    mapping(uint64 => address) public instanceShare;

    /// @notice Per-bot vault address, keyed by (serviceId, callId)
    mapping(uint64 serviceId => mapping(uint64 callId => address)) public botVaults;

    /// @notice Per-bot share token, keyed by (serviceId, callId)
    mapping(uint64 serviceId => mapping(uint64 callId => address)) public botShares;

    /// @notice VaultFactory address — set via setVaultFactory()
    address public vaultFactory;

    /// @notice When true, vault is created in onServiceInitialized (instance/TEE mode).
    /// When false, vault is created per-bot in onJobResult(PROVISION) (fleet mode).
    bool public instanceMode;

    // ═══════════════════════════════════════════════════════════════════════════
    // PER-JOB PRICING MULTIPLIERS (informational — used by off-chain pricing engine)
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 public constant PRICE_MULT_PROVISION = 50;
    uint256 public constant PRICE_MULT_CONFIGURE = 2;
    uint256 public constant PRICE_MULT_START_TRADING = 1;
    uint256 public constant PRICE_MULT_STOP_TRADING = 1;
    uint256 public constant PRICE_MULT_STATUS = 0;
    uint256 public constant PRICE_MULT_DEPROVISION = 1;
    uint256 public constant PRICE_MULT_EXTEND = 10;

    // ─── Pending request storage (requestId → config) ────────────────────────

    struct ServiceRequestConfig {
        address requester;
        address assetToken;
        address[] signers;
        uint256 requiredSignatures;
        string name;
        string symbol;
    }

    mapping(uint64 => ServiceRequestConfig) internal _pendingRequests;

    // ─── Per-service persistent storage ────────────────────────────────────

    /// @dev Service config persisted beyond request lifecycle (for per-bot vault defaults)
    mapping(uint64 serviceId => ServiceRequestConfig) internal _serviceConfigs;

    /// @dev Operators for each service (used to grant roles on new bot vaults)
    mapping(uint64 serviceId => address[]) internal _serviceOperators;

    // ─── Per-provision storage (populated in onJobCall, consumed in onJobResult) ─

    struct PendingProvision {
        address assetToken;
        address[] signers;
        uint256 requiredSigs;
        string name;
    }

    /// @dev Provision inputs stored during onJobCall for use in _handleProvisionResult.
    ///      The Tangle protocol may not forward the original submitJob inputs to onJobResult,
    ///      so we persist the config here where inputs are guaranteed correct.
    mapping(uint64 serviceId => mapping(uint64 callId => PendingProvision)) internal _pendingProvisions;

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error VaultFactoryNotSet();
    error InvalidLifetimeDays();
    error BaseRateTooLarge(uint256 baseRate, uint256 maxBaseRate);

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultDeployed(uint64 indexed serviceId, address indexed vault, address indexed shareToken);
    event BotVaultDeployed(uint64 indexed serviceId, uint64 indexed callId, address vault, address shareToken);
    event OperatorGranted(uint64 indexed serviceId, address indexed operator, address vault);
    event ServiceTerminated(uint64 indexed serviceId);
    event TradingStarted(uint64 indexed serviceId);
    event TradingStopped(uint64 indexed serviceId);
    event BotExtended(uint64 indexed serviceId, uint64 jobCallId, uint64 additionalDays);
    event BotVaultSkipped(uint64 indexed serviceId, uint64 indexed callId, string reason);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Set the VaultFactory address.  Called once after deployment.
    function setVaultFactory(address _factory) external onlyFromTangle {
        vaultFactory = _factory;
    }

    /// @notice Enable instance mode: vault created at service init, not per-bot.
    /// @dev Set to true for instance/TEE BSMs after deployment.
    function setInstanceMode(bool _mode) external onlyFromTangle {
        instanceMode = _mode;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SERVICE LIFECYCLE HOOKS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Called when a consumer requests a service.
    /// @dev Stores vault configuration from requestInputs for use in onServiceInitialized.
    ///      requestInputs ABI-encodes: (address assetToken, address[] signers,
    ///      uint256 requiredSignatures, string name, string symbol)
    function onRequest(
        uint64 requestId,
        address requester,
        address[] calldata,
        bytes calldata requestInputs,
        uint64,
        address,
        uint256
    ) external payable override onlyFromTangle {
        if (requestInputs.length > 0) {
            (
                address assetToken,
                address[] memory signers,
                uint256 requiredSigs,
                string memory name,
                string memory symbol
            ) = abi.decode(requestInputs, (address, address[], uint256, string, string));

            _pendingRequests[requestId] = ServiceRequestConfig({
                requester: requester,
                assetToken: assetToken,
                signers: signers,
                requiredSignatures: requiredSigs,
                name: name,
                symbol: symbol
            });
        }
    }

    /// @notice Called when the service is activated (all operators approved).
    /// @dev Stores config and operators for per-bot vault creation.
    ///      Fleet mode: Vaults created per-bot in onJobResult(PROVISION).
    ///      Instance mode: Vault created here immediately (one vault per service).
    function onServiceInitialized(
        uint64,
        uint64 requestId,
        uint64 serviceId,
        address,
        address[] calldata operators,
        uint64
    ) external override onlyFromTangle {
        ServiceRequestConfig memory req = _pendingRequests[requestId];

        // Persist config for per-bot vault defaults
        _serviceConfigs[serviceId] = req;
        _serviceOperators[serviceId] = operators;
        instanceProvisioned[serviceId] = true;

        delete _pendingRequests[requestId];

        // Instance mode: create vault immediately at service initialization
        if (instanceMode) {
            _createInstanceVault(serviceId, req, operators);
        }
    }

    /// @notice Creates a singleton vault for instance mode (one vault per service).
    /// @dev Called from onServiceInitialized when instanceMode=true. Uses callId=0
    ///      since there is exactly one bot per service. Mirrors _handleProvisionResult
    ///      logic but uses service-level config directly.
    function _createInstanceVault(uint64 serviceId, ServiceRequestConfig memory cfg, address[] calldata operators)
        internal
    {
        if (vaultFactory == address(0)) return;

        address assetToken = cfg.assetToken;
        if (assetToken == address(0)) {
            emit BotVaultSkipped(serviceId, 0, "no asset token at service init");
            return;
        }

        // Resolve signers: explicit from request > service operators
        address[] memory signers;
        uint256 requiredSigs;
        if (cfg.signers.length > 0) {
            signers = cfg.signers;
            requiredSigs = cfg.requiredSignatures > 0 ? cfg.requiredSignatures : 1;
        } else {
            signers = new address[](operators.length);
            for (uint256 i = 0; i < operators.length; i++) {
                signers[i] = operators[i];
            }
            requiredSigs = signers.length > 0 ? 1 : 0;
        }

        if (signers.length == 0 || requiredSigs == 0) {
            emit BotVaultSkipped(serviceId, 0, "no signers at service init");
            return;
        }

        // callId=0 for instance mode (singleton bot)
        bytes32 salt = keccak256(abi.encodePacked(serviceId, uint64(0)));
        string memory name_ = bytes(cfg.name).length > 0 ? cfg.name : "Instance Vault";
        string memory symbol_ = bytes(cfg.symbol).length > 0 ? cfg.symbol : "iVAULT";

        (address vault, address shareToken) = IVaultFactory(vaultFactory)
            .createBotVault(
                serviceId,
                assetToken,
                address(this), // admin = this BSM
                address(0), // no initial operator — granted below
                signers,
                requiredSigs,
                name_,
                symbol_,
                salt
            );

        // Store in both instance-level and per-bot (callId=0) mappings
        instanceVault[serviceId] = vault;
        instanceShare[serviceId] = shareToken;
        botVaults[serviceId][0] = vault;
        botShares[serviceId][0] = shareToken;

        // Grant OPERATOR_ROLE to all service operators
        for (uint256 i = 0; i < operators.length; i++) {
            IAccessControl(vault).grantRole(VAULT_OPERATOR_ROLE, operators[i]);
        }

        // Grant CREATOR_ROLE to the service requester
        if (cfg.requester != address(0)) {
            IAccessControl(vault).grantRole(VAULT_CREATOR_ROLE, cfg.requester);
        }

        emit BotVaultDeployed(serviceId, 0, vault, shareToken);
    }

    /// @notice Called when an operator joins the service.
    /// @dev Grants OPERATOR_ROLE on ALL vaults for this service (legacy + per-bot).
    function onOperatorJoined(uint64 serviceId, address operator, uint16) external override onlyFromTangle {
        // Grant on legacy service-level vault (if exists)
        address legacyVault = instanceVault[serviceId];
        if (legacyVault != address(0)) {
            IAccessControl(legacyVault).grantRole(VAULT_OPERATOR_ROLE, operator);
            emit OperatorGranted(serviceId, operator, legacyVault);
        }

        // Grant on ALL bot vaults via VaultFactory enumeration
        if (vaultFactory != address(0)) {
            address[] memory vaults = IVaultFactory(vaultFactory).getServiceVaults(serviceId);
            for (uint256 i = 0; i < vaults.length; i++) {
                if (vaults[i] != legacyVault) {
                    IAccessControl(vaults[i]).grantRole(VAULT_OPERATOR_ROLE, operator);
                    emit OperatorGranted(serviceId, operator, vaults[i]);
                }
            }
        }

        // Track operator for future bot vault grants
        _serviceOperators[serviceId].push(operator);
    }

    /// @notice Called when the service is terminated.
    function onServiceTermination(uint64 serviceId, address) external override onlyFromTangle {
        instanceProvisioned[serviceId] = false;
        emit ServiceTerminated(serviceId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // QoS — REQUIRED RESULT COUNT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice All operators participate in every job.
    /// @dev Returns 0 which means "use protocol default" (all registered operators).
    ///      Intent deduplication at the vault level prevents duplicate execution.
    function getRequiredResultCount(uint64, uint8) external view virtual override returns (uint32) {
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRICING HELPERS (informational — actual enforcement via Tangle protocol)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Returns default per-job rates given a base rate.
    /// @dev Used by the off-chain pricing engine to generate EIP-712 quotes.
    ///      Actual payment enforcement happens via the protocol's quote system.
    /// @param baseRate Base rate in wei. Must be <= type(uint256).max / PRICE_MULT_PROVISION.
    function getDefaultJobRates(uint256 baseRate)
        external
        pure
        returns (uint8[] memory jobIndexes, uint256[] memory rates)
    {
        uint256 maxBase = type(uint256).max / PRICE_MULT_PROVISION;
        if (baseRate > maxBase) revert BaseRateTooLarge(baseRate, maxBase);

        jobIndexes = new uint8[](7);
        rates = new uint256[](7);
        jobIndexes[0] = JOB_PROVISION;
        rates[0] = baseRate * PRICE_MULT_PROVISION;
        jobIndexes[1] = JOB_CONFIGURE;
        rates[1] = baseRate * PRICE_MULT_CONFIGURE;
        jobIndexes[2] = JOB_START_TRADING;
        rates[2] = baseRate * PRICE_MULT_START_TRADING;
        jobIndexes[3] = JOB_STOP_TRADING;
        rates[3] = baseRate * PRICE_MULT_STOP_TRADING;
        jobIndexes[4] = JOB_STATUS;
        rates[4] = baseRate * PRICE_MULT_STATUS;
        jobIndexes[5] = JOB_DEPROVISION;
        rates[5] = baseRate * PRICE_MULT_DEPROVISION;
        jobIndexes[6] = JOB_EXTEND;
        rates[6] = baseRate * PRICE_MULT_EXTEND;
    }

    /// @notice Returns the pricing multiplier for a specific job.
    function getJobPriceMultiplier(uint8 jobId) external pure returns (uint256) {
        if (jobId == JOB_PROVISION) return PRICE_MULT_PROVISION;
        if (jobId == JOB_CONFIGURE) return PRICE_MULT_CONFIGURE;
        if (jobId == JOB_START_TRADING) return PRICE_MULT_START_TRADING;
        if (jobId == JOB_STOP_TRADING) return PRICE_MULT_STOP_TRADING;
        if (jobId == JOB_STATUS) return PRICE_MULT_STATUS;
        if (jobId == JOB_DEPROVISION) return PRICE_MULT_DEPROVISION;
        if (jobId == JOB_EXTEND) return PRICE_MULT_EXTEND;
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // JOB HOOKS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Called when a job is submitted.
    /// @dev No on-chain payment validation — pricing is handled by the Tangle protocol
    ///      via createServiceFromQuotes (subscription) or submitJobFromQuote (per-job).
    ///      This hook only stores provision inputs and validates preconditions.
    function onJobCall(uint64 serviceId, uint8 job, uint64 jobCallId, bytes calldata inputs)
        external
        payable
        virtual
        override
        onlyFromTangle
    {
        if (job == JOB_PROVISION) {
            _storeProvisionInputs(serviceId, jobCallId, inputs);
        } else {
            // All non-provision jobs require the service to be provisioned
            require(instanceProvisioned[serviceId], "Not provisioned");
            if (job == JOB_EXTEND) {
                (, uint64 additionalDays) = abi.decode(inputs, (string, uint64));
                if (additionalDays == 0) revert InvalidLifetimeDays();
                emit BotExtended(serviceId, jobCallId, additionalDays);
            }
        }
    }

    /// @notice Called when a job result is submitted by an operator.
    function onJobResult(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        address operator,
        bytes calldata inputs,
        bytes calldata outputs
    ) external payable virtual override onlyFromTangle {
        _handleCommonJobResult(serviceId, job, jobCallId, operator, inputs, outputs);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL — shared job result logic for subclasses
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Handles common job results.
    /// @dev JOB_PROVISION creates a per-bot vault via VaultFactory.
    function _handleCommonJobResult(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        address operator,
        bytes calldata inputs,
        bytes calldata outputs
    ) internal {
        if (job == JOB_PROVISION) {
            _handleProvisionResult(serviceId, jobCallId, inputs);
        } else if (job == JOB_START_TRADING) {
            emit TradingStarted(serviceId);
        } else if (job == JOB_STOP_TRADING) {
            emit TradingStopped(serviceId);
        }
    }

    /// @notice Decode and store provision inputs during onJobCall.
    /// @dev Called from onJobCall when job == JOB_PROVISION. The Tangle protocol
    ///      may not forward the original submitJob inputs to onJobResult, so we
    ///      persist the vault config fields here for _handleProvisionResult to read.
    function _storeProvisionInputs(uint64 serviceId, uint64 jobCallId, bytes calldata inputs) internal {
        if (inputs.length == 0) return;

        // Handle tuple wrapping: viem encodes structs with 0x20 offset prefix
        bytes calldata inner = inputs;
        if (inputs.length > 32) {
            uint256 firstWord = uint256(bytes32(inputs[0:32]));
            if (firstWord == 0x20) {
                inner = inputs[32:];
            }
        }

        // Decode TradingProvisionRequest to extract vault config fields
        // Layout: (name, strategy_type, strategy_config_json, risk_params_json,
        //          factory_address, asset_token, signers, required_signatures, ...)
        (string memory botName,,,,, address assetToken, address[] memory signers, uint256 requiredSigs,,,,,,,) = abi.decode(
            inner,
            (
                string,
                string,
                string,
                string,
                address,
                address,
                address[],
                uint256,
                uint256,
                string,
                string,
                uint64,
                uint64,
                uint64,
                uint64[]
            )
        );

        _pendingProvisions[serviceId][jobCallId] =
            PendingProvision({assetToken: assetToken, signers: signers, requiredSigs: requiredSigs, name: botName});
    }

    /// @notice Creates a per-bot vault when a provision job completes.
    /// @dev Reads vault config from _pendingProvisions (stored during onJobCall),
    ///      falls back to service-level config for missing fields.
    ///      Does NOT rely on the `inputs` parameter from onJobResult, which the
    ///      Tangle protocol may not populate with the original submitJob inputs.
    function _handleProvisionResult(
        uint64 serviceId,
        uint64 jobCallId,
        bytes calldata /* inputs — unreliable, use _pendingProvisions instead */
    )
        internal
    {
        if (vaultFactory == address(0)) return;

        // Read stored provision config (set in onJobCall)
        PendingProvision memory pp = _pendingProvisions[serviceId][jobCallId];
        ServiceRequestConfig memory svcCfg = _serviceConfigs[serviceId];

        // Resolve vault config: provision-specific > service defaults
        address assetToken = pp.assetToken != address(0) ? pp.assetToken : svcCfg.assetToken;
        string memory botName = bytes(pp.name).length > 0 ? pp.name : svcCfg.name;

        // Use service operators as TradeValidator signers — operators (not users)
        // produce EIP-712 validation signatures via the validator blueprint.
        // If provision request included explicit signers, use those as override.
        address[] memory signers = _serviceOperators[serviceId];
        uint256 requiredSigs = signers.length > 0 ? 1 : 0;
        if (pp.signers.length > 0) {
            signers = pp.signers;
            requiredSigs = pp.requiredSigs;
        }

        // Require valid config — emit diagnostic event on skip so operators can diagnose.
        // We don't revert because that would brick onJobResult for the entire service.
        if (assetToken == address(0)) {
            emit BotVaultSkipped(serviceId, jobCallId, "no asset token");
            return;
        }
        if (signers.length == 0 || requiredSigs == 0) {
            emit BotVaultSkipped(serviceId, jobCallId, "no signers (operators may not have joined yet)");
            return;
        }

        bytes32 salt = keccak256(abi.encodePacked(serviceId, jobCallId));
        string memory symbol = string(abi.encodePacked("bot", _uint64ToString(jobCallId)));

        (address vault, address shareToken) = IVaultFactory(vaultFactory)
            .createBotVault(
                serviceId,
                assetToken,
                address(this), // admin = this BSM contract
                address(0), // no initial operator — granted below
                signers,
                requiredSigs,
                botName,
                symbol,
                salt
            );

        botVaults[serviceId][jobCallId] = vault;
        botShares[serviceId][jobCallId] = shareToken;

        // Grant OPERATOR_ROLE to all service operators
        address[] memory ops = _serviceOperators[serviceId];
        for (uint256 i = 0; i < ops.length; i++) {
            IAccessControl(vault).grantRole(VAULT_OPERATOR_ROLE, ops[i]);
        }

        // Grant CREATOR_ROLE to the service requester
        if (svcCfg.requester != address(0)) {
            IAccessControl(vault).grantRole(VAULT_CREATOR_ROLE, svcCfg.requester);
        }

        // Cleanup stored inputs
        delete _pendingProvisions[serviceId][jobCallId];

        emit BotVaultDeployed(serviceId, jobCallId, vault, shareToken);
    }

    /// @dev Convert uint64 to decimal string (for share token symbols).
    function _uint64ToString(uint64 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint64 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

/// @notice Minimal interface for VaultFactory calls
interface IVaultFactory {
    function createVault(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external returns (address vault, address shareToken);

    function createBotVault(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external returns (address vault, address shareToken);

    function getServiceVaults(uint64 serviceId) external view returns (address[] memory);
}
