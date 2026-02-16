// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PolicyEngine
/// @notice Per-vault hard policy enforcement for trading operations
/// @dev All state is nested under vault address. Supports whitelists, position limits,
///      leverage caps, rate limiting (anti-churning), and slippage bounds.
contract PolicyEngine is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error VaultNotInitialized(address vault);
    error VaultAlreadyInitialized(address vault);
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultInitialized(address indexed vault, uint256 leverageCap, uint256 maxTradesPerHour, uint256 maxSlippageBps);
    event PolicyUpdated(address indexed vault, string policyType);
    event TradeRejected(address indexed vault, address indexed token, uint256 amount, string reason);

    // ═══════════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════════

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

    /// @notice Per-vault token whitelist
    mapping(address vault => mapping(address token => bool)) public tokenWhitelisted;

    /// @notice Per-vault target whitelist
    mapping(address vault => mapping(address target => bool)) public targetWhitelisted;

    /// @notice Per-vault per-token position limits
    mapping(address vault => mapping(address token => uint256)) public positionLimit;

    /// @notice Per-vault circular buffer of trade timestamps for rate limiting
    mapping(address vault => uint256[]) public tradeTimestamps;

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier vaultInitialized(address vault) {
        if (!policies[vault].initialized) revert VaultNotInitialized(vault);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor() Ownable(msg.sender) {}

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Initialize policy for a new vault with default parameters
    /// @param vault The vault address
    /// @param leverageCap Maximum leverage in basis points (e.g., 50000 = 5x)
    /// @param maxTradesPerHour Maximum trades per hour (0 = unlimited)
    /// @param maxSlippageBps Maximum slippage in basis points
    function initializeVault(
        address vault,
        uint256 leverageCap,
        uint256 maxTradesPerHour,
        uint256 maxSlippageBps
    ) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        if (policies[vault].initialized) revert VaultAlreadyInitialized(vault);

        policies[vault] = VaultPolicy({
            initialized: true,
            leverageCap: leverageCap,
            maxTradesPerHour: maxTradesPerHour,
            maxSlippageBps: maxSlippageBps,
            tradeTimestampIndex: 0
        });

        if (maxTradesPerHour > 0) {
            tradeTimestamps[vault] = new uint256[](maxTradesPerHour);
        }

        emit VaultInitialized(vault, leverageCap, maxTradesPerHour, maxSlippageBps);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION (all scoped to vault)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Set token whitelist status for a vault
    function setWhitelist(address vault, address[] calldata tokens, bool allowed)
        external onlyOwner vaultInitialized(vault)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            tokenWhitelisted[vault][tokens[i]] = allowed;
        }
        emit PolicyUpdated(vault, "tokenWhitelist");
    }

    /// @notice Set target contract whitelist status for a vault
    function setTargetWhitelist(address vault, address[] calldata targets, bool allowed)
        external onlyOwner vaultInitialized(vault)
    {
        for (uint256 i = 0; i < targets.length; i++) {
            targetWhitelisted[vault][targets[i]] = allowed;
        }
        emit PolicyUpdated(vault, "targetWhitelist");
    }

    /// @notice Set the maximum position size for a token in a vault
    function setPositionLimit(address vault, address token, uint256 maxAmount)
        external onlyOwner vaultInitialized(vault)
    {
        positionLimit[vault][token] = maxAmount;
        emit PolicyUpdated(vault, "positionLimit");
    }

    /// @notice Set the maximum leverage for a vault
    function setLeverageCap(address vault, uint256 maxLeverage)
        external onlyOwner vaultInitialized(vault)
    {
        policies[vault].leverageCap = maxLeverage;
        emit PolicyUpdated(vault, "leverageCap");
    }

    /// @notice Set the rate limit for a vault
    function setRateLimit(address vault, uint256 _maxTradesPerHour)
        external onlyOwner vaultInitialized(vault)
    {
        policies[vault].maxTradesPerHour = _maxTradesPerHour;
        delete tradeTimestamps[vault];
        if (_maxTradesPerHour > 0) {
            tradeTimestamps[vault] = new uint256[](_maxTradesPerHour);
        }
        policies[vault].tradeTimestampIndex = 0;
        emit PolicyUpdated(vault, "rateLimit");
    }

    /// @notice Set the maximum allowed slippage for a vault
    function setMaxSlippage(address vault, uint256 bps)
        external onlyOwner vaultInitialized(vault)
    {
        policies[vault].maxSlippageBps = bps;
        emit PolicyUpdated(vault, "maxSlippage");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Validate a trade against all configured policies for a vault
    /// @param vault The vault executing the trade
    /// @param token The output token being traded for
    /// @param amount The trade output amount (for position limit check)
    /// @param target The target contract being called
    /// @param leverage The leverage in basis points (0 for spot)
    /// @return valid Whether the trade passes all policy checks
    function validateTrade(
        address vault,
        address token,
        uint256 amount,
        address target,
        uint256 leverage
    ) external returns (bool valid) {
        VaultPolicy storage policy = policies[vault];
        if (!policy.initialized) {
            emit TradeRejected(vault, token, amount, "Vault not initialized");
            return false;
        }

        // Check token whitelist
        if (!tokenWhitelisted[vault][token]) {
            emit TradeRejected(vault, token, amount, "Token not whitelisted");
            return false;
        }

        // Check target whitelist
        if (!targetWhitelisted[vault][target]) {
            emit TradeRejected(vault, token, amount, "Target not whitelisted");
            return false;
        }

        // Check position limit
        uint256 limit = positionLimit[vault][token];
        if (limit > 0 && amount > limit) {
            emit TradeRejected(vault, token, amount, "Position limit exceeded");
            return false;
        }

        // Check leverage cap
        if (leverage > policy.leverageCap) {
            emit TradeRejected(vault, token, amount, "Leverage exceeded");
            return false;
        }

        // Check rate limit (anti-churning via circular buffer)
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
                emit TradeRejected(vault, token, amount, "Rate limit exceeded");
                return false;
            }

            // Record this trade timestamp
            if (timestamps.length == 0) {
                timestamps.push(block.timestamp);
            } else {
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
