// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/blueprints/TradingBlueprint.sol";
import "../src/VaultFactory.sol";
import "../src/PolicyEngine.sol";
import "../src/TradeValidator.sol";
import "../src/FeeDistributor.sol";

/// @title DeployTradingManager
/// @notice Deploys the live trading manager stack without creating a blueprint record.
/// @dev This is the production-shaped path for remote testnet deploys:
///      1. deploy support contracts + manager
///      2. authorize manager on VaultFactory
///      3. register blueprint via cargo tangle using the emitted manager address
contract DeployTradingManager is Script {
    event log_string(string value);

    function run() external {
        uint256 deployerKey = vm.envUint("SCRIPT_PRIVATE_KEY");
        bool instanceMode = vm.envOr("INSTANCE_MODE", false);

        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        PolicyEngine policyEngine = new PolicyEngine();
        TradeValidator tradeValidator = new TradeValidator();
        FeeDistributor feeDistributor = new FeeDistributor(deployer);
        VaultFactory vaultFactory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);
        TradingBlueprint manager = new TradingBlueprint();

        policyEngine.transferOwnership(address(vaultFactory));
        tradeValidator.transferOwnership(address(vaultFactory));
        feeDistributor.transferOwnership(address(vaultFactory));
        vaultFactory.acceptDependencyOwnership();

        manager.bootstrapConfigure(address(vaultFactory), instanceMode);
        vaultFactory.setAuthorizedCaller(address(manager), true);

        vm.stopBroadcast();

        emit log_string(string.concat("DEPLOY_MANAGER=", vm.toString(address(manager))));
        emit log_string(string.concat("DEPLOY_VAULT_FACTORY=", vm.toString(address(vaultFactory))));
        emit log_string(
            string.concat("DEPLOY_POLICY_ENGINE=", vm.toString(address(policyEngine)))
        );
        emit log_string(
            string.concat("DEPLOY_TRADE_VALIDATOR=", vm.toString(address(tradeValidator)))
        );
        emit log_string(
            string.concat("DEPLOY_FEE_DISTRIBUTOR=", vm.toString(address(feeDistributor)))
        );
    }
}
