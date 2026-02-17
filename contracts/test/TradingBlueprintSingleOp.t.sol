// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "../src/blueprints/DexTradingBlueprint.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title TradingBlueprintMultiOpTest
/// @notice Tests for TradingBlueprint multi-operator model, vault auto-deploy,
///         lifecycle hooks, intent dedup, and job pricing.
///         Uses DexTradingBlueprint as a concrete subclass.
contract TradingBlueprintMultiOpTest is Setup {
    DexTradingBlueprint public blueprint;
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
    uint8 JOB_EXECUTE_TWAP;

    function setUp() public override {
        super.setUp(); // Deploys tokens, VaultFactory, PolicyEngine, TradeValidator, FeeDistributor

        blueprint = new DexTradingBlueprint();
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
        JOB_EXECUTE_TWAP = blueprint.JOB_EXECUTE_TWAP();
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

    /// @dev Full service lifecycle: onRequest → onServiceInitialized
    function _initService() internal returns (address vault, address shareToken) {
        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputs(), 0, address(0), 0);

        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), new address[](0), 0);

        vault = blueprint.instanceVault(serviceId);
        shareToken = blueprint.instanceShare(serviceId);
    }

    function _joinOperator(address op) internal {
        vm.prank(tangleCore);
        blueprint.onOperatorJoined(serviceId, op, 0);
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
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_EXECUTE_TWAP), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT AUTO-DEPLOY (onServiceInitialized)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onServiceInitialized_deploysVault() public {
        (address vault, address shareToken) = _initService();

        assertTrue(vault != address(0), "Vault should be deployed");
        assertTrue(shareToken != address(0), "Share token should be deployed");
        assertTrue(blueprint.instanceProvisioned(serviceId), "Should be provisioned");
    }

    function test_onServiceInitialized_emitsVaultDeployed() public {
        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputs(), 0, address(0), 0);

        vm.prank(tangleCore);
        // Can't predict exact addresses, just verify the event is emitted
        vm.expectEmit(true, false, false, false);
        emit TradingBlueprint.VaultDeployed(serviceId, address(0), address(0));
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), new address[](0), 0);
    }

    function test_onServiceInitialized_blueprintIsVaultAdmin() public {
        (address vault,) = _initService();

        TradingVault tv = TradingVault(payable(vault));
        assertTrue(tv.hasRole(tv.DEFAULT_ADMIN_ROLE(), address(blueprint)));
    }

    function test_onServiceInitialized_noInitialOperator() public {
        (address vault,) = _initService();

        // No operator role granted yet (operator param was address(0))
        TradingVault tv = TradingVault(payable(vault));
        assertFalse(tv.hasRole(tv.OPERATOR_ROLE(), operator));
        assertFalse(tv.hasRole(tv.OPERATOR_ROLE(), operator2));
    }

    function test_onServiceInitialized_clearsRequestConfig() public {
        _initService();

        // Calling onServiceInitialized again with same requestId but new serviceId
        // should not deploy (config was deleted)
        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, 99, address(0), new address[](0), 0);

        assertEq(blueprint.instanceVault(99), address(0), "Should not deploy without config");
    }

    function test_onServiceInitialized_skipsWithoutFactory() public {
        // Deploy a fresh blueprint without factory set
        DexTradingBlueprint freshBlueprint = new DexTradingBlueprint();
        freshBlueprint.onBlueprintCreated(42, address(this), tangleCore);
        // Don't set factory

        vm.prank(tangleCore);
        freshBlueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputs(), 0, address(0), 0);

        vm.prank(tangleCore);
        freshBlueprint.onServiceInitialized(0, requestId, serviceId, address(0), new address[](0), 0);

        assertEq(freshBlueprint.instanceVault(serviceId), address(0), "No vault without factory");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MULTI-OPERATOR (onOperatorJoined)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onOperatorJoined_grantsRole() public {
        (address vault,) = _initService();
        _joinOperator(operator);

        TradingVault tv = TradingVault(payable(vault));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator));
    }

    function test_multipleOperators_allGetRole() public {
        (address vault,) = _initService();
        _joinOperator(operator);
        _joinOperator(operator2);
        _joinOperator(operator3);

        TradingVault tv = TradingVault(payable(vault));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator2));
        assertTrue(tv.hasRole(tv.OPERATOR_ROLE(), operator3));
    }

    function test_onOperatorJoined_emitsEvent() public {
        (address vault,) = _initService();

        vm.expectEmit(true, true, false, true);
        emit TradingBlueprint.OperatorGranted(serviceId, operator, vault);

        _joinOperator(operator);
    }

    function test_onOperatorJoined_nopWithoutVault() public {
        // Service 99 has no vault — should not revert
        vm.prank(tangleCore);
        blueprint.onOperatorJoined(99, operator, 0);
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
    // SUBCLASS DELEGATION
    // ═══════════════════════════════════════════════════════════════════════════

    function test_subclass_twapJobWorks() public {
        _initService();

        vm.prank(tangleCore);
        blueprint.onJobCall{value: 0}(serviceId, JOB_EXECUTE_TWAP, 5, "");

        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_EXECUTE_TWAP, 5, operator, "", "");
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
}
