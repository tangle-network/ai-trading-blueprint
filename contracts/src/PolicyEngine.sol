// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
        address indexed vault,
        address indexed admin,
        uint256 leverageCap,
        uint256 maxTradesPerHour,
        uint256 maxSlippageBps
    );
    event VaultAdminUpdated(address indexed vault, address indexed newAdmin);
    event PolicyUpdated(address indexed vault, uint8 indexed policyType);

    /// @dev Policy type codes for PolicyUpdated event
    uint8 public constant POLICY_TOKEN_WHITELIST = 1;
    uint8 public constant POLICY_TARGET_WHITELIST = 2;
    uint8 public constant POLICY_POSITION_LIMIT = 3;
    uint8 public constant POLICY_LEVERAGE_CAP = 4;
    uint8 public constant POLICY_RATE_LIMIT = 5;
    uint8 public constant POLICY_MAX_SLIPPAGE = 6;

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

    /// @notice Addresses authorized to call recordTrade (e.g. vault contracts)
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

    /// @notice Set the maximum leverage cap for a vault, in BPS (10000 = 1x).
    /// @dev H-3: enforced on-chain in TradingVault._executeHealthFactor. Computed as
    ///      totalCollateralBase * 10000 / (totalCollateralBase - totalDebtBase) from the
    ///      Aave health-factor reading, the cap is checked post-borrow / post-withdraw
    ///      so any leverage-increasing action that breaks the cap reverts the trade.
    ///      A 0 cap disables the on-chain check (off-chain validators may still gate).
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

    /// @notice Set the maximum allowed slippage for a vault, in BPS (e.g. 50 = 0.5%).
    /// @dev H-3: enforced on-chain in TradingVault swap-envelope entry points via
    ///      `_assertSlippageCap`. The validator-signed minOutput must price out (in
    ///      deposit-asset units) within `maxSlippageBps` of the input value, where
    ///      both sides are valued by the vault's per-token IAssetValuator adapters.
    ///      A 0 cap disables the on-chain check (validator-signed minOutputPerInput
    ///      remains the only gate).
    function setMaxSlippage(address vault, uint256 bps) external vaultInitialized(vault) onlyVaultAdminOrOwner(vault) {
        policies[vault].maxSlippageBps = bps;
        emit PolicyUpdated(vault, POLICY_MAX_SLIPPAGE);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Check whether a trade satisfies on-chain policy WITHOUT recording it.
    /// @dev H-5: split from the legacy `validateTrade` so the rate-limit slot is only
    ///      consumed on a fully successful trade. Callers (TradingVault) check this
    ///      pre-call and then invoke `recordTrade` post-success.
    ///      On-chain enforcement covers: token/target whitelists, position limits, and rate limiting.
    ///      Slippage and leverage are enforced elsewhere (TradingVault.minOutput check + envelope sigs).
    function checkTrade(address vault, address token, uint256 amount, address target)
        external
        view
        returns (bool valid)
    {
        VaultPolicy storage policy = policies[vault];
        if (!policy.initialized) return false;
        if (!tokenWhitelisted[vault][token]) return false;
        if (!targetWhitelisted[vault][target]) return false;

        uint256 limit = positionLimit[vault][token];
        if (limit > 0) {
            uint256 currentExposure = token == address(0) ? vault.balance : IERC20(token).balanceOf(vault);
            if (currentExposure + amount > limit) return false;
        }

        if (policy.maxTradesPerHour > 0) {
            uint256[] storage timestamps = tradeTimestamps[vault];
            uint256 oneHourAgo = block.timestamp > 1 hours ? block.timestamp - 1 hours : 0;
            uint256 recentTrades = 0;
            for (uint256 i = 0; i < timestamps.length; i++) {
                if (timestamps[i] > oneHourAgo) recentTrades++;
            }
            if (recentTrades >= policy.maxTradesPerHour) return false;
        }

        return true;
    }

    /// @notice Record a successful trade against the rate-limit ring buffer for a vault.
    /// @dev H-5: invoked by TradingVault AFTER the executor returns successfully so failed
    ///      trades do not burn rate-limit slots. Caller must hold authorized status; the
    ///      slot is only consumed when the trade actually completed.
    function recordTrade(address vault) external onlyAuthorizedOrOwner {
        VaultPolicy storage policy = policies[vault];
        if (!policy.initialized) revert VaultNotInitialized(vault);
        if (policy.maxTradesPerHour == 0) return;

        uint256[] storage timestamps = tradeTimestamps[vault];
        if (timestamps.length == 0) return;

        timestamps[policy.tradeTimestampIndex] = block.timestamp;
        policy.tradeTimestampIndex = (policy.tradeTimestampIndex + 1) % timestamps.length;
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
