// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./TradingVault.sol";
import "./VaultShare.sol";
import "./TradeValidator.sol";
import "./PolicyEngine.sol";
import "./FeeDistributor.sol";

/// @title VaultFactory
/// @notice Deploys full ERC-7575 vault stacks via CREATE2
/// @dev Creates VaultShare + TradingVault(s) + configures TradeValidator and PolicyEngine.
///      For single-asset: one createVault() call.
///      For multi-asset: call createVault() once (creates share token), then addAssetVault() for each additional asset.
contract VaultFactory is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error ServiceNotInitialized(uint64 serviceId);
    error ServiceAlreadyInitialized(uint64 serviceId);
    error InvalidSignerConfig();

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

    // ═══════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════════

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
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // OWNERSHIP
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Accept pending ownership of PolicyEngine and TradeValidator.
    /// @dev Call this after the deployer calls transferOwnership(vaultFactory) on both.
    function acceptDependencyOwnership() external onlyOwner {
        policyEngine.acceptOwnership();
        tradeValidator.acceptOwnership();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT CREATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Create the first vault for a service (also creates the shared VaultShare)
    /// @param serviceId The Tangle service ID
    /// @param assetToken The deposit asset for this vault
    /// @param admin The vault admin address
    /// @param operator The trading agent address (OPERATOR_ROLE)
    /// @param signers Array of validator signer addresses
    /// @param requiredSigs Minimum signatures required (m in m-of-n)
    /// @param name Share token name (e.g., "AI Yield Shares")
    /// @param symbol Share token symbol (e.g., "aiYLD")
    /// @param salt User-provided salt for deterministic addresses
    /// @return vault The deployed vault address
    /// @return shareAddr The VaultShare token address
    function createVault(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external returns (address vault, address shareAddr) {
        if (assetToken == address(0) || admin == address(0)) revert ZeroAddress();
        if (serviceShares[serviceId] != address(0)) revert ServiceAlreadyInitialized(serviceId);
        if (signers.length == 0 || requiredSigs == 0 || requiredSigs > signers.length) {
            revert InvalidSignerConfig();
        }

        // 1. Deploy VaultShare via CREATE2
        bytes32 shareSalt = keccak256(abi.encodePacked(serviceId, "share", salt));
        VaultShare shareToken = new VaultShare{salt: shareSalt}(name, symbol, address(this));
        shareAddr = address(shareToken);
        serviceShares[serviceId] = shareAddr;
        emit ShareTokenCreated(serviceId, shareAddr);

        // 2. Deploy TradingVault via CREATE2
        vault = _deployVault(serviceId, assetToken, shareToken, admin, operator, salt);

        // 3. Grant MINTER_ROLE to vault on VaultShare
        shareToken.grantRole(shareToken.MINTER_ROLE(), vault);

        // 4. Link vault in VaultShare
        shareToken.linkVault(vault);

        // 5. Configure TradeValidator for this vault
        tradeValidator.configureVault(vault, signers, requiredSigs);

        // 6. Initialize PolicyEngine with sensible defaults
        policyEngine.initializeVault(vault, 50000, 100, 500); // 5x leverage, 100 trades/hr, 5% slippage

        // 7. Auto-whitelist the asset token (always needed for deposits/withdrawals)
        address[] memory tokenList = new address[](1);
        tokenList[0] = assetToken;
        policyEngine.setWhitelist(vault, tokenList, true);

        emit VaultCreated(serviceId, vault, shareAddr, assetToken, admin, operator);
    }

    /// @notice Create an independent vault for a specific bot (per-bot isolation).
    /// @dev Unlike createVault(), this allows multiple vaults per service — each bot
    ///      gets its own VaultShare + TradingVault. Called by the BSM in onJobResult
    ///      when a provision job completes.
    /// @param serviceId The Tangle service ID
    /// @param assetToken The deposit asset for this vault
    /// @param admin The vault admin address (typically the BSM contract)
    /// @param operator Initial operator (address(0) if granted later via onOperatorJoined)
    /// @param signers Array of validator signer addresses
    /// @param requiredSigs Minimum signatures required (m in m-of-n)
    /// @param name Share token name (e.g., bot name)
    /// @param symbol Share token symbol
    /// @param salt Unique salt (typically keccak256(serviceId, callId))
    /// @return vault The deployed vault address
    /// @return shareAddr The VaultShare token address
    function createBotVault(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external returns (address vault, address shareAddr) {
        if (assetToken == address(0) || admin == address(0)) revert ZeroAddress();
        // NOTE: No ServiceAlreadyInitialized check — multiple bot vaults per service allowed
        if (signers.length == 0 || requiredSigs == 0 || requiredSigs > signers.length) {
            revert InvalidSignerConfig();
        }

        // 1. Deploy VaultShare via CREATE2 (unique per bot via salt)
        bytes32 shareSalt = keccak256(abi.encodePacked(serviceId, "bot-share", salt));
        VaultShare shareToken = new VaultShare{salt: shareSalt}(name, symbol, address(this));
        shareAddr = address(shareToken);
        emit ShareTokenCreated(serviceId, shareAddr);

        // 2. Deploy TradingVault via CREATE2
        vault = _deployVault(serviceId, assetToken, shareToken, admin, operator, salt);

        // 3. Grant MINTER_ROLE to vault on VaultShare
        shareToken.grantRole(shareToken.MINTER_ROLE(), vault);

        // 4. Link vault in VaultShare
        shareToken.linkVault(vault);

        // 5. Configure TradeValidator for this vault
        tradeValidator.configureVault(vault, signers, requiredSigs);

        // 6. Initialize PolicyEngine with sensible defaults
        policyEngine.initializeVault(vault, 50000, 100, 500);

        // 7. Auto-whitelist the asset token (always needed for deposits/withdrawals)
        address[] memory tokenList = new address[](1);
        tokenList[0] = assetToken;
        policyEngine.setWhitelist(vault, tokenList, true);

        emit VaultCreated(serviceId, vault, shareAddr, assetToken, admin, operator);
    }

    /// @notice Add another asset vault to an existing service (multi-asset ERC-7575)
    /// @param serviceId The existing service ID (must already have a VaultShare)
    /// @param assetToken The new deposit asset
    /// @param admin The vault admin
    /// @param operator The trading agent
    /// @param signers Validator signers for this vault
    /// @param requiredSigs Required signatures
    /// @param salt User-provided salt
    /// @return vault The deployed vault address
    function addAssetVault(
        uint64 serviceId,
        address assetToken,
        address admin,
        address operator,
        address[] calldata signers,
        uint256 requiredSigs,
        bytes32 salt
    ) external returns (address vault) {
        if (assetToken == address(0) || admin == address(0)) revert ZeroAddress();
        address shareAddr = serviceShares[serviceId];
        if (shareAddr == address(0)) revert ServiceNotInitialized(serviceId);
        if (signers.length == 0 || requiredSigs == 0 || requiredSigs > signers.length) {
            revert InvalidSignerConfig();
        }

        VaultShare shareToken = VaultShare(shareAddr);

        // 1. Deploy TradingVault
        vault = _deployVault(serviceId, assetToken, shareToken, admin, operator, salt);

        // 2. Grant MINTER_ROLE
        shareToken.grantRole(shareToken.MINTER_ROLE(), vault);

        // 3. Link vault
        shareToken.linkVault(vault);

        // 4. Configure TradeValidator
        tradeValidator.configureVault(vault, signers, requiredSigs);

        // 5. Initialize PolicyEngine
        policyEngine.initializeVault(vault, 50000, 100, 500);

        // 6. Auto-whitelist the asset token
        address[] memory tokenList = new address[](1);
        tokenList[0] = assetToken;
        policyEngine.setWhitelist(vault, tokenList, true);

        emit VaultCreated(serviceId, vault, shareAddr, assetToken, admin, operator);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Get all vault addresses for a service
    function getServiceVaults(uint64 serviceId) external view returns (address[] memory) {
        return serviceVaults[serviceId];
    }

    /// @notice Get the vault count for a service
    function getServiceVaultCount(uint64 serviceId) external view returns (uint256) {
        return serviceVaults[serviceId].length;
    }

    /// @notice Precompute vault address for given parameters
    function getVaultAddress(uint64 serviceId, address assetToken, address admin, address operator, bytes32 salt)
        external
        view
        returns (address)
    {
        address shareAddr = serviceShares[serviceId];
        if (shareAddr == address(0)) {
            // Predict the share address first
            bytes32 shareSalt = keccak256(abi.encodePacked(serviceId, "share", salt));
            shareAddr = _predictCreate2(shareSalt, type(VaultShare).creationCode);
        }

        bytes32 vaultSalt = keccak256(abi.encodePacked(serviceId, assetToken, admin, salt));
        bytes memory constructorArgs = abi.encode(
            assetToken, VaultShare(shareAddr), policyEngine, tradeValidator, feeDistributor, admin, operator
        );

        return _predictCreate2(vaultSalt, abi.encodePacked(type(TradingVault).creationCode, constructorArgs));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════════

    function _deployVault(
        uint64 serviceId,
        address assetToken,
        VaultShare shareToken,
        address admin,
        address operator,
        bytes32 salt
    ) internal returns (address vault) {
        bytes32 vaultSalt = keccak256(abi.encodePacked(serviceId, assetToken, admin, salt));

        TradingVault v = new TradingVault{salt: vaultSalt}(
            assetToken, shareToken, policyEngine, tradeValidator, feeDistributor, admin, operator
        );

        vault = address(v);
        serviceVaults[serviceId].push(vault);
        vaultServiceId[vault] = serviceId;
    }

    function _predictCreate2(bytes32 salt, bytes memory creationCode) internal view returns (address) {
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(creationCode)));
        return address(uint160(uint256(hash)));
    }
}
