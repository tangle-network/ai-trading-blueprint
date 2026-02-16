// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/blueprints/ValidatorBlueprint.sol";

/// @title ValidatorBlueprintQoSTest
/// @notice Tests for ValidatorBlueprint: registration via protocol hooks,
///         reputation tracking, slashing hooks, and getRequiredResultCount.
contract ValidatorBlueprintQoSTest is Test {
    ValidatorBlueprint public blueprint;
    address public tangleCore;
    address public operator1;
    address public operator2;
    address public operator3;
    uint64 public serviceId;

    // Cache job constants
    uint8 JOB_UPDATE_REPUTATION;
    uint8 JOB_UPDATE_CONFIG;
    uint8 JOB_LIVENESS;

    function setUp() public {
        blueprint = new ValidatorBlueprint();
        tangleCore = makeAddr("tangleCore");
        operator1 = makeAddr("operator1");
        operator2 = makeAddr("operator2");
        operator3 = makeAddr("operator3");
        serviceId = 1;

        // Initialize blueprint (simulates onBlueprintCreated from Tangle)
        blueprint.onBlueprintCreated(42, address(this), tangleCore);

        // Cache constants
        JOB_UPDATE_REPUTATION = blueprint.JOB_UPDATE_REPUTATION();
        JOB_UPDATE_CONFIG = blueprint.JOB_UPDATE_CONFIG();
        JOB_LIVENESS = blueprint.JOB_LIVENESS();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REGISTRATION VIA PROTOCOL HOOKS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onRegister_initializesReputation() public {
        vm.prank(tangleCore);
        blueprint.onRegister{value: 0}(operator1, abi.encode(serviceId));

        assertTrue(blueprint.validatorRegistered(serviceId, operator1));
        assertEq(blueprint.validatorCount(serviceId), 1);
        assertEq(blueprint.validatorReputation(serviceId, operator1), 100);
    }

    function test_onRegister_multipleOperators() public {
        vm.startPrank(tangleCore);
        blueprint.onRegister{value: 0}(operator1, abi.encode(serviceId));
        blueprint.onRegister{value: 0}(operator2, abi.encode(serviceId));
        blueprint.onRegister{value: 0}(operator3, abi.encode(serviceId));
        vm.stopPrank();

        assertEq(blueprint.validatorCount(serviceId), 3);
        assertEq(blueprint.validatorReputation(serviceId, operator1), 100);
        assertEq(blueprint.validatorReputation(serviceId, operator2), 100);
        assertEq(blueprint.validatorReputation(serviceId, operator3), 100);
    }

    function test_onRegister_idempotent() public {
        vm.startPrank(tangleCore);
        blueprint.onRegister{value: 0}(operator1, abi.encode(serviceId));
        blueprint.onRegister{value: 0}(operator1, abi.encode(serviceId));
        vm.stopPrank();

        assertEq(blueprint.validatorCount(serviceId), 1);
    }

    function test_onRegister_onlyFromTangle() public {
        vm.expectRevert();
        blueprint.onRegister{value: 0}(operator1, abi.encode(serviceId));
    }

    function test_onUnregister_removesOperator() public {
        vm.startPrank(tangleCore);
        blueprint.onRegister{value: 0}(operator1, ""); // empty = serviceId 0
        assertTrue(blueprint.validatorRegistered(0, operator1));
        assertEq(blueprint.validatorCount(0), 1);

        blueprint.onUnregister(operator1);
        vm.stopPrank();

        assertFalse(blueprint.validatorRegistered(0, operator1));
        assertEq(blueprint.validatorCount(0), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REPUTATION TRACKING
    // ═══════════════════════════════════════════════════════════════════════════

    function test_updateReputation_incrementsValidations() public {
        _registerOperator(operator1);

        bytes memory outputs = abi.encode(uint256(10), int256(5));
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_UPDATE_REPUTATION, 1, operator1, "", outputs);

        assertEq(blueprint.totalValidations(serviceId, operator1), 10);
        assertEq(blueprint.validatorReputation(serviceId, operator1), 105);
    }

    function test_updateReputation_canDecreaseReputation() public {
        _registerOperator(operator1);

        bytes memory outputs = abi.encode(uint256(5), int256(-20));
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_UPDATE_REPUTATION, 1, operator1, "", outputs);

        assertEq(blueprint.validatorReputation(serviceId, operator1), 80);
    }

    function test_updateReputation_accumulatesOverMultipleCalls() public {
        _registerOperator(operator1);

        vm.startPrank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_UPDATE_REPUTATION, 1, operator1, "",
            abi.encode(uint256(5), int256(3)));
        blueprint.onJobResult(serviceId, JOB_UPDATE_REPUTATION, 2, operator1, "",
            abi.encode(uint256(10), int256(-1)));
        vm.stopPrank();

        assertEq(blueprint.totalValidations(serviceId, operator1), 15);
        assertEq(blueprint.validatorReputation(serviceId, operator1), 102);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SLASHING HOOKS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onSlash_reducesReputation() public {
        _registerOperator(operator1);
        assertEq(blueprint.validatorReputation(serviceId, operator1), 100);

        vm.prank(tangleCore);
        blueprint.onSlash(serviceId, abi.encode(operator1), 30);

        assertEq(blueprint.validatorReputation(serviceId, operator1), 70);
    }

    function test_onSlash_canGoNegative() public {
        _registerOperator(operator1);

        vm.startPrank(tangleCore);
        blueprint.onSlash(serviceId, abi.encode(operator1), 80);
        blueprint.onSlash(serviceId, abi.encode(operator1), 50);
        vm.stopPrank();

        assertEq(blueprint.validatorReputation(serviceId, operator1), -30);
    }

    function test_onUnappliedSlash_isNoOp() public {
        _registerOperator(operator1);

        vm.prank(tangleCore);
        blueprint.onUnappliedSlash(serviceId, abi.encode(operator1), 50);

        assertEq(blueprint.validatorReputation(serviceId, operator1), 100);
    }

    function test_querySlashingOrigin_returnsSelf() public view {
        assertEq(blueprint.querySlashingOrigin(serviceId), address(blueprint));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LIVENESS (HEARTBEAT)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_liveness_recordsTimestamp() public {
        _registerOperator(operator1);

        vm.warp(1000);
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_LIVENESS, 1, operator1, "", "");

        assertEq(blueprint.lastHeartbeat(serviceId, operator1), 1000);
    }

    function test_liveness_updatesOnSubsequentCalls() public {
        _registerOperator(operator1);

        vm.warp(1000);
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_LIVENESS, 1, operator1, "", "");
        assertEq(blueprint.lastHeartbeat(serviceId, operator1), 1000);

        vm.warp(2000);
        vm.prank(tangleCore);
        blueprint.onJobResult(serviceId, JOB_LIVENESS, 2, operator1, "", "");
        assertEq(blueprint.lastHeartbeat(serviceId, operator1), 2000);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // getRequiredResultCount
    // ═══════════════════════════════════════════════════════════════════════════

    function test_getRequiredResultCount_livenessRequiresAll() public {
        _registerOperator(operator1);
        _registerOperator(operator2);
        _registerOperator(operator3);

        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_LIVENESS), 3);
    }

    function test_getRequiredResultCount_livenessDefault1WhenNoOperators() public view {
        assertEq(blueprint.getRequiredResultCount(99, JOB_LIVENESS), 1);
    }

    function test_getRequiredResultCount_otherJobsReturnOne() public view {
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_UPDATE_REPUTATION), 1);
        assertEq(blueprint.getRequiredResultCount(serviceId, JOB_UPDATE_CONFIG), 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _registerOperator(address op) internal {
        vm.prank(tangleCore);
        blueprint.onRegister{value: 0}(op, abi.encode(serviceId));
    }
}
