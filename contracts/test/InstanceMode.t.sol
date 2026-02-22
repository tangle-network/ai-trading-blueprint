// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "../src/blueprints/TradingBlueprint.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title InstanceModeTest
/// @notice Tests for the instanceMode flag: vault creation at service init,
///         operator role grants, and fleet mode non-interference.
contract InstanceModeTest is Setup {
    TradingBlueprint public blueprint;
    address public tangleCore;
    address public op1;
    address public op2;

    uint64 public requestId = 1;
    uint64 public serviceId = 1;

    function setUp() public override {
        super.setUp();

        blueprint = new TradingBlueprint();
        tangleCore = makeAddr("tangleCore");
        op1 = makeAddr("op1");
        op2 = makeAddr("op2");

        // Initialize blueprint
        blueprint.onBlueprintCreated(42, address(this), tangleCore);

        // Set vault factory
        vm.prank(tangleCore);
        blueprint.setVaultFactory(address(vaultFactory));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Build request inputs with asset token + signers for vault creation
    function _buildRequestInputsWithAsset() internal view returns (bytes memory) {
        address[] memory signers = new address[](2);
        signers[0] = validator1;
        signers[1] = validator2;

        return abi.encode(
            address(tokenA), // assetToken
            signers, // signers
            uint256(1), // requiredSignatures
            "Instance Vault", // name
            "iVLT" // symbol
        );
    }

    /// @dev Build request inputs WITHOUT asset token (zero address)
    function _buildRequestInputsNoAsset() internal pure returns (bytes memory) {
        address[] memory signers = new address[](0);

        return abi.encode(
            address(0), // assetToken = zero
            signers, // signers
            uint256(0), // requiredSignatures
            "", // name
            "" // symbol
        );
    }

    /// @dev Full service lifecycle with operators
    function _initServiceWithOperators() internal {
        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputsWithAsset(), 0, address(0), 0);

        address[] memory operators = new address[](2);
        operators[0] = op1;
        operators[1] = op2;

        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), operators, 0);
    }

    /// @dev Init service with no asset token
    function _initServiceNoAsset() internal {
        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputsNoAsset(), 0, address(0), 0);

        address[] memory operators = new address[](2);
        operators[0] = op1;
        operators[1] = op2;

        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), operators, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: instanceMode flag
    // ═══════════════════════════════════════════════════════════════════════════

    function test_instanceMode_defaultsFalse() public view {
        assertFalse(blueprint.instanceMode());
    }

    function test_instanceMode_setByTangle() public {
        vm.prank(tangleCore);
        blueprint.setInstanceMode(true);
        assertTrue(blueprint.instanceMode());

        vm.prank(tangleCore);
        blueprint.setInstanceMode(false);
        assertFalse(blueprint.instanceMode());
    }

    function test_instanceMode_onlyFromTangle() public {
        vm.expectRevert();
        blueprint.setInstanceMode(true);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: instanceMode creates vault at service init
    // ═══════════════════════════════════════════════════════════════════════════

    function test_instance_mode_creates_vault_on_init() public {
        // Enable instance mode
        vm.prank(tangleCore);
        blueprint.setInstanceMode(true);

        // Verify no vault exists before
        assertEq(blueprint.instanceVault(serviceId), address(0));
        assertEq(blueprint.botVaults(serviceId, 0), address(0));

        // Init service — should create vault automatically
        _initServiceWithOperators();

        // Vault should now exist
        address vault = blueprint.instanceVault(serviceId);
        assertTrue(vault != address(0), "instanceVault should be set");

        address share = blueprint.instanceShare(serviceId);
        assertTrue(share != address(0), "instanceShare should be set");

        // Also accessible via botVaults[serviceId][0]
        assertEq(blueprint.botVaults(serviceId, 0), vault);
        assertEq(blueprint.botShares(serviceId, 0), share);
    }

    function test_instance_mode_emits_BotVaultDeployed() public {
        vm.prank(tangleCore);
        blueprint.setInstanceMode(true);

        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), _buildRequestInputsWithAsset(), 0, address(0), 0);

        address[] memory operators = new address[](2);
        operators[0] = op1;
        operators[1] = op2;

        // Expect BotVaultDeployed event
        vm.expectEmit(true, true, false, false);
        emit TradingBlueprint.BotVaultDeployed(serviceId, 0, address(0), address(0));

        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), operators, 0);
    }

    function test_instance_mode_operator_roles_granted() public {
        vm.prank(tangleCore);
        blueprint.setInstanceMode(true);

        _initServiceWithOperators();

        address vault = blueprint.instanceVault(serviceId);
        assertTrue(vault != address(0));

        // Check VAULT_OPERATOR_ROLE is granted to both operators
        bytes32 operatorRole = blueprint.VAULT_OPERATOR_ROLE();
        assertTrue(IAccessControl(vault).hasRole(operatorRole, op1), "op1 should have OPERATOR_ROLE");
        assertTrue(IAccessControl(vault).hasRole(operatorRole, op2), "op2 should have OPERATOR_ROLE");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: fleet mode does NOT create vault at init
    // ═══════════════════════════════════════════════════════════════════════════

    function test_fleet_mode_no_vault_on_init() public {
        // instanceMode defaults to false (fleet mode)
        assertFalse(blueprint.instanceMode());

        _initServiceWithOperators();

        // No vault should exist
        assertEq(blueprint.instanceVault(serviceId), address(0));
        assertEq(blueprint.botVaults(serviceId, 0), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: graceful skip conditions
    // ═══════════════════════════════════════════════════════════════════════════

    function test_instance_mode_skips_no_asset_token() public {
        vm.prank(tangleCore);
        blueprint.setInstanceMode(true);

        // Init with no asset token — should skip vault creation
        _initServiceNoAsset();

        // No vault should exist (skipped)
        assertEq(blueprint.instanceVault(serviceId), address(0));
    }

    function test_instance_mode_skips_no_signers() public {
        vm.prank(tangleCore);
        blueprint.setInstanceMode(true);

        // Build inputs with asset but no explicit signers, and pass empty operators
        address[] memory signers = new address[](0);
        bytes memory inputs = abi.encode(address(tokenA), signers, uint256(0), "Test", "TST");

        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), inputs, 0, address(0), 0);

        // Init with empty operators AND empty signers — should skip
        address[] memory emptyOps = new address[](0);
        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), emptyOps, 0);

        assertEq(blueprint.instanceVault(serviceId), address(0));
    }

    function test_instance_mode_uses_operators_as_default_signers() public {
        vm.prank(tangleCore);
        blueprint.setInstanceMode(true);

        // Build inputs with asset but NO explicit signers
        address[] memory signers = new address[](0);
        bytes memory inputs = abi.encode(
            address(tokenA),
            signers,
            uint256(0), // requiredSigs = 0 (will default to 1)
            "Op Vault",
            "oVLT"
        );

        vm.prank(tangleCore);
        blueprint.onRequest(requestId, address(0), new address[](0), inputs, 0, address(0), 0);

        address[] memory operators = new address[](2);
        operators[0] = op1;
        operators[1] = op2;

        vm.prank(tangleCore);
        blueprint.onServiceInitialized(0, requestId, serviceId, address(0), operators, 0);

        // Vault should be created using operators as signers
        address vault = blueprint.instanceVault(serviceId);
        assertTrue(vault != address(0), "vault should be created with operator signers");
    }

    function test_instance_mode_skips_without_factory() public {
        // Deploy fresh blueprint WITHOUT setting vault factory
        TradingBlueprint fresh = new TradingBlueprint();
        fresh.onBlueprintCreated(99, address(this), tangleCore);

        // Don't call setVaultFactory — vaultFactory is address(0)
        vm.prank(tangleCore);
        fresh.setInstanceMode(true);

        vm.prank(tangleCore);
        fresh.onRequest(requestId, address(0), new address[](0), _buildRequestInputsWithAsset(), 0, address(0), 0);

        address[] memory operators = new address[](1);
        operators[0] = op1;

        // Should not revert, just skip vault creation
        vm.prank(tangleCore);
        fresh.onServiceInitialized(0, requestId, serviceId, address(0), operators, 0);

        assertEq(fresh.instanceVault(serviceId), address(0));
    }
}
