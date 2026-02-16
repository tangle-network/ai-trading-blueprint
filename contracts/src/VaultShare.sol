// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IOracleAdapter.sol";

/// @title VaultShare
/// @notice ERC-20 share token for the ERC-7575 vault system
/// @dev Tracks linked vaults and computes cross-vault NAV for multi-asset support.
///      Single-asset deployments: one linked vault, no oracle needed.
///      Multi-asset deployments: multiple linked vaults, oracle required for NAV.
contract VaultShare is ERC20, AccessControl {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error VaultAlreadyLinked(address vault);
    error VaultNotLinked(address vault);
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultLinked(address indexed vault);
    event VaultUnlinked(address indexed vault);
    event OracleUpdated(address indexed oracle);

    // ═══════════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════════

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice All vaults linked to this share token
    address[] public linkedVaults;

    /// @notice Quick lookup for linked status
    mapping(address => bool) public isLinkedVault;

    /// @notice Oracle for multi-asset NAV calculation (address(0) = single-asset mode)
    IOracleAdapter public oracle;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(
        string memory name_,
        string memory symbol_,
        address admin
    ) ERC20(name_, symbol_) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MINTING / BURNING (vault-only)
    // ═══════════════════════════════════════════════════════════════════════════

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT REGISTRY
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Link a vault to this share token (called by factory)
    function linkVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault == address(0)) revert ZeroAddress();
        if (isLinkedVault[vault]) revert VaultAlreadyLinked(vault);

        linkedVaults.push(vault);
        isLinkedVault[vault] = true;

        emit VaultLinked(vault);
    }

    /// @notice Unlink a vault from this share token
    function unlinkVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isLinkedVault[vault]) revert VaultNotLinked(vault);

        isLinkedVault[vault] = false;
        for (uint256 i = 0; i < linkedVaults.length; i++) {
            if (linkedVaults[i] == vault) {
                linkedVaults[i] = linkedVaults[linkedVaults.length - 1];
                linkedVaults.pop();
                break;
            }
        }

        emit VaultUnlinked(vault);
    }

    /// @notice Set the oracle adapter for multi-asset NAV
    function setOracle(address _oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oracle = IOracleAdapter(_oracle);
        emit OracleUpdated(_oracle);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NAV CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Total net asset value across all linked vaults
    /// @dev In single-asset mode (no oracle), returns sum of deposit asset balances.
    ///      In multi-asset mode (oracle set), converts all asset balances to USD.
    /// @return nav The total NAV (in asset units for single-asset, USD-scaled for multi-asset)
    function totalNAV() public view returns (uint256 nav) {
        if (address(oracle) == address(0)) {
            // Single-asset mode: sum raw balances of each vault's deposit asset
            for (uint256 i = 0; i < linkedVaults.length; i++) {
                address vault = linkedVaults[i];
                address vaultAsset = IVaultAsset(vault).asset();
                nav += IERC20(vaultAsset).balanceOf(vault);
            }
        } else {
            // Multi-asset mode: convert all positions to USD via oracle
            for (uint256 i = 0; i < linkedVaults.length; i++) {
                address vault = linkedVaults[i];
                address vaultAsset = IVaultAsset(vault).asset();
                uint256 balance = IERC20(vaultAsset).balanceOf(vault);
                if (balance > 0) {
                    (uint256 price, uint8 dec) = oracle.getPrice(vaultAsset);
                    nav += (balance * price) / (10 ** dec);
                }
            }
        }
    }

    /// @notice Number of linked vaults
    function vaultCount() external view returns (uint256) {
        return linkedVaults.length;
    }
}

/// @dev Minimal interface to query a vault's deposit asset
interface IVaultAsset {
    function asset() external view returns (address);
}
