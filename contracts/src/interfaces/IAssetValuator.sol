// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAssetValuator
/// @notice Converts a token amount into the vault asset's units.
interface IAssetValuator {
    /// @notice Return true when `token` can be valued in `asset` units.
    function isSupported(address token, address asset) external view returns (bool);

    /// @notice Convert `amount` of `token` into raw units of `asset`.
    function valueInAsset(address token, uint256 amount, address asset) external view returns (uint256 value);
}
