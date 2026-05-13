// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./TradingVault.sol";
import "./PolicyEngine.sol";
import "./TradeValidator.sol";
import "./FeeDistributor.sol";
import "./VaultShare.sol";

/// @title VaultDeployer
/// @notice Deploys per-service `TradingVault` instances as EIP-1167 minimal
///         proxies pointing at a single shared `TradingVault` implementation.
/// @dev    Each clone is a 45-byte proxy that DELEGATECALLs into the
///         implementation, which means `VaultDeployer`'s own runtime
///         bytecode does **not** embed `TradingVault.creationCode` — that's
///         the only way to stay under the EIP-170 24,576 B cap that
///         Hyperliquid enforces. Each clone is initialized once via
///         `TradingVault.initialize(...)` in the same call that creates it,
///         so the proxy is never observable in an un-configured state.
contract VaultDeployer {
    error NotAuthorized();
    error ImplementationNotSet();

    address public immutable factory;
    PolicyEngine public immutable policyEngine;
    TradeValidator public immutable tradeValidator;
    FeeDistributor public immutable feeDistributor;

    /// @notice The pre-deployed `TradingVault` implementation every clone
    ///         delegates to. Set once at construction; can never change.
    address public immutable implementation;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotAuthorized();
        _;
    }

    constructor(address _factory, address _implementation, PolicyEngine _pe, TradeValidator _tv, FeeDistributor _fd) {
        if (_factory == address(0)) revert NotAuthorized();
        if (_implementation == address(0)) revert ImplementationNotSet();
        factory = _factory;
        implementation = _implementation;
        policyEngine = _pe;
        tradeValidator = _tv;
        feeDistributor = _fd;
    }

    /// @notice Deploy a `TradingVault` clone via CREATE2. The clone is
    ///         initialized atomically before returning so callers always
    ///         see a fully-configured vault.
    function deployVault(bytes32 salt, address assetToken, VaultShare shareToken, address admin, address operator)
        external
        onlyFactory
        returns (TradingVault)
    {
        address clone = Clones.cloneDeterministic(implementation, salt);
        TradingVault(payable(clone))
            .initialize(assetToken, shareToken, policyEngine, tradeValidator, feeDistributor, admin, operator);
        return TradingVault(payable(clone));
    }

    /// @notice Predict the CREATE2 address of a clone before deployment.
    function predictVault(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }
}
