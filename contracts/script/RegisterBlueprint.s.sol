// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "tnt-core/libraries/Types.sol";
import "../src/blueprints/TradingBlueprint.sol";
import "../src/VaultFactory.sol";
import "../src/PolicyEngine.sol";
import "../src/TradeValidator.sol";
import "../src/FeeDistributor.sol";
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
    // Anvil well-known keys
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // Tangle protocol address (deterministic from Anvil state snapshot)
    address constant TANGLE = 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9;

    // Test accounts
    address constant USER_ACCOUNT = 0x68FF20459d48917748CA13afCbDA3B265a449D48;

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

        // ── Deploy Mock Tokens ────────────────────────────────────────
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);

        // ── Deploy Core Contracts ─────────────────────────────────────
        PolicyEngine policyEngine = new PolicyEngine();
        TradeValidator tradeValidator = new TradeValidator();
        FeeDistributor feeDistributor = new FeeDistributor(deployer);
        VaultFactory vaultFactory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);

        // Transfer ownership of PolicyEngine + TradeValidator to VaultFactory
        policyEngine.transferOwnership(address(vaultFactory));
        tradeValidator.transferOwnership(address(vaultFactory));
        vaultFactory.acceptDependencyOwnership();

        // ── Deploy BSM ────────────────────────────────────────────────
        TradingBlueprint bsm = new TradingBlueprint();

        // ── Fund Test Accounts ────────────────────────────────────────
        payable(USER_ACCOUNT).transfer(100 ether);
        usdc.mint(USER_ACCOUNT, 1_000_000 * 1e6);
        weth.mint(USER_ACCOUNT, 100 ether);
        usdc.mint(deployer, 1_000_000 * 1e6);
        weth.mint(deployer, 100 ether);

        // Fund extra accounts if provided via EXTRA_ACCOUNTS env var
        string memory extraStr = vm.envOr("EXTRA_ACCOUNTS", string(""));
        if (bytes(extraStr).length > 0) {
            // Extra accounts handled by bash wrapper (complex parsing)
        }

        // ── Register Blueprint on Tangle ──────────────────────────────
        Types.BlueprintDefinition memory def = _buildDefinition(address(bsm));
        uint64 blueprintId = tangle.createBlueprint(def);
        // createBlueprint internally calls bsm.onBlueprintCreated(blueprintId, deployer, TANGLE)
        // which sets tangleCore = TANGLE in the BSM

        vm.stopBroadcast();

        // ── Output Addresses (parsed by bash wrapper) ─────────────────
        console.log("DEPLOY_BSM=%s", vm.toString(address(bsm)));
        console.log("DEPLOY_VAULT_FACTORY=%s", vm.toString(address(vaultFactory)));
        console.log("DEPLOY_USDC=%s", vm.toString(address(usdc)));
        console.log("DEPLOY_WETH=%s", vm.toString(address(weth)));
        console.log("DEPLOY_POLICY_ENGINE=%s", vm.toString(address(policyEngine)));
        console.log("DEPLOY_TRADE_VALIDATOR=%s", vm.toString(address(tradeValidator)));
        console.log("DEPLOY_FEE_DISTRIBUTOR=%s", vm.toString(address(feeDistributor)));
        console.log("DEPLOY_BLUEPRINT_ID=%s", vm.toString(blueprintId));
    }

    /// @notice Construct the BlueprintDefinition struct for createBlueprint()
    function _buildDefinition(address manager) internal pure returns (Types.BlueprintDefinition memory def) {
        def.metadataUri = "ipfs://QmTradingBlueprint";
        def.manager = manager;
        def.masterManagerRevision = 0;
        def.hasConfig = true;

        // Config
        def.config = Types.BlueprintConfig({
            membership: Types.MembershipModel.Fixed,
            pricing: Types.PricingModel.PayOnce,
            minOperators: 1,
            maxOperators: 10,
            subscriptionRate: 0,
            subscriptionInterval: 0,
            eventRate: 0
        });

        // Metadata
        def.metadata = Types.BlueprintMetadata({
            name: "AI Trading Blueprint",
            description: "Autonomous AI trading bots on Tangle Network",
            author: "Tangle",
            category: "Trading",
            codeRepository: "https://github.com/tangle-network/ai-trading-blueprints",
            logo: "",
            website: "https://tangle.network",
            license: "MIT",
            profilingData: ""
        });

        // Jobs (7 core jobs matching blueprint-definition.json)
        def.jobs = new Types.JobDefinition[](7);
        def.jobs[0] = Types.JobDefinition("provision", "Provision a new trading bot", "", "", "");
        def.jobs[1] = Types.JobDefinition("configure", "Reconfigure bot strategy", "", "", "");
        def.jobs[2] = Types.JobDefinition("start_trading", "Start trading loop", "", "", "");
        def.jobs[3] = Types.JobDefinition("stop_trading", "Stop trading loop", "", "", "");
        def.jobs[4] = Types.JobDefinition("status", "Query bot status", "", "", "");
        def.jobs[5] = Types.JobDefinition("deprovision", "Deprovision bot", "", "", "");
        def.jobs[6] = Types.JobDefinition("extend", "Extend bot lifetime", "", "", "");

        // Schemas (empty = no validation, any input accepted)
        def.registrationSchema = "";
        def.requestSchema = "";

        // Source (Native binary)
        def.sources = new Types.BlueprintSource[](1);
        Types.BlueprintBinary[] memory bins = new Types.BlueprintBinary[](1);
        bins[0] = Types.BlueprintBinary({
            arch: Types.BlueprintArchitecture.Amd64,
            os: Types.BlueprintOperatingSystem.Linux,
            name: "trading-blueprint",
            sha256: bytes32(uint256(0xdeadbeef))
        });

        def.sources[0] = Types.BlueprintSource({
            kind: Types.BlueprintSourceKind.Native,
            container: Types.ImageRegistrySource("", "", ""),
            wasm: Types.WasmSource(Types.WasmRuntime.Unknown, Types.BlueprintFetcherKind.None, "", ""),
            native: Types.NativeSource(
                Types.BlueprintFetcherKind.None,
                "file:///target/release/trading-blueprint",
                "./target/release/trading-blueprint"
            ),
            testing: Types.TestingSource("trading-blueprint-bin", "trading-blueprint", "."),
            binaries: bins
        });

        // Supported memberships
        def.supportedMemberships = new Types.MembershipModel[](1);
        def.supportedMemberships[0] = Types.MembershipModel.Fixed;
    }
}
