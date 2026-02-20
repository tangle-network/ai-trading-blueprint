// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "../src/blueprints/TradingBlueprint.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title TradingBlueprintMultiOpTest
/// @notice Tests for TradingBlueprint multi-operator model, vault auto-deploy,
///         lifecycle hooks, intent dedup, and job pricing.
///         Tests the unified TradingBlueprint contract directly.
contract TradingBlueprintMultiOpTest is Setup {
    TradingBlueprint public blueprint;
    address public tangleCore;
    address public operator2;
    address public operator3;

    uint64 public requestId = 1;
    uint64 public serviceId = 1;

    // Cache job constants
    uint8 JOB_PROVISION;
    uint8 JOB_CONFIGURE;
    uint8 JOB_START_TRADING;
    uint8 JOB_STOP_TRADING;
    uint8 JOB_STATUS;
    uint8 JOB_DEPROVISION;
    uint8 JOB_EXTEND;
    uint8 JOB_WORKFLOW_TICK;

    function setUp() public override {
        super.setUp(); // Deploys tokens, VaultFactory, PolicyEngine, TradeValidator, FeeDistributor

        blueprint = new TradingBlueprint();
        tangleCore = makeAddr("tangleCore");
        operator2 = makeAddr("operator2");
        operator3 = makeAddr("operator3");

        // Initialize blueprint
        blueprint.onBlueprintCreated(42, address(this), tangleCore);

        // Set vault factory
        vm.prank(tangleCore);
        blueprint.setVaultFactory(address(vaultFactory));

        // Cache constants
        JOB_PROVISION = blueprint.JOB_PROVISION();
        JOB_CONFIGURE = blueprint.JOB_CONFIGURE();
        JOB_START_TRADING = blueprint.JOB_START_TRADING();
        JOB_STOP_TRADING = blueprint.JOB_STOP_TRADING();
        JOB_STATUS = blueprint.JOB_STATUS();
        JOB_DEPROVISION = blueprint.JOB_DEPROVISION();
        JOB_EXTEND = blueprint.JOB_EXTEND();
        JOB_WORKFLOW_TICK = blueprint.JOB_WORKFLOW_TICK();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _buildRequestInputs() internal view returns (bytes memory) {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        return abi.encode(
            address(tokenA),  // assetToken
            signers,          // signers
            uint256(2),       // requiredSignatures (2-of-3)
            "Test Vault",     // name
            "tVLT"            // symbol
        );
    }

    /// @dev Full service lifecycle: onRequest → onServiceInitialized (no vault created)
    function _initService() internal {
        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputs(), 0, address(0), 0);

        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), new address[](0), 0);
    }

    function _joinOperator(address op) internal {
        vm.prank(tangleCore);
        blueprint.onOperatorJoined(serviceId, op, 0);
    }

    /// @dev Build provision inputs with valid vault config (asset token, signers)
    function _buildBotProvisionInputs() internal view returns (bytes memory) {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
        uint64[] memory validatorIds = new uint64[](0);
        return abi.encode(
            "Test Bot",         // name
            "",                 // strategy_type
            "",                 // strategy_config_json
            "",                 // risk_params_json
            address(0),         // factory_address
            address(tokenA),    // asset_token
            signers,            // signers
            uint256(2),         // required_signatures
            uint256(0),         // chain_id
            "",                 // rpc_url
            "",                 // trading_loop_cron
            uint64(1),          // cpu_cores
            uint64(1024),       // memory_mb
            uint64(30),         // max_lifetime_days
            validatorIds        // validator_service_ids
        );
    }

    /// @dev Submit a provision job and its result, creating a per-bot vault
    function _provisionBot(uint64 callId) internal returns (address vault, address shareToken) {
        bytes memory inputs = _buildBotProvisionInputs();
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, callId, inputs);
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_PROVISION, callId, operator, inputs, "");
        vault = blueprint.botVaults(serviceId, callId);
        shareToken = blueprint.botShares(serviceId, callId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // getRequiredResultCount
    // ═══════════════════════════════════════════════════════════════════════════

    function test_getRequiredResultCount_returnsZero() public view {
        // 0 = protocol default (all operators)
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_PROVISION), 0);
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_CONFIGURE), 0);
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_START_TRADING), 0);
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_STOP_TRADING), 0);
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_STATUS), 0);
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_DEPROVISION), 0);
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_WORKFLOW_TICK), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SERVICE INIT (onServiceInitialized) — stores config only, no vault
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onServiceInitialized_storesConfigOnly() public {
        _initService();

        // No vault at service init — vaults are created per-bot via onJobResult
        assertEq(blueprint.instanceVault(serviceId), address(0), "No vault at service init");
        assertEq(blueprint.instanceShare(serviceId), address(0), "No share at service init");
        assertTrue(blueprint.instanceProvisioned(serviceId), "Should be provisioned");
    }

    function test_onServiceInitialized_clearsRequestConfig() public {
        _initService();

        // Calling onServiceInitialized again with same requestId but new serviceId
        // stores empty config (pending request was deleted)
        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, 99, address(0), new address[](0), 0);

        // Provision a bot for service 99 — should silently skip (empty service config,
        // and provision inputs also have zero asset_token → no vault created)
        bytes memory inputs = _buildProvisionInputs(1, 1024, 30);
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(99, JOB_PROVISION, 1, inputs);
        vm.prank(tangleCore);
        blueprint.onJobResult(99, JOB_PROVISION, 1, operator, inputs, "");

        assertEq(blueprint.botVaults(99, 1), address(0), "Should not deploy without config");
    }

    function test_onServiceInitialized_skipsWithoutFactory() public {
        // Deploy a fresh blueprint without factory set
        TradingBlueprint freshBlueprint = new TradingBlueprint();
        freshBlueprint.onBlueprintCreated(42, address(this), tangleCore);
        // Don't set factory

        vm.prank(tangleCore);
        freshBlueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputs(), 0, address(0), 0);

        vm.prank(tangleCore);
        freshBlueprint.onServiceInitialized(0, requestId, serviceId, address(0), new address[](0), 0);

        // Provision job result — should silently skip (no factory)
        bytes memory inputs = _buildBotProvisionInputs();
        vm.prank(tangleCore);
        freshBlueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, 1, inputs);
        vm.prank(tangleCore);
        freshBlueprint.onJobResult(serviceId, JOB_PROVISION, 1, operator, inputs, "");

        assertEq(freshBlueprint.botVaults(serviceId, 1), address(0), "No vault without factory");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PER-BOT VAULT (onJobResult for JOB_PROVISION)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_provisionJob_deploysBotVault() public {
        _initService();
        (address vault, address shareToken) = _provisionBot(1);

        assertTrue(vault != address(0), "Bot vault should be deployed");
        assertTrue(shareToken != address(0), "Bot share token should be deployed");
    }

    function test_provisionJob_emitsBotVaultDeployed() public {
        _initService();
        bytes memory inputs = _buildBotProvisionInputs();

        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, 1, inputs);

        vm.expectEmit(true, true, false, false);
        emit TradingBlueprint.BotVaultDeployed(serviceId, 1, address(0), address(0));

        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_PROVISION, 1, operator, inputs, "");
    }

    function test_provisionJob_blueprintIsVaultAdmin() public {
        _initService();
        (address vault,) = _provisionBot(1);

        TradingVault tv = TradingVault(payable(vault));
        assertTrue(tv.hasRole(tv.DEFAULT_ADMIN_ROLE(), address(blueprint)));
    }

    function test_provisionJob_noInitialOperator() public {
        _initService();
        (address vault,) = _provisionBot(1);

        // No operators were in _serviceOperators (empty array passed to onServiceInitialized)
        TradingVault tv = TradingVault(payable(vault));
        assertFalse(tv.hasRole(tv.OPERATOR_ROLE(), operator));
        assertFalse(tv.hasRole(tv.OPERATOR_ROLE(), operator2));
    }

    function test_provisionJob_multipleBotVaults() public {
        _initService();
        (address vault1,) = _provisionBot(1);
        (address vault2,) = _provisionBot(2);

        assertTrue(vault1 != address(0), "Bot 1 vault should be deployed");
        assertTrue(vault2 != address(0), "Bot 2 vault should be deployed");
        assertTrue(vault1 != vault2, "Each bot should get a different vault");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MULTI-OPERATOR (onOperatorJoined)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onOperatorJoined_grantsRoleOnBotVault() public {
        _initService();
        (address vault,) = _provisionBot(1);
        _joinOperator(operator);

        TradingVault tv = TradingVault(payable(vault));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator));
    }

    function test_multipleOperators_allGetRoleOnBotVault() public {
        _initService();
        (address vault,) = _provisionBot(1);
        _joinOperator(operator);
        _joinOperator(operator2);
        _joinOperator(operator3);

        TradingVault tv = TradingVault(payable(vault));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator2));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator3));
    }

    function test_onOperatorJoined_emitsEvent() public {
        _initService();
        (address vault,) = _provisionBot(1);

        vm.expectEmit(true, true, false, true);
        emit TradingBlueprint.OperatorGranted(serviceId, operator, vault);

        _joinOperator(operator);
    }

    function test_onOperatorJoined_nopWithoutVault() public {
        // Service 99 has no vault — should not revert
        vm.prank(tangleCore);
        blueprint.onOperatorJoined(99, operator, 0);
    }

    function test_onOperatorJoined_grantsRoleOnMultipleBotVaults() public {
        _initService();
        (address vault1,) = _provisionBot(1);
        (address vault2,) = _provisionBot(2);
        _joinOperator(operator);

        TradingVault tv1 = TradingVault(payable(vault1));
        TradingVault tv2 = TradingVault(payable(vault2));
        assertTrue(tv1.hasRole(tv1.OPERATOR_ROLE(), operator));
        assertTrue(tv2.hasRole(tv2.OPERATOR_ROLE(), operator));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SERVICE TERMINATION
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onServiceTermination_clearsProvisioned() public {
        _initService();
        assertTrue(blueprint.instanceProvisioned(serviceId));

        vm.prank(tangleCore);
        blueprint.onServiceTermination(serviceId, address(0));

        assertFalse(blueprint.instanceProvisioned(serviceId));
    }

    function test_onServiceTermination_emitsEvent() public {
        _initService();

        vm.expectEmit(true, false, false, false);
        emit TradingBlueprint.ServiceTerminated(serviceId);

        vm.prank(tangleCore);
        blueprint.onServiceTermination(serviceId, address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LIFECYCLE EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_startTrading_emitsEvent() public {
        _initService();

        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_START_TRADING, 2, "");

        vm.expectEmit(true, false, false, false);
        emit TradingBlueprint.TradingStarted(serviceId);
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_START_TRADING, 2, operator, "", "");
    }

    function test_stopTrading_emitsEvent() public {
        _initService();

        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_STOP_TRADING, 3, "");

        vm.expectEmit(true, false, false, false);
        emit TradingBlueprint.TradingStopped(serviceId);
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_STOP_TRADING, 3, operator, "", "");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // JOB PROVISION (lightweight signal)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_provision_jobDoesNotRequireProvisioned() public {
        // JOB_PROVISION is exempt from instanceProvisioned check
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, 1, "");
    }

    function test_nonProvisionJob_requiresProvisioned() public {
        // JOB_CONFIGURE requires instanceProvisioned
        vm.prank(tangleCore);
        vm.expectRevert("Not provisioned");
        blueprint.onJobCall{value: 0}(serviceId, JOB_CONFIGURE, 1, "");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCESS CONTROL
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onJobCall_onlyFromTangle() public {
        vm.expectRevert();
        blueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, 1, "");
    }

    function test_onJobResult_onlyFromTangle() public {
        vm.expectRevert();
        blueprint.onJobResult(serviceId, JOB_PROVISION, 1, operator, "", "");
    }

    function test_setVaultFactory_onlyFromTangle() public {
        vm.expectRevert();
        blueprint.setVaultFactory(address(0xBEEF));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // JOB PRICING (flat)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setJobPrice() public {
        vm.prank(tangleCore);
        blueprint.setJobPrice(JOB_PROVISION, 0.01 ether);

        assertEq(blueprint.jobPrice(JOB_PROVISION), 0.01 ether);
    }

    function test_setJobPrice_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit TradingBlueprint.JobPriceUpdated(JOB_PROVISION, 0.01 ether);

        vm.prank(tangleCore);
        blueprint.setJobPrice(JOB_PROVISION, 0.01 ether);
    }

    function test_onJobCall_rejectsInsufficientPayment() public {
        vm.prank(tangleCore);
        blueprint.setJobPrice(JOB_PROVISION, 0.01 ether);

        vm.deal(tangleCore, 1 ether);
        vm.prank(tangleCore);
        vm.expectRevert(
            abi.encodeWithSelector(
                TradingBlueprint.InsufficientPayment.selector,
                JOB_PROVISION,
                0.01 ether,
                0.005 ether
            )
        );
        blueprint.onJobCall{value: 0.005 ether}(serviceId, JOB_PROVISION, 1, "");
    }

    function test_onJobCall_acceptsSufficientPayment() public {
        vm.prank(tangleCore);
        blueprint.setJobPrice(JOB_PROVISION, 0.01 ether);

        vm.deal(tangleCore, 1 ether);
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0.01 ether}(serviceId, JOB_PROVISION, 1, "");
    }

    function test_onJobCall_acceptsOverpayment() public {
        vm.prank(tangleCore);
        blueprint.setJobPrice(JOB_PROVISION, 0.01 ether);

        vm.deal(tangleCore, 1 ether);
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0.05 ether}(serviceId, JOB_PROVISION, 1, "");
    }

    function test_onJobCall_freeJobsStillWork() public {
        assertEq(blueprint.jobPrice(JOB_STATUS), 0);

        _initService();
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_STATUS, 2, "");
    }

    function test_setJobPrice_onlyFromTangle() public {
        vm.expectRevert();
        blueprint.setJobPrice(JOB_PROVISION, 0.01 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DYNAMIC PROVISION PRICING
    // ═══════════════════════════════════════════════════════════════════════════

    function _setDefaultPricing() internal {
        vm.prank(tangleCore);
        blueprint.setProvisionPricing(
            0.01 ether,     // basePrice
            0.001 ether,    // dailyRate
            0.0005 ether,   // cpuDailyRate
            0.0002 ether    // memGbDailyRate
        );
    }

    function test_setProvisionPricing() public {
        _setDefaultPricing();

        assertEq(blueprint.provisionBasePrice(), 0.01 ether);
        assertEq(blueprint.dailyRate(), 0.001 ether);
        assertEq(blueprint.cpuDailyRate(), 0.0005 ether);
        assertEq(blueprint.memGbDailyRate(), 0.0002 ether);
    }

    function test_setProvisionPricing_onlyFromTangle() public {
        vm.expectRevert();
        blueprint.setProvisionPricing(1, 2, 3, 4);
    }

    function test_estimateProvisionCost() public {
        _setDefaultPricing();

        // 30 days, 2 cores, 4096 MB (4 GB)
        // basePrice + (30 * 0.001) + (30 * 2 * 0.0005) + (30 * 4096 * 0.0002 / 1024)
        // = 0.01 + 0.03 + 0.03 + 0.024 = 0.094 ether
        uint256 cost = blueprint.estimateProvisionCost(30, 2, 4096);
        assertEq(cost, 0.094 ether);

        // 0 days should default to 30
        uint256 costDefault = blueprint.estimateProvisionCost(0, 2, 4096);
        assertEq(costDefault, cost, "0 days should default to 30");

        // 1 day, 1 core, 1024 MB (1 GB)
        // basePrice + (1 * 0.001) + (1 * 1 * 0.0005) + (1 * 1024 * 0.0002 / 1024)
        // = 0.01 + 0.001 + 0.0005 + 0.0002 = 0.0117 ether
        uint256 costMin = blueprint.estimateProvisionCost(1, 1, 1024);
        assertEq(costMin, 0.0117 ether);
    }

    function test_dynamicPricing_rejectsUnderpayment() public {
        _initService();
        _setDefaultPricing();

        // 30 days, 2 cores, 4096 MB = 0.094 ether
        uint256 required = blueprint.estimateProvisionCost(30, 2, 4096);

        // Build a minimal provision-like ABI payload with the resource fields
        bytes memory inputs = _buildProvisionInputs(2, 4096, 30);

        vm.deal(tangleCore, 1 ether);
        vm.prank(tangleCore);
        vm.expectRevert(
            abi.encodeWithSelector(
                TradingBlueprint.InsufficientPayment.selector,
                JOB_PROVISION,
                required,
                required / 2
            )
        );
        blueprint.onJobCall{value: required / 2}(serviceId, JOB_PROVISION, 1, inputs);
    }

    function test_dynamicPricing_acceptsCorrectPayment() public {
        _initService();
        _setDefaultPricing();

        uint256 required = blueprint.estimateProvisionCost(30, 2, 4096);
        bytes memory inputs = _buildProvisionInputs(2, 4096, 30);

        vm.deal(tangleCore, 1 ether);
        vm.prank(tangleCore);
        blueprint.onJobCall{value: required}(serviceId, JOB_PROVISION, 1, inputs);
    }

    function test_dynamicPricing_zeroRates_freeProvision() public {
        // When no pricing is set (all zeros), provision should be free — backward compatible
        assertEq(blueprint.provisionBasePrice(), 0);
        assertEq(blueprint.dailyRate(), 0);

        uint256 cost = blueprint.estimateProvisionCost(365, 8, 32768);
        assertEq(cost, 0, "Zero rates should mean free provisioning");

        // Should succeed with no payment
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, 1, "");
    }

    function test_extendJob_pricing() public {
        _initService();

        vm.prank(tangleCore);
        blueprint.setProvisionPricing(0.01 ether, 0.001 ether, 0, 0);

        // JOB_EXTEND: 60 additional days at 0.001/day = 0.06 ether
        bytes memory extendInputs = abi.encode("sandbox-123", uint64(60));

        vm.deal(tangleCore, 1 ether);

        // Underpayment should revert
        vm.prank(tangleCore);
        vm.expectRevert(
            abi.encodeWithSelector(
                TradingBlueprint.InsufficientPayment.selector,
                JOB_EXTEND,
                0.06 ether,
                0.01 ether
            )
        );
        blueprint.onJobCall{value: 0.01 ether}(serviceId, JOB_EXTEND, 1, extendInputs);

        // Correct payment should succeed
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0.06 ether}(serviceId, JOB_EXTEND, 2, extendInputs);
    }

    function test_extendJob_zeroDays_reverts() public {
        _initService();

        bytes memory extendInputs = abi.encode("sandbox-123", uint64(0));

        vm.prank(tangleCore);
        vm.expectRevert(TradingBlueprint.InvalidLifetimeDays.selector);
        blueprint.onJobCall{value: 0}(serviceId, JOB_EXTEND, 1, extendInputs);
    }

    /// @dev Build a minimal TradingProvisionRequest ABI payload for testing dynamic pricing.
    function _buildProvisionInputs(
        uint64 cpuCores,
        uint64 memoryMb,
        uint64 maxLifetimeDays
    ) internal pure returns (bytes memory) {
        // TradingProvisionRequest fields in order
        address[] memory signers = new address[](0);
        uint64[] memory validatorIds = new uint64[](0);
        return abi.encode(
            "",                 // name
            "",                 // strategy_type
            "",                 // strategy_config_json
            "",                 // risk_params_json
            address(0),         // factory_address
            address(0),         // asset_token
            signers,            // signers
            uint256(0),         // required_signatures
            uint256(0),         // chain_id
            "",                 // rpc_url
            "",                 // trading_loop_cron
            cpuCores,           // cpu_cores
            memoryMb,           // memory_mb
            maxLifetimeDays,    // max_lifetime_days
            validatorIds        // validator_service_ids
        );
    }

    /// @dev Build provision inputs with valid asset token but NO explicit signers.
    ///      When signers are empty and requiredSigs is 0, the blueprint falls back
    ///      to using _serviceOperators as signers with requiredSigs = 1.
    function _buildBotProvisionInputsNoSigners() internal view returns (bytes memory) {
        address[] memory signers = new address[](0);
        uint64[] memory validatorIds = new uint64[](0);
        return abi.encode(
            "Test Bot",         // name
            "",                 // strategy_type
            "",                 // strategy_config_json
            "",                 // risk_params_json
            address(0),         // factory_address
            address(tokenA),    // asset_token
            signers,            // signers (empty — fallback to operators)
            uint256(0),         // required_signatures (0 — fallback to 1)
            uint256(0),         // chain_id
            "",                 // rpc_url
            "",                 // trading_loop_cron
            uint64(1),          // cpu_cores
            uint64(1024),       // memory_mb
            uint64(30),         // max_lifetime_days
            validatorIds        // validator_service_ids
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTO-WHITELIST VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice After provisioning a bot vault, the asset token should be auto-whitelisted
    ///         in PolicyEngine by VaultFactory.createBotVault().
    function test_createBotVault_autoWhitelistsAssetToken() public {
        _initService();
        (address vault,) = _provisionBot(1);

        assertTrue(
            policyEngine.tokenWhitelisted(vault, address(tokenA)),
            "Asset token should be auto-whitelisted in PolicyEngine"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // OPERATOR-AS-SIGNERS DEFAULT (no explicit signers)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice When provision inputs have empty signers, the blueprint should fall back
    ///         to using service operators as TradeValidator signers (1-of-N).
    function test_provisionJob_usesOperatorsAsSigners() public {
        _initService();
        _joinOperator(operator);

        // Provision with no explicit signers — should use operators as signers
        bytes memory inputs = _buildBotProvisionInputsNoSigners();
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, 1, inputs);
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_PROVISION, 1, operator, inputs, "");

        address vault = blueprint.botVaults(serviceId, 1);
        assertTrue(vault != address(0), "Bot vault should be deployed");

        // TradeValidator should have 1 signer (the operator) with requiredSigs = 1
        assertEq(tradeValidator.getSignerCount(vault), 1, "Should have 1 signer (the operator)");
        assertEq(tradeValidator.getRequiredSignatures(vault), 1, "Should require 1 signature");
        assertTrue(tradeValidator.isVaultSigner(vault, operator), "Operator should be a signer");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EMPTY OPERATORS + EMPTY SIGNERS → SKIP EVENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice When no operators have joined and provision inputs have empty signers,
    ///         the blueprint should emit BotVaultSkipped and not create a vault.
    function test_provisionJob_emitsSkipWhenNoOperatorsNoSigners() public {
        _initService(); // Empty operators, no _joinOperator

        bytes memory inputs = _buildBotProvisionInputsNoSigners();
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_PROVISION, 1, inputs);

        vm.expectEmit(true, true, false, true);
        emit TradingBlueprint.BotVaultSkipped(serviceId, 1, "no signers (operators may not have joined yet)");

        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_PROVISION, 1, operator, inputs, "");

        assertEq(blueprint.botVaults(serviceId, 1), address(0), "No vault should be created");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EMPTY OPERATORS + NO ASSET TOKEN → DIFFERENT SKIP EVENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice When provision inputs have address(0) as asset token AND the service
    ///         config has no asset token, the blueprint should emit BotVaultSkipped
    ///         with "no asset token" reason.
    function test_provisionJob_emitsSkipWhenNoAssetToken() public {
        // Initialize service WITHOUT onRequest so _serviceConfigs has zero asset token
        uint64 svcId = 99;
        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, 0, svcId, address(0), new address[](0), 0);

        // Use _buildProvisionInputs which has address(0) as asset_token
        bytes memory inputs = _buildProvisionInputs(1, 1024, 30);
        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(svcId, JOB_PROVISION, 1, inputs);

        vm.expectEmit(true, true, false, true);
        emit TradingBlueprint.BotVaultSkipped(svcId, 1, "no asset token");

        vm.prank(tangleCore);
        blueprint.onJobResult(svcId, JOB_PROVISION, 1, operator, inputs, "");

        assertEq(blueprint.botVaults(svcId, 1), address(0), "No vault should be created");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXPLICIT SIGNERS OVERRIDE OPERATORS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice When provision inputs include explicit signers, those should override
    ///         the operator-based defaults even if operators have joined.
    function test_provisionJob_explicitSignersOverrideOperators() public {
        _initService();
        _joinOperator(operator);
        _joinOperator(operator2);

        // Provision with explicit signers [v1,v2,v3] and requiredSigs=2
        // (the default _buildBotProvisionInputs uses these explicit signers)
        (address vault,) = _provisionBot(1);

        // TradeValidator should have 3 signers (validators) requiring 2, NOT 1-of-2 from operators
        assertEq(tradeValidator.getSignerCount(vault), 3, "Should have 3 explicit signers");
        assertEq(tradeValidator.getRequiredSignatures(vault), 2, "Should require 2 signatures");

        // Verify the explicit signers are registered, not the operators
        assertTrue(tradeValidator.isVaultSigner(vault, validator1), "validator1 should be a signer");
        assertTrue(tradeValidator.isVaultSigner(vault, validator2), "validator2 should be a signer");
        assertTrue(tradeValidator.isVaultSigner(vault, validator3), "validator3 should be a signer");

        // Operators should NOT be signers (they have OPERATOR_ROLE, not signer role)
        assertFalse(tradeValidator.isVaultSigner(vault, operator), "operator should not be a signer");
        assertFalse(tradeValidator.isVaultSigner(vault, operator2), "operator2 should not be a signer");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULTFACTORY DIRECT VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice VaultFactory.createBotVault() should revert with InvalidSignerConfig
    ///         when called with an empty signers array.
    function test_createBotVault_revertsOnEmptySigners() public {
        address[] memory emptySigners = new address[](0);

        vm.expectRevert(VaultFactory.InvalidSignerConfig.selector);
        vaultFactory.createBotVault(
            serviceId,
            address(tokenA),
            address(this),      // admin
            address(0),         // operator
            emptySigners,
            uint256(1),         // requiredSigs
            "Test Bot",
            "tBOT",
            bytes32("test-salt")
        );
    }

    /// @notice VaultFactory.createBotVault() should revert with InvalidSignerConfig
    ///         when requiredSigs exceeds signers.length.
    function test_createBotVault_revertsOnExcessiveRequiredSigs() public {
        address[] memory signers = new address[](2);
        signers[0] = validator1;
        signers[1] = validator2;

        vm.expectRevert(VaultFactory.InvalidSignerConfig.selector);
        vaultFactory.createBotVault(
            serviceId,
            address(tokenA),
            address(this),      // admin
            address(0),         // operator
            signers,
            uint256(3),         // requiredSigs > signers.length
            "Test Bot",
            "tBOT",
            bytes32("test-salt")
        );
    }
}
