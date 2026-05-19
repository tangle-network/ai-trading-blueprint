// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/StdJson.sol";
import "../src/HyperliquidVault.sol";
import "../src/HyperliquidVaultDeployer.sol";
import "../src/HyperliquidVaultFactory.sol";
import "../src/VaultShareDeployer.sol";
import "../test/helpers/Setup.sol"; // MockERC20, only used when ASSET_TOKEN is unset

/// @title DeployHyperliquidVaultStack
/// @notice Deploys the lightweight HyperEVM-compatible Hyperliquid vault stack.
contract DeployHyperliquidVaultStack is Script {
    using stdJson for string;

    event log_string(string value);

    uint256 internal constant ANVIL_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    struct DeploymentResult {
        uint256 chainId;
        address deployer;
        address assetToken;
        address vaultFactory;
        address vaultImplementation;
        address vaultDeployer;
        address vaultShareDeployer;
    }

    struct DeployConfig {
        uint256 deployerKey;
        address assetTokenOverride;
        bool writeJson;
    }

    function run() external returns (DeploymentResult memory result) {
        return runWithConfig(_loadConfigFromEnv());
    }

    function runWithConfig(DeployConfig memory cfg) public returns (DeploymentResult memory result) {
        address deployerAddress = vm.addr(cfg.deployerKey);

        vm.startBroadcast(cfg.deployerKey);

        address assetToken;
        if (cfg.assetTokenOverride != address(0)) {
            assetToken = cfg.assetTokenOverride;
        } else {
            MockERC20 mock = new MockERC20("USD Coin (Mock)", "USDC", 6);
            assetToken = address(mock);
            mock.mint(deployerAddress, 1_000_000 * 1e6);
        }

        HyperliquidVault implementation = new HyperliquidVault();
        HyperliquidVaultFactory factory = new HyperliquidVaultFactory();
        HyperliquidVaultDeployer vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));
        factory.setVaultDeployers(vaultDeployer, shareDeployer);

        vm.stopBroadcast();

        result = DeploymentResult({
            chainId: block.chainid,
            deployer: deployerAddress,
            assetToken: assetToken,
            vaultFactory: address(factory),
            vaultImplementation: address(implementation),
            vaultDeployer: address(vaultDeployer),
            vaultShareDeployer: address(shareDeployer)
        });

        if (cfg.writeJson) {
            _writeDeploymentJson(result);
        }

        emit log_string(string.concat("HYPERLIQUID_ASSET_TOKEN=", vm.toString(assetToken)));
        emit log_string(string.concat("HYPERLIQUID_VAULT_FACTORY=", vm.toString(address(factory))));
        emit log_string(string.concat("HYPERLIQUID_VAULT_IMPLEMENTATION=", vm.toString(address(implementation))));
        emit log_string(string.concat("HYPERLIQUID_VAULT_DEPLOYER=", vm.toString(address(vaultDeployer))));
        emit log_string(string.concat("HYPERLIQUID_VAULT_SHARE_DEPLOYER=", vm.toString(address(shareDeployer))));
    }

    function _loadConfigFromEnv() internal view returns (DeployConfig memory cfg) {
        cfg.deployerKey = vm.envOr("PRIVATE_KEY", ANVIL_DEPLOYER_KEY);
        cfg.assetTokenOverride = vm.envOr("ASSET_TOKEN", address(0));
        cfg.writeJson = _strEq(vm.envOr("WRITE_DEPLOYMENT_JSON", string("true")), "true");
    }

    function _writeDeploymentJson(DeploymentResult memory r) internal {
        string memory baseDir = vm.envOr("DEPLOYMENT_JSON_DIR", string("./deployments"));
        string memory chainDir = string.concat(baseDir, "/", vm.toString(r.chainId));
        string memory jsonPath = string.concat(chainDir, "/hyperliquid-vault.json");

        vm.createDir(chainDir, true);

        string memory key = "hyperliquid-vault";
        vm.serializeUint(key, "chainId", r.chainId);
        vm.serializeAddress(key, "deployer", r.deployer);
        vm.serializeAddress(key, "assetToken", r.assetToken);
        vm.serializeAddress(key, "vaultFactory", r.vaultFactory);
        vm.serializeAddress(key, "vaultImplementation", r.vaultImplementation);
        vm.serializeAddress(key, "vaultDeployer", r.vaultDeployer);
        string memory output = vm.serializeAddress(key, "vaultShareDeployer", r.vaultShareDeployer);

        vm.writeFile(jsonPath, output);
    }

    function _strEq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
