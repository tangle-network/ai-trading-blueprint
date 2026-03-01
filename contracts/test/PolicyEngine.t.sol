// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Tests for PolicyEngine are run with a standalone instance
///         where the test contract is the owner (not the factory).
contract PolicyEngineTest is Setup {
    PolicyEngine public pe;
    address public testVault;
    address public testVault2;
    address public testToken;
    address public testTarget;

    function setUp() public override {
        super.setUp();

        // Deploy a standalone PolicyEngine owned by this test contract
        pe = new PolicyEngine();
        testVault = makeAddr("testVault");
        testVault2 = makeAddr("testVault2");
        testToken = address(tokenA);
        testTarget = makeAddr("target");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _defaultConfig() internal pure returns (PolicyEngine.PolicyConfig memory) {
        return PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 100, maxSlippageBps: 500});
    }

    function _initVault(address vault) internal {
        pe.initializeVault(vault, address(this), _defaultConfig());
    }

    function _setupWhitelists(address vault) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(vault, tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(vault, targets, true);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_initializeVault() public {
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        assertTrue(pe.isInitialized(testVault));
        (bool initialized, uint256 leverageCap, uint256 maxTradesPerHour, uint256 maxSlippageBps,) =
            pe.policies(testVault);
        assertTrue(initialized);
        assertEq(leverageCap, 30000);
        assertEq(maxTradesPerHour, 50);
        assertEq(maxSlippageBps, 300);
        assertEq(pe.vaultAdmin(testVault), owner);
    }

    function test_doubleInitReverts() public {
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.VaultAlreadyInitialized.selector, testVault));
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PER-VAULT ADMIN TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_vaultAdminCanUpdatePolicy() public {
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        // Vault admin (owner) can update leverage
        vm.prank(owner);
        pe.setLeverageCap(testVault, 80000);
        (, uint256 newLeverage,,,) = pe.policies(testVault);
        assertEq(newLeverage, 80000);

        // Vault admin can update whitelists
        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        vm.prank(owner);
        pe.setWhitelist(testVault, tokens, true);
        assertTrue(pe.tokenWhitelisted(testVault, testToken));
    }

    function test_nonAdminCannotUpdatePolicy() public {
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        // Random address cannot update leverage
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotVaultAdminOrOwner.selector));
        pe.setLeverageCap(testVault, 80000);
    }

    function test_transferVaultAdmin() public {
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        // Transfer admin to user
        vm.prank(owner);
        pe.setVaultAdmin(testVault, user);
        assertEq(pe.vaultAdmin(testVault), user);

        // Old admin (owner) can no longer update
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotVaultAdminOrOwner.selector));
        pe.setLeverageCap(testVault, 80000);

        // New admin (user) can update
        vm.prank(user);
        pe.setLeverageCap(testVault, 80000);
        (, uint256 newLeverage,,,) = pe.policies(testVault);
        assertEq(newLeverage, 80000);
    }

    function test_contractOwnerCanAlwaysUpdate() public {
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        // Contract owner (this) can update even though admin is owner
        pe.setLeverageCap(testVault, 99000);
        (, uint256 newLeverage,,,) = pe.policies(testVault);
        assertEq(newLeverage, 99000);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WHITELIST TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_tokenWhitelist() public {
        _initVault(testVault);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);

        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault, tokens, true);

        valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertTrue(valid);
    }

    function test_targetWhitelist() public {
        _initVault(testVault);

        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault, tokens, true);

        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertTrue(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // POSITION LIMIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_positionLimit() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setPositionLimit(testVault, testToken, 100 ether);

        bool valid = pe.validateTrade(testVault, testToken, 50 ether, testTarget, 0);
        assertTrue(valid);

        valid = pe.validateTrade(testVault, testToken, 200 ether, testTarget, 0);
        assertFalse(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LEVERAGE CAP TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_leverageCap_storedButNotEnforcedOnChain() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setLeverageCap(testVault, 30000);
        (, uint256 leverageCap,,,) = pe.policies(testVault);
        assertEq(leverageCap, 30000, "Leverage cap should be stored for off-chain use");

        // Leverage parameter is ignored on-chain — enforced by AI validators off-chain
        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 50000);
        assertTrue(valid, "On-chain validation should pass regardless of leverage value");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RATE LIMIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_rateLimit() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setRateLimit(testVault, 3);

        for (uint256 i = 0; i < 3; i++) {
            bool v = pe.validateTrade(testVault, testToken, 10 ether, testTarget, 0);
            assertTrue(v, "Trade should pass within rate limit");
        }

        bool valid = pe.validateTrade(testVault, testToken, 10 ether, testTarget, 0);
        assertFalse(valid);

        vm.warp(block.timestamp + 1 hours + 1);

        valid = pe.validateTrade(testVault, testToken, 10 ether, testTarget, 0);
        assertTrue(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MAX SLIPPAGE TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_maxSlippage() public {
        _initVault(testVault);

        pe.setMaxSlippage(testVault, 100);

        (,,, uint256 maxSlippageBps,) = pe.policies(testVault);
        assertEq(maxSlippageBps, 100);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UNINITIALIZED VAULT
    // ═══════════════════════════════════════════════════════════════════════════

    function test_validateUninitialized() public {
        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SEPARATE VAULT POLICIES
    // ═══════════════════════════════════════════════════════════════════════════

    function test_separateVaultPolicies() public {
        pe.initializeVault(
            testVault,
            owner,
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );
        pe.initializeVault(
            testVault2,
            user,
            PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 200, maxSlippageBps: 500})
        );

        _setupWhitelists(testVault);

        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertTrue(valid);

        valid = pe.validateTrade(testVault2, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);

        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault2, tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault2, targets, true);

        valid = pe.validateTrade(testVault2, testToken, 100 ether, testTarget, 0);
        assertTrue(valid);

        (, uint256 leverageCap1,,,) = pe.policies(testVault);
        (, uint256 leverageCap2,,,) = pe.policies(testVault2);
        assertEq(leverageCap1, 30000);
        assertEq(leverageCap2, 50000);

        // Verify different admins
        assertEq(pe.vaultAdmin(testVault), owner);
        assertEq(pe.vaultAdmin(testVault2), user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTHORIZED CALLER TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setAuthorizedCaller_emitsEvent() public {
        address caller = makeAddr("caller");

        vm.expectEmit(true, false, false, true);
        emit PolicyEngine.AuthorizedCallerUpdated(caller, true);
        pe.setAuthorizedCaller(caller, true);

        assertTrue(pe.authorizedCallers(caller), "Caller should be authorized");
    }

    function test_setAuthorizedCaller_revoke() public {
        address caller = makeAddr("caller");

        pe.setAuthorizedCaller(caller, true);
        assertTrue(pe.authorizedCallers(caller));

        vm.expectEmit(true, false, false, true);
        emit PolicyEngine.AuthorizedCallerUpdated(caller, false);
        pe.setAuthorizedCaller(caller, false);

        assertFalse(pe.authorizedCallers(caller), "Caller should be revoked");
    }

    function test_setAuthorizedCaller_onlyOwner() public {
        address caller = makeAddr("caller");

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        pe.setAuthorizedCaller(caller, true);
    }

    function test_unauthorizedCaller_reverts() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        // Non-authorized caller cannot validate trades
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotAuthorizedCaller.selector));
        pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
    }
}
