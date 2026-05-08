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
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
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
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.VaultAlreadyInitialized.selector, testVault));
        pe.initializeVault(
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PER-VAULT ADMIN TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_vaultAdminCanUpdatePolicy() public {
        pe.initializeVault(
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
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
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );

        // Random address cannot update leverage
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotVaultAdminOrOwner.selector));
        pe.setLeverageCap(testVault, 80000);
    }

    function test_transferVaultAdmin() public {
        pe.initializeVault(
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
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
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
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

        bool valid = pe.checkTrade(testVault, testToken, 100 ether, testTarget);
        assertFalse(valid);

        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault, tokens, true);

        valid = pe.checkTrade(testVault, testToken, 100 ether, testTarget);
        assertTrue(valid);
    }

    function test_targetWhitelist() public {
        _initVault(testVault);

        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault, tokens, true);

        bool valid = pe.checkTrade(testVault, testToken, 100 ether, testTarget);
        assertFalse(valid);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        valid = pe.checkTrade(testVault, testToken, 100 ether, testTarget);
        assertTrue(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // POSITION LIMIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_positionLimit() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setPositionLimit(testVault, testToken, 100 ether);

        bool valid = pe.checkTrade(testVault, testToken, 50 ether, testTarget);
        assertTrue(valid);

        valid = pe.checkTrade(testVault, testToken, 200 ether, testTarget);
        assertFalse(valid);
    }

    function test_positionLimitIncludesCurrentVaultExposure() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        tokenA.mint(testVault, 75 ether);
        pe.setPositionLimit(testVault, testToken, 100 ether);

        bool valid = pe.checkTrade(testVault, testToken, 20 ether, testTarget);
        assertTrue(valid);

        valid = pe.checkTrade(testVault, testToken, 30 ether, testTarget);
        assertFalse(valid);
    }

    function test_nativeEthWithNoPositionLimitDoesNotCallZeroAddress() public {
        _initVault(testVault);
        pe.whitelistToken(testVault, address(0), true);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        bool valid = pe.checkTrade(testVault, address(0), 5 ether, testTarget);
        assertTrue(valid);
    }

    function test_nativeEthPositionLimitUsesVaultBalance() public {
        _initVault(testVault);
        pe.whitelistToken(testVault, address(0), true);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        vm.deal(testVault, 75 ether);
        pe.setPositionLimit(testVault, address(0), 100 ether);

        bool valid = pe.checkTrade(testVault, address(0), 20 ether, testTarget);
        assertTrue(valid);
    }

    function test_nativeEthPositionLimitRejectsOverLimitWithoutZeroAddressRevert() public {
        _initVault(testVault);
        pe.whitelistToken(testVault, address(0), true);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        vm.deal(testVault, 75 ether);
        pe.setPositionLimit(testVault, address(0), 100 ether);

        bool valid = pe.checkTrade(testVault, address(0), 30 ether, testTarget);
        assertFalse(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LEVERAGE CAP TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice H-3: leverageCap stored in policy and enforced on-chain by
    ///         TradingVault._executeHealthFactor at the post-borrow / post-withdraw
    ///         site. PolicyEngine itself only stores the value; the trading vault
    ///         is responsible for asserting against Aave health data.
    function test_leverageCap_storedAndExposed() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setLeverageCap(testVault, 30000);
        (, uint256 leverageCap,,,) = pe.policies(testVault);
        assertEq(leverageCap, 30000, "Leverage cap should be stored");

        // checkTrade itself does not gate on leverage — the cap binds at the
        // health-factor executor in TradingVault.
        bool valid = pe.checkTrade(testVault, testToken, 100 ether, testTarget);
        assertTrue(valid, "checkTrade ignores leverageCap; the vault enforces it");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RATE LIMIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_rateLimit() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setRateLimit(testVault, 3);
        // recordTrade is onlyAuthorizedOrOwner; treat the vault address as the caller.
        pe.setAuthorizedCaller(testVault, true);

        for (uint256 i = 0; i < 3; i++) {
            bool v = pe.checkTrade(testVault, testToken, 10 ether, testTarget);
            assertTrue(v, "Trade should pass within rate limit");
            vm.prank(testVault);
            pe.recordTrade(testVault);
        }

        bool valid = pe.checkTrade(testVault, testToken, 10 ether, testTarget);
        assertFalse(valid, "Fourth trade exceeds rate limit");

        vm.warp(block.timestamp + 1 hours + 1);

        valid = pe.checkTrade(testVault, testToken, 10 ether, testTarget);
        assertTrue(valid, "Trade resumes after the hour rolls over");
    }

    /// @notice H-5: a failed trade does not burn a rate-limit slot. checkTrade is a
    ///         pure view; only `recordTrade` (called post-success in TradingVault)
    ///         consumes a slot.
    function test_rateLimit_failedTradeDoesNotBurnSlot() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setRateLimit(testVault, 2);
        pe.setAuthorizedCaller(testVault, true);

        // Successful trade #1 — record consumed.
        assertTrue(pe.checkTrade(testVault, testToken, 10 ether, testTarget));
        vm.prank(testVault);
        pe.recordTrade(testVault);

        // Trade #2 passes the check but the executor reverts — recordTrade NOT called.
        assertTrue(pe.checkTrade(testVault, testToken, 10 ether, testTarget));

        // Slot is still reusable: trade #3 passes the check and gets the second slot.
        assertTrue(pe.checkTrade(testVault, testToken, 10 ether, testTarget));
        vm.prank(testVault);
        pe.recordTrade(testVault);

        // Both real slots now consumed; further checks fail.
        assertFalse(pe.checkTrade(testVault, testToken, 10 ether, testTarget));
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
        bool valid = pe.checkTrade(testVault, testToken, 100 ether, testTarget);
        assertFalse(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SEPARATE VAULT POLICIES
    // ═══════════════════════════════════════════════════════════════════════════

    function test_separateVaultPolicies() public {
        pe.initializeVault(
            testVault, owner, PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300})
        );
        pe.initializeVault(
            testVault2,
            user,
            PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 200, maxSlippageBps: 500})
        );

        _setupWhitelists(testVault);

        bool valid = pe.checkTrade(testVault, testToken, 100 ether, testTarget);
        assertTrue(valid);

        valid = pe.checkTrade(testVault2, testToken, 100 ether, testTarget);
        assertFalse(valid);

        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault2, tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault2, targets, true);

        valid = pe.checkTrade(testVault2, testToken, 100 ether, testTarget);
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

    function test_unauthorizedCaller_cannotRecordTrade() public {
        _initVault(testVault);
        _setupWhitelists(testVault);
        pe.setRateLimit(testVault, 5);

        // checkTrade is permissionless view — no auth needed. The auth gate is on
        // recordTrade, which mutates the rate-limit ring buffer.
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotAuthorizedCaller.selector));
        pe.recordTrade(testVault);
    }
}
