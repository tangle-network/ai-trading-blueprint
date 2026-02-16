// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IOracleAdapter
/// @notice Price feed interface for multi-asset NAV calculation
/// @dev Implementations can wrap Chainlink, Pyth, Redstone, or any price source
interface IOracleAdapter {
    /// @notice Get the USD price of a token
    /// @param token The token address to price
    /// @return price The price in USD (scaled by 10^decimals)
    /// @return decimals The number of decimals in the price
    function getPrice(address token) external view returns (uint256 price, uint8 decimals);
}
