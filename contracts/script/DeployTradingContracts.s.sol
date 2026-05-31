// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/VaultFactory.sol";
import "../src/VaultDeployer.sol";
import "../src/VaultShareDeployer.sol";
import "../src/PolicyEngine.sol";
import "../src/TradeValidator.sol";
import "../src/FeeDistributor.sol";
import "../src/TradingVault.sol";
import "../src/ChainlinkUsdValuator.sol";
import "../src/WrappedAssetValuator.sol";
import "../src/interfaces/IAssetValuator.sol";

/// @title DeployTradingContracts
/// @notice DEPLOY-ONLY: brings up the trading vault infrastructure (PolicyEngine,
///         TradeValidator, FeeDistributor, VaultFactory, VaultDeployer,
///         VaultShareDeployer + Chainlink/wrapped valuators) on a real chain.
///
/// @dev This script is the contract-deployment half of RegisterBlueprint.s.sol with
///      the Tangle blueprint-registration half deliberately removed. It deploys the
///      identical core stack and wires it the same way:
///        - valuators            → RegisterBlueprint.s.sol:303-323
///        - core contracts        → RegisterBlueprint.s.sol:332-342
///        - default whitelists    → RegisterBlueprint.s.sol:539-551
///        - dependency ownership  → RegisterBlueprint.s.sol:405-409
///      It does NOT deploy any TradingBlueprint / ValidatorBlueprint BSM and does NOT
///      call Tangle.createBlueprint, so re-running it can never duplicate the live
///      blueprint id 13. There is no `ITangle` import and no broadcast tx targets Tangle.
///
/// Usage (Base Sepolia 84532, once the deployer is funded):
///   PRIVATE_KEY=0x... \
///     forge script contracts/script/DeployTradingContracts.s.sol:DeployTradingContracts \
///       --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
///
/// Optional env vars:
///   FEE_TREASURY          — treasury address for FeeDistributor (default: deployer)
///   WRITE_DEPLOYMENT_JSON — "false" to skip writing deployments/{chainId}/trading-contracts.json (default: true)
///   DEPLOYMENT_JSON_DIR   — override base directory (default: "./deployments")
contract DeployTradingContracts is Script {
    // Anvil's default deployer key (account 0). Used only when PRIVATE_KEY is unset
    // (local dry-run simulations); live deploys always set PRIVATE_KEY.
    uint256 internal constant ANVIL_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // ── Supported chain ids ──────────────────────────────────────────
    uint256 internal constant CHAIN_ID_BASE_SEPOLIA = 84532;

    // ── Base Sepolia (chainId 84532) token set ───────────────────────
    // Mirrors RegisterBlueprint.s.sol:232-234 / 628-634. Only WETH + USDC +
    // the ETH/USD Chainlink feed exist on Base Sepolia; USDC has no Chainlink
    // feed there, and the legacy stable/wrapped tokens are absent.
    address internal constant BASE_SEPOLIA_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant BASE_SEPOLIA_ETH_USD_FEED = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;

    /// @notice Per-chain token + Chainlink feed bundle.
    /// @dev Any address may be `address(0)` to indicate the token / feed is
    ///      unavailable on this network. Callers must skip address(0) entries
    ///      when wiring valuators / whitelists. Mirrors RegisterBlueprint's TokenSet.
    struct TokenSet {
        address weth;
        address usdc;
        address ethUsdFeed;
        address usdcUsdFeed;
    }

    struct DeploymentResult {
        uint256 chainId;
        address deployer;
        address policyEngine;
        address tradeValidator;
        address feeDistributor;
        address vaultFactory;
        address vaultDeployer;
        address vaultShareDeployer;
        address tradingVaultImpl;
        address primaryValuator;
        address wrappedValuator;
        address weth;
        address usdc;
    }

    function run() external {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", ANVIL_DEPLOYER_KEY);
        address deployer = vm.addr(deployerKey);
        address feeTreasury = vm.envOr("FEE_TREASURY", deployer);

        TokenSet memory tokens = _resolveTokenSet();

        vm.startBroadcast(deployerKey);

        // ── Valuators (RegisterBlueprint.s.sol:303-323, existing-assets path) ──
        // Real chain → real ERC20s → Chainlink-backed valuation. Feeds with no
        // Base Sepolia equivalent (USDC/USD) are address(0) and skipped; setFeed
        // reverts on address(0).
        ChainlinkUsdValuator chainlinkValuator = new ChainlinkUsdValuator(deployer);
        _setFeedIfAvailable(chainlinkValuator, tokens.weth, tokens.ethUsdFeed);
        _setFeedIfAvailable(chainlinkValuator, tokens.usdc, tokens.usdcUsdFeed);

        WrappedAssetValuator wrapperValuator = new WrappedAssetValuator(deployer, chainlinkValuator);

        IAssetValuator primaryValuator = chainlinkValuator;
        IAssetValuator wrappedValuator = wrapperValuator;

        // ── Core contracts (RegisterBlueprint.s.sol:332-342) ──────────────────
        PolicyEngine policyEngine = new PolicyEngine();
        TradeValidator tradeValidator = new TradeValidator();
        FeeDistributor feeDistributor = new FeeDistributor(feeTreasury);
        VaultFactory vaultFactory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);
        TradingVault tradingVaultImpl = new TradingVault();
        VaultDeployer vaultDeployer = new VaultDeployer(
            address(vaultFactory), address(tradingVaultImpl), policyEngine, tradeValidator, feeDistributor
        );
        VaultShareDeployer vaultShareDeployer = new VaultShareDeployer(address(vaultFactory));
        vaultFactory.setVaultDeployers(vaultDeployer, vaultShareDeployer);

        // Default whitelist (RegisterBlueprint.s.sol:539-551, existing-assets path):
        // on Base Sepolia this collapses to WETH + USDC.
        vaultFactory.setDefaultWhitelistedToken(tokens.usdc, true);
        vaultFactory.setDefaultWhitelistedToken(tokens.weth, true);

        // Transfer ownership of the three dependency contracts to the factory
        // (RegisterBlueprint.s.sol:405-409). FeeDistributor/PolicyEngine/TradeValidator
        // are Ownable2Step → factory.acceptDependencyOwnership() finalizes the handoff.
        policyEngine.transferOwnership(address(vaultFactory));
        tradeValidator.transferOwnership(address(vaultFactory));
        feeDistributor.transferOwnership(address(vaultFactory));
        vaultFactory.acceptDependencyOwnership();

        vm.stopBroadcast();

        // ── Output ────────────────────────────────────────────────────────────
        DeploymentResult memory r = DeploymentResult({
            chainId: block.chainid,
            deployer: deployer,
            policyEngine: address(policyEngine),
            tradeValidator: address(tradeValidator),
            feeDistributor: address(feeDistributor),
            vaultFactory: address(vaultFactory),
            vaultDeployer: address(vaultDeployer),
            vaultShareDeployer: address(vaultShareDeployer),
            tradingVaultImpl: address(tradingVaultImpl),
            primaryValuator: address(primaryValuator),
            wrappedValuator: address(wrappedValuator),
            weth: tokens.weth,
            usdc: tokens.usdc
        });

        _logResult(r);

        if (_strEq(vm.envOr("WRITE_DEPLOYMENT_JSON", string("true")), "true")) {
            _writeDeploymentJson(r);
        }
    }

    // ───────────────────────── Token set resolution ──────────────────────────

    /// @notice Pick the address bundle for the current chain.
    /// @dev Only Base Sepolia is wired today; any other chain reverts loudly so a
    ///      misconfigured RPC can't silently deploy against zero-address tokens.
    function _resolveTokenSet() internal view returns (TokenSet memory t) {
        uint256 cid = block.chainid;
        if (cid == CHAIN_ID_BASE_SEPOLIA) {
            t.weth = BASE_SEPOLIA_WETH;
            t.usdc = BASE_SEPOLIA_USDC;
            t.ethUsdFeed = BASE_SEPOLIA_ETH_USD_FEED;
            // usdcUsdFeed stays address(0): no Base Sepolia Chainlink USDC/USD feed.
            return t;
        }
        revert(
            string.concat(
                "DeployTradingContracts: unsupported chain (only Base Sepolia 84532 is wired). chainid=",
                vm.toString(cid)
            )
        );
    }

    function _setFeedIfAvailable(ChainlinkUsdValuator valuator, address token, address feed) internal {
        // ChainlinkUsdValuator.setFeed reverts on address(0) — guard here so
        // partial chain coverage (Base Sepolia missing USDC/USD feed) is tolerated.
        if (token == address(0) || feed == address(0)) return;
        valuator.setFeed(token, feed, 1 days);
    }

    function _logResult(DeploymentResult memory r) internal pure {
        console2.log("=== DeployTradingContracts: NO blueprint registration performed ===");
        console2.log("chainId            ", r.chainId);
        console2.log("deployer           ", r.deployer);
        console2.log("policyEngine       ", r.policyEngine);
        console2.log("tradeValidator     ", r.tradeValidator);
        console2.log("feeDistributor     ", r.feeDistributor);
        console2.log("vaultFactory       ", r.vaultFactory);
        console2.log("vaultDeployer      ", r.vaultDeployer);
        console2.log("vaultShareDeployer ", r.vaultShareDeployer);
        console2.log("tradingVaultImpl   ", r.tradingVaultImpl);
        console2.log("primaryValuator    ", r.primaryValuator);
        console2.log("wrappedValuator    ", r.wrappedValuator);
        console2.log("weth               ", r.weth);
        console2.log("usdc               ", r.usdc);
    }

    function _writeDeploymentJson(DeploymentResult memory r) internal {
        string memory baseDir = vm.envOr("DEPLOYMENT_JSON_DIR", string("./deployments"));
        string memory chainDir = string.concat(baseDir, "/", vm.toString(r.chainId));
        string memory jsonPath = string.concat(chainDir, "/trading-contracts.json");

        vm.createDir(chainDir, true);

        string memory key = "trading-contracts";
        vm.serializeUint(key, "chainId", r.chainId);
        vm.serializeAddress(key, "deployer", r.deployer);
        vm.serializeAddress(key, "policyEngine", r.policyEngine);
        vm.serializeAddress(key, "tradeValidator", r.tradeValidator);
        vm.serializeAddress(key, "feeDistributor", r.feeDistributor);
        vm.serializeAddress(key, "vaultFactory", r.vaultFactory);
        vm.serializeAddress(key, "vaultDeployer", r.vaultDeployer);
        vm.serializeAddress(key, "vaultShareDeployer", r.vaultShareDeployer);
        vm.serializeAddress(key, "tradingVaultImpl", r.tradingVaultImpl);
        vm.serializeAddress(key, "primaryValuator", r.primaryValuator);
        vm.serializeAddress(key, "wrappedValuator", r.wrappedValuator);
        vm.serializeAddress(key, "weth", r.weth);
        string memory finalJson = vm.serializeAddress(key, "usdc", r.usdc);

        vm.writeFile(jsonPath, finalJson);
        console2.log("Wrote deployment JSON:", jsonPath);
    }

    function _strEq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
