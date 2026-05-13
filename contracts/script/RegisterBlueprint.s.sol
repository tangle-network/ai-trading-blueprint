// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "tnt-core/libraries/Types.sol";
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

/// @notice Minimal interface for Tangle contract blueprint registration
interface ITangle {
    function createBlueprint(Types.BlueprintDefinition calldata def) external returns (uint64);
    function blueprintCount() external view returns (uint64);
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

    // Anvil well-known keys
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // Tangle protocol address (deterministic from Anvil state snapshot)
    address constant TANGLE = 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9;

    // Test accounts
    address constant USER_ACCOUNT = 0x68FF20459d48917748CA13afCbDA3B265a449D48;
    address constant OPERATOR1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant OPERATOR2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

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

    function run() external {
        address deployer = vm.addr(DEPLOYER_KEY);
        ITangle tangle = ITangle(TANGLE);

        vm.startBroadcast(DEPLOYER_KEY);

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
            chainlinkValuator.setFeed(MAINNET_WETH, ETH_USD_FEED, 1 days);
            chainlinkValuator.setFeed(MAINNET_USDC, USDC_USD_FEED, 1 days);
            chainlinkValuator.setFeed(MAINNET_USDT, USDT_USD_FEED, 1 days);
            chainlinkValuator.setFeed(MAINNET_DAI, DAI_USD_FEED, 1 days);
            chainlinkValuator.setFeed(MAINNET_WBTC, BTC_USD_FEED, 1 days);

            WrappedAssetValuator wrapperValuator = new WrappedAssetValuator(deployer, chainlinkValuator);
            wrapperValuator.setUnderlying(AAVE_AWETH, MAINNET_WETH);
            wrapperValuator.setUnderlying(AAVE_AUSDC, MAINNET_USDC);
            wrapperValuator.setUnderlying(AAVE_ADAI, MAINNET_DAI);

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
        _configureDefaultWhitelists(vaultFactory, usingExistingAssets, usdcAddress, wethAddress);

        // ── Deploy BSMs ───────────────────────────────────────────────
        // Each variant needs its own BSM instance because onBlueprintCreated
        // can only be called once per contract (sets Tangle address).
        TradingBlueprint bsm = new TradingBlueprint();
        TradingBlueprint instanceBsm = new TradingBlueprint();
        TradingBlueprint teeBsm = new TradingBlueprint();
        ValidatorBlueprint validatorBsm = new ValidatorBlueprint();

        // ── Fund Test Accounts ────────────────────────────────────────
        payable(USER_ACCOUNT).transfer(100 ether);
        if (!usingExistingAssets) {
            MockERC20(usdcAddress).mint(USER_ACCOUNT, 1_000_000 * 1e6);
            MockERC20(wethAddress).mint(USER_ACCOUNT, 100 ether);
            MockERC20(usdcAddress).mint(deployer, 1_000_000 * 1e6);
            MockERC20(wethAddress).mint(deployer, 100 ether);
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
                wrappedValuator
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
                wrappedValuator
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
        uint64 cloudId = tangle.createBlueprint(
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
        uint64 instanceId = tangle.createBlueprint(
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
        uint64 teeId = tangle.createBlueprint(
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
        uint64 validatorId = tangle.createBlueprint(_buildValidatorDefinition(address(validatorBsm)));

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
        IAssetValuator wrappedValuator
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
            address(vault), policyEngine, usingExistingAssets, primaryValuator, wrappedValuator, assetToken
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
        address wethAddress
    ) internal {
        vaultFactory.setDefaultWhitelistedToken(usdcAddress, true);
        vaultFactory.setDefaultWhitelistedToken(wethAddress, true);
        if (usingExistingAssets) {
            vaultFactory.setDefaultWhitelistedToken(MAINNET_USDT, true);
            vaultFactory.setDefaultWhitelistedToken(MAINNET_DAI, true);
            vaultFactory.setDefaultWhitelistedToken(MAINNET_WBTC, true);
            vaultFactory.setDefaultWhitelistedToken(AAVE_AWETH, true);
            vaultFactory.setDefaultWhitelistedToken(AAVE_AUSDC, true);
            vaultFactory.setDefaultWhitelistedToken(AAVE_ADAI, true);
        }
    }

    function _configureVaultWhitelistsAndAdapters(
        address vaultAddress,
        PolicyEngine policyEngine,
        bool usingExistingAssets,
        IAssetValuator primaryValuator,
        IAssetValuator wrappedValuator,
        address assetToken
    ) internal {
        TradingVault vault = TradingVault(payable(vaultAddress));
        if (usingExistingAssets) {
            address[5] memory tokens = [MAINNET_WETH, MAINNET_USDC, MAINNET_USDT, MAINNET_DAI, MAINNET_WBTC];
            for (uint256 i = 0; i < tokens.length; i++) {
                policyEngine.whitelistToken(vaultAddress, tokens[i], true);
                vault.setValuationAdapter(tokens[i], address(primaryValuator));
            }
            address[3] memory wrappers = [AAVE_AWETH, AAVE_AUSDC, AAVE_ADAI];
            for (uint256 i = 0; i < wrappers.length; i++) {
                policyEngine.whitelistToken(vaultAddress, wrappers[i], true);
                vault.setValuationAdapter(wrappers[i], address(wrappedValuator));
            }
        } else {
            vault.setValuationAdapter(assetToken, address(primaryValuator));
        }
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
    ) internal pure returns (Types.BlueprintDefinition memory def) {
        def.metadataUri = "ipfs://QmTradingBlueprint";
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
        def.sources = new Types.BlueprintSource[](1);
        Types.BlueprintBinary[] memory bins = new Types.BlueprintBinary[](1);
        bins[0] = Types.BlueprintBinary({
            arch: Types.BlueprintArchitecture.Amd64,
            os: Types.BlueprintOperatingSystem.Linux,
            name: binaryName,
            sha256: bytes32(uint256(0xdeadbeef))
        });

        def.sources[0] = Types.BlueprintSource({
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

        // Supported memberships
        def.supportedMemberships = new Types.MembershipModel[](1);
        def.supportedMemberships[0] = Types.MembershipModel.Fixed;
    }

    /// @notice Construct the BlueprintDefinition for the validator blueprint.
    /// @dev Separate from trading variants: different BSM, different jobs (3 vs 7).
    function _buildValidatorDefinition(address manager) internal pure returns (Types.BlueprintDefinition memory def) {
        def.metadataUri = "ipfs://QmValidatorBlueprint";
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

        def.sources = new Types.BlueprintSource[](1);
        Types.BlueprintBinary[] memory bins = new Types.BlueprintBinary[](1);
        bins[0] = Types.BlueprintBinary({
            arch: Types.BlueprintArchitecture.Amd64,
            os: Types.BlueprintOperatingSystem.Linux,
            name: "trading-validator",
            sha256: bytes32(uint256(0xdeadbeef))
        });

        def.sources[0] = Types.BlueprintSource({
            kind: Types.BlueprintSourceKind.Native,
            container: Types.ImageRegistrySource("", "", ""),
            wasm: Types.WasmSource(Types.WasmRuntime.Unknown, Types.BlueprintFetcherKind.None, "", ""),
            native: Types.NativeSource(
                Types.BlueprintFetcherKind.None,
                "file:///target/release/trading-validator",
                "./target/release/trading-validator"
            ),
            testing: Types.TestingSource("trading-validator-bin", "trading-validator", "."),
            binaries: bins
        });

        def.supportedMemberships = new Types.MembershipModel[](1);
        def.supportedMemberships[0] = Types.MembershipModel.Fixed;
    }
}
