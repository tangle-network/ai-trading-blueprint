// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./HyperliquidVault.sol";
import "./HyperliquidVaultDeployer.sol";
import "./VaultShare.sol";
import "./VaultShareDeployer.sol";

/// @title HyperliquidVaultFactory
/// @notice Deploys lightweight per-bot Hyperliquid vault accounts on HyperEVM.
/// @dev Preserves the backend-facing `VaultFactory.createBotVault` ABI and
///      `VaultCreated` event while excluding universal EVM trade execution.
contract HyperliquidVaultFactory is Ownable2Step, ReentrancyGuard {
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

    struct SignerConfig {
        uint256 requiredSignatures;
        uint256 signerCount;
    }

    error ZeroAddress();
    error InvalidSignerConfig();
    error NotAuthorized();
    error VaultDeployerAlreadySet();
    error VaultDeployerNotSet();

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

    mapping(uint64 serviceId => address[]) public serviceVaults;
    mapping(address vault => uint64) public vaultServiceId;
    mapping(address => bool) public authorizedCallers;
    mapping(address vault => SignerConfig) public signerConfigs;

    HyperliquidVaultDeployer public deployer;
    VaultShareDeployer public shareDeployer;

    modifier onlyAuthorized() {
        if (msg.sender != owner() && !authorizedCallers[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {}

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
        PolicyConfig calldata,
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
        HyperliquidVault v = vaultDeployer.deployVault(vaultSalt, assetToken, shareToken, admin, operator);
        vault = address(v);

        serviceVaults[serviceId].push(vault);
        vaultServiceId[vault] = serviceId;
        signerConfigs[vault] = SignerConfig({requiredSignatures: requiredSigs, signerCount: signers.length});

        shareToken.grantRole(shareToken.MINTER_ROLE(), vault);
        shareToken.linkVault(vault);

        emit VaultCreated(serviceId, vault, shareAddr, assetToken, admin, operator);
    }
}
