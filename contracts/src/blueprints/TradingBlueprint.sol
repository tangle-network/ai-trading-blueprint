// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "tnt-core/BlueprintServiceManagerBase.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title TradingBlueprint
/// @notice Abstract base for all trading blueprints.
/// @dev Extends BlueprintServiceManagerBase with:
///   - Automatic vault deployment via VaultFactory on service initialization
///   - Multi-operator support (all operators get OPERATOR_ROLE on the vault)
///   - Intent deduplication happens at the vault level (TradingVault.executedIntents)
///   - Configurable per-job pricing
///
///   Lifecycle:
///     1. Consumer calls requestService() → onRequest() stores vault config
///     2. Operators approve → service initialized → onServiceInitialized() deploys vault
///     3. Each operator joins → onOperatorJoined() grants OPERATOR_ROLE on vault
///     4. Consumer submits JOB_PROVISION → operators bootstrap off-chain infra (sidecars)
///     5. Trading begins — multiple operators independently generate trade intents
///     6. Validator network scores intents, vault executes approved ones (deduped by intentHash)
abstract contract TradingBlueprint is BlueprintServiceManagerBase {
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

    /// @notice Whether the service has been initialized (vault deployed)
    mapping(uint64 => bool) public instanceProvisioned;

    /// @notice The vault address associated with a service ID
    mapping(uint64 => address) public instanceVault;

    /// @notice Share token address per service
    mapping(uint64 => address) public instanceShare;

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
    event OperatorGranted(uint64 indexed serviceId, address indexed operator, address vault);
    event ServiceTerminated(uint64 indexed serviceId);
    event TradingStarted(uint64 indexed serviceId);
    event TradingStopped(uint64 indexed serviceId);
    event JobPriceUpdated(uint8 indexed job, uint256 price);
    event ProvisionPricingUpdated(uint256 basePrice, uint256 dailyRate, uint256 cpuDailyRate, uint256 memGbDailyRate);
    event BotExtended(uint64 indexed serviceId, uint64 jobCallId, uint64 additionalDays);

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
    /// @dev Deploys vault via VaultFactory if configured.  The BSM contract
    ///      becomes the vault admin so it can grant OPERATOR_ROLE to operators.
    function onServiceInitialized(
        uint64,
        uint64 requestId,
        uint64 serviceId,
        address,
        address[] calldata,
        uint64
    ) external override onlyFromTangle {
        ServiceRequestConfig memory req = _pendingRequests[requestId];

        if (vaultFactory != address(0) && req.assetToken != address(0)) {
            bytes32 salt = keccak256(abi.encodePacked(serviceId, requestId));

            // Deploy vault — BSM (address(this)) is admin, no initial operator
            (address vault, address shareToken) = IVaultFactory(vaultFactory).createVault(
                serviceId,
                req.assetToken,
                address(this),      // admin = this BSM contract
                address(0),         // no initial operator — granted via onOperatorJoined
                req.signers,
                req.requiredSignatures,
                req.name,
                req.symbol,
                salt
            );

            instanceVault[serviceId] = vault;
            instanceShare[serviceId] = shareToken;
            instanceProvisioned[serviceId] = true;

            // Grant CREATOR_ROLE to the service requester so they can
            // activate wind-down and perform admin unwinds.
            if (req.requester != address(0)) {
                IAccessControl(vault).grantRole(VAULT_CREATOR_ROLE, req.requester);
            }

            emit VaultDeployed(serviceId, vault, shareToken);
        }

        delete _pendingRequests[requestId];
    }

    /// @notice Called when an operator joins the service.
    /// @dev Grants OPERATOR_ROLE on the vault so the operator can call execute().
    function onOperatorJoined(
        uint64 serviceId,
        address operator,
        uint16
    ) external override onlyFromTangle {
        address vault = instanceVault[serviceId];
        if (vault != address(0)) {
            IAccessControl(vault).grantRole(VAULT_OPERATOR_ROLE, operator);
            emit OperatorGranted(serviceId, operator, vault);
        }
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
    function onJobCall(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        bytes calldata inputs
    ) external payable virtual override onlyFromTangle {
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
        _handleCommonJobResult(serviceId, job, jobCallId, operator, outputs);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL — shared job result logic for subclasses
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Handles common job results.
    /// @dev JOB_PROVISION/JOB_DEPROVISION are lightweight events.
    ///      Vault deployment is handled by onServiceInitialized, not here.
    function _handleCommonJobResult(
        uint64 serviceId,
        uint8 job,
        uint64,
        address operator,
        bytes calldata
    ) internal {
        if (job == JOB_START_TRADING) {
            emit TradingStarted(serviceId);
        } else if (job == JOB_STOP_TRADING) {
            emit TradingStopped(serviceId);
        }
    }
}

/// @notice Minimal interface for VaultFactory.createVault() calls
interface IVaultFactory {
    function createVault(
        uint64 serviceId, address assetToken, address admin, address operator,
        address[] calldata signers, uint256 requiredSigs,
        string calldata name, string calldata symbol, bytes32 salt
    ) external returns (address vault, address shareToken);
}
