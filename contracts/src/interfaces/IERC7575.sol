// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IERC7575
/// @notice Multi-asset vault interface (ERC-7575)
/// @dev Extends the ERC-4626 vault concept with a separate share token.
///      Multiple vaults sharing the same share token enable multi-asset deposits.
interface IERC7575 {
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    /// @notice Address of the share token (ERC-7575 extension over ERC-4626)
    function share() external view returns (address shareTokenAddress);

    /// @notice Address of the underlying deposit asset for this vault
    function asset() external view returns (address assetTokenAddress);

    /// @notice Total value of assets managed by this vault, denominated in `asset()`
    function totalAssets() external view returns (uint256 totalManagedAssets);

    /// @notice Convert an asset amount to shares at current exchange rate
    function convertToShares(uint256 assets) external view returns (uint256 shares);

    /// @notice Convert a share amount to assets at current exchange rate
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /// @notice Maximum deposit for a given receiver
    function maxDeposit(address receiver) external view returns (uint256 maxAssets);

    /// @notice Preview the shares that would be minted for a deposit
    function previewDeposit(uint256 assets) external view returns (uint256 shares);

    /// @notice Deposit assets and mint shares to receiver
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    /// @notice Maximum withdrawal for a given owner
    function maxWithdraw(address owner) external view returns (uint256 maxAssets);

    /// @notice Preview the shares that would be burned for a withdrawal
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);

    /// @notice Withdraw assets by burning shares
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    /// @notice Maximum redeemable shares for a given owner
    function maxRedeem(address owner) external view returns (uint256 maxShares);

    /// @notice Preview the assets that would be returned for a redemption
    function previewRedeem(uint256 shares) external view returns (uint256 assets);

    /// @notice Redeem shares for underlying assets
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}
