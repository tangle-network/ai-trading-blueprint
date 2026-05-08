// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/VaultFactory.sol";
import "../src/PolicyEngine.sol";
import "../src/FeeDistributor.sol";

contract CreateSingletonVault is Script {
    event log_string(string value);

    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        uint256 deployerKey = vm.envOr("SCRIPT_PRIVATE_KEY", DEPLOYER_KEY);
        address vaultFactoryAddress = vm.envAddress("VAULT_FACTORY");
        uint64 serviceId = uint64(vm.envUint("SERVICE_ID"));
        address assetToken = vm.envAddress("ASSET_TOKEN");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address signerOne = vm.envAddress("SIGNER_ONE");
        address signerTwo = vm.envAddress("SIGNER_TWO");
        string memory vaultName = vm.envOr("VAULT_NAME", string("Instance Vault"));
        string memory vaultSymbol = vm.envOr("VAULT_SYMBOL", string("iVAULT"));

        address[] memory signers = new address[](2);
        signers[0] = signerOne;
        signers[1] = signerTwo;

        vm.startBroadcast(deployerKey);
        (address vault, address share) = VaultFactory(vaultFactoryAddress)
            .createBotVault(
                serviceId,
                assetToken,
                admin,
                address(0),
                signers,
                2,
                vaultName,
                vaultSymbol,
                keccak256(abi.encodePacked(serviceId, uint64(0), "manual-singleton")),
                PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 100, maxSlippageBps: 500}),
                FeeDistributor.FeeConfig({performanceFeeBps: 2000, managementFeeBps: 200, validatorFeeShareBps: 3000})
            );
        vm.stopBroadcast();

        emit log_string(string.concat("MANUAL_VAULT=", vm.toString(vault)));
        emit log_string(string.concat("MANUAL_SHARE=", vm.toString(share)));
    }
}
