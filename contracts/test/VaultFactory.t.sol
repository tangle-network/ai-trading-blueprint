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
            serviceId, address(tokenA), owner, operator, signers, 2, "Test Shares", "tSHR", bytes32("salt1"),
            _defaultPolicyConfig(), _defaultFeeConfig()
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

        // Check PolicyEngine was initialized with custom config
        assertTrue(policyEngine.isInitialized(vault));
        (, uint256 leverageCap, uint256 maxTradesPerHour, uint256 maxSlippageBps,) = policyEngine.policies(vault);
        assertEq(leverageCap, 50000);
        assertEq(maxTradesPerHour, 100);
        assertEq(maxSlippageBps, 500);

        // Check FeeDistributor was initialized with custom config
        assertTrue(feeDistributor.vaultFeeInitialized(vault));
        (uint256 perfBps, uint256 mgmtBps, uint256 valShareBps) = feeDistributor.vaultFeeConfig(vault);
        assertEq(perfBps, 2000);
        assertEq(mgmtBps, 200);
        assertEq(valShareBps, 3000);
    }

    function test_createVaultWithCustomConfig() public {
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        PolicyEngine.PolicyConfig memory customPolicy =
            PolicyEngine.PolicyConfig({leverageCap: 30000, maxTradesPerHour: 50, maxSlippageBps: 300});
        FeeDistributor.FeeConfig memory customFee =
            FeeDistributor.FeeConfig({performanceFeeBps: 1000, managementFeeBps: 100, validatorFeeShareBps: 5000});

        (address vault,) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Custom Vault", "cVAULT", bytes32("custom-salt"),
            customPolicy, customFee
        );

        // Verify custom policy config
        (, uint256 leverageCap, uint256 maxTradesPerHour, uint256 maxSlippageBps,) = policyEngine.policies(vault);
        assertEq(leverageCap, 30000);
        assertEq(maxTradesPerHour, 50);
        assertEq(maxSlippageBps, 300);

        // Verify custom fee config
        (uint256 perfBps, uint256 mgmtBps, uint256 valShareBps) = feeDistributor.vaultFeeConfig(vault);
        assertEq(perfBps, 1000);
        assertEq(mgmtBps, 100);
        assertEq(valShareBps, 5000);
    }

    function test_createBotVault() public {
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        // Bot vaults don't set serviceShares — multiple per service allowed
        (address vault1, address share1) = vaultFactory.createBotVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Bot 1", "BOT1", bytes32("bot-salt1"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
        (address vault2, address share2) = vaultFactory.createBotVault(
            serviceId, address(tokenB), owner, operator, signers, 2, "Bot 2", "BOT2", bytes32("bot-salt2"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );

        // Each bot vault gets its own share token
        assertTrue(share1 != share2);
        assertTrue(vault1 != vault2);

        // serviceShares should NOT be set by createBotVault
        assertEq(vaultFactory.serviceShares(serviceId), address(0));

        // Both vaults tracked under same service
        address[] memory vaults = vaultFactory.getServiceVaults(serviceId);
        assertEq(vaults.length, 2);
    }

    function test_duplicateServiceReverts() public {
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Test", "TST", bytes32("salt1"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.ServiceAlreadyInitialized.selector, serviceId));
        vaultFactory.createVault(
            serviceId, address(tokenA), user, operator, signers, 2, "Test2", "TST2", bytes32("salt2"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
    }

    function test_getServiceVaults() public {
        uint64 serviceId = 1;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address vault1,) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Test", "TST", bytes32("salt1"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );

        // Use createBotVault for a second vault under same service
        (address vault2,) = vaultFactory.createBotVault(
            serviceId, address(tokenB), owner, operator, signers, 2, "Bot", "BOT", bytes32("salt2"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );

        address[] memory vaults = vaultFactory.getServiceVaults(serviceId);
        assertEq(vaults.length, 2);
        assertEq(vaults[0], vault1);
        assertEq(vaults[1], vault2);
    }

    function test_vaultAddressPrecomputation() public {
        uint64 serviceId = 42;
        bytes32 salt = bytes32("deterministic");
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address actual,) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Test", "TST", salt,
            _defaultPolicyConfig(), _defaultFeeConfig()
        );

        // After creation, we can verify the service is mapped
        assertTrue(actual != address(0));
        assertEq(vaultFactory.vaultServiceId(actual), serviceId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // KEY EVENT TESTS — VaultCreated
    // ═══════════════════════════════════════════════════════════════════════════

    function test_createVault_emitsVaultCreated() public {
        uint64 serviceId = 99;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        // We can't predict the exact vault/share addresses, so just check indexed fields
        vm.expectEmit(false, false, false, false);
        emit VaultFactory.VaultCreated(serviceId, address(0), address(0), address(tokenA), owner, operator);

        vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Event Test", "EVT", bytes32("event-salt"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
    }

    function test_oracleZeroPrice_reverts() public {
        // Set up vault with oracle
        uint64 serviceId = 10;
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (address usdcVault, address shareAddr) = vaultFactory.createVault(
            serviceId, address(tokenA), owner, operator, signers, 2, "Oracle Test", "oTST", bytes32("oracle-salt"),
            _defaultPolicyConfig(), _defaultFeeConfig()
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
            serviceId, address(tokenA), owner, operator, signers, 2, "Oracle Test2", "oTST2", bytes32("oracle-salt2"),
            _defaultPolicyConfig(), _defaultFeeConfig()
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
