// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./HyperliquidVault.sol";
import "./HyperliquidVaultDeployer.sol";
import "./ITradeValidator.sol";
import "./VaultShare.sol";
import "./VaultShareDeployer.sol";

/// @title HyperliquidVaultFactory
/// @notice Deploys lightweight per-bot Hyperliquid vault accounts on HyperEVM.
/// @dev Preserves the backend-facing `VaultFactory.createBotVault` ABI and
///      `VaultCreated` event while excluding universal EVM trade execution.
contract HyperliquidVaultFactory {
    struct PolicyConfig {
        uint256 leverageCap;
        uint256 maxTradesPerHour;
        uint256 maxSlippageBps;
    }

    struct FeeConfig {
        uint256 performanceFeeBps;
        uint256 managementFeeBps;
        uint256 validatorFeeShareBps;
    }

    error ZeroAddress();
    error InvalidSignerConfig();
    error NotAuthorized();
    error VaultDeployerAlreadySet();
    error VaultDeployerNotSet();
    error Reentrancy();

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
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    mapping(uint64 serviceId => address[]) public serviceVaults;
    mapping(address vault => uint64) public vaultServiceId;
    mapping(address vault => PolicyConfig) public vaultPolicyConfigs;
    mapping(address => bool) public authorizedCallers;

    address public owner;
    address public pendingOwner;
    ITradeValidator public immutable tradeValidator;
    HyperliquidVaultDeployer public deployer;
    VaultShareDeployer public shareDeployer;
    uint256 private _entered;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner && !authorizedCallers[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(ITradeValidator _tradeValidator) {
        if (address(_tradeValidator) == address(0)) revert ZeroAddress();
        owner = msg.sender;
        tradeValidator = _tradeValidator;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotAuthorized();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    /// @notice Accept pending ownership of the shared TradeValidator.
    function acceptDependencyOwnership() external onlyOwner {
        tradeValidator.acceptOwnership();
    }

    function setVaultDeployers(HyperliquidVaultDeployer _deployer, VaultShareDeployer _shareDeployer)
        external
        onlyOwner
    {
        if (address(_deployer) == address(0) || address(_shareDeployer) == address(0)) revert ZeroAddress();
        if (address(deployer) != address(0) || address(shareDeployer) != address(0)) revert VaultDeployerAlreadySet();
        if (_deployer.factory() != address(this) || _shareDeployer.factory() != address(this)) revert NotAuthorized();
        deployer = _deployer;
        shareDeployer = _shareDeployer;
    }

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerUpdated(caller, authorized);
    }

    function getServiceVaults(uint64 serviceId) external view returns (address[] memory) {
        return serviceVaults[serviceId];
    }

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
        PolicyConfig calldata policyConfig,
        FeeConfig calldata
    ) external onlyAuthorized nonReentrant returns (address vault, address shareAddr) {
        if (assetToken == address(0) || admin == address(0)) revert ZeroAddress();
        if (signers.length < 3 || requiredSigs > signers.length || requiredSigs * 3 < signers.length * 2) {
            revert InvalidSignerConfig();
        }
        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == address(0)) revert InvalidSignerConfig();
            for (uint256 j = i + 1; j < signers.length; j++) {
                if (signers[i] == signers[j]) revert InvalidSignerConfig();
            }
        }
        HyperliquidVaultDeployer vaultDeployer = deployer;
        VaultShareDeployer vaultShareDeployer = shareDeployer;
        if (address(vaultDeployer) == address(0) || address(vaultShareDeployer) == address(0)) {
            revert VaultDeployerNotSet();
        }

        bytes32 shareSalt = keccak256(abi.encodePacked(serviceId, "hyperliquid-share", salt));
        VaultShare shareToken = vaultShareDeployer.deployShare(shareSalt, name, symbol, address(this));
        shareAddr = address(shareToken);
        emit ShareTokenCreated(serviceId, shareAddr);

        bytes32 vaultSalt = keccak256(abi.encodePacked(serviceId, assetToken, admin, "hyperliquid-vault", salt));
        HyperliquidVault v = vaultDeployer.deployVault(
            vaultSalt,
            assetToken,
            shareToken,
            tradeValidator,
            admin,
            operator,
            policyConfig.leverageCap,
            policyConfig.maxTradesPerHour,
            policyConfig.maxSlippageBps
        );
        vault = address(v);

        serviceVaults[serviceId].push(vault);
        vaultServiceId[vault] = serviceId;
        vaultPolicyConfigs[vault] = policyConfig;

        shareToken.grantRole(shareToken.MINTER_ROLE(), vault);
        shareToken.linkVault(vault);
        tradeValidator.configureVault(vault, signers, requiredSigs);

        emit VaultCreated(serviceId, vault, shareAddr, assetToken, admin, operator);
    }
}
