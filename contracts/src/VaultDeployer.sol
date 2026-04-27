// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradingVault.sol";
import "./VaultShare.sol";
import "./PolicyEngine.sol";
import "./TradeValidator.sol";
import "./FeeDistributor.sol";

/// @title VaultDeployer
/// @notice Holds TradingVault creation bytecode, keeping VaultFactory under size limit.
/// @dev Called exclusively by VaultFactory to deploy vaults via CREATE2.
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
