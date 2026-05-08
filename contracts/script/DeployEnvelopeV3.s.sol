// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/StdJson.sol";
import "../src/VaultFactory.sol";
import "../src/VaultDeployer.sol";
import "../src/VaultShareDeployer.sol";
import "../src/PolicyEngine.sol";
import "../src/TradeValidator.sol";
import "../src/FeeDistributor.sol";
import "../src/StrategyRegistry.sol";
import "../src/TradingVault.sol";
import "../test/helpers/Setup.sol"; // MockERC20 (only used when ASSET_TOKEN is unset)

/**
 * @title DeployEnvelopeV3
 * @notice End-to-end deploy for the v3 envelope architecture against any EVM chain.
 *
 * The v3 envelope additions (TradeValidator typehashes + TradingVault.executeXxxEnvelope)
 * are intra-contract and do NOT introduce new contracts — this script deploys the same
 * core stack (TradeValidator, PolicyEngine, FeeDistributor, VaultFactory, VaultDeployer,
 * VaultShareDeployer, StrategyRegistry) wired the way DeployLocal does, plus a sample
 * TradingVault for testing.
 *
 * Outputs the deployed addresses as JSON to `deployments/{chainId}/v3.json` for
 * the arena (chains.ts) to consume.
 *
 * Usage (real chain):
 *   PRIVATE_KEY=0x... \
 *   ASSET_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
 *   ADMIN=0x... \
 *   SIGNERS=0xaaa,0xbbb,0xccc \
 *     forge script contracts/script/DeployEnvelopeV3.s.sol \
 *       --rpc-url $RPC_URL --broadcast --slow
 *
 * Usage (local Anvil — uses default deployer key, mints MockERC20 USDC):
 *   anvil &
 *   forge script contracts/script/DeployEnvelopeV3.s.sol \
 *     --rpc-url http://127.0.0.1:8545 --broadcast
 *
 * Optional env vars:
 *   SERVICE_ID            — uint64 service id for the sample vault (default: 0)
 *   REQUIRED_SIGS         — m-of-n threshold (default: 2; must satisfy 2/3 supermajority)
 *   MIN_SCORE_THRESHOLD   — minimum average score for envelope approval (default: 50)
 *   VAULT_NAME            — share token name (default: "Envelope V3 Vault Shares")
 *   VAULT_SYMBOL          — share token symbol (default: "ev3SHARE")
 *   WRITE_DEPLOYMENT_JSON — "false" to skip writing deployments/{chainId}/v3.json (default: true)
 *   DEPLOYMENT_JSON_DIR   — override base directory (default: "./deployments")
 *
 * Signer floor: VaultFactory rejects fewer than 3 signers or below ceil(2n/3) requiredSigs
 *               (H-2/H-4 audit fix). Provide at least 3 distinct addresses in SIGNERS.
 */
contract DeployEnvelopeV3 is Script {
    using stdJson for string;

    // Anvil's default deployer key (account 0). Used only when PRIVATE_KEY is unset.
    uint256 internal constant ANVIL_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant ANVIL_SIGNER_ONE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant ANVIL_SIGNER_TWO = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant ANVIL_SIGNER_THREE = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    struct DeploymentResult {
        uint256 chainId;
        address deployer;
        address policyEngine;
        address tradeValidator;
        address feeDistributor;
        address vaultFactory;
        address vaultDeployer;
        address vaultShareDeployer;
        address strategyRegistry;
        address assetToken;
        address sampleVault;
        address sampleShare;
        uint64 sampleServiceId;
        uint256 minScoreThreshold;
        address[] sampleSigners;
        uint256 sampleRequiredSignatures;
    }

    /// @notice Resolved deploy configuration. Either populated from env vars by
    ///         `run()`, or supplied directly by tests via `runWithConfig()` to
    ///         avoid the host-process env race that occurs when multiple
    ///         parallel tests mutate the same `vm.setEnv` keys.
    struct DeployConfig {
        uint256 deployerKey;
        address admin;
        address[] signers;
        uint64 serviceId;
        uint256 requiredSigs;
        uint256 minScoreThreshold;
        address assetTokenOverride; // 0 -> deploy MockERC20
        string vaultName;
        string vaultSymbol;
        bool writeJson;
    }

    function run() external returns (DeploymentResult memory result) {
        return runWithConfig(_loadConfigFromEnv());
    }

    /// @notice Test-friendly entry point — no env reads beyond the supplied config.
    function runWithConfig(DeployConfig memory cfg) public returns (DeploymentResult memory result) {
        // VaultFactory enforces >=3 signers and requiredSigs * 3 >= signers.length * 2
        // (H-2/H-4 audit fix). Surface the same requirements up front for a useful error.
        if (cfg.signers.length < 3) {
            revert("DeployEnvelopeV3: SIGNERS must have at least 3 distinct addresses");
        }
        if (cfg.requiredSigs * 3 < cfg.signers.length * 2) {
            revert("DeployEnvelopeV3: REQUIRED_SIGS must satisfy 2/3 supermajority");
        }
        if (cfg.requiredSigs > cfg.signers.length) {
            revert("DeployEnvelopeV3: REQUIRED_SIGS exceeds signers length");
        }
        for (uint256 i = 0; i < cfg.signers.length; i++) {
            if (cfg.signers[i] == address(0)) {
                revert("DeployEnvelopeV3: signer is zero address");
            }
            for (uint256 j = i + 1; j < cfg.signers.length; j++) {
                if (cfg.signers[i] == cfg.signers[j]) {
                    revert("DeployEnvelopeV3: duplicate signer");
                }
            }
        }
        if (cfg.minScoreThreshold > 100) {
            revert("DeployEnvelopeV3: MIN_SCORE_THRESHOLD must be 0..100");
        }
        address deployer = vm.addr(cfg.deployerKey);

        vm.startBroadcast(cfg.deployerKey);

        // ── Asset token: real ERC20 if provided, else mint a MockERC20 (local). ──
        address assetToken;
        if (cfg.assetTokenOverride != address(0)) {
            assetToken = cfg.assetTokenOverride;
            console.log("Using ASSET_TOKEN:", assetToken);
        } else {
            MockERC20 mock = new MockERC20("USD Coin (Mock)", "USDC", 6);
            assetToken = address(mock);
            mock.mint(deployer, 1_000_000 * 1e6);
            console.log("Deployed Mock USDC:", assetToken);
        }

        // ── Core stack ──
        PolicyEngine policyEngine = new PolicyEngine();
        TradeValidator tradeValidator = new TradeValidator();
        FeeDistributor feeDistributor = new FeeDistributor(deployer);
        VaultFactory vaultFactory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);
        VaultDeployer vaultDeployer =
            new VaultDeployer(address(vaultFactory), policyEngine, tradeValidator, feeDistributor);
        VaultShareDeployer vaultShareDeployer = new VaultShareDeployer(address(vaultFactory));
        vaultFactory.setVaultDeployers(vaultDeployer, vaultShareDeployer);

        policyEngine.transferOwnership(address(vaultFactory));
        tradeValidator.transferOwnership(address(vaultFactory));
        feeDistributor.transferOwnership(address(vaultFactory));
        vaultFactory.acceptDependencyOwnership();

        StrategyRegistry strategyRegistry = new StrategyRegistry(deployer);

        console.log("PolicyEngine:        ", address(policyEngine));
        console.log("TradeValidator:      ", address(tradeValidator));
        console.log("FeeDistributor:      ", address(feeDistributor));
        console.log("VaultFactory:        ", address(vaultFactory));
        console.log("VaultDeployer:       ", address(vaultDeployer));
        console.log("VaultShareDeployer:  ", address(vaultShareDeployer));
        console.log("StrategyRegistry:    ", address(strategyRegistry));

        // ── Sample vault (envelope-ready: m-of-n signers + score threshold). ──
        address[] memory signers = cfg.signers;

        bytes32 salt = keccak256(abi.encodePacked("envelope-v3", uint256(block.chainid), cfg.serviceId, deployer));

        (address sampleVault, address sampleShare) = vaultFactory.createBotVault(
            cfg.serviceId,
            assetToken,
            cfg.admin,
            address(0), // operator — admin can wire later via grantRole
            signers,
            cfg.requiredSigs,
            cfg.vaultName,
            cfg.vaultSymbol,
            salt,
            PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 100, maxSlippageBps: 500}),
            FeeDistributor.FeeConfig({performanceFeeBps: 2000, managementFeeBps: 200, validatorFeeShareBps: 3000})
        );

        // NOTE on min_score_threshold:
        //   After ownership transfer, TradeValidator.owner() == VaultFactory; the
        //   deployer (factory owner) cannot directly call setMinScoreThreshold
        //   without going through a factory passthrough that doesn't currently
        //   exist. The threshold is therefore captured in the deployment JSON
        //   for operators to apply via a follow-up factory upgrade or by
        //   pre-transferring vaultConfigOwner.

        console.log("Sample Vault:        ", sampleVault);
        console.log("Sample Share:        ", sampleShare);

        vm.stopBroadcast();

        result = DeploymentResult({
            chainId: block.chainid,
            deployer: deployer,
            policyEngine: address(policyEngine),
            tradeValidator: address(tradeValidator),
            feeDistributor: address(feeDistributor),
            vaultFactory: address(vaultFactory),
            vaultDeployer: address(vaultDeployer),
            vaultShareDeployer: address(vaultShareDeployer),
            strategyRegistry: address(strategyRegistry),
            assetToken: assetToken,
            sampleVault: sampleVault,
            sampleShare: sampleShare,
            sampleServiceId: cfg.serviceId,
            minScoreThreshold: cfg.minScoreThreshold,
            sampleSigners: signers,
            sampleRequiredSignatures: cfg.requiredSigs
        });

        // ── Persist deployment JSON for arena consumption ──
        if (cfg.writeJson) {
            _writeDeploymentJson(result);
        }

        // ── Summary ──
        console.log("\n=== ENVELOPE V3 DEPLOYMENT SUMMARY ===");
        console.log("Chain ID:            ", block.chainid);
        console.log("Deployer:            ", deployer);
        console.log("Asset Token:         ", assetToken);
        console.log("VaultFactory:        ", address(vaultFactory));
        console.log("TradeValidator:      ", address(tradeValidator));
        console.log("Sample Vault:        ", sampleVault);
        console.log("Service ID:          ", cfg.serviceId);
        console.log("Required Sigs:       ", cfg.requiredSigs);
        console.log("Signers ({n}):       ", cfg.signers.length);
        for (uint256 i = 0; i < cfg.signers.length; i++) {
            console.log("  -", cfg.signers[i]);
        }
        console.log("Min Score Threshold (requested):", cfg.minScoreThreshold);
    }

    function _loadConfigFromEnv() internal returns (DeployConfig memory cfg) {
        cfg.deployerKey = vm.envOr("PRIVATE_KEY", ANVIL_DEPLOYER_KEY);
        address deployer = vm.addr(cfg.deployerKey);

        cfg.serviceId = uint64(vm.envOr("SERVICE_ID", uint256(0)));
        cfg.requiredSigs = vm.envOr("REQUIRED_SIGS", uint256(2));
        cfg.minScoreThreshold = vm.envOr("MIN_SCORE_THRESHOLD", uint256(50));
        cfg.vaultName = vm.envOr("VAULT_NAME", string("Envelope V3 Vault Shares"));
        cfg.vaultSymbol = vm.envOr("VAULT_SYMBOL", string("ev3SHARE"));
        cfg.admin = vm.envOr("ADMIN", deployer);

        // SIGNERS env: comma-separated list of addresses. Falls back to the
        // three Anvil dev keys (accounts 1/2/3) for local-only deploys so the
        // 3-signer floor is satisfied out of the box. Production deploys MUST
        // set SIGNERS explicitly.
        address[] memory defaultSigners = new address[](3);
        defaultSigners[0] = ANVIL_SIGNER_ONE;
        defaultSigners[1] = ANVIL_SIGNER_TWO;
        defaultSigners[2] = ANVIL_SIGNER_THREE;
        cfg.signers = vm.envOr("SIGNERS", ",", defaultSigners);

        cfg.assetTokenOverride = vm.envOr("ASSET_TOKEN", address(0));
        cfg.writeJson = _strEq(vm.envOr("WRITE_DEPLOYMENT_JSON", string("true")), "true");
    }

    function _writeDeploymentJson(DeploymentResult memory r) internal {
        string memory baseDir = vm.envOr("DEPLOYMENT_JSON_DIR", string("./deployments"));
        string memory chainDir = string.concat(baseDir, "/", vm.toString(r.chainId));
        string memory jsonPath = string.concat(chainDir, "/v3.json");

        vm.createDir(chainDir, true);

        string memory key = "envelope-v3";
        vm.serializeUint(key, "chainId", r.chainId);
        vm.serializeAddress(key, "deployer", r.deployer);
        vm.serializeAddress(key, "policyEngine", r.policyEngine);
        vm.serializeAddress(key, "tradeValidator", r.tradeValidator);
        vm.serializeAddress(key, "feeDistributor", r.feeDistributor);
        vm.serializeAddress(key, "vaultFactory", r.vaultFactory);
        vm.serializeAddress(key, "vaultDeployer", r.vaultDeployer);
        vm.serializeAddress(key, "vaultShareDeployer", r.vaultShareDeployer);
        vm.serializeAddress(key, "strategyRegistry", r.strategyRegistry);
        vm.serializeAddress(key, "assetToken", r.assetToken);
        vm.serializeAddress(key, "sampleVault", r.sampleVault);
        vm.serializeAddress(key, "sampleShare", r.sampleShare);
        vm.serializeUint(key, "sampleServiceId", uint256(r.sampleServiceId));
        vm.serializeUint(key, "minScoreThreshold", r.minScoreThreshold);
        vm.serializeUint(key, "sampleRequiredSignatures", r.sampleRequiredSignatures);
        string memory finalJson = vm.serializeAddress(key, "sampleSigners", r.sampleSigners);

        vm.writeFile(jsonPath, finalJson);
        console.log("Wrote deployment JSON:", jsonPath);
    }

    function _strEq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
