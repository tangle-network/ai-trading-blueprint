// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title StrategyRegistry
/// @notice Strategy catalog and discovery for trading strategies
contract StrategyRegistry {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error OnlyOwner();
    error OnlyStrategyOwner();
    error StrategyNotFound(uint256 strategyId);
    error StrategyNotActive(uint256 strategyId);
    error EmptyName();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event StrategyRegistered(uint256 indexed strategyId, uint64 indexed serviceId, address indexed owner, string name);
    event StrategyUpdated(uint256 indexed strategyId, string ipfsHash);
    event StrategyDeactivated(uint256 indexed strategyId);
    event MetricsUpdated(uint256 indexed strategyId, uint256 aum, int256 pnl);

    // ═══════════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    struct StrategyInfo {
        uint64 serviceId;
        address owner;
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

    address public owner;

    /// @notice Auto-incrementing strategy ID counter
    uint256 public nextStrategyId;

    /// @notice Strategy storage
    mapping(uint256 => StrategyInfo) public strategies;

    /// @notice Mapping from strategy type to list of strategy IDs
    mapping(string => uint256[]) private _strategiesByType;

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

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

    constructor(address _owner) {
        owner = _owner;
        nextStrategyId = 1; // Start at 1 so 0 can be used as "not found"
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Register a new strategy
    /// @param serviceId The Tangle service ID
    /// @param name The strategy name
    /// @param strategyType The strategy type (e.g., "defi-yield", "dex-trading")
    /// @param ipfsHash The IPFS hash of the strategy configuration
    /// @return strategyId The ID of the newly registered strategy
    function registerStrategy(
        uint64 serviceId,
        string calldata name,
        string calldata strategyType,
        string calldata ipfsHash
    ) external returns (uint256 strategyId) {
        if (bytes(name).length == 0) revert EmptyName();

        strategyId = nextStrategyId++;

        strategies[strategyId] = StrategyInfo({
            serviceId: serviceId,
            owner: msg.sender,
            name: name,
            strategyType: strategyType,
            ipfsHash: ipfsHash,
            aum: 0,
            totalPnl: 0,
            active: true,
            createdAt: block.timestamp
        });

        _strategiesByType[strategyType].push(strategyId);

        emit StrategyRegistered(strategyId, serviceId, msg.sender, name);
    }

    /// @notice Update a strategy's IPFS hash
    /// @param strategyId The strategy ID
    /// @param ipfsHash The new IPFS hash
    function updateStrategy(
        uint256 strategyId,
        string calldata ipfsHash
    ) external strategyExists(strategyId) onlyStrategyOwner(strategyId) {
        if (!strategies[strategyId].active) revert StrategyNotActive(strategyId);

        strategies[strategyId].ipfsHash = ipfsHash;

        emit StrategyUpdated(strategyId, ipfsHash);
    }

    /// @notice Deactivate a strategy
    /// @param strategyId The strategy ID
    function deactivateStrategy(
        uint256 strategyId
    ) external strategyExists(strategyId) onlyStrategyOwner(strategyId) {
        if (!strategies[strategyId].active) revert StrategyNotActive(strategyId);

        strategies[strategyId].active = false;

        emit StrategyDeactivated(strategyId);
    }

    /// @notice Update a strategy's metrics
    /// @param strategyId The strategy ID
    /// @param aum The current AUM
    /// @param pnl The current PnL
    function updateMetrics(
        uint256 strategyId,
        uint256 aum,
        int256 pnl
    ) external strategyExists(strategyId) onlyStrategyOwner(strategyId) {
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
    function getStrategy(uint256 strategyId) external view strategyExists(strategyId) returns (StrategyInfo memory info) {
        return strategies[strategyId];
    }

    /// @notice Get all strategy IDs of a given type
    /// @param strategyType The strategy type to filter by
    /// @return ids Array of matching strategy IDs
    function getStrategiesByType(string calldata strategyType) external view returns (uint256[] memory ids) {
        return _strategiesByType[strategyType];
    }
}
