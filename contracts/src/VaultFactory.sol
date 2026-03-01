// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./TradingVault.sol";
import "./VaultShare.sol";
import "./TradeValidator.sol";
import "./PolicyEngine.sol";
import "./FeeDistributor.sol";
import "./VaultDeployer.sol";

/// @title VaultFactory
/// @notice Deploys full ERC-7575 vault stacks via CREATE2
/// @dev Creates VaultShare + TradingVault(s) + configures TradeValidator and PolicyEngine.
///      Vault/share deployment is delegated to VaultDeployer to stay under the bytecode size limit.
contract VaultFactory is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error ServiceAlreadyInitialized(uint64 serviceId);
    error InvalidSignerConfig();
    error NotAuthorized();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultCreated(
        uint64 indexed serviceId,
        address indexed vault,
        address indexed shareToken,
        address assetToken,
        address admin,
        address operator
    );
    event ShareTokenCreated(uint64 indexed serviceId, address indexed shareToken);
    event AuthorizedCallerUpdated(address indexed caller, bool authorized);

    // ═══════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════════

    VaultDeployer public immutable deployer;
    PolicyEngine public immutable policyEngine;
    TradeValidator public immutable tradeValidator;
    FeeDistributor public immutable feeDistributor;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Mapping from serviceId to shared VaultShare token
    mapping(uint64 serviceId => address) public serviceShares;

    /// @notice All vaults for a given service (one per asset)
    mapping(uint64 serviceId => address[]) public serviceVaults;

    /// @notice Quick lookup: vault address to serviceId
    mapping(address vault => uint64) public vaultServiceId;

    /// @notice Addresses authorized to call createVault/createBotVault
    mapping(address => bool) public authorizedCallers;

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyAuthorized() {
        if (msg.sender != owner() && !authorizedCallers[msg.sender]) {
            revert NotAuthorized();
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(PolicyEngine _policyEngine, TradeValidator _tradeValidator, FeeDistributor _feeDistributor)
        Ownable(msg.sender)
    {
        if (address(_policyEngine) == address(0)) revert ZeroAddress();
        if (address(_tradeValidator) == address(0)) revert ZeroAddress();
        if (address(_feeDistributor) == address(0)) revert ZeroAddress();

        policyEngine = _policyEngine;
        tradeValidator = _tradeValidator;
        feeDistributor = _feeDistributor;
        deployer = new VaultDeployer(_policyEngine, _tradeValidator, _feeDistributor);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Accept pending ownership of PolicyEngine, TradeValidator, and FeeDistributor.
    function acceptDependencyOwnership() external onlyOwner {
        policyEngine.acceptOwnership();
        tradeValidator.acceptOwnership();
        feeDistributor.acceptOwnership();
    }

    /// @notice Set or revoke authorized caller status for an address
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerUpdated(caller, authorized);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT CREATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Create the first vault for a service (also creates the shared VaultShare)
    /// @dev Sets serviceShares[serviceId] — reverts if already set. For per-bot vaults, use createBotVault.
    function createVault(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        string calldata name,
        string calldata symbol,
        bytes32 salt,
        PolicyEngine.PolicyConfig calldata policyConfig,
        FeeDistributor.FeeConfig calldata feeConfig
    ) external onlyAuthorized returns (address vault, address shareAddr) {
        if (serviceShares[serviceId] != address(0)) revert ServiceAlreadyInitialized(serviceId);

        (vault, shareAddr) =
            _createVaultWithNewShare(serviceId, assetToken, admin, operator, signers, requiredSigs, name, symbol, salt, false, policyConfig, feeConfig);

        serviceShares[serviceId] = shareAddr;
    }

    /// @notice Create an independent vault for a specific bot (per-bot isolation)
    /// @dev Does NOT set serviceShares — allows multiple bot vaults per service.
    function createBotVault(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        string calldata name,
        string calldata symbol,
        bytes32 salt,
        PolicyEngine.PolicyConfig calldata policyConfig,
        FeeDistributor.FeeConfig calldata feeConfig
    ) external onlyAuthorized returns (address vault, address shareAddr) {
        (vault, shareAddr) =
            _createVaultWithNewShare(serviceId, assetToken, admin, operator, signers, requiredSigs, name, symbol, salt, true, policyConfig, feeConfig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Get all vault addresses for a service
    function getServiceVaults(uint64 serviceId) external view returns (address[] memory) {
        return serviceVaults[serviceId];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════════

    function _createVaultWithNewShare(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        string calldata name,
        string calldata symbol,
        bytes32 salt,
        bool isBotVault,
        PolicyEngine.PolicyConfig calldata policyConfig,
        FeeDistributor.FeeConfig calldata feeConfig
    ) internal returns (address vault, address shareAddr) {
        if (assetToken == address(0) || admin == address(0)) revert ZeroAddress();
        if (signers.length == 0 || requiredSigs == 0 || requiredSigs > signers.length) {
            revert InvalidSignerConfig();
        }

        // Deploy VaultShare via VaultDeployer
        bytes32 shareSalt = isBotVault
            ? keccak256(abi.encodePacked(serviceId, "bot-share", salt))
            : keccak256(abi.encodePacked(serviceId, "share", salt));
        VaultShare shareToken = deployer.deployShare(shareSalt, name, symbol, address(this));
        shareAddr = address(shareToken);
        emit ShareTokenCreated(serviceId, shareAddr);

        // Deploy TradingVault via VaultDeployer
        bytes32 vaultSalt = keccak256(abi.encodePacked(serviceId, assetToken, admin, salt));
        TradingVault v = deployer.deployVault(vaultSalt, assetToken, shareToken, admin, operator);
        vault = address(v);
        serviceVaults[serviceId].push(vault);
        vaultServiceId[vault] = serviceId;

        // Configure all dependencies
        shareToken.grantRole(shareToken.MINTER_ROLE(), vault);
        shareToken.linkVault(vault);
        tradeValidator.configureVault(vault, signers, requiredSigs);
        policyEngine.initializeVault(vault, admin, policyConfig);
        policyEngine.setAuthorizedCaller(vault, true);
        policyEngine.whitelistToken(vault, assetToken, true);
        feeDistributor.initializeVaultFees(vault, admin, feeConfig);

        emit VaultCreated(serviceId, vault, shareAddr, assetToken, admin, operator);
    }
}
