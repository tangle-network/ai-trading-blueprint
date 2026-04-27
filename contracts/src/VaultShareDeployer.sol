// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./VaultShare.sol";

/// @title VaultShareDeployer
/// @notice Holds VaultShare creation bytecode so VaultDeployer stays below the EIP-170 size limit.
/// @dev Called exclusively by VaultFactory to deploy share tokens via CREATE2.
contract VaultShareDeployer {
    error NotAuthorized();

    address public immutable factory;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotAuthorized();
        _;
    }

    constructor(address _factory) {
        if (_factory == address(0)) revert NotAuthorized();
        factory = _factory;
    }

    /// @notice Deploy a VaultShare token via CREATE2.
    function deployShare(bytes32 salt, string calldata name, string calldata symbol, address admin)
        external
        onlyFactory
        returns (VaultShare)
    {
        return new VaultShare{salt: salt}(name, symbol, admin);
    }
}
