// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {Types} from "tnt-core/libraries/Types.sol";
import "../src/blueprints/TradingBlueprint.sol";
import "../src/blueprints/ValidatorBlueprint.sol";
import "../src/VaultFactory.sol";
import "../src/VaultDeployer.sol";
import "../src/VaultShareDeployer.sol";
import "../src/PolicyEngine.sol";
import "../src/TradeValidator.sol";
import "../src/FeeDistributor.sol";
import "../src/VaultShare.sol";
import "../src/TradingVault.sol";
import "../src/ChainlinkUsdValuator.sol";
import "../src/WrappedAssetValuator.sol";
import "../src/interfaces/IAssetValuator.sol";
import "../test/helpers/Setup.sol";

/// @notice Minimal tnt-core v0.10 blueprint type surface for local snapshot compatibility.
library TypesV010 {
    enum MembershipModel {
        Fixed,
        Dynamic
    }

    enum PricingModel {
        PayOnce,
        Subscription,
        EventDriven
    }

    struct BlueprintConfig {
        MembershipModel membership;
        PricingModel pricing;
        uint32 minOperators;
        uint32 maxOperators;
        uint256 subscriptionRate;
        uint64 subscriptionInterval;
        uint256 eventRate;
    }

    struct BlueprintMetadata {
        string name;
        string description;
        string author;
        string category;
        string codeRepository;
        string logo;
        string website;
        string license;
        string profilingData;
    }

    struct JobDefinition {
        string name;
        string description;
        string metadataUri;
        bytes paramsSchema;
        bytes resultSchema;
    }

    enum BlueprintSourceKind {
        Container,
        Wasm,
        Native
    }

    enum BlueprintFetcherKind {
        None,
        Ipfs,
        Http,
        Github
    }

    enum WasmRuntime {
        Unknown,
        Wasmtime,
        Wasmer
    }

    struct ImageRegistrySource {
        string registry;
        string image;
        string tag;
    }

    struct WasmSource {
        WasmRuntime runtime;
        BlueprintFetcherKind fetcher;
        string artifactUri;
        string entrypoint;
    }

    struct NativeSource {
        BlueprintFetcherKind fetcher;
        string artifactUri;
        string entrypoint;
    }

    struct TestingSource {
        string cargoPackage;
        string cargoBin;
        string basePath;
    }

    enum BlueprintArchitecture {
        Wasm32,
        Wasm64,
        Wasi32,
        Wasi64,
        Amd32,
        Amd64,
        Arm32,
        Arm64,
        RiscV32,
        RiscV64
    }

    enum BlueprintOperatingSystem {
        Unknown,
        Linux,
        Windows,
        MacOS,
        BSD
    }

    struct BlueprintBinary {
        BlueprintArchitecture arch;
        BlueprintOperatingSystem os;
        string name;
        bytes32 sha256;
    }

    struct BlueprintSource {
        BlueprintSourceKind kind;
        ImageRegistrySource container;
        WasmSource wasm;
        NativeSource native;
        TestingSource testing;
        BlueprintBinary[] binaries;
    }

    struct BlueprintDefinition {
        string metadataUri;
        address manager;
        uint32 masterManagerRevision;
        bool hasConfig;
        BlueprintConfig config;
        BlueprintMetadata metadata;
        JobDefinition[] jobs;
        bytes registrationSchema;
        bytes requestSchema;
        BlueprintSource[] sources;
        MembershipModel[] supportedMemberships;
    }
}

/// @notice Minimal interface for Tangle contract blueprint registration
interface ITangle {
    function createBlueprint(Types.BlueprintDefinition calldata def) external returns (uint64);
    function blueprintCount() external view returns (uint64);
}

interface ITangleV010 {
    function createBlueprint(TypesV010.BlueprintDefinition calldata def) external returns (uint64);
}

/// @title RegisterBlueprint
/// @notice Deploys Arena contracts and registers the blueprint on Tangle.
/// @dev Run via: forge script contracts/script/RegisterBlueprint.s.sol --rpc-url $RPC_URL --broadcast --slow
///
///      This script handles the complex struct encoding for createBlueprint().
///      Anvil impersonation steps (setVaultFactory, onOperatorJoined) and service
///      lifecycle (requestService, approveService) are handled by the bash wrapper.
contract RegisterBlueprint is Script {
    event log_string(string value);

    // Anvil well-known keys (fallback for local-only flows that don't set PRIVATE_KEY).
    // For live networks the wrapper sets PRIVATE_KEY and we honour it instead — see
    // _resolveDeployerKey() below. Hardcoding the anvil key into vm.startBroadcast
    // would override the deployer that funded the broadcast, sending every tx from
    // an unfunded address and tripping the RPC's eth_estimateGas pre-flight.
    uint256 constant ANVIL_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // Tangle protocol address default (deterministic from Anvil state snapshot).
    // Overridable per-network via the `TANGLE_CORE` env var (the bash wrapper /
    // base-sepolia env loader sets this to the live Base Sepolia Tangle proxy).
    address constant TANGLE_LOCAL_DEFAULT = 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9;

    // Test accounts
    address constant USER_ACCOUNT = 0x68FF20459d48917748CA13afCbDA3B265a449D48;
    address constant OPERATOR1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant OPERATOR2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    // ── Supported chain ids ──────────────────────────────────────────
    uint256 constant CHAIN_ID_LOCAL = 31337;
    uint256 constant CHAIN_ID_LOCAL_TESTNET = 31338; // anvil w/ Tangle snapshot
    uint256 constant CHAIN_ID_BASE_SEPOLIA = 84532;
    uint256 constant CHAIN_ID_MAINNET = 1;

    // ── Ethereum mainnet token + Chainlink USD feeds ─────────────────
    // Retained only for completeness — RegisterBlueprint targets local +
    // Base Sepolia. Mainnet entries are surfaced via `_mainnetTokens()` if
    // someone explicitly opts in by running against chainId 1.
    address constant MAINNET_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant MAINNET_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant MAINNET_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant MAINNET_DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant MAINNET_WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address constant AAVE_AWETH = 0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8;
    address constant AAVE_AUSDC = 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c;
    address constant AAVE_ADAI = 0x018008bfb33d285247A21d44E50697654f754e63;

    address constant ETH_USD_FEED = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;
    address constant USDC_USD_FEED = 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6;
    address constant USDT_USD_FEED = 0x3E7d1eAB13ad0104d2750B8863b489D65364e32D;
    address constant DAI_USD_FEED = 0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9;
    address constant BTC_USD_FEED = 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c;

    // ── Base Sepolia (chainId 84532) ────────────────────────────────
    // WETH is the canonical Base predeploy (also live on Base Sepolia).
    // USDC is Circle's official Base Sepolia testnet USDC.
    // ETH/USD feed comes from the Chainlink Base Sepolia feed list.
    // USDC/USD has no Base Sepolia Chainlink feed today — set to address(0)
    // and skip valuator registration on this chain; the BSM does not gate
    // blueprint creation on token validity.
    // Tokens with no Base Sepolia equivalent (USDT, DAI, WBTC, aWETH, aUSDC,
    // aDAI) are set to address(0) and structurally excluded from whitelists +
    // valuator wiring on chainId 84532.
    address constant BASE_SEPOLIA_WETH = 0x4200000000000000000000000000000000000006;
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant BASE_SEPOLIA_ETH_USD_FEED = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;

    /// @notice Per-chain token + Chainlink feed bundle.
    /// @dev Any address may be `address(0)` to indicate the token / feed is
    ///      unavailable on this network. Callers must skip address(0) entries
    ///      when wiring valuators / whitelists.
    struct TokenSet {
        address weth;
        address usdc;
        address usdt;
        address dai;
        address wbtc;
        address aWeth;
        address aUsdc;
        address aDai;
        address ethUsdFeed;
        address usdcUsdFeed;
        address usdtUsdFeed;
        address daiUsdFeed;
        address btcUsdFeed;
    }

    function run() external {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", ANVIL_DEPLOYER_KEY);
        address deployer = vm.addr(deployerKey);

        // Tangle protocol address is env-overridable so the same script can
        // target local Anvil (default) or any deployed network (Base Sepolia,
        // mainnet, etc.). The bash wrappers export TANGLE_CORE; if absent we
        // fall back to the Anvil-snapshot deterministic address.
        address tangleAddr = vm.envOr("TANGLE_CORE", TANGLE_LOCAL_DEFAULT);
        ITangle tangle = ITangle(tangleAddr);

        // Pick the per-chain token / feed set. block.chainid is the source of
        // truth — `TARGET_NETWORK` env var overrides only when explicitly set
        // (e.g. dry-run simulations on a different chain).
        TokenSet memory tokens = _resolveTokenSet();

        vm.startBroadcast(deployerKey);

        // ── Deploy Multicall3 (required by viem) ──────────────────────
        // Deploy to temp address then copy code to canonical address
        address mc3Canonical = 0xcA11bde05977b3631167028862bE2a173976CA11;
        if (mc3Canonical.code.length == 0) {
            // Inline minimal Multicall3 is complex; the bash wrapper handles
            // Multicall3 deployment separately if needed. Skip here.
        }

        // ── Resolve Trading Assets ────────────────────────────────────
        address existingUsdc = vm.envOr("EXISTING_USDC_ADDRESS", address(0));
        address existingWeth = vm.envOr("EXISTING_WETH_ADDRESS", address(0));
        bool usingExistingAssets = existingUsdc != address(0) || existingWeth != address(0);

        if (usingExistingAssets && (existingUsdc == address(0) || existingWeth == address(0))) {
            revert("Both EXISTING_USDC_ADDRESS and EXISTING_WETH_ADDRESS are required");
        }

        address usdcAddress;
        address wethAddress;
        if (usingExistingAssets) {
            usdcAddress = existingUsdc;
            wethAddress = existingWeth;
        } else {
            MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
            MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
            usdcAddress = address(usdc);
            wethAddress = address(weth);
        }

        IAssetValuator primaryValuator;
        IAssetValuator wrappedValuator;
        if (usingExistingAssets) {
            ChainlinkUsdValuator chainlinkValuator = new ChainlinkUsdValuator(deployer);
            // Only register feeds whose token AND feed address are non-zero on
            // this chain. ChainlinkUsdValuator.setFeed reverts on address(0),
            // so Base Sepolia's missing USDC/USD + missing USDT/DAI/WBTC are
            // simply skipped.
            _setFeedIfAvailable(chainlinkValuator, tokens.weth, tokens.ethUsdFeed);
            _setFeedIfAvailable(chainlinkValuator, tokens.usdc, tokens.usdcUsdFeed);
            _setFeedIfAvailable(chainlinkValuator, tokens.usdt, tokens.usdtUsdFeed);
            _setFeedIfAvailable(chainlinkValuator, tokens.dai, tokens.daiUsdFeed);
            _setFeedIfAvailable(chainlinkValuator, tokens.wbtc, tokens.btcUsdFeed);

            WrappedAssetValuator wrapperValuator = new WrappedAssetValuator(deployer, chainlinkValuator);
            _setUnderlyingIfAvailable(wrapperValuator, tokens.aWeth, tokens.weth);
            _setUnderlyingIfAvailable(wrapperValuator, tokens.aUsdc, tokens.usdc);
            _setUnderlyingIfAvailable(wrapperValuator, tokens.aDai, tokens.dai);

            primaryValuator = chainlinkValuator;
            wrappedValuator = wrapperValuator;
        } else {
            MockAssetValuator mockValuator = new MockAssetValuator();
            mockValuator.setRate(wethAddress, usdcAddress, 2000 * 1e6);
            mockValuator.setRate(usdcAddress, wethAddress, 5e26);
            primaryValuator = mockValuator;
            wrappedValuator = mockValuator;
        }

        // ── Deploy Core Contracts ─────────────────────────────────────
        PolicyEngine policyEngine = new PolicyEngine();
        TradeValidator tradeValidator = new TradeValidator();
        FeeDistributor feeDistributor = new FeeDistributor(deployer);
        VaultFactory vaultFactory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);
        VaultDeployer vaultDeployer = new VaultDeployer(
            address(vaultFactory), address(new TradingVault()), policyEngine, tradeValidator, feeDistributor
        );
        VaultShareDeployer vaultShareDeployer = new VaultShareDeployer(address(vaultFactory));
        vaultFactory.setVaultDeployers(vaultDeployer, vaultShareDeployer);
        _configureDefaultWhitelists(vaultFactory, usingExistingAssets, usdcAddress, wethAddress, tokens);

        // ── Deploy BSMs ───────────────────────────────────────────────
        // Each variant needs its own BSM instance because onBlueprintCreated
        // can only be called once per contract (sets Tangle address).
        TradingBlueprint bsm = new TradingBlueprint();
        TradingBlueprint instanceBsm = new TradingBlueprint();
        TradingBlueprint teeBsm = new TradingBlueprint();
        ValidatorBlueprint validatorBsm = new ValidatorBlueprint();

        // ── Fund Test Accounts ────────────────────────────────────────
        // Only on local Anvil — funding hardcoded test accounts on a live
        // chain (Base Sepolia, mainnet, …) would either burn real funds or
        // OOG before completing the deploy.
        if (_isLocalChain()) {
            payable(USER_ACCOUNT).transfer(100 ether);
            if (!usingExistingAssets) {
                MockERC20(usdcAddress).mint(USER_ACCOUNT, 1_000_000 * 1e6);
                MockERC20(wethAddress).mint(USER_ACCOUNT, 100 ether);
                MockERC20(usdcAddress).mint(deployer, 1_000_000 * 1e6);
                MockERC20(wethAddress).mint(deployer, 100 ether);
            }
        }

        // Fund extra accounts if provided via EXTRA_ACCOUNTS env var
        string memory extraStr = vm.envOr("EXTRA_ACCOUNTS", string(""));
        if (bytes(extraStr).length > 0) {
            // Extra accounts handled by bash wrapper (complex parsing)
        }

        bool precreateSingletonVaults = vm.envOr("PRECREATE_SINGLETON_VAULTS", false);
        address instanceSingletonVault = address(0);
        address teeSingletonVault = address(0);
        if (precreateSingletonVaults) {
            address singletonAsset = vm.envOr("ASSET_TOKEN_ADDRESS", usdcAddress);
            instanceSingletonVault = _createPrecreatedSingletonVault(
                singletonAsset,
                deployer,
                "Instance Vault",
                "iVAULT",
                policyEngine,
                tradeValidator,
                feeDistributor,
                usingExistingAssets,
                primaryValuator,
                wrappedValuator,
                tokens
            );
            teeSingletonVault = _createPrecreatedSingletonVault(
                singletonAsset,
                deployer,
                "TEE Vault",
                "tVAULT",
                policyEngine,
                tradeValidator,
                feeDistributor,
                usingExistingAssets,
                primaryValuator,
                wrappedValuator,
                tokens
            );
        }

        // Transfer ownership of PolicyEngine + TradeValidator + FeeDistributor to VaultFactory
        policyEngine.transferOwnership(address(vaultFactory));
        tradeValidator.transferOwnership(address(vaultFactory));
        feeDistributor.transferOwnership(address(vaultFactory));
        vaultFactory.acceptDependencyOwnership();

        // ── Register Blueprints on Tangle ─────────────────────────────
        // All three variants share the same BSM logic. Cloud exposes lifecycle
        // as jobs, while instance/TEE variants expose only state-changing bot jobs.

        // 1. Cloud (multi-bot fleet)
        uint64 cloudId = _createBlueprint(
            tangle,
            _buildDefinition(
                address(bsm),
                "AI Trading Cloud",
                "Multi-bot fleet: deploy multiple trading bots per service",
                "trading-blueprint-bin",
                "trading-blueprint",
                false
            )
        );

        // 2. Instance (single-bot per service)
        uint64 instanceId = _createBlueprint(
            tangle,
            _buildDefinition(
                address(instanceBsm),
                "AI Trading Instance",
                "Single dedicated bot per service: one agent, one strategy",
                "trading-instance-blueprint-bin",
                "trading-instance-blueprint",
                true
            )
        );

        // 3. TEE Instance (hardware-isolated single-bot)
        uint64 teeId = _createBlueprint(
            tangle,
            _buildDefinition(
                address(teeBsm),
                "AI Trading TEE Instance",
                "TEE-secured single bot: hardware-isolated execution",
                "trading-tee-instance-blueprint-bin",
                "trading-tee-instance-blueprint",
                true
            )
        );

        // 4. Validator (shared trade validation network)
        uint64 validatorId = _createBlueprint(tangle, _buildValidatorDefinition(address(validatorBsm)));

        vm.stopBroadcast();

        // ── Output Addresses (parsed by bash wrapper) ─────────────────
        emit log_string(string.concat("DEPLOY_BSM=", vm.toString(address(bsm))));
        emit log_string(string.concat("DEPLOY_INSTANCE_BSM=", vm.toString(address(instanceBsm))));
        emit log_string(string.concat("DEPLOY_TEE_BSM=", vm.toString(address(teeBsm))));
        emit log_string(string.concat("DEPLOY_VAULT_FACTORY=", vm.toString(address(vaultFactory))));
        emit log_string(string.concat("DEPLOY_USDC=", vm.toString(usdcAddress)));
        emit log_string(string.concat("DEPLOY_WETH=", vm.toString(wethAddress)));
        emit log_string(string.concat("DEPLOY_PRIMARY_VALUATOR=", vm.toString(address(primaryValuator))));
        emit log_string(string.concat("DEPLOY_WRAPPED_VALUATOR=", vm.toString(address(wrappedValuator))));
        emit log_string(string.concat("DEPLOY_POLICY_ENGINE=", vm.toString(address(policyEngine))));
        emit log_string(string.concat("DEPLOY_TRADE_VALIDATOR=", vm.toString(address(tradeValidator))));
        emit log_string(string.concat("DEPLOY_FEE_DISTRIBUTOR=", vm.toString(address(feeDistributor))));
        emit log_string(string.concat("DEPLOY_VALIDATOR_BSM=", vm.toString(address(validatorBsm))));
        emit log_string(string.concat("DEPLOY_BLUEPRINT_ID=", vm.toString(cloudId)));
        emit log_string(string.concat("DEPLOY_INSTANCE_BLUEPRINT_ID=", vm.toString(instanceId)));
        emit log_string(string.concat("DEPLOY_TEE_BLUEPRINT_ID=", vm.toString(teeId)));
        emit log_string(string.concat("DEPLOY_VALIDATOR_BLUEPRINT_ID=", vm.toString(validatorId)));
        if (instanceSingletonVault != address(0)) {
            emit log_string(string.concat("DEPLOY_INSTANCE_SINGLETON_VAULT=", vm.toString(instanceSingletonVault)));
        }
        if (teeSingletonVault != address(0)) {
            emit log_string(string.concat("DEPLOY_TEE_SINGLETON_VAULT=", vm.toString(teeSingletonVault)));
        }
    }

    function _createPrecreatedSingletonVault(
        address assetToken,
        address admin,
        string memory vaultName,
        string memory vaultSymbol,
        PolicyEngine policyEngine,
        TradeValidator tradeValidator,
        FeeDistributor feeDistributor,
        bool usingExistingAssets,
        IAssetValuator primaryValuator,
        IAssetValuator wrappedValuator,
        TokenSet memory tokens
    ) internal returns (address vaultAddress) {
        address[] memory signers = new address[](2);
        signers[0] = OPERATOR1;
        signers[1] = OPERATOR2;

        VaultShare share = new VaultShare(vaultName, vaultSymbol, admin);
        TradingVault vault = new TradingVault();
        vault.initialize(assetToken, share, policyEngine, tradeValidator, feeDistributor, admin, address(0));

        share.grantRole(share.MINTER_ROLE(), address(vault));
        share.linkVault(address(vault));

        tradeValidator.configureVault(address(vault), signers, 1);
        policyEngine.initializeVault(
            address(vault),
            admin,
            PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 100, maxSlippageBps: 500})
        );
        policyEngine.setAuthorizedCaller(address(vault), true);
        policyEngine.whitelistToken(address(vault), assetToken, true);
        _configureVaultWhitelistsAndAdapters(
            address(vault), policyEngine, usingExistingAssets, primaryValuator, wrappedValuator, assetToken, tokens
        );
        feeDistributor.initializeVaultFees(
            address(vault),
            admin,
            FeeDistributor.FeeConfig({performanceFeeBps: 2000, managementFeeBps: 200, validatorFeeShareBps: 3000})
        );

        vault.grantRole(keccak256("OPERATOR_ROLE"), OPERATOR1);
        vault.grantRole(keccak256("OPERATOR_ROLE"), OPERATOR2);
        vault.grantRole(keccak256("CREATOR_ROLE"), admin);

        return address(vault);
    }

    function _configureDefaultWhitelists(
        VaultFactory vaultFactory,
        bool usingExistingAssets,
        address usdcAddress,
        address wethAddress,
        TokenSet memory tokens
    ) internal {
        vaultFactory.setDefaultWhitelistedToken(usdcAddress, true);
        vaultFactory.setDefaultWhitelistedToken(wethAddress, true);
        if (usingExistingAssets) {
            // Skip any token absent on the current chain (address(0)). On
            // Base Sepolia this collapses the set to just WETH + USDC.
            _whitelistIfAvailable(vaultFactory, tokens.usdt);
            _whitelistIfAvailable(vaultFactory, tokens.dai);
            _whitelistIfAvailable(vaultFactory, tokens.wbtc);
            _whitelistIfAvailable(vaultFactory, tokens.aWeth);
            _whitelistIfAvailable(vaultFactory, tokens.aUsdc);
            _whitelistIfAvailable(vaultFactory, tokens.aDai);
        }
    }

    function _configureVaultWhitelistsAndAdapters(
        address vaultAddress,
        PolicyEngine policyEngine,
        bool usingExistingAssets,
        IAssetValuator primaryValuator,
        IAssetValuator wrappedValuator,
        address assetToken,
        TokenSet memory tokens
    ) internal {
        TradingVault vault = TradingVault(payable(vaultAddress));
        if (usingExistingAssets) {
            address[5] memory primaries = [tokens.weth, tokens.usdc, tokens.usdt, tokens.dai, tokens.wbtc];
            for (uint256 i = 0; i < primaries.length; i++) {
                if (primaries[i] == address(0)) continue;
                policyEngine.whitelistToken(vaultAddress, primaries[i], true);
                vault.setValuationAdapter(primaries[i], address(primaryValuator));
            }
            address[3] memory wrappers = [tokens.aWeth, tokens.aUsdc, tokens.aDai];
            for (uint256 i = 0; i < wrappers.length; i++) {
                if (wrappers[i] == address(0)) continue;
                policyEngine.whitelistToken(vaultAddress, wrappers[i], true);
                vault.setValuationAdapter(wrappers[i], address(wrappedValuator));
            }
        } else {
            vault.setValuationAdapter(assetToken, address(primaryValuator));
        }
    }

    // ───────────────────────── Token set resolution ──────────────────────────

    /// @notice Pick the address bundle for the current chain.
    /// @dev `TARGET_NETWORK` env var (values: "local", "base-sepolia",
    ///      "mainnet") overrides block.chainid for simulations on a different
    ///      chain. Default: select by block.chainid; revert on unknown chain.
    function _resolveTokenSet() internal view returns (TokenSet memory) {
        string memory override_ = vm.envOr("TARGET_NETWORK", string(""));
        if (bytes(override_).length > 0) {
            bytes32 h = keccak256(bytes(override_));
            if (h == keccak256("local") || h == keccak256("local-testnet")) {
                return _localTokens();
            }
            if (h == keccak256("base-sepolia")) {
                return _sepoliaTokens();
            }
            if (h == keccak256("mainnet")) {
                return _mainnetTokens();
            }
            revert(string.concat("RegisterBlueprint: unknown TARGET_NETWORK=", override_));
        }

        uint256 cid = block.chainid;
        if (cid == CHAIN_ID_LOCAL || cid == CHAIN_ID_LOCAL_TESTNET) return _localTokens();
        if (cid == CHAIN_ID_BASE_SEPOLIA) return _sepoliaTokens();
        if (cid == CHAIN_ID_MAINNET) return _mainnetTokens();
        revert(
            string.concat(
                "RegisterBlueprint: unsupported chain. Set TARGET_NETWORK=local|base-sepolia|mainnet. chainid=",
                vm.toString(cid)
            )
        );
    }

    /// @dev Local Anvil flow uses freshly minted MockERC20s, so this set is
    ///      structurally empty — the address(0) sentinels signal "skip" to
    ///      every downstream wiring helper. Identical behaviour to the
    ///      pre-refactor `!usingExistingAssets` path.
    function _localTokens() internal pure returns (TokenSet memory t) {
        // All fields default to address(0). Returning the zeroed struct keeps
        // existing anvil flows unchanged (MockERC20 mint path is taken).
    }

    /// @dev Base Sepolia (chainId 84532). Subset of mainnet tokens — only
    ///      WETH + USDC + the ETH/USD Chainlink feed are populated. USDC has
    ///      no Chainlink feed on Base Sepolia, and the legacy stable / wrapped
    ///      tokens (USDT, DAI, WBTC, aWETH, aUSDC, aDAI) don't exist there.
    function _sepoliaTokens() internal pure returns (TokenSet memory t) {
        t.weth = BASE_SEPOLIA_WETH;
        t.usdc = BASE_SEPOLIA_USDC;
        t.ethUsdFeed = BASE_SEPOLIA_ETH_USD_FEED;
        // usdt, dai, wbtc, aWeth, aUsdc, aDai, usdcUsdFeed, usdtUsdFeed,
        // daiUsdFeed, btcUsdFeed all remain address(0) (default).
    }

    /// @dev Ethereum mainnet. Original constant set, kept for parity if the
    ///      script is ever pointed at a mainnet fork. Not exercised by CI.
    function _mainnetTokens() internal pure returns (TokenSet memory t) {
        t.weth = MAINNET_WETH;
        t.usdc = MAINNET_USDC;
        t.usdt = MAINNET_USDT;
        t.dai = MAINNET_DAI;
        t.wbtc = MAINNET_WBTC;
        t.aWeth = AAVE_AWETH;
        t.aUsdc = AAVE_AUSDC;
        t.aDai = AAVE_ADAI;
        t.ethUsdFeed = ETH_USD_FEED;
        t.usdcUsdFeed = USDC_USD_FEED;
        t.usdtUsdFeed = USDT_USD_FEED;
        t.daiUsdFeed = DAI_USD_FEED;
        t.btcUsdFeed = BTC_USD_FEED;
    }

    function _setFeedIfAvailable(ChainlinkUsdValuator valuator, address token, address feed) internal {
        // ChainlinkUsdValuator.setFeed reverts on address(0) — guard here so
        // partial chain coverage (e.g. Base Sepolia missing USDC/USD feed) is
        // tolerated without reverting the deploy.
        if (token == address(0) || feed == address(0)) return;
        valuator.setFeed(token, feed, 1 days);
    }

    function _setUnderlyingIfAvailable(WrappedAssetValuator valuator, address wrapper, address underlying) internal {
        if (wrapper == address(0) || underlying == address(0)) return;
        valuator.setUnderlying(wrapper, underlying);
    }

    function _whitelistIfAvailable(VaultFactory vaultFactory, address token) internal {
        if (token == address(0)) return;
        vaultFactory.setDefaultWhitelistedToken(token, true);
    }

    function _createBlueprint(ITangle tangle, Types.BlueprintDefinition memory def) internal returns (uint64) {
        // The canonical local anvil snapshot ships the current tnt-core (0.13.0)
        // Tangle, which routes createBlueprint(Types.BlueprintDefinition). Forcing
        // the legacy V010 ABI here reverts with UnknownSelector against that
        // snapshot. Older V010 snapshots opt in explicitly with
        // TANGLE_BLUEPRINT_ABI=v010 rather than gating on chain id.
        if (_useV010Abi()) {
            return ITangleV010(address(tangle)).createBlueprint(_toV010Definition(def));
        }
        return tangle.createBlueprint(def);
    }

    function _useV010Abi() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("TANGLE_BLUEPRINT_ABI", string("")))) == keccak256(bytes("v010"));
    }

    function _toV010Definition(Types.BlueprintDefinition memory def)
        internal
        pure
        returns (TypesV010.BlueprintDefinition memory v010)
    {
        v010.metadataUri = def.metadataUri;
        v010.manager = def.manager;
        v010.masterManagerRevision = def.masterManagerRevision;
        v010.hasConfig = def.hasConfig;
        v010.config = TypesV010.BlueprintConfig({
            membership: TypesV010.MembershipModel(uint8(def.config.membership)),
            pricing: TypesV010.PricingModel(uint8(def.config.pricing)),
            minOperators: def.config.minOperators,
            maxOperators: def.config.maxOperators,
            subscriptionRate: def.config.subscriptionRate,
            subscriptionInterval: def.config.subscriptionInterval,
            eventRate: def.config.eventRate
        });
        v010.metadata = TypesV010.BlueprintMetadata({
            name: def.metadata.name,
            description: def.metadata.description,
            author: def.metadata.author,
            category: def.metadata.category,
            codeRepository: def.metadata.codeRepository,
            logo: def.metadata.logo,
            website: def.metadata.website,
            license: def.metadata.license,
            profilingData: def.metadata.profilingData
        });

        v010.jobs = new TypesV010.JobDefinition[](def.jobs.length);
        for (uint256 i = 0; i < def.jobs.length; i++) {
            v010.jobs[i] = TypesV010.JobDefinition({
                name: def.jobs[i].name,
                description: def.jobs[i].description,
                metadataUri: def.jobs[i].metadataUri,
                paramsSchema: def.jobs[i].paramsSchema,
                resultSchema: def.jobs[i].resultSchema
            });
        }

        v010.registrationSchema = def.registrationSchema;
        v010.requestSchema = def.requestSchema;
        v010.sources = new TypesV010.BlueprintSource[](def.sources.length);
        for (uint256 i = 0; i < def.sources.length; i++) {
            Types.BlueprintSource memory source = def.sources[i];
            TypesV010.BlueprintBinary[] memory bins = new TypesV010.BlueprintBinary[](source.binaries.length);
            for (uint256 j = 0; j < source.binaries.length; j++) {
                bins[j] = TypesV010.BlueprintBinary({
                    arch: TypesV010.BlueprintArchitecture(uint8(source.binaries[j].arch)),
                    os: TypesV010.BlueprintOperatingSystem(uint8(source.binaries[j].os)),
                    name: source.binaries[j].name,
                    sha256: source.binaries[j].sha256
                });
            }
            v010.sources[i] = TypesV010.BlueprintSource({
                kind: TypesV010.BlueprintSourceKind(uint8(source.kind)),
                container: TypesV010.ImageRegistrySource({
                    registry: source.container.registry, image: source.container.image, tag: source.container.tag
                }),
                wasm: TypesV010.WasmSource({
                    runtime: TypesV010.WasmRuntime(uint8(source.wasm.runtime)),
                    fetcher: TypesV010.BlueprintFetcherKind(uint8(source.wasm.fetcher)),
                    artifactUri: source.wasm.artifactUri,
                    entrypoint: source.wasm.entrypoint
                }),
                native: TypesV010.NativeSource({
                    fetcher: TypesV010.BlueprintFetcherKind(uint8(source.native.fetcher)),
                    artifactUri: source.native.artifactUri,
                    entrypoint: source.native.entrypoint
                }),
                testing: TypesV010.TestingSource({
                    cargoPackage: source.testing.cargoPackage,
                    cargoBin: source.testing.cargoBin,
                    basePath: source.testing.basePath
                }),
                binaries: bins
            });
        }

        v010.supportedMemberships = new TypesV010.MembershipModel[](def.supportedMemberships.length);
        for (uint256 i = 0; i < def.supportedMemberships.length; i++) {
            v010.supportedMemberships[i] = TypesV010.MembershipModel(uint8(def.supportedMemberships[i]));
        }
    }

    /// @notice True only when the script is running against a local Anvil
    ///         chain (31337/31338 or TARGET_NETWORK=local). Used to gate
    ///         test-account funding so live deploys don't burn real ETH.
    function _isLocalChain() internal view returns (bool) {
        string memory override_ = vm.envOr("TARGET_NETWORK", string(""));
        if (bytes(override_).length > 0) {
            bytes32 h = keccak256(bytes(override_));
            return h == keccak256("local") || h == keccak256("local-testnet");
        }
        uint256 cid = block.chainid;
        return cid == CHAIN_ID_LOCAL || cid == CHAIN_ID_LOCAL_TESTNET;
    }

    /// @notice Construct a BlueprintDefinition for a specific variant.
    /// @param manager BSM contract address (shared across all variants)
    /// @param bpName Human-readable name for the blueprint
    /// @param bpDescription Description of this variant
    /// @param crateName Rust crate name (e.g. "trading-blueprint-bin")
    /// @param binaryName Binary name (e.g. "trading-blueprint")
    /// @param instanceVariant True for instance/TEE variants that do not expose lifecycle jobs.
    function _buildDefinition(
        address manager,
        string memory bpName,
        string memory bpDescription,
        string memory crateName,
        string memory binaryName,
        bool instanceVariant
    ) internal view returns (Types.BlueprintDefinition memory def) {
        def.metadataUri = "ipfs://QmTradingBlueprint";
        string memory salt = vm.envOr("LOCAL_BLUEPRINT_SALT", string(""));
        def.metadataHash = bytes(salt).length == 0
            ? keccak256(abi.encodePacked("ai-trading-blueprint:", bpName, ":", binaryName))
            : keccak256(abi.encodePacked("ai-trading-blueprint:", salt, ":", bpName, ":", binaryName));
        def.manager = manager;
        def.masterManagerRevision = 0;
        def.hasConfig = true;

        // Config
        def.config = Types.BlueprintConfig({
            membership: Types.MembershipModel.Fixed,
            pricing: Types.PricingModel.Subscription,
            minOperators: 1,
            maxOperators: 10,
            subscriptionRate: 1_000_000_000, // 1 USD per interval (10^9 scale)
            subscriptionInterval: 86400, // daily billing
            eventRate: 100_000_000 // 0.1 USD per job event
        });

        // Metadata
        def.metadata = Types.BlueprintMetadata({
            name: bpName,
            description: bpDescription,
            author: "Tangle",
            category: "Trading",
            codeRepository: "https://github.com/tangle-network/ai-trading-blueprints",
            logo: "",
            website: "https://tangle.network",
            license: "MIT",
            profilingData: ""
        });

        if (instanceVariant) {
            // Instance/TEE variants: lifecycle is service-level + operator API, not submitJob.
            def.jobs = new Types.JobDefinition[](5);
            def.jobs[0] = Types.JobDefinition("configure", "Reconfigure bot strategy", "", "", "");
            def.jobs[1] = Types.JobDefinition("start_trading", "Start trading loop", "", "", "");
            def.jobs[2] = Types.JobDefinition("stop_trading", "Stop trading loop", "", "", "");
            def.jobs[3] = Types.JobDefinition("status", "Query bot status", "", "", "");
            def.jobs[4] = Types.JobDefinition("extend", "Extend bot lifetime", "", "", "");
        } else {
            // Cloud fleet variant: lifecycle remains on-chain jobs.
            def.jobs = new Types.JobDefinition[](7);
            def.jobs[0] = Types.JobDefinition("provision", "Provision a new trading bot", "", "", "");
            def.jobs[1] = Types.JobDefinition("configure", "Reconfigure bot strategy", "", "", "");
            def.jobs[2] = Types.JobDefinition("start_trading", "Start trading loop", "", "", "");
            def.jobs[3] = Types.JobDefinition("stop_trading", "Stop trading loop", "", "", "");
            def.jobs[4] = Types.JobDefinition("status", "Query bot status", "", "", "");
            def.jobs[5] = Types.JobDefinition("deprovision", "Deprovision bot", "", "", "");
            def.jobs[6] = Types.JobDefinition("extend", "Extend bot lifetime", "", "", "");
        }

        // Schemas (empty = no validation, any input accepted)
        def.registrationSchema = "";
        def.requestSchema = "";

        // Source (Native binary — differs per variant)
        def.sources = _buildSources(crateName, binaryName);

        // Supported memberships
        def.supportedMemberships = new Types.MembershipModel[](1);
        def.supportedMemberships[0] = Types.MembershipModel.Fixed;
    }

    /// @notice Construct the BlueprintDefinition for the validator blueprint.
    /// @dev Separate from trading variants: different BSM, different jobs (3 vs 7).
    function _buildValidatorDefinition(address manager) internal view returns (Types.BlueprintDefinition memory def) {
        def.metadataUri = "ipfs://QmValidatorBlueprint";
        string memory salt = vm.envOr("LOCAL_BLUEPRINT_SALT", string(""));
        def.metadataHash = bytes(salt).length == 0
            ? keccak256("ai-trading-blueprint:validator:trading-validator")
            : keccak256(abi.encodePacked("ai-trading-blueprint:", salt, ":validator:trading-validator"));
        def.manager = manager;
        def.masterManagerRevision = 0;
        def.hasConfig = true;

        def.config = Types.BlueprintConfig({
            membership: Types.MembershipModel.Fixed,
            pricing: Types.PricingModel.PayOnce,
            minOperators: 1,
            maxOperators: 50,
            subscriptionRate: 0,
            subscriptionInterval: 0,
            eventRate: 0
        });

        def.metadata = Types.BlueprintMetadata({
            name: "AI Trading Validator",
            description: "Trade validation network: AI scoring + EIP-712 signing",
            author: "Tangle",
            category: "Trading",
            codeRepository: "https://github.com/tangle-network/ai-trading-blueprints",
            logo: "",
            website: "https://tangle.network",
            license: "MIT",
            profilingData: ""
        });

        // 3 operational jobs
        def.jobs = new Types.JobDefinition[](3);
        def.jobs[0] =
            Types.JobDefinition("update_reputation", "Record validation count and reputation delta", "", "", "");
        def.jobs[1] = Types.JobDefinition("update_config", "Update validator configuration", "", "", "");
        def.jobs[2] = Types.JobDefinition("liveness", "Heartbeat liveness proof", "", "", "");

        def.registrationSchema = "";
        def.requestSchema = "";

        def.sources = _buildSources("trading-validator-bin", "trading-validator");

        def.supportedMemberships = new Types.MembershipModel[](1);
        def.supportedMemberships[0] = Types.MembershipModel.Fixed;
    }

    /// @notice Build the blueprint's binary sources.
    /// @dev Two modes:
    ///      - RELEASE_TAG set (live networks): a Native/Http source pointing at
    ///        this repo's GitHub release for that tag, with the EXTRACTED
    ///        binary sha256 from `<BINARY>_SHA256` env (the release's
    ///        `.bin.sha256` asset). The stock blueprint-manager downloads,
    ///        unpacks, and sha256-verifies — no source build. Mirrors
    ///        deploy/publish-blueprint-sources.sh, which is the post-release
    ///        update path for already-registered blueprints.
    ///      - RELEASE_TAG unset (local devnet): a fetcher-less placeholder plus
    ///        a Testing source so the manager cargo-builds from the workspace.
    ///        NEVER register this on a live network: operators cold-starting
    ///        through the manager get a 70-minute source build (or no boot).
    function _buildSources(
        string memory crateName,
        string memory binaryName
    )
        internal
        view
        returns (Types.BlueprintSource[] memory sources)
    {
        sources = new Types.BlueprintSource[](1);
        Types.BlueprintBinary[] memory bins = new Types.BlueprintBinary[](1);

        string memory tag = vm.envOr("RELEASE_TAG", string(""));
        if (bytes(tag).length == 0) {
            require(
                _isLocalChain(),
                "RegisterBlueprint: set RELEASE_TAG (+ <BINARY>_SHA256) on live networks; placeholder sources force operators into cargo source builds"
            );
            bins[0] = Types.BlueprintBinary({
                arch: Types.BlueprintArchitecture.Amd64,
                os: Types.BlueprintOperatingSystem.Linux,
                name: binaryName,
                sha256: bytes32(uint256(0xdeadbeef))
            });
            sources[0] = Types.BlueprintSource({
                kind: Types.BlueprintSourceKind.Native,
                container: Types.ImageRegistrySource("", "", ""),
                wasm: Types.WasmSource(Types.WasmRuntime.Unknown, Types.BlueprintFetcherKind.None, "", ""),
                native: Types.NativeSource(
                    Types.BlueprintFetcherKind.None,
                    string(abi.encodePacked("file:///target/release/", binaryName)),
                    string(abi.encodePacked("./target/release/", binaryName))
                ),
                testing: Types.TestingSource(crateName, binaryName, "."),
                binaries: bins
            });
            return sources;
        }

        // Extracted-binary hash (NOT the tarball hash): the manager's
        // RemoteBinaryFetcher verifies the unpacked binary against this value.
        bytes32 sha = vm.envBytes32(string(abi.encodePacked(_envName(binaryName), "_SHA256")));
        require(sha != bytes32(0), "RegisterBlueprint: zero sha256");

        string memory base =
            string(abi.encodePacked("https://github.com/tangle-network/ai-trading-blueprint/releases/download/", tag));
        string memory artifactUri = string(
            abi.encodePacked(
                "{\"dist_url\":\"",
                base,
                "/dist-manifest.json\",\"archive_url\":\"",
                base,
                "/",
                binaryName,
                "-x86_64-unknown-linux-gnu.tar.xz\",\"binaries\":[]}"
            )
        );

        bins[0] = Types.BlueprintBinary({
            arch: Types.BlueprintArchitecture.Amd64,
            os: Types.BlueprintOperatingSystem.Linux,
            name: binaryName,
            sha256: sha
        });
        sources[0] = Types.BlueprintSource({
            kind: Types.BlueprintSourceKind.Native,
            container: Types.ImageRegistrySource("", "", ""),
            wasm: Types.WasmSource(Types.WasmRuntime.Unknown, Types.BlueprintFetcherKind.None, "", ""),
            native: Types.NativeSource(Types.BlueprintFetcherKind.Http, artifactUri, binaryName),
            // No testing fallback on live networks: download failures must
            // surface as errors, not silent multi-hour source builds.
            testing: Types.TestingSource("", "", ""),
            binaries: bins
        });
    }

    /// @notice "trading-blueprint" -> "TRADING_BLUEPRINT" for env lookups.
    /// @dev Copies the bytes: `bytes(name)` aliases the caller's string, and
    ///      mutating it in place would uppercase `binaryName` everywhere it is
    ///      used afterwards (artifactUri, on-chain binary name).
    function _envName(string memory name) internal pure returns (string memory) {
        bytes memory src = bytes(name);
        bytes memory b = new bytes(src.length);
        for (uint256 i = 0; i < src.length; i++) {
            if (src[i] == "-") {
                b[i] = "_";
            } else if (src[i] >= "a" && src[i] <= "z") {
                b[i] = bytes1(uint8(src[i]) - 32);
            } else {
                b[i] = src[i];
            }
        }
        return string(b);
    }
}
