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
///   - Configurable per-job pricing
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

    /// @notice Configurable price per job (in wei).  Zero = free.
    mapping(uint8 => uint256) public jobPrice;

    /// @notice Dynamic provision pricing — one-time setup fee (wei)
    uint256 public provisionBasePrice;
    /// @notice Per-day rate (wei)
    uint256 public dailyRate;
    /// @notice Per-CPU-core per-day rate (wei)
    uint256 public cpuDailyRate;
    /// @notice Per-GB-memory per-day rate (wei)
    uint256 public memGbDailyRate;

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

    error InsufficientPayment(uint8 job, uint256 required, uint256 sent);
    error VaultFactoryNotSet();
    error InvalidLifetimeDays();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultDeployed(uint64 indexed serviceId, address indexed vault, address indexed shareToken);
    event BotVaultDeployed(uint64 indexed serviceId, uint64 indexed callId, address vault, address shareToken);
    event OperatorGranted(uint64 indexed serviceId, address indexed operator, address vault);
    event ServiceTerminated(uint64 indexed serviceId);
    event TradingStarted(uint64 indexed serviceId);
    event TradingStopped(uint64 indexed serviceId);
    event JobPriceUpdated(uint8 indexed job, uint256 price);
    event ProvisionPricingUpdated(uint256 basePrice, uint256 dailyRate, uint256 cpuDailyRate, uint256 memGbDailyRate);
    event BotExtended(uint64 indexed serviceId, uint64 jobCallId, uint64 additionalDays);
    event BotVaultSkipped(uint64 indexed serviceId, uint64 indexed callId, string reason);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Set the VaultFactory address.  Called once after deployment.
    function setVaultFactory(address _factory) external onlyFromTangle {
        vaultFactory = _factory;
    }

    /// @notice Set the price for a specific job (governance only).
    function setJobPrice(uint8 job, uint256 price) external onlyFromTangle {
        jobPrice[job] = price;
        emit JobPriceUpdated(job, price);
    }

    /// @notice Set dynamic provision pricing parameters (governance only).
    function setProvisionPricing(
        uint256 _basePrice,
        uint256 _dailyRate,
        uint256 _cpuDailyRate,
        uint256 _memGbDailyRate
    ) external onlyFromTangle {
        provisionBasePrice = _basePrice;
        dailyRate = _dailyRate;
        cpuDailyRate = _cpuDailyRate;
        memGbDailyRate = _memGbDailyRate;
        emit ProvisionPricingUpdated(_basePrice, _dailyRate, _cpuDailyRate, _memGbDailyRate);
    }

    /// @notice Estimate the cost for provisioning a bot.
    /// @param maxLifetimeDays Number of days the bot will run (0 = default 30)
    /// @param cpuCores Number of CPU cores requested
    /// @param memoryMb Memory in MB requested
    /// @return cost Total cost in wei
    function estimateProvisionCost(
        uint64 maxLifetimeDays,
        uint64 cpuCores,
        uint64 memoryMb
    ) public view returns (uint256 cost) {
        uint64 days_ = maxLifetimeDays == 0 ? 30 : maxLifetimeDays;
        cost = provisionBasePrice
            + (uint256(days_) * dailyRate)
            + (uint256(days_) * uint256(cpuCores) * cpuDailyRate)
            + (uint256(days_) * uint256(memoryMb) * memGbDailyRate / 1024);
    }

    /// @notice Estimate the cost for extending a bot's lifetime.
    /// @param additionalDays Number of extra days to add
    /// @return cost Total cost in wei
    function estimateExtendCost(uint64 additionalDays) public view returns (uint256 cost) {
        cost = uint256(additionalDays) * dailyRate;
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
    /// @dev Stores config and operators for per-bot vault creation in onJobResult.
    ///      Vaults are NOT created here — they are created per-bot when JOB_PROVISION
    ///      results arrive via _handleProvisionResult.
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
    }

    /// @notice Called when an operator joins the service.
    /// @dev Grants OPERATOR_ROLE on ALL vaults for this service (legacy + per-bot).
    function onOperatorJoined(
        uint64 serviceId,
        address operator,
        uint16
    ) external override onlyFromTangle {
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
    function onServiceTermination(
        uint64 serviceId,
        address
    ) external override onlyFromTangle {
        instanceProvisioned[serviceId] = false;
        emit ServiceTerminated(serviceId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // QoS — REQUIRED RESULT COUNT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice All operators participate in every job.
    /// @dev Returns 0 which means "use protocol default" (all registered operators).
    ///      Intent deduplication at the vault level prevents duplicate execution.
    function getRequiredResultCount(
        uint64,
        uint8
    ) external view virtual override returns (uint32) {
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // JOB HOOKS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Called when a job is submitted.
    /// @dev Validates payment.  JOB_PROVISION and JOB_EXTEND use dynamic pricing
    ///      based on resource requirements and lifetime.  All other jobs use flat
    ///      `jobPrice` pricing.
    ///      For JOB_PROVISION: stores decoded inputs for use in _handleProvisionResult,
    ///      because the Tangle protocol may not forward original inputs to onJobResult.
    function onJobCall(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        bytes calldata inputs
    ) external payable virtual override onlyFromTangle {
        if (job == JOB_PROVISION) {
            _storeProvisionInputs(serviceId, jobCallId, inputs);
        }
        _onJobCallDynamic(serviceId, job, jobCallId, inputs);
    }

    /// @notice Internal: dynamic pricing for PROVISION/EXTEND, flat pricing for all others.
    function _onJobCallDynamic(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        bytes calldata inputs
    ) internal {
        if (job == JOB_PROVISION && _hasDynamicPricing()) {
            _validateProvisionPayment(inputs);
        } else if (job == JOB_EXTEND) {
            require(instanceProvisioned[serviceId], "Not provisioned");
            _validateExtendPayment(inputs, jobCallId, serviceId);
            return; // skip _onJobCallBase — we already checked provisioned
        } else {
            _onJobCallBase(serviceId, job);
            return;
        }
        // For JOB_PROVISION with dynamic pricing, still run base checks
        _onJobCallBase(serviceId, job);
    }

    /// @notice Internal: payment validation + common preconditions.
    function _onJobCallBase(uint64 serviceId, uint8 job) internal {
        // Payment validation (flat pricing — skipped for PROVISION when dynamic pricing is active)
        uint256 required = jobPrice[job];
        if (required > 0 && msg.value < required) {
            revert InsufficientPayment(job, required, msg.value);
        }

        // Service must be initialized (vault deployed) for all jobs
        if (job <= JOB_EXTEND && job != JOB_PROVISION) {
            require(instanceProvisioned[serviceId], "Not provisioned");
        }
    }

    /// @notice Check if dynamic provision pricing is configured (any rate > 0).
    function _hasDynamicPricing() internal view returns (bool) {
        return provisionBasePrice > 0 || dailyRate > 0 || cpuDailyRate > 0 || memGbDailyRate > 0;
    }

    /// @notice Validate payment for JOB_PROVISION using dynamic pricing.
    /// @dev Decodes provision inputs to extract resource parameters and lifetime.
    function _validateProvisionPayment(bytes calldata inputs) internal view {
        // TradingProvisionRequest layout: 15 fields, maxLifetimeDays is field index 11 (0-indexed)
        // Fields: name, strategy_type, strategy_config_json, risk_params_json,
        //         factory_address, asset_token, signers, required_signatures, chain_id,
        //         rpc_url, trading_loop_cron, cpu_cores, memory_mb, max_lifetime_days, validator_service_ids
        (,,,,,,,,,,,uint64 cpuCores, uint64 memoryMb, uint64 maxLifetimeDays,) =
            abi.decode(inputs, (string, string, string, string,
                address, address, address[], uint256, uint256,
                string, string, uint64, uint64, uint64, uint64[]));

        uint256 required = estimateProvisionCost(maxLifetimeDays, cpuCores, memoryMb);
        if (required > 0 && msg.value < required) {
            revert InsufficientPayment(JOB_PROVISION, required, msg.value);
        }
    }

    /// @notice Validate payment for JOB_EXTEND using dynamic pricing.
    function _validateExtendPayment(
        bytes calldata inputs,
        uint64 jobCallId,
        uint64 serviceId
    ) internal {
        (string memory sandboxId, uint64 additionalDays) =
            abi.decode(inputs, (string, uint64));

        if (additionalDays == 0) revert InvalidLifetimeDays();

        // Compute cost: use same daily rates but no base price for extensions
        // Use 1 cpu / 1024 mb as baseline (rates already factor in resources for extend)
        uint256 required = uint256(additionalDays) * dailyRate;
        if (required > 0 && msg.value < required) {
            revert InsufficientPayment(JOB_EXTEND, required, msg.value);
        }

        emit BotExtended(serviceId, jobCallId, additionalDays);
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
    function _storeProvisionInputs(
        uint64 serviceId,
        uint64 jobCallId,
        bytes calldata inputs
    ) internal {
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
        (string memory botName,,,,, address assetToken, address[] memory signers,
            uint256 requiredSigs,,,,,,,) =
            abi.decode(inner, (string, string, string, string,
                address, address, address[], uint256, uint256,
                string, string, uint64, uint64, uint64, uint64[]));

        _pendingProvisions[serviceId][jobCallId] = PendingProvision({
            assetToken: assetToken,
            signers: signers,
            requiredSigs: requiredSigs,
            name: botName
        });
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
    ) internal {
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

        (address vault, address shareToken) = IVaultFactory(vaultFactory).createBotVault(
            serviceId,
            assetToken,
            address(this),  // admin = this BSM contract
            address(0),     // no initial operator — granted below
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
        while (temp != 0) { digits++; temp /= 10; }
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
        uint64 serviceId, address assetToken, address admin, address operator,
        address[] calldata signers, uint256 requiredSigs,
        string calldata name, string calldata symbol, bytes32 salt
    ) external returns (address vault, address shareToken);

    function createBotVault(
        uint64 serviceId, address assetToken, address admin, address operator,
        address[] calldata signers, uint256 requiredSigs,
        string calldata name, string calldata symbol, bytes32 salt
    ) external returns (address vault, address shareToken);

    function getServiceVaults(uint64 serviceId) external view returns (address[] memory);
}
