// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PolicyEngine
/// @notice Per-vault hard policy enforcement for trading operations
/// @dev All state is nested under vault address. Supports whitelists, position limits,
///      leverage caps, rate limiting (anti-churning), and slippage bounds.
///      Each vault has an admin who can update its policy configuration.
contract PolicyEngine is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error VaultNotInitialized(address vault);
    error VaultAlreadyInitialized(address vault);
    error ZeroAddress();
    error NotVaultAdminOrOwner();
    error NotAuthorizedCaller();
    error MaxTradesPerHourTooHigh();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultInitialized(
        address indexed vault, address indexed admin, uint256 leverageCap, uint256 maxTradesPerHour, uint256 maxSlippageBps
    );
    event VaultAdminUpdated(address indexed vault, address indexed newAdmin);
    event PolicyUpdated(address indexed vault, uint8 indexed policyType);
    event TradeRejected(address indexed vault, address indexed token, uint256 amount, uint8 indexed reason);

    /// @dev Policy type codes for PolicyUpdated event
    uint8 public constant POLICY_TOKEN_WHITELIST = 1;
    uint8 public constant POLICY_TARGET_WHITELIST = 2;
    uint8 public constant POLICY_POSITION_LIMIT = 3;
    uint8 public constant POLICY_LEVERAGE_CAP = 4;
    uint8 public constant POLICY_RATE_LIMIT = 5;
    uint8 public constant POLICY_MAX_SLIPPAGE = 6;

    /// @dev Rejection reason codes for TradeRejected event
    uint8 public constant REJECT_NOT_INITIALIZED = 1;
    uint8 public constant REJECT_TOKEN_NOT_WHITELISTED = 2;
    uint8 public constant REJECT_TARGET_NOT_WHITELISTED = 3;
    uint8 public constant REJECT_POSITION_LIMIT = 4;
    uint8 public constant REJECT_RATE_LIMIT = 5;
    event AuthorizedCallerUpdated(address indexed caller, bool authorized);

    // ═══════════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Configuration struct passed during vault initialization
    struct PolicyConfig {
        uint256 leverageCap;
        uint256 maxTradesPerHour;
        uint256 maxSlippageBps;
    }

    struct VaultPolicy {
        bool initialized;
        uint256 leverageCap;
        uint256 maxTradesPerHour;
        uint256 maxSlippageBps;
        uint256 tradeTimestampIndex;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Per-vault policy configuration
    mapping(address vault => VaultPolicy) public policies;

    /// @notice Per-vault admin (can update their vault's policy)
    mapping(address vault => address) public vaultAdmin;

    /// @notice Per-vault token whitelist
    mapping(address vault => mapping(address token => bool)) public tokenWhitelisted;

    /// @notice Per-vault target whitelist
    mapping(address vault => mapping(address target => bool)) public targetWhitelisted;

    /// @notice Per-vault per-token position limits
    mapping(address vault => mapping(address token => uint256)) public positionLimit;

    /// @notice Per-vault circular buffer of trade timestamps for rate limiting
    mapping(address vault => uint256[]) public tradeTimestamps;

    /// @notice Addresses authorized to call validateTrade (e.g. vault contracts)
    mapping(address => bool) public authorizedCallers;

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier vaultInitialized(address vault) {
        if (!policies[vault].initialized) revert VaultNotInitialized(vault);
        _;
    }

    modifier onlyVaultAdminOrOwner(address vault) {
        if (msg.sender != owner() && msg.sender != vaultAdmin[vault]) {
            revert NotVaultAdminOrOwner();
        }
        _;
    }

    /// @notice Maximum allowed value for maxTradesPerHour to prevent gas DoS on the rate-limit loop
    uint256 public constant MAX_TRADES_PER_HOUR_CAP = 1000;

    modifier onlyAuthorizedOrOwner() {
        if (msg.sender != owner() && !authorizedCallers[msg.sender]) {
            revert NotAuthorizedCaller();
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor() Ownable(msg.sender) {}

    /// @notice Set or revoke authorized caller status (e.g. vault contracts)
    /// @dev Only contract owner (VaultFactory) can grant — security-critical
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerUpdated(caller, authorized);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Initialize policy for a new vault
    /// @param vault The vault address
    /// @param admin The vault admin who can update policy settings
    /// @param config The initial policy configuration
    function initializeVault(address vault, address admin, PolicyConfig calldata config) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        if (policies[vault].initialized) revert VaultAlreadyInitialized(vault);
        if (config.maxTradesPerHour > MAX_TRADES_PER_HOUR_CAP) revert MaxTradesPerHourTooHigh();

        vaultAdmin[vault] = admin;

        policies[vault] = VaultPolicy({
            initialized: true,
            leverageCap: config.leverageCap,
            maxTradesPerHour: config.maxTradesPerHour,
            maxSlippageBps: config.maxSlippageBps,
            tradeTimestampIndex: 0
        });

        if (config.maxTradesPerHour > 0) {
            tradeTimestamps[vault] = new uint256[](config.maxTradesPerHour);
        }

        emit VaultInitialized(vault, admin, config.leverageCap, config.maxTradesPerHour, config.maxSlippageBps);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT ADMIN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Transfer vault admin to a new address
    function setVaultAdmin(address vault, address newAdmin)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        if (newAdmin == address(0)) revert ZeroAddress();
        vaultAdmin[vault] = newAdmin;
        emit VaultAdminUpdated(vault, newAdmin);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION (all scoped to vault — vault admin or contract owner)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Set token whitelist status for a vault (batch)
    function setWhitelist(address vault, address[] calldata tokens, bool allowed)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            tokenWhitelisted[vault][tokens[i]] = allowed;
        }
        emit PolicyUpdated(vault, POLICY_TOKEN_WHITELIST);
    }

    /// @notice Set token whitelist status for a single token
    function whitelistToken(address vault, address token, bool allowed)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        tokenWhitelisted[vault][token] = allowed;
        emit PolicyUpdated(vault, POLICY_TOKEN_WHITELIST);
    }

    /// @notice Set target contract whitelist status for a vault
    function setTargetWhitelist(address vault, address[] calldata targets, bool allowed)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        for (uint256 i = 0; i < targets.length; i++) {
            targetWhitelisted[vault][targets[i]] = allowed;
        }
        emit PolicyUpdated(vault, POLICY_TARGET_WHITELIST);
    }

    /// @notice Set the maximum position size for a token in a vault
    function setPositionLimit(address vault, address token, uint256 maxAmount)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        positionLimit[vault][token] = maxAmount;
        emit PolicyUpdated(vault, POLICY_POSITION_LIMIT);
    }

    /// @notice Set the maximum leverage for a vault (advisory — enforced off-chain by AI validators)
    /// @dev Stored for off-chain tooling and UI display. Not enforced in validateTrade().
    function setLeverageCap(address vault, uint256 maxLeverage)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        policies[vault].leverageCap = maxLeverage;
        emit PolicyUpdated(vault, POLICY_LEVERAGE_CAP);
    }

    /// @notice Set the rate limit for a vault
    function setRateLimit(address vault, uint256 _maxTradesPerHour)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        if (_maxTradesPerHour > MAX_TRADES_PER_HOUR_CAP) revert MaxTradesPerHourTooHigh();
        policies[vault].maxTradesPerHour = _maxTradesPerHour;
        delete tradeTimestamps[vault];
        if (_maxTradesPerHour > 0) {
            tradeTimestamps[vault] = new uint256[](_maxTradesPerHour);
        }
        policies[vault].tradeTimestampIndex = 0;
        emit PolicyUpdated(vault, POLICY_RATE_LIMIT);
    }

    /// @notice Set the maximum allowed slippage for a vault (advisory — enforced by TradingVault.minOutput)
    /// @dev Stored for off-chain tooling. On-chain slippage is enforced by the minOutput check in execute().
    function setMaxSlippage(address vault, uint256 bps)
        external
        vaultInitialized(vault)
        onlyVaultAdminOrOwner(vault)
    {
        policies[vault].maxSlippageBps = bps;
        emit PolicyUpdated(vault, POLICY_MAX_SLIPPAGE);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Validate a trade against all configured policies for a vault
    /// @dev Leverage and slippage are enforced off-chain by AI validators and the trading runtime.
    ///      On-chain enforcement covers: token/target whitelists, position limits, and rate limiting.
    ///      Slippage is enforced by TradingVault.execute()'s minOutput check.
    /// @dev NOTE: Rate-limit slot is consumed on successful validation even if the trade later
    ///      fails validator checks. This is by design — splitting validate/record would require
    ///      a callback pattern. The practical impact is limited since only OPERATOR_ROLE can call.
    function validateTrade(address vault, address token, uint256 amount, address target, uint256 /* leverage */)
        external
        onlyAuthorizedOrOwner
        returns (bool valid)
    {
        VaultPolicy storage policy = policies[vault];
        if (!policy.initialized) {
            emit TradeRejected(vault, token, amount, REJECT_NOT_INITIALIZED);
            return false;
        }

        if (!tokenWhitelisted[vault][token]) {
            emit TradeRejected(vault, token, amount, REJECT_TOKEN_NOT_WHITELISTED);
            return false;
        }

        if (!targetWhitelisted[vault][target]) {
            emit TradeRejected(vault, token, amount, REJECT_TARGET_NOT_WHITELISTED);
            return false;
        }

        uint256 limit = positionLimit[vault][token];
        if (limit > 0 && amount > limit) {
            emit TradeRejected(vault, token, amount, REJECT_POSITION_LIMIT);
            return false;
        }

        // Rate limit (anti-churning via circular buffer)
        if (policy.maxTradesPerHour > 0) {
            uint256[] storage timestamps = tradeTimestamps[vault];
            uint256 oneHourAgo = block.timestamp > 1 hours ? block.timestamp - 1 hours : 0;
            uint256 recentTrades = 0;

            for (uint256 i = 0; i < timestamps.length; i++) {
                if (timestamps[i] > oneHourAgo) {
                    recentTrades++;
                }
            }

            if (recentTrades >= policy.maxTradesPerHour) {
                emit TradeRejected(vault, token, amount, REJECT_RATE_LIMIT);
                return false;
            }

            if (timestamps.length > 0) {
                timestamps[policy.tradeTimestampIndex] = block.timestamp;
                policy.tradeTimestampIndex = (policy.tradeTimestampIndex + 1) % timestamps.length;
            }
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Get the number of trades in the last hour for a vault
    function getRecentTradeCount(address vault) external view returns (uint256 count) {
        uint256[] storage timestamps = tradeTimestamps[vault];
        uint256 oneHourAgo = block.timestamp > 1 hours ? block.timestamp - 1 hours : 0;
        for (uint256 i = 0; i < timestamps.length; i++) {
            if (timestamps[i] > oneHourAgo) {
                count++;
            }
        }
    }

    /// @notice Check if a vault's policy is initialized
    function isInitialized(address vault) external view returns (bool) {
        return policies[vault].initialized;
    }
}
