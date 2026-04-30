// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradingVault.sol";
import "./PolicyEngine.sol";
import "./TradeValidator.sol";
import "./FeeDistributor.sol";

/// @title VaultDeployer
/// @notice Deploys TradingVault instances for VaultFactory via CREATE2.
/// @dev Split from VaultShare deployment so each helper stays below the EVM code size limit.
contract VaultDeployer {
    error NotAuthorized();

    address public immutable factory;
    PolicyEngine public immutable policyEngine;
    TradeValidator public immutable tradeValidator;
    FeeDistributor public immutable feeDistributor;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotAuthorized();
        _;
    }

    constructor(address _factory, PolicyEngine _pe, TradeValidator _tv, FeeDistributor _fd) {
        if (_factory == address(0)) revert NotAuthorized();
        factory = _factory;
        policyEngine = _pe;
        tradeValidator = _tv;
        feeDistributor = _fd;
    }

    /// @notice Deploy a TradingVault via CREATE2
    function deployVault(bytes32 salt, address assetToken, VaultShare shareToken, address admin, address operator)
        external
        onlyFactory
        returns (TradingVault)
    {
        return new TradingVault{salt: salt}(
            assetToken, shareToken, policyEngine, tradeValidator, feeDistributor, admin, operator
        );
    }
}
