// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Tests for VaultShare in isolation
contract VaultShareTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;

    function setUp() public override {
        super.setUp();
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LINKING / UNLINKING
    // ═══════════════════════════════════════════════════════════════════════════

    function test_linkVault_emitsEvent() public {
        // Deploy a fresh share token owned by this contract (not the factory)
        VaultShare fresh = new VaultShare("Fresh", "FRH", address(this));

        address fakeVault = makeAddr("fakeVault");

        vm.expectEmit(true, false, false, true);
        emit VaultShare.VaultLinked(fakeVault);
        fresh.linkVault(fakeVault);

        assertTrue(fresh.isLinkedVault(fakeVault));
        assertEq(fresh.vaultCount(), 1);
    }

    function test_linkVault_duplicateReverts() public {
        VaultShare fresh = new VaultShare("Fresh", "FRH", address(this));
        address fakeVault = makeAddr("fakeVault");

        fresh.linkVault(fakeVault);

        vm.expectRevert(abi.encodeWithSelector(VaultShare.VaultAlreadyLinked.selector, fakeVault));
        fresh.linkVault(fakeVault);
    }

    function test_linkVault_zeroAddressReverts() public {
        VaultShare fresh = new VaultShare("Fresh", "FRH", address(this));

        vm.expectRevert(abi.encodeWithSelector(VaultShare.ZeroAddress.selector));
        fresh.linkVault(address(0));
    }

    function test_unlinkVault_revokesMinterRole() public {
        VaultShare fresh = new VaultShare("Fresh", "FRH", address(this));
        address fakeVault = makeAddr("fakeVault");

        fresh.linkVault(fakeVault);
        fresh.grantRole(fresh.MINTER_ROLE(), fakeVault);
        assertTrue(fresh.hasRole(fresh.MINTER_ROLE(), fakeVault));

        vm.expectEmit(true, false, false, true);
        emit VaultShare.VaultUnlinked(fakeVault);
        fresh.unlinkVault(fakeVault);

        assertFalse(fresh.isLinkedVault(fakeVault));
        assertFalse(fresh.hasRole(fresh.MINTER_ROLE(), fakeVault));
        assertEq(fresh.vaultCount(), 0);
    }

    function test_unlinkVault_notLinkedReverts() public {
        VaultShare fresh = new VaultShare("Fresh", "FRH", address(this));
        address fakeVault = makeAddr("fakeVault");

        vm.expectRevert(abi.encodeWithSelector(VaultShare.VaultNotLinked.selector, fakeVault));
        fresh.unlinkVault(fakeVault);
    }

    function test_linkVault_onlyAdmin() public {
        VaultShare fresh = new VaultShare("Fresh", "FRH", address(this));
        bytes32 adminRole = fresh.DEFAULT_ADMIN_ROLE();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, adminRole
        ));
        fresh.linkVault(makeAddr("vault"));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MINT / BURN ACCESS CONTROL
    // ═══════════════════════════════════════════════════════════════════════════

    function test_mint_onlyMinterRole() public {
        bytes32 minterRole = shareToken.MINTER_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, minterRole
        ));
        shareToken.mint(user, 100 ether);
    }

    function test_burn_onlyMinterRole() public {
        bytes32 minterRole = shareToken.MINTER_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, minterRole
        ));
        shareToken.burn(user, 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TOTAL NAV
    // ═══════════════════════════════════════════════════════════════════════════

    function test_totalNAV_singleVault() public {
        // Deposit to vault
        vm.startPrank(user);
        tokenA.approve(address(vault), 1000 ether);
        vault.deposit(1000 ether, user);
        vm.stopPrank();

        // totalNAV should include vault's totalAssets
        assertEq(shareToken.totalNAV(), vault.totalAssets());
    }

    function test_totalNAV_emptyVault() public view {
        // No deposits — totalNAV should be 0
        assertEq(shareToken.totalNAV(), 0);
    }

    function test_totalNAV_multiVault() public {
        // Create a standalone share token and link two vaults manually
        VaultShare multiShare = new VaultShare("Multi", "MULTI", address(this));

        // Deploy two vaults with the same share token but different deposit assets
        TradingVault vault1 = new TradingVault(
            address(tokenA), multiShare, policyEngine, tradeValidator, feeDistributor, address(this), operator
        );
        TradingVault vault2 = new TradingVault(
            address(tokenB), multiShare, policyEngine, tradeValidator, feeDistributor, address(this), operator
        );

        // Link both vaults and grant minter role
        multiShare.linkVault(address(vault1));
        multiShare.linkVault(address(vault2));
        multiShare.grantRole(multiShare.MINTER_ROLE(), address(vault1));
        multiShare.grantRole(multiShare.MINTER_ROLE(), address(vault2));

        // Initialize policy for both vaults so deposits work
        // (policyEngine is owned by vaultFactory, use its address)
        vm.startPrank(address(vaultFactory));
        policyEngine.initializeVault(address(vault1), address(this), PolicyEngine.PolicyConfig(50000, 100, 500));
        policyEngine.initializeVault(address(vault2), address(this), PolicyEngine.PolicyConfig(50000, 100, 500));
        feeDistributor.initializeVaultFees(address(vault1), address(this), FeeDistributor.FeeConfig(2000, 200, 3000));
        feeDistributor.initializeVaultFees(address(vault2), address(this), FeeDistributor.FeeConfig(2000, 200, 3000));
        vm.stopPrank();

        // Deposit tokenA into vault1
        tokenA.mint(address(this), 5000 ether);
        tokenA.approve(address(vault1), 5000 ether);
        vault1.deposit(5000 ether, address(this));

        // Deposit tokenB into vault2
        tokenB.mint(address(this), 3000 ether);
        tokenB.approve(address(vault2), 3000 ether);
        vault2.deposit(3000 ether, address(this));

        // totalNAV should be sum of both vaults (no oracle = raw asset units)
        uint256 nav = multiShare.totalNAV();
        assertEq(nav, 5000 ether + 3000 ether, "Multi-vault NAV should sum both vaults");
        assertEq(multiShare.vaultCount(), 2, "Should have 2 linked vaults");
    }

    function test_totalNAV_multiVault_withOracle() public {
        VaultShare multiShare = new VaultShare("Multi", "MULTI", address(this));
        MockOracle mockOracle = new MockOracle();
        multiShare.setOracle(address(mockOracle));

        TradingVault vault1 = new TradingVault(
            address(tokenA), multiShare, policyEngine, tradeValidator, feeDistributor, address(this), operator
        );
        TradingVault vault2 = new TradingVault(
            address(tokenB), multiShare, policyEngine, tradeValidator, feeDistributor, address(this), operator
        );

        multiShare.linkVault(address(vault1));
        multiShare.linkVault(address(vault2));
        multiShare.grantRole(multiShare.MINTER_ROLE(), address(vault1));
        multiShare.grantRole(multiShare.MINTER_ROLE(), address(vault2));

        vm.startPrank(address(vaultFactory));
        policyEngine.initializeVault(address(vault1), address(this), PolicyEngine.PolicyConfig(50000, 100, 500));
        policyEngine.initializeVault(address(vault2), address(this), PolicyEngine.PolicyConfig(50000, 100, 500));
        feeDistributor.initializeVaultFees(address(vault1), address(this), FeeDistributor.FeeConfig(2000, 200, 3000));
        feeDistributor.initializeVaultFees(address(vault2), address(this), FeeDistributor.FeeConfig(2000, 200, 3000));
        vm.stopPrank();

        // Set oracle prices: tokenA = $1, tokenB = $2000 (8 decimals)
        mockOracle.setPrice(address(tokenA), 1e8, 8);
        mockOracle.setPrice(address(tokenB), 2000e8, 8);

        // Deposit
        tokenA.mint(address(this), 10000 ether);
        tokenA.approve(address(vault1), 10000 ether);
        vault1.deposit(10000 ether, address(this));

        tokenB.mint(address(this), 5 ether);
        tokenB.approve(address(vault2), 5 ether);
        vault2.deposit(5 ether, address(this));

        // NAV = 10000e18 * 1e8 / 1e8 + 5e18 * 2000e8 / 1e8
        //     = 10000e18 + 10000e18 = 20000e18
        uint256 nav = multiShare.totalNAV();
        assertEq(nav, 20000 ether, "Oracle-based multi-vault NAV should sum USD values");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ORACLE
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setOracle_emitsEvent() public {
        VaultShare fresh = new VaultShare("Fresh", "FRH", address(this));
        MockOracle mockOracle = new MockOracle();

        vm.expectEmit(true, false, false, true);
        emit VaultShare.OracleUpdated(address(mockOracle));
        fresh.setOracle(address(mockOracle));

        assertEq(address(fresh.oracle()), address(mockOracle));
    }

    function test_setOracle_onlyAdmin() public {
        bytes32 adminRole = shareToken.DEFAULT_ADMIN_ROLE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, user, adminRole
        ));
        shareToken.setOracle(address(1));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERC-7575 SHARE VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    function test_shareView() public view {
        assertEq(vault.share(), address(shareToken));
    }

    function test_assetView() public view {
        assertEq(vault.asset(), address(tokenA));
    }
}
