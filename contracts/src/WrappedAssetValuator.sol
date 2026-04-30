// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IAssetValuator.sol";

/// @title WrappedAssetValuator
/// @notice Values wrapper tokens as their configured underlying asset.
/// @dev Intended for wrappers whose balance is already denominated in underlying units, e.g. Aave aTokens.
contract WrappedAssetValuator is IAssetValuator, Ownable {
    error ZeroAddress();
    error UnderlyingNotSet(address token);

    IAssetValuator public immutable baseValuator;
    mapping(address => address) public underlyingOf;

    event UnderlyingUpdated(address indexed wrapper, address indexed underlying);

    constructor(address owner_, IAssetValuator baseValuator_) Ownable(owner_) {
        if (owner_ == address(0) || address(baseValuator_) == address(0)) revert ZeroAddress();
        baseValuator = baseValuator_;
    }

    function setUnderlying(address wrapper, address underlying) external onlyOwner {
        if (wrapper == address(0) || underlying == address(0)) revert ZeroAddress();
        underlyingOf[wrapper] = underlying;
        emit UnderlyingUpdated(wrapper, underlying);
    }

    function isSupported(address token, address asset) external view override returns (bool) {
        address underlying = underlyingOf[token];
        return underlying != address(0) && baseValuator.isSupported(underlying, asset);
    }

    function valueInAsset(address token, uint256 amount, address asset) external view override returns (uint256 value) {
        address underlying = underlyingOf[token];
        if (underlying == address(0)) revert UnderlyingNotSet(token);
        return baseValuator.valueInAsset(underlying, amount, asset);
    }
}
