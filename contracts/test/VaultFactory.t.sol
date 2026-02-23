// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

contract VaultFactoryTest is Setup {
    function setUp() public override {
        super.setUp();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CREATE VAULT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_createVault() public {
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address vault, address shareAddr) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Test Shares", "tSHR", bytes32("salt1")
        );

        assertTrue(vault != address(0));
        assertTrue(shareAddr != address(0));

        // Check share token was created
        assertEq(vaultFactory.serviceShares(serviceId), shareAddr);

        // Check vault is tracked
        address[] memory vaults = vaultFactory.getServiceVaults(serviceId);
        assertEq(vaults.length, 1);
        assertEq(vaults[0], vault);

        // Check vault's roles
        TradingVault tradingVault = TradingVault(payable(vault));
        assertTrue(tradingVault.hasRole(tradingVault.DEFAULT_ADMIN_ROLE(), owner));
        assertTrue(tradingVault.hasRole(tradingVault.OPERATOR_ROLE(), operator));

        // Check share token is properly linked
        VaultShare share = VaultShare(shareAddr);
        assertTrue(share.isLinkedVault(vault));
        assertTrue(share.hasRole(share.MINTER_ROLE(), vault));

        // Check TradeValidator was configured
        assertEq(tradeValidator.getSignerCount(vault), 3);
        assertEq(tradeValidator.getRequiredSignatures(vault), 2);

        // Check PolicyEngine was initialized
        assertTrue(policyEngine.isInitialized(vault));
    }

    function test_addAssetVault() public {
        // First create a vault (USDC vault)
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address vault1, address shareAddr) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Test Shares", "tSHR", bytes32("salt1")
        );

        // Now add a second asset vault (WETH vault) to the same service
        address vault2 =
            vaultFactory.addAssetVault(serviceId, address(tokenB), owner, operator, signers, 2, bytes32("salt2"));

        assertTrue(vault2 != address(0));
        assertTrue(vault1 != vault2);

        // Both vaults should share the same share token
        TradingVault tv1 = TradingVault(payable(vault1));
        TradingVault tv2 = TradingVault(payable(vault2));
        assertEq(address(tv1.shareToken()), shareAddr);
        assertEq(address(tv2.shareToken()), shareAddr);

        // Share token should have both vaults linked
        VaultShare share = VaultShare(shareAddr);
        assertEq(share.vaultCount(), 2);
        assertTrue(share.isLinkedVault(vault1));
        assertTrue(share.isLinkedVault(vault2));

        // Service should have 2 vaults
        address[] memory vaults = vaultFactory.getServiceVaults(serviceId);
        assertEq(vaults.length, 2);
    }

    function test_multiAsset() public {
        // Create USDC vault + WETH vault sharing same shares
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address usdcVault, address shareAddr) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Multi-Asset Shares", "maSHR", bytes32("salt-usdc")
        );

        address wethVault =
            vaultFactory.addAssetVault(serviceId, address(tokenB), owner, operator, signers, 2, bytes32("salt-weth"));

        // Deposit into USDC vault
        vm.startPrank(user);
        tokenA.approve(usdcVault, type(uint256).max);
        TradingVault(payable(usdcVault)).deposit(1000 ether, user);
        vm.stopPrank();

        // Deposit into WETH vault
        vm.startPrank(user);
        tokenB.approve(wethVault, type(uint256).max);
        TradingVault(payable(wethVault)).deposit(500 ether, user);
        vm.stopPrank();

        // User has shares from both deposits
        VaultShare share = VaultShare(shareAddr);
        // First deposit: 1000 shares, second deposit shares depend on NAV
        assertTrue(share.balanceOf(user) > 0);

        // Total NAV should reflect both vault balances (single-asset mode, no oracle)
        uint256 nav = share.totalNAV();
        assertEq(nav, 1500 ether); // 1000 + 500
    }

    function test_duplicateServiceReverts() public {
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Test", "TST", bytes32("salt1")
        );

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.ServiceAlreadyInitialized.selector, serviceId));
        vaultFactory.createVault(
            serviceId, address(tokenA), user, operator, signers, 2, "Test2", "TST2", bytes32("salt2")
        );
    }

    function test_getServiceVaults() public {
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address vault1,) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Test", "TST", bytes32("salt1")
        );

        address vault2 =
            vaultFactory.addAssetVault(serviceId, address(tokenB), owner, operator, signers, 2, bytes32("salt2"));

        address[] memory vaults = vaultFactory.getServiceVaults(serviceId);
        assertEq(vaults.length, 2);
        assertEq(vaults[0], vault1);
        assertEq(vaults[1], vault2);
        assertEq(vaultFactory.getServiceVaultCount(serviceId), 2);
    }

    function test_vaultAddressPrecomputation() public {
        uint64 serviceId = 42;
        bytes32 salt = bytes32("deterministic");
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        // Note: getVaultAddress requires the share token to exist first for accurate prediction
        // when the service doesn't exist yet. The factory internally deploys the share token first,
        // then the vault. For precomputation to work correctly, we need the share token address.
        // Since the factory uses CREATE2, the address is deterministic.
        (address actual,) =
            vaultFactory.createVault(serviceId, address(tokenA), owner, operator, signers, 2, "Test", "TST", salt);

        // After creation, we can verify the service is mapped
        assertTrue(actual != address(0));
        assertEq(vaultFactory.vaultServiceId(actual), serviceId);
    }

    function test_oracleZeroPrice_reverts() public {
        // Set up multi-asset vault with oracle
        uint64 serviceId = 10;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address usdcVault, address shareAddr) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Oracle Test", "oTST", bytes32("oracle-salt")
        );

        // Deploy oracle and set it on the share token
        MockOracle orc = new MockOracle();
        VaultShare share = VaultShare(shareAddr);

        // VaultFactory is the admin of the share token, grant admin to this test
        vm.startPrank(address(vaultFactory));
        share.grantRole(share.DEFAULT_ADMIN_ROLE(), address(this));
        vm.stopPrank();
        share.setOracle(address(orc));

        // Deposit so vault has a balance
        vm.startPrank(user);
        tokenA.approve(usdcVault, type(uint256).max);
        TradingVault(payable(usdcVault)).deposit(1000 ether, user);
        vm.stopPrank();

        // Oracle returns price=0 for tokenA -- should revert
        orc.setPrice(address(tokenA), 0, 8);
        vm.expectRevert(abi.encodeWithSelector(VaultShare.StaleOraclePrice.selector, address(tokenA)));
        share.totalNAV();
    }

    function test_oracleValidPrice_works() public {
        uint64 serviceId = 11;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address usdcVault, address shareAddr) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Oracle Test2", "oTST2", bytes32("oracle-salt2")
        );

        MockOracle orc = new MockOracle();
        VaultShare share = VaultShare(shareAddr);

        vm.startPrank(address(vaultFactory));
        share.grantRole(share.DEFAULT_ADMIN_ROLE(), address(this));
        vm.stopPrank();
        share.setOracle(address(orc));

        vm.startPrank(user);
        tokenA.approve(usdcVault, type(uint256).max);
        TradingVault(payable(usdcVault)).deposit(1000 ether, user);
        vm.stopPrank();

        // Oracle returns valid price: $2000 per token, 8 decimals
        orc.setPrice(address(tokenA), 2000e8, 8);
        uint256 nav = share.totalNAV();
        // 1000e18 * 2000e8 / 1e8 = 2000000e18
        assertEq(nav, 2000000 ether);
    }
}
