// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

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

    function _initVault(address vault) internal {
        pe.initializeVault(vault, 50000, 100, 500); // 5x leverage, 100 trades/hr, 5% slippage
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
        pe.initializeVault(testVault, 30000, 50, 300);

        assertTrue(pe.isInitialized(testVault));
        (bool initialized, uint256 leverageCap, uint256 maxTradesPerHour, uint256 maxSlippageBps,) =
            pe.policies(testVault);
        assertTrue(initialized);
        assertEq(leverageCap, 30000);
        assertEq(maxTradesPerHour, 50);
        assertEq(maxSlippageBps, 300);
    }

    function test_doubleInitReverts() public {
        pe.initializeVault(testVault, 30000, 50, 300);

        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.VaultAlreadyInitialized.selector, testVault));
        pe.initializeVault(testVault, 30000, 50, 300);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WHITELIST TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_tokenWhitelist() public {
        _initVault(testVault);

        // Only whitelist target but not token
        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        // Trade should fail (token not whitelisted)
        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);

        // Now whitelist the token
        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault, tokens, true);

        // Trade should pass
        valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertTrue(valid);
    }

    function test_targetWhitelist() public {
        _initVault(testVault);

        // Only whitelist token but not target
        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault, tokens, true);

        // Trade should fail (target not whitelisted)
        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);

        // Now whitelist the target
        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault, targets, true);

        // Trade should pass
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

        // Within limit
        bool valid = pe.validateTrade(testVault, testToken, 50 ether, testTarget, 0);
        assertTrue(valid);

        // Exceeding limit
        valid = pe.validateTrade(testVault, testToken, 200 ether, testTarget, 0);
        assertFalse(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LEVERAGE CAP TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_leverageCap() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setLeverageCap(testVault, 30000); // 3x

        // Within leverage
        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 20000); // 2x
        assertTrue(valid);

        // Exceeding leverage
        valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 50000); // 5x
        assertFalse(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RATE LIMIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_rateLimit() public {
        _initVault(testVault);
        _setupWhitelists(testVault);

        pe.setRateLimit(testVault, 3);

        // First 3 trades should pass
        for (uint256 i = 0; i < 3; i++) {
            bool v = pe.validateTrade(testVault, testToken, 10 ether, testTarget, 0);
            assertTrue(v, "Trade should pass within rate limit");
        }

        // 4th trade should fail (rate limit exceeded)
        bool valid = pe.validateTrade(testVault, testToken, 10 ether, testTarget, 0);
        assertFalse(valid);

        // Advance time past the 1-hour window
        vm.warp(block.timestamp + 1 hours + 1);

        // Should now pass
        valid = pe.validateTrade(testVault, testToken, 10 ether, testTarget, 0);
        assertTrue(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MAX SLIPPAGE TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_maxSlippage() public {
        _initVault(testVault);

        pe.setMaxSlippage(testVault, 100); // 1%

        (,,, uint256 maxSlippageBps,) = pe.policies(testVault);
        assertEq(maxSlippageBps, 100);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UNINITIALIZED VAULT
    // ═══════════════════════════════════════════════════════════════════════════

    function test_validateUninitialized() public {
        // Don't initialize the vault, just try to validate
        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SEPARATE VAULT POLICIES
    // ═══════════════════════════════════════════════════════════════════════════

    function test_separateVaultPolicies() public {
        // Initialize both vaults with different parameters
        pe.initializeVault(testVault, 30000, 50, 300);
        pe.initializeVault(testVault2, 50000, 200, 500);

        // Whitelist tokens/targets for vault1 only
        _setupWhitelists(testVault);

        // vault1 should pass
        bool valid = pe.validateTrade(testVault, testToken, 100 ether, testTarget, 0);
        assertTrue(valid);

        // vault2 should fail (no whitelists set up for vault2)
        valid = pe.validateTrade(testVault2, testToken, 100 ether, testTarget, 0);
        assertFalse(valid);

        // Setup whitelists for vault2 now
        address[] memory tokens = new address[](1);
        tokens[0] = testToken;
        pe.setWhitelist(testVault2, tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = testTarget;
        pe.setTargetWhitelist(testVault2, targets, true);

        // vault2 should now pass
        valid = pe.validateTrade(testVault2, testToken, 100 ether, testTarget, 0);
        assertTrue(valid);

        // Verify leverage caps are independent
        (, uint256 leverageCap1,,,) = pe.policies(testVault);
        (, uint256 leverageCap2,,,) = pe.policies(testVault2);
        assertEq(leverageCap1, 30000);
        assertEq(leverageCap2, 50000);
    }
}
