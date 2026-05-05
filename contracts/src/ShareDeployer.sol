// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./VaultShare.sol";

/// @title ShareDeployer
/// @notice Holds VaultShare creation bytecode so VaultFactory can stay below size limits.
/// @dev Called exclusively by VaultFactory to deploy share tokens via CREATE2.
contract ShareDeployer {
    error NotAuthorized();

    address public immutable factory;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotAuthorized();
        _;
    }

    constructor() {
        factory = msg.sender;
    }

    function deployShare(bytes32 salt, string calldata name, string calldata symbol, address admin)
        external
        onlyFactory
        returns (VaultShare)
    {
        return new VaultShare{salt: salt}(name, symbol, admin);
    }
}
