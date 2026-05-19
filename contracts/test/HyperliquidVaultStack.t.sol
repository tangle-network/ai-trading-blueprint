// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/HyperliquidVault.sol";
import "../src/HyperliquidVaultDeployer.sol";
import "../src/HyperliquidVaultFactory.sol";
import "../src/VaultShare.sol";
import "../src/VaultShareDeployer.sol";
import "./helpers/Setup.sol";

contract HyperliquidMockCoreWriter {
    bytes public lastAction;
    address public lastSender;

    function sendRawAction(bytes calldata action) external {
        lastSender = msg.sender;
        lastAction = action;
    }
}

contract HyperliquidVaultStackTest is Test {
    address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

    MockERC20 internal usdc;
    HyperliquidVault internal implementation;
    HyperliquidVaultFactory internal factory;
    HyperliquidVaultDeployer internal vaultDeployer;
    VaultShareDeployer internal shareDeployer;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal user = makeAddr("user");
    address internal validator1 = makeAddr("validator1");
    address internal validator2 = makeAddr("validator2");
    address internal validator3 = makeAddr("validator3");
    address internal agentWallet = makeAddr("agentWallet");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        implementation = new HyperliquidVault();
        factory = new HyperliquidVaultFactory();
        vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        shareDeployer = new VaultShareDeployer(address(factory));
        factory.setVaultDeployers(vaultDeployer, shareDeployer);
    }

    function test_createBotVault_emitsCompatibleEventAndTracksVault() public {
        vm.recordLogs();

        (address vault, address share) = _createBotVault(1, bytes32("event-salt"));

        assertTrue(vault != address(0));
        assertTrue(share != address(0));
        assertEq(factory.vaultServiceId(vault), 1);

        address[] memory vaults = factory.getServiceVaults(1);
        assertEq(vaults.length, 1);
        assertEq(vaults[0], vault);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 eventSig = keccak256("VaultCreated(uint64,address,address,address,address,address)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 4 && logs[i].topics[0] == eventSig) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), vault);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), share);
                found = true;
            }
        }
        assertTrue(found, "compatible VaultCreated event not emitted");
    }

    function test_createdVaultSupportsDepositRedeemAndShareAccounting() public {
        (address vaultAddr, address shareAddr) = _createBotVault(1, bytes32("deposit-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        VaultShare share = VaultShare(shareAddr);

        assertEq(vault.asset(), address(usdc));
        assertEq(vault.share(), shareAddr);
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), operator));
        assertTrue(vault.hasRole(vault.ACCOUNTANT_ROLE(), admin));
        assertTrue(vault.hasRole(vault.ACCOUNTANT_ROLE(), operator));
        assertTrue(share.isLinkedVault(vaultAddr));
        assertTrue(share.hasRole(share.MINTER_ROLE(), vaultAddr));

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1_000e6);
        uint256 shares = vault.deposit(1_000e6, user);
        assertEq(shares, 1_000e6);
        assertEq(share.balanceOf(user), 1_000e6);
        assertEq(vault.totalAssets(), 1_000e6);

        uint256 assets = vault.redeem(400e6, user, user);
        vm.stopPrank();

        assertEq(assets, 400e6);
        assertEq(usdc.balanceOf(user), 400e6);
        assertEq(share.balanceOf(user), 600e6);
        assertEq(vault.totalAssets(), 600e6);
    }

    function test_hyperliquidAccountingMakesSharesNavAwareButLiquidityBound() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("accounting-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1_000e6);
        uint256 shares = vault.deposit(1_000e6, user);
        vm.stopPrank();
        assertEq(shares, 1_000e6);
        assertEq(vault.idleAssets(), 1_000e6);

        vm.prank(operator);
        vault.setHyperliquidAccountAssets(9_000e6);
        assertEq(vault.totalAssets(), 10_000e6);
        assertEq(vault.maxWithdraw(user), 1_000e6);
        assertEq(vault.maxRedeem(user), 100e6);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidVault.InsufficientLiquidity.selector, 2_000e6, 1_000e6));
        vault.redeem(200e6, user, user);

        // Simulate liquidity coming back from HyperCore while NAV stays constant.
        usdc.mint(vaultAddr, 1_000e6);
        vm.prank(operator);
        vault.setHyperliquidAccountAssets(8_000e6);

        vm.prank(user);
        uint256 assets = vault.redeem(200e6, user, user);
        assertEq(assets, 2_000e6);
        assertEq(vault.totalAssets(), 8_000e6);
    }

    function test_staleHyperliquidAccountingBlocksUserFlows() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("stale-accounting-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        vm.prank(admin);
        vault.setMaxAccountingStaleness(1);

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1_000e6);
        vault.deposit(1_000e6, user);
        vm.stopPrank();

        vm.warp(block.timestamp + 2);
        assertFalse(vault.isAccountingFresh());
        assertEq(vault.maxDeposit(user), 0);
        assertEq(vault.maxWithdraw(user), 0);
        assertEq(vault.maxRedeem(user), 0);

        vm.startPrank(user);
        vm.expectRevert();
        vault.deposit(1e6, user);
        vm.expectRevert();
        vault.redeem(1e6, user, user);
        vm.stopPrank();

        vm.prank(operator);
        vault.setHyperliquidAccountAssets(0);
        assertTrue(vault.isAccountingFresh());
    }

    function test_queuedRedeemLocksSharesAndFulfillsAtFreshNavFifo() public {
        (address vaultAddr, address shareAddr) = _createBotVault(1, bytes32("queued-redeem-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        VaultShare share = VaultShare(shareAddr);
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");

        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(vaultAddr, 1_000e6);
        vault.deposit(1_000e6, alice);
        vm.stopPrank();
        vm.startPrank(bob);
        usdc.approve(vaultAddr, 1_000e6);
        vault.deposit(1_000e6, bob);
        vm.stopPrank();

        vm.prank(operator);
        vault.setHyperliquidAccountAssets(8_000e6);
        assertEq(vault.accountingShareSupply(), 2_000e6);
        assertEq(vault.totalAssets(), 10_000e6);

        vm.prank(alice);
        uint256 aliceRequest = vault.requestRedeem(500e6, alice, alice);
        vm.prank(bob);
        uint256 bobRequest = vault.requestRedeem(100e6, bob, bob);

        assertEq(aliceRequest, 1);
        assertEq(bobRequest, 2);
        assertEq(share.balanceOf(alice), 500e6);
        assertEq(share.balanceOf(bob), 900e6);
        assertEq(vault.pendingRedeemShares(), 600e6);
        assertEq(vault.accountingShareSupply(), 2_000e6);
        assertEq(vault.nextFulfillableWithdrawalRequestId(), 1);

        vm.expectRevert(abi.encodeWithSelector(HyperliquidVault.WithdrawalQueueOutOfOrder.selector, 1, 2));
        vault.fulfillRedeem(bobRequest);

        vm.expectRevert(abi.encodeWithSelector(HyperliquidVault.InsufficientLiquidity.selector, 2_500e6, 2_000e6));
        vault.fulfillRedeem(aliceRequest);

        usdc.mint(vaultAddr, 3_000e6);
        vm.prank(operator);
        vault.setHyperliquidAccountAssets(5_000e6);

        uint256 aliceBalanceBefore = usdc.balanceOf(alice);
        uint256 fulfilledAssets = vault.fulfillRedeem(aliceRequest);
        assertEq(fulfilledAssets, 2_500e6);
        assertEq(usdc.balanceOf(alice), aliceBalanceBefore + 2_500e6);
        assertEq(vault.pendingRedeemShares(), 100e6);
        assertEq(vault.nextFulfillableWithdrawalRequestId(), 2);
    }

    function test_queuedRedeemCanBeCancelledBeforeFulfillment() public {
        (address vaultAddr, address shareAddr) = _createBotVault(1, bytes32("cancel-redeem-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        VaultShare share = VaultShare(shareAddr);

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1_000e6);
        vault.deposit(1_000e6, user);
        uint256 requestId = vault.requestRedeem(250e6, user, user);
        assertEq(share.balanceOf(user), 750e6);
        uint256 cancelledShares = vault.cancelRedeem(requestId);
        vm.stopPrank();

        assertEq(cancelledShares, 250e6);
        assertEq(share.balanceOf(user), 1_000e6);
        assertEq(vault.pendingRedeemShares(), 0);
        assertEq(vault.nextFulfillableWithdrawalRequestId(), 2);

        vm.expectRevert(HyperliquidVault.WithdrawalAlreadyFinalized.selector);
        vault.fulfillRedeem(requestId);
    }

    function test_adminCanSubmitHyperliquidApiWalletApproval() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("corewriter-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        HyperliquidMockCoreWriter mock = new HyperliquidMockCoreWriter();
        vm.etch(CORE_WRITER, address(mock).code);

        string memory agentName = "bot-1";
        bytes memory expectedAction = abi.encodePacked(uint8(1), bytes3(uint24(9)), abi.encode(agentWallet, agentName));

        vm.prank(admin);
        vault.approveHyperliquidApiWallet(agentWallet, agentName);

        HyperliquidMockCoreWriter coreWriter = HyperliquidMockCoreWriter(CORE_WRITER);
        assertEq(coreWriter.lastSender(), vaultAddr);
        assertEq(coreWriter.lastAction(), expectedAction);
    }

    function test_nonAdminCannotSubmitHyperliquidApiWalletApproval() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("non-admin-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        vm.prank(operator);
        vm.expectRevert();
        vault.approveHyperliquidApiWallet(agentWallet, "bot-1");
    }

    function test_zeroApiWalletReverts() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("zero-wallet-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        vm.prank(admin);
        vm.expectRevert(HyperliquidVault.ZeroAddress.selector);
        vault.approveHyperliquidApiWallet(address(0), "bot-1");
    }

    function test_createBotVaultRejectsSignerConfigsBelowContractFloor() public {
        address[] memory twoSigners = new address[](2);
        twoSigners[0] = validator1;
        twoSigners[1] = validator2;

        vm.expectRevert(HyperliquidVaultFactory.InvalidSignerConfig.selector);
        factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            twoSigners,
            2,
            "Bad",
            "BAD",
            bytes32("bad-two"),
            _defaultPolicyConfig(),
            _defaultFeeConfig()
        );

        address[] memory threeSigners = _signers();
        vm.expectRevert(HyperliquidVaultFactory.InvalidSignerConfig.selector);
        factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            threeSigners,
            1,
            "Bad",
            "BAD",
            bytes32("bad-threshold"),
            _defaultPolicyConfig(),
            _defaultFeeConfig()
        );
    }

    function test_createBotVaultRejectsZeroAndDuplicateSigners() public {
        address[] memory zeroSigner = _signers();
        zeroSigner[2] = address(0);

        vm.expectRevert(HyperliquidVaultFactory.InvalidSignerConfig.selector);
        factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            zeroSigner,
            2,
            "Bad",
            "BAD",
            bytes32("bad-zero"),
            _defaultPolicyConfig(),
            _defaultFeeConfig()
        );

        address[] memory duplicateSigner = _signers();
        duplicateSigner[2] = duplicateSigner[1];

        vm.expectRevert(HyperliquidVaultFactory.InvalidSignerConfig.selector);
        factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            duplicateSigner,
            2,
            "Bad",
            "BAD",
            bytes32("bad-duplicate"),
            _defaultPolicyConfig(),
            _defaultFeeConfig()
        );
    }

    function _createBotVault(uint64 serviceId, bytes32 salt) internal returns (address vault, address share) {
        return factory.createBotVault(
            serviceId,
            address(usdc),
            admin,
            operator,
            _signers(),
            2,
            "Hyperliquid Bot Shares",
            "hlSHARE",
            salt,
            _defaultPolicyConfig(),
            _defaultFeeConfig()
        );
    }

    function _signers() internal view returns (address[] memory signers) {
        signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
    }

    function _defaultPolicyConfig() internal pure returns (HyperliquidVaultFactory.PolicyConfig memory) {
        return HyperliquidVaultFactory.PolicyConfig({leverageCap: 50_000, maxTradesPerHour: 100, maxSlippageBps: 500});
    }

    function _defaultFeeConfig() internal pure returns (HyperliquidVaultFactory.FeeConfig memory) {
        return HyperliquidVaultFactory.FeeConfig({
            performanceFeeBps: 2_000, managementFeeBps: 200, validatorFeeShareBps: 3_000
        });
    }
}

contract HyperliquidVaultStackGasTest is Test {
    uint256 internal constant HYPEREVM_GAS_LIMIT = 3_000_000;

    function test_hyperliquidStackDeploymentStepsStayUnderHyperevmGasLimit() public {
        uint256 startGas = gasleft();
        HyperliquidVault implementation = new HyperliquidVault();
        _assertUnderLimit(startGas, "HyperliquidVault implementation deploy");

        startGas = gasleft();
        HyperliquidVaultFactory factory = new HyperliquidVaultFactory();
        _assertUnderLimit(startGas, "HyperliquidVaultFactory deploy");

        startGas = gasleft();
        HyperliquidVaultDeployer vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        _assertUnderLimit(startGas, "HyperliquidVaultDeployer deploy");

        startGas = gasleft();
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));
        _assertUnderLimit(startGas, "VaultShareDeployer deploy");

        factory.setVaultDeployers(vaultDeployer, shareDeployer);
    }

    function test_createBotVaultStaysUnderHyperevmGasLimit() public {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        HyperliquidVault implementation = new HyperliquidVault();
        HyperliquidVaultFactory factory = new HyperliquidVaultFactory();
        HyperliquidVaultDeployer vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));
        factory.setVaultDeployers(vaultDeployer, shareDeployer);

        address[] memory signers = new address[](3);
        signers[0] = makeAddr("validator1");
        signers[1] = makeAddr("validator2");
        signers[2] = makeAddr("validator3");

        uint256 startGas = gasleft();
        factory.createBotVault(
            1,
            address(usdc),
            makeAddr("admin"),
            makeAddr("operator"),
            signers,
            2,
            "Hyperliquid Bot Shares",
            "hlSHARE",
            bytes32("gas-salt"),
            HyperliquidVaultFactory.PolicyConfig({leverageCap: 50_000, maxTradesPerHour: 100, maxSlippageBps: 500}),
            HyperliquidVaultFactory.FeeConfig({
                performanceFeeBps: 2_000, managementFeeBps: 200, validatorFeeShareBps: 3_000
            })
        );
        _assertUnderLimit(startGas, "HyperliquidVaultFactory.createBotVault");
    }

    function _assertUnderLimit(uint256 startGas, string memory label) internal view {
        uint256 gasUsed = startGas - gasleft();
        assertLt(gasUsed, HYPEREVM_GAS_LIMIT, label);
    }
}
