// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/HyperliquidVault.sol";
import "../src/HyperliquidVaultDeployer.sol";
import "../src/HyperliquidVaultFactory.sol";
import "../src/HyperliquidTradeValidator.sol";
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
    address internal constant SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;
    address internal constant ACCOUNT_MARGIN_SUMMARY_PRECOMPILE = 0x000000000000000000000000000000000000080F;

    MockERC20 internal usdc;
    HyperliquidVault internal implementation;
    HyperliquidTradeValidator internal tradeValidator;
    HyperliquidVaultFactory internal factory;
    HyperliquidVaultDeployer internal vaultDeployer;
    VaultShareDeployer internal shareDeployer;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal user = makeAddr("user");
    address internal validator1 = makeAddr("validator1");
    address internal validator2 = makeAddr("validator2");
    address internal validator3 = makeAddr("validator3");
    uint256 internal validator1Key;
    uint256 internal validator2Key;
    uint256 internal validator3Key;
    address internal agentWallet = makeAddr("agentWallet");

    function setUp() public {
        (validator1, validator1Key) = makeAddrAndKey("validator1");
        (validator2, validator2Key) = makeAddrAndKey("validator2");
        (validator3, validator3Key) = makeAddrAndKey("validator3");
        usdc = new MockERC20("USD Coin", "USDC", 6);
        implementation = new HyperliquidVault();
        tradeValidator = new HyperliquidTradeValidator();
        factory = new HyperliquidVaultFactory(tradeValidator);
        vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        shareDeployer = new VaultShareDeployer(address(factory));
        tradeValidator.transferOwnership(address(factory));
        factory.acceptDependencyOwnership();
        factory.setVaultDeployers(vaultDeployer, shareDeployer);
    }

    function test_implementationInitializeRevertsButFactoryCloneInitializes() public {
        vm.expectRevert(HyperliquidVault.AlreadyInitialized.selector);
        implementation.initialize(address(usdc), VaultShare(address(0)), tradeValidator, admin, operator);

        (address vaultAddr, address shareAddr) = _createBotVault(1, bytes32("implementation-lock-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        assertEq(vault.asset(), address(usdc));
        assertEq(vault.share(), shareAddr);
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), operator));
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
        assertEq(address(vault.tradeValidator()), address(tradeValidator));
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), operator));
        assertTrue(share.isLinkedVault(vaultAddr));
        assertTrue(share.hasRole(share.MINTER_ROLE(), vaultAddr));
        assertEq(tradeValidator.getRequiredSignatures(vaultAddr), 2);
        assertTrue(tradeValidator.isVaultSigner(vaultAddr, validator1));

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

    function test_firstDepositAfterPrefundUsesVirtualOffsetAndRedeemsFairly() public {
        (address vaultAddr, address shareAddr) = _createBotVault(1, bytes32("prefund-first-deposit-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        VaultShare share = VaultShare(shareAddr);

        usdc.mint(vaultAddr, 1);
        assertEq(vault.totalAssets(), 1);
        uint256 virtualOffset = vault.HYPERLIQUID_VIRTUAL_OFFSET();
        uint256 expectedShares = 1_000e6 * virtualOffset / (1 + virtualOffset);
        assertEq(vault.convertToShares(1_000e6), expectedShares);
        assertGt(expectedShares, 0);

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1_000e6);
        uint256 shares = vault.deposit(1_000e6, user);
        assertEq(shares, expectedShares);
        assertEq(share.balanceOf(user), expectedShares);

        uint256 assets = vault.redeem(shares, user, user);
        vm.stopPrank();

        assertApproxEqAbs(assets, 1_000e6, 1);
        assertApproxEqAbs(usdc.balanceOf(user), 1_000e6, 1);
        assertLe(vault.totalAssets(), 2);
    }

    function test_donationAfterFirstDepositCannotMintZeroShares() public {
        (address vaultAddr, address shareAddr) = _createBotVault(1, bytes32("post-deposit-donation-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        VaultShare share = VaultShare(shareAddr);
        address donor = makeAddr("donor");
        address victim = makeAddr("victim");

        usdc.mint(user, 1e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1e6);
        uint256 firstShares = vault.deposit(1e6, user);
        vm.stopPrank();
        assertEq(firstShares, 1e6);

        usdc.mint(donor, 1_000e6);
        vm.prank(donor);
        usdc.transfer(vaultAddr, 1_000e6);

        uint256 expectedVictimShares = vault.convertToShares(1_000e6);
        assertGt(expectedVictimShares, 0);

        usdc.mint(victim, 1_000e6);
        vm.startPrank(victim);
        usdc.approve(vaultAddr, 1_000e6);
        uint256 victimShares = vault.deposit(1_000e6, victim);
        vm.stopPrank();
        assertEq(victimShares, expectedVictimShares);
        assertEq(share.balanceOf(victim), expectedVictimShares);

        address dustDepositor = makeAddr("dustDepositor");
        usdc.mint(dustDepositor, 1);
        vm.startPrank(dustDepositor);
        usdc.approve(vaultAddr, 1);
        assertEq(vault.convertToShares(1), 0);
        vm.expectRevert(HyperliquidVault.ZeroShares.selector);
        vault.deposit(1, dustDepositor);
        vm.stopPrank();
    }

    function test_hyperCoreNavDonationCannotMintZeroShares() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("hypercore-nav-donation-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        _mockHyperCoreAccount(vaultAddr, 0, 10_000e6);
        assertEq(vault.totalAssets(), 10_000e6);
        assertEq(vault.convertToShares(1), 0);

        usdc.mint(user, 1);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1);
        vm.expectRevert(HyperliquidVault.ZeroShares.selector);
        vault.deposit(1, user);
        vm.stopPrank();
    }

    function test_deterministicAddressPrefundingStillAllowsFirstDeposit() public {
        bytes32 salt = bytes32("deterministic-prefund-salt");
        bytes32 vaultSalt = keccak256(abi.encodePacked(uint64(1), address(usdc), admin, "hyperliquid-vault", salt));
        address predictedVault = vaultDeployer.predictVault(vaultSalt);

        usdc.mint(predictedVault, 1_000e6);

        (address vaultAddr, address shareAddr) = _createBotVault(1, salt);
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        VaultShare share = VaultShare(shareAddr);
        assertEq(vaultAddr, predictedVault);
        assertEq(vault.totalAssets(), 1_000e6);

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1_000e6);
        uint256 expectedShares = vault.convertToShares(1_000e6);
        assertGt(expectedShares, 0);
        uint256 shares = vault.deposit(1_000e6, user);
        vm.stopPrank();
        assertEq(shares, expectedShares);
        assertEq(share.balanceOf(user), expectedShares);
    }

    function test_hyperliquidTradeValidatorAcceptsOnlyVaultBoundExecutionHash() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("validator-bind-salt"));
        bytes32 intentHash = keccak256("bot-intent");
        bytes32 executionHash = keccak256(abi.encode("hyperliquid", vaultAddr, "ETH", true, uint256(1 ether)));
        uint256 deadline = block.timestamp + 1 hours;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signValidation(validator1Key, intentHash, executionHash, vaultAddr, scores[0], deadline, 2);
        sigs[1] = _signValidation(validator2Key, intentHash, executionHash, vaultAddr, scores[1], deadline, 2);

        (bool approved, uint256 validCount) =
            tradeValidator.validateWithSignatures(intentHash, executionHash, vaultAddr, sigs, scores, deadline, 2);
        assertTrue(approved);
        assertEq(validCount, 2);

        (approved, validCount) = tradeValidator.validateWithSignatures(
            intentHash, keccak256("wrong-execution"), vaultAddr, sigs, scores, deadline, 2
        );
        assertFalse(approved, "signatures must not replay onto a different execution hash");
        assertEq(validCount, 0);

        address otherVault = makeAddr("other-vault");
        vm.expectRevert(abi.encodeWithSelector(HyperliquidTradeValidator.VaultNotConfigured.selector, otherVault));
        tradeValidator.validateWithSignatures(intentHash, executionHash, otherVault, sigs, scores, deadline, 2);

        (approved, validCount) =
            tradeValidator.validateWithSignatures(intentHash, executionHash, vaultAddr, sigs, scores, deadline, 1);
        assertFalse(approved, "signatures must not replay across action kinds");
        assertEq(validCount, 0);
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

        _mockHyperCoreAccount(vaultAddr, 0, 9_000e6);
        assertEq(vault.totalAssets(), 10_000e6);
        assertEq(vault.maxWithdraw(user), 1_000e6);
        assertEq(vault.maxRedeem(user), vault.convertToShares(vault.idleAssets()));

        uint256 redeemAssets = vault.convertToAssets(200e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidVault.InsufficientLiquidity.selector, redeemAssets, 1_000e6));
        vault.redeem(200e6, user, user);

        // Simulate liquidity coming back from HyperCore while NAV stays constant.
        usdc.mint(vaultAddr, 1_000e6);
        _mockHyperCoreAccount(vaultAddr, 0, 8_000e6);

        vm.prank(user);
        uint256 assets = vault.redeem(200e6, user, user);
        assertEq(assets, redeemAssets);
        assertEq(vault.totalAssets(), 10_000e6 - redeemAssets);
    }

    function test_coreSpotUsdcIsIncludedInHyperliquidAccountAssets() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("core-spot-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        _mockHyperCoreAccount(vaultAddr, 123_456_789_000, 9_000e6);

        assertEq(vault.hyperliquidAccountAssets(), 10_234_567_890);
    }

    function test_hypercoreAccountingUnavailableBlocksUserFlows() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("unavailable-accounting-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(vaultAddr, 1_000e6);
        vault.deposit(1_000e6, user);
        vm.stopPrank();

        vm.mockCallRevert(SPOT_BALANCE_PRECOMPILE, abi.encode(vaultAddr, uint64(0)), bytes(""));
        vm.mockCallRevert(ACCOUNT_MARGIN_SUMMARY_PRECOMPILE, abi.encode(uint32(0), vaultAddr), bytes(""));
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

        vm.clearMockedCalls();
        _mockHyperCoreAccount(vaultAddr, 0, 0);
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

        _mockHyperCoreAccount(vaultAddr, 0, 8_000e6);
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

        uint256 aliceRequestAssets = vault.convertToAssets(500e6);
        vm.expectRevert(
            abi.encodeWithSelector(HyperliquidVault.InsufficientLiquidity.selector, aliceRequestAssets, 2_000e6)
        );
        vault.fulfillRedeem(aliceRequest);

        usdc.mint(vaultAddr, 3_000e6);
        _mockHyperCoreAccount(vaultAddr, 0, 5_000e6);

        uint256 aliceBalanceBefore = usdc.balanceOf(alice);
        uint256 fulfilledAssets = vault.fulfillRedeem(aliceRequest);
        assertEq(fulfilledAssets, aliceRequestAssets);
        assertEq(usdc.balanceOf(alice), aliceBalanceBefore + aliceRequestAssets);
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

    function test_operatorCanSubmitUsdClassLiquidityReturnOnly() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("corewriter-return-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        HyperliquidMockCoreWriter mock = new HyperliquidMockCoreWriter();
        vm.etch(CORE_WRITER, address(mock).code);

        bytes memory expectedUsdAction =
            abi.encodePacked(uint8(1), bytes3(uint24(7)), abi.encode(uint64(1_000_000), false));
        vm.expectEmit(false, false, false, true, vaultAddr);
        emit HyperliquidVault.HyperliquidUsdClassTransferSubmitted(1_000_000, false, expectedUsdAction);

        vm.prank(operator);
        vault.returnUsdClassLiquidity(1_000_000, false);

        HyperliquidMockCoreWriter coreWriter = HyperliquidMockCoreWriter(CORE_WRITER);
        assertEq(coreWriter.lastSender(), vaultAddr);
        assertEq(coreWriter.lastAction(), expectedUsdAction);
    }

    function test_adminCanSubmitSpotLiquidityReturn() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("corewriter-spot-return-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));
        HyperliquidMockCoreWriter mock = new HyperliquidMockCoreWriter();
        vm.etch(CORE_WRITER, address(mock).code);

        address destination = makeAddr("liquidity-destination");
        bytes memory expectedSpotAction =
            abi.encodePacked(uint8(1), bytes3(uint24(6)), abi.encode(destination, uint64(1_505), uint64(2_000_000)));
        vm.expectEmit(true, false, false, true, vaultAddr);
        emit HyperliquidVault.HyperliquidSpotSendSubmitted(destination, 1_505, 2_000_000, expectedSpotAction);

        vm.prank(admin);
        vault.returnSpotLiquidity(destination, 1_505, 2_000_000);

        HyperliquidMockCoreWriter coreWriter = HyperliquidMockCoreWriter(CORE_WRITER);
        assertEq(coreWriter.lastSender(), vaultAddr);
        assertEq(coreWriter.lastAction(), expectedSpotAction);
    }

    function test_nonOperatorCannotSubmitLiquidityReturnActions() public {
        (address vaultAddr,) = _createBotVault(1, bytes32("corewriter-return-acl-salt"));
        HyperliquidVault vault = HyperliquidVault(payable(vaultAddr));

        vm.prank(user);
        vm.expectRevert();
        vault.returnUsdClassLiquidity(1_000_000, false);

        vm.prank(operator);
        vm.expectRevert();
        vault.returnSpotLiquidity(user, 1_505, 2_000_000);

        vm.prank(user);
        vm.expectRevert();
        vault.returnSpotLiquidity(user, 1_505, 2_000_000);
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
        (vault, share) = factory.createBotVault(
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
        _mockHyperCoreAccount(vault, 0, 0);
    }

    function _mockHyperCoreAccount(address vault, uint64 spotUsdcRaw, int64 perpAccountValue) internal {
        vm.mockCall(
            SPOT_BALANCE_PRECOMPILE, abi.encode(vault, uint64(0)), abi.encode(spotUsdcRaw, uint64(0), uint64(0))
        );
        vm.mockCall(
            ACCOUNT_MARGIN_SUMMARY_PRECOMPILE,
            abi.encode(uint32(0), vault),
            abi.encode(perpAccountValue, uint64(0), uint64(0), int64(0))
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

    function _signValidation(
        uint256 privateKey,
        bytes32 intentHash,
        bytes32 executionHash,
        address vault,
        uint256 score,
        uint256 deadline,
        uint256 actionKind
    ) internal view returns (bytes memory) {
        bytes32 digest = tradeValidator.computeDigest(intentHash, executionHash, vault, score, deadline, actionKind);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract HyperliquidVaultStackGasTest is Test {
    uint256 internal constant HYPEREVM_GAS_LIMIT = 3_000_000;

    function test_hyperliquidStackDeploymentStepsStayUnderHyperevmGasLimit() public {
        uint256 startGas = gasleft();
        HyperliquidVault implementation = new HyperliquidVault();
        _assertUnderLimit(startGas, "HyperliquidVault implementation deploy");

        startGas = gasleft();
        HyperliquidTradeValidator tradeValidator = new HyperliquidTradeValidator();
        _assertUnderLimit(startGas, "HyperliquidTradeValidator deploy");

        startGas = gasleft();
        HyperliquidVaultFactory factory = new HyperliquidVaultFactory(tradeValidator);
        _assertUnderLimit(startGas, "HyperliquidVaultFactory deploy");

        startGas = gasleft();
        HyperliquidVaultDeployer vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        _assertUnderLimit(startGas, "HyperliquidVaultDeployer deploy");

        startGas = gasleft();
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));
        _assertUnderLimit(startGas, "VaultShareDeployer deploy");

        tradeValidator.transferOwnership(address(factory));
        factory.acceptDependencyOwnership();
        factory.setVaultDeployers(vaultDeployer, shareDeployer);
    }

    function test_createBotVaultStaysUnderHyperevmGasLimit() public {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        HyperliquidVault implementation = new HyperliquidVault();
        HyperliquidTradeValidator tradeValidator = new HyperliquidTradeValidator();
        HyperliquidVaultFactory factory = new HyperliquidVaultFactory(tradeValidator);
        HyperliquidVaultDeployer vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));
        tradeValidator.transferOwnership(address(factory));
        factory.acceptDependencyOwnership();
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
