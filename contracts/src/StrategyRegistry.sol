// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Minimal interface for a TradingVault-like contract with AccessControl + ERC4626 total assets.
interface ITradingVaultAdmin {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function totalAssets() external view returns (uint256);
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);
}

/// @title StrategyRegistry
/// @notice Strategy catalog and discovery for trading strategies.
/// @dev Registrations optionally link to a TradingVault. When linked, only the vault's
///      DEFAULT_ADMIN_ROLE holder may register, which proves the registrant controls the
///      on-chain capital. Unlinked entries remain available for off-chain strategies.
contract StrategyRegistry is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error OnlyStrategyOwner();
    error StrategyNotFound(uint256 strategyId);
    error StrategyNotActive(uint256 strategyId);
    error EmptyName();
    error NotVaultAdmin(address vault, address caller);
    error StrategyNotLinked(uint256 strategyId);

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event StrategyRegistered(
        uint256 indexed strategyId,
        uint64 indexed serviceId,
        address indexed owner,
        address linkedVault,
        string name
    );
    event StrategyUpdated(uint256 indexed strategyId, string ipfsHash);
    event StrategyDeactivated(uint256 indexed strategyId);
    event MetricsUpdated(uint256 indexed strategyId, uint256 aum, int256 pnl);

    // ═══════════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    struct StrategyInfo {
        uint64 serviceId;
        address owner;
        address linkedVault;
        string name;
        string strategyType;
        string ipfsHash;
        uint256 aum;
        int256 totalPnl;
        bool active;
        uint256 createdAt;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Auto-incrementing strategy ID counter
    uint256 public nextStrategyId;

    /// @notice Strategy storage
    mapping(uint256 => StrategyInfo) public strategies;

    /// @notice Mapping from strategy type to list of strategy IDs
    mapping(string => uint256[]) private _strategiesByType;

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyStrategyOwner(uint256 strategyId) {
        if (strategies[strategyId].owner != msg.sender) revert OnlyStrategyOwner();
        _;
    }

    modifier strategyExists(uint256 strategyId) {
        if (strategyId >= nextStrategyId) revert StrategyNotFound(strategyId);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(address _owner) Ownable(_owner) {
        nextStrategyId = 1; // Start at 1 so 0 can be used as "not found"
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Register a new strategy.
    /// @dev If `linkedVault != address(0)`, the caller must hold DEFAULT_ADMIN_ROLE on
    ///      that vault; this proves the registrant actually controls the on-chain capital.
    ///      If `linkedVault == address(0)`, registration is permitted for off-chain strategies.
    /// @param serviceId The Tangle service ID
    /// @param linkedVault The on-chain TradingVault this strategy is bound to (or address(0))
    /// @param name The strategy name
    /// @param strategyType The strategy type (e.g., "defi-yield", "dex-trading")
    /// @param ipfsHash The IPFS hash of the strategy configuration
    /// @return strategyId The ID of the newly registered strategy
    function registerStrategy(
        uint64 serviceId,
        address linkedVault,
        string calldata name,
        string calldata strategyType,
        string calldata ipfsHash
    ) external returns (uint256 strategyId) {
        if (bytes(name).length == 0) revert EmptyName();

        if (linkedVault != address(0)) {
            bytes32 adminRole = ITradingVaultAdmin(linkedVault).DEFAULT_ADMIN_ROLE();
            if (!ITradingVaultAdmin(linkedVault).hasRole(adminRole, msg.sender)) {
                revert NotVaultAdmin(linkedVault, msg.sender);
            }
        }

        strategyId = nextStrategyId++;

        strategies[strategyId] = StrategyInfo({
            serviceId: serviceId,
            owner: msg.sender,
            linkedVault: linkedVault,
            name: name,
            strategyType: strategyType,
            ipfsHash: ipfsHash,
            aum: 0,
            totalPnl: 0,
            active: true,
            createdAt: block.timestamp
        });

        _strategiesByType[strategyType].push(strategyId);

        emit StrategyRegistered(strategyId, serviceId, msg.sender, linkedVault, name);
    }

    /// @notice Update a strategy's IPFS hash
    /// @param strategyId The strategy ID
    /// @param ipfsHash The new IPFS hash
    function updateStrategy(uint256 strategyId, string calldata ipfsHash)
        external
        strategyExists(strategyId)
        onlyStrategyOwner(strategyId)
    {
        if (!strategies[strategyId].active) revert StrategyNotActive(strategyId);

        strategies[strategyId].ipfsHash = ipfsHash;

        emit StrategyUpdated(strategyId, ipfsHash);
    }

    /// @notice Deactivate a strategy
    /// @param strategyId The strategy ID
    function deactivateStrategy(uint256 strategyId) external strategyExists(strategyId) onlyStrategyOwner(strategyId) {
        if (!strategies[strategyId].active) revert StrategyNotActive(strategyId);

        strategies[strategyId].active = false;

        emit StrategyDeactivated(strategyId);
    }

    /// @notice Update a strategy's metrics using caller-supplied values.
    /// @dev The caller must be the strategy owner. AUM/PnL are unverified.
    /// @param strategyId The strategy ID
    /// @param aum The current assets under management (in deposit token units)
    /// @param pnl The cumulative profit/loss (negative for losses)
    function updateMetrics(uint256 strategyId, uint256 aum, int256 pnl)
        external
        strategyExists(strategyId)
        onlyStrategyOwner(strategyId)
    {
        strategies[strategyId].aum = aum;
        strategies[strategyId].totalPnl = pnl;

        emit MetricsUpdated(strategyId, aum, pnl);
    }

    /// @notice Update a strategy's metrics by reading AUM from the linked vault.
    /// @dev Only the strategy owner may call. The strategy must have a non-zero linkedVault.
    ///      AUM is authoritative from totalAssets(); PnL is caller-supplied since it
    ///      requires off-chain history of deposits, withdrawals, and fees.
    /// @param strategyId The strategy ID
    /// @param pnl The cumulative profit/loss (negative for losses)
    function recordMetrics(uint256 strategyId, int256 pnl)
        external
        strategyExists(strategyId)
        onlyStrategyOwner(strategyId)
    {
        address vault = strategies[strategyId].linkedVault;
        if (vault == address(0)) revert StrategyNotLinked(strategyId);

        uint256 aum = ITradingVaultAdmin(vault).totalAssets();
        strategies[strategyId].aum = aum;
        strategies[strategyId].totalPnl = pnl;

        emit MetricsUpdated(strategyId, aum, pnl);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Get full strategy info
    /// @param strategyId The strategy ID
    /// @return info The strategy information struct
    function getStrategy(uint256 strategyId)
        external
        view
        strategyExists(strategyId)
        returns (StrategyInfo memory info)
    {
        return strategies[strategyId];
    }

    /// @notice Get all strategy IDs of a given type
    /// @param strategyType The strategy type to filter by
    /// @return ids Array of matching strategy IDs
    function getStrategiesByType(string calldata strategyType) external view returns (uint256[] memory ids) {
        return _strategiesByType[strategyType];
    }
}
