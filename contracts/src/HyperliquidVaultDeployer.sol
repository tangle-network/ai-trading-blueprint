// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./HyperliquidVault.sol";
import "./TradeValidator.sol";
import "./VaultShare.sol";

/// @title HyperliquidVaultDeployer
/// @notice Deploys HyperliquidVault clones for the HyperEVM factory.
contract HyperliquidVaultDeployer {
    error NotAuthorized();
    error ImplementationNotSet();

    address public immutable factory;
    address public immutable implementation;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotAuthorized();
        _;
    }

    constructor(address _factory, address _implementation) {
        if (_factory == address(0)) revert NotAuthorized();
        if (_implementation == address(0)) revert ImplementationNotSet();
        factory = _factory;
        implementation = _implementation;
    }

    function deployVault(
        bytes32 salt,
        address assetToken,
        VaultShare shareToken,
        TradeValidator tradeValidator,
        address admin,
        address operator
    ) external onlyFactory returns (HyperliquidVault) {
        address clone = Clones.cloneDeterministic(implementation, salt);
        HyperliquidVault(payable(clone)).initialize(assetToken, shareToken, tradeValidator, admin, operator);
        return HyperliquidVault(payable(clone));
    }

    function predictVault(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }
}
