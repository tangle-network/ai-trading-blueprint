// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Comprehensive error path tests to close audit gaps
contract ErrorPathsTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;
    MockTarget public mockTarget;

    function setUp() public override {
        super.setUp();
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);
        mockTarget = new MockTarget(tokenB);

        // Standard deposit + policy config
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 ether, user);
        vm.stopPrank();

        vm.startPrank(address(vaultFactory));
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = address(mockTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);
        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FeeDistributor Error Paths
    // ═══════════════════════════════════════════════════════════════════════════

    function test_fd_setTreasury() public {
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        feeDistributor.setTreasury(makeAddr("newTreasury"));
        assertEq(feeDistributor.treasury(), makeAddr("newTreasury"));
    }

    function test_fd_setTreasury_zeroAddress() public {
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAddress.selector));
        feeDistributor.setTreasury(address(0));
    }

    function test_fd_settleFees_zeroVault() public {
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAddress.selector));
        feeDistributor.settleFees(address(0), address(tokenA));
    }

    function test_fd_settleFees_zeroFeeToken() public {
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAddress.selector));
        feeDistributor.settleFees(address(vault), address(0));
    }

    function test_fd_withdrawFees_zeroAmount() public {
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAmount.selector));
        feeDistributor.withdrawFees(address(tokenA), 0);
    }

    function test_fd_withdrawFees_zeroAddress() public {
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAddress.selector));
        feeDistributor.withdrawFees(address(0), 100);
    }

    function test_fd_withdrawFees_insufficientProtocolFees() public {
        // No fees have been settled, so protocol fees = 0
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.InsufficientProtocolFees.selector));
        feeDistributor.withdrawFees(address(tokenA), 100);
    }

    function test_fd_withdrawValidatorFees_zeroAmount() public {
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAmount.selector));
        feeDistributor.withdrawValidatorFees(address(tokenA), makeAddr("to"), 0);
    }

    function test_fd_withdrawValidatorFees_zeroAddress() public {
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAddress.selector));
        feeDistributor.withdrawValidatorFees(address(0), makeAddr("to"), 100);
    }

    function test_fd_withdrawValidatorFees_zeroToAddress() public {
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAddress.selector));
        feeDistributor.withdrawValidatorFees(address(tokenA), address(0), 100);
    }

    function test_fd_initializeVaultFees_invalidBps_performance() public {
        address fdOwner = feeDistributor.owner();
        address fakeVault = makeAddr("fakeVault2");
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.InvalidBps.selector));
        feeDistributor.initializeVaultFees(
            fakeVault, owner,
            FeeDistributor.FeeConfig({performanceFeeBps: 10001, managementFeeBps: 200, validatorFeeShareBps: 3000})
        );
    }

    function test_fd_initializeVaultFees_invalidBps_management() public {
        address fdOwner = feeDistributor.owner();
        address fakeVault = makeAddr("fakeVault3");
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.InvalidBps.selector));
        feeDistributor.initializeVaultFees(
            fakeVault, owner,
            FeeDistributor.FeeConfig({performanceFeeBps: 2000, managementFeeBps: 10001, validatorFeeShareBps: 3000})
        );
    }

    function test_fd_initializeVaultFees_invalidBps_validatorShare() public {
        address fdOwner = feeDistributor.owner();
        address fakeVault = makeAddr("fakeVault4");
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.InvalidBps.selector));
        feeDistributor.initializeVaultFees(
            fakeVault, owner,
            FeeDistributor.FeeConfig({performanceFeeBps: 2000, managementFeeBps: 200, validatorFeeShareBps: 10001})
        );
    }

    function test_fd_setVaultFeeConfig_invalidBps() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.InvalidBps.selector));
        feeDistributor.setVaultFeeConfig(
            address(vault),
            FeeDistributor.FeeConfig({performanceFeeBps: 10001, managementFeeBps: 200, validatorFeeShareBps: 3000})
        );
    }

    function test_fd_setVaultFeeAdmin_zeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.ZeroAddress.selector));
        feeDistributor.setVaultFeeAdmin(address(vault), address(0));
    }

    function test_fd_settleFees_feeCapping() public {
        // Set up high fees on vault with small balance
        vm.prank(owner);
        vault.approveFeeAllowance(type(uint256).max);

        // Initialize HWM
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Large gains: 50k ether
        tokenA.mint(address(vault), 50000 ether);
        vm.warp(block.timestamp + 365 days);

        // Set absurdly high fee rates
        vm.prank(owner);
        feeDistributor.setVaultFeeConfig(
            address(vault),
            FeeDistributor.FeeConfig({performanceFeeBps: 9000, managementFeeBps: 5000, validatorFeeShareBps: 5000})
        );

        // Settlement should cap fees to vault balance
        uint256 vaultBal = tokenA.balanceOf(address(vault));
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));
        assertTrue(perfFee + mgmtFee <= vaultBal, "Fees should be capped to vault balance");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PolicyEngine Error Paths
    // ═══════════════════════════════════════════════════════════════════════════

    function test_pe_maxTradesPerHourTooHigh_init() public {
        address fdOwner = feeDistributor.owner();
        address newVault = makeAddr("newVault");
        vm.prank(address(vaultFactory));
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.MaxTradesPerHourTooHigh.selector));
        policyEngine.initializeVault(
            newVault, owner,
            PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 1001, maxSlippageBps: 500})
        );
    }

    function test_pe_maxTradesPerHourTooHigh_setRateLimit() public {
        vm.prank(address(vaultFactory));
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.MaxTradesPerHourTooHigh.selector));
        policyEngine.setRateLimit(address(vault), 1001);
    }

    function test_pe_initializeVault_zeroAddress() public {
        vm.prank(address(vaultFactory));
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.ZeroAddress.selector));
        policyEngine.initializeVault(
            address(0), owner,
            PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 100, maxSlippageBps: 500})
        );
    }

    function test_pe_setVaultAdmin_zeroAddress() public {
        vm.prank(address(vaultFactory));
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.ZeroAddress.selector));
        policyEngine.setVaultAdmin(address(vault), address(0));
    }

    function test_pe_vaultNotInitialized_setWhitelist() public {
        address fakeVault = makeAddr("uninitVault");
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        vm.prank(address(vaultFactory));
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.VaultNotInitialized.selector, fakeVault));
        policyEngine.setWhitelist(fakeVault, tokens, true);
    }

    function test_pe_vaultNotInitialized_setPositionLimit() public {
        address fakeVault = makeAddr("uninitVault2");
        vm.prank(address(vaultFactory));
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.VaultNotInitialized.selector, fakeVault));
        policyEngine.setPositionLimit(fakeVault, address(tokenA), 1000 ether);
    }

    function test_pe_tradeRejected_emitsNotInitialized() public {
        address uninit = makeAddr("uninitVault3");
        // Cache constants before prank (external view calls consume prank)
        uint8 rejectCode = policyEngine.REJECT_NOT_INITIALIZED();
        vm.startPrank(address(vaultFactory));
        vm.expectEmit(true, true, true, true);
        emit PolicyEngine.TradeRejected(uninit, address(tokenA), 100 ether, rejectCode);
        policyEngine.validateTrade(uninit, address(tokenA), 100 ether, address(mockTarget), 0);
        vm.stopPrank();
    }

    function test_pe_tradeRejected_emitsTokenNotWhitelisted() public {
        address unlistedToken = makeAddr("unlistedToken");
        uint8 rejectCode = policyEngine.REJECT_TOKEN_NOT_WHITELISTED();
        vm.startPrank(address(vaultFactory));
        vm.expectEmit(true, true, true, true);
        emit PolicyEngine.TradeRejected(address(vault), unlistedToken, 100 ether, rejectCode);
        policyEngine.validateTrade(address(vault), unlistedToken, 100 ether, address(mockTarget), 0);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TradeValidator Error Paths (standalone instance)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_tv_vaultNotConfigured() public {
        TradeValidator tv = new TradeValidator();
        address unconfigured = makeAddr("unconfigured");

        bytes32 intent = keccak256("test");
        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);
        scores[0] = 80;
        sigs[0] = _signValidation(validator1Key, intent, unconfigured, 80, block.timestamp + 1 hours);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.VaultNotConfigured.selector, unconfigured));
        tv.validateWithSignatures(intent, unconfigured, sigs, scores, block.timestamp + 1 hours);
    }

    function test_tv_configureVault_zeroAddress() public {
        TradeValidator tv = new TradeValidator();
        address[] memory signers = new address[](1);
        signers[0] = validator1;

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.ZeroAddress.selector));
        tv.configureVault(address(0), signers, 1);
    }

    function test_tv_configureVault_zeroRequiredSigs() public {
        TradeValidator tv = new TradeValidator();
        address[] memory signers = new address[](1);
        signers[0] = validator1;

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.InvalidRequiredSignatures.selector));
        tv.configureVault(makeAddr("v"), signers, 0);
    }

    function test_tv_configureVault_excessiveRequiredSigs() public {
        TradeValidator tv = new TradeValidator();
        address[] memory signers = new address[](1);
        signers[0] = validator1;

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.InvalidRequiredSignatures.selector));
        tv.configureVault(makeAddr("v"), signers, 5);
    }

    function test_tv_configureVault_zeroAddressSigner() public {
        TradeValidator tv = new TradeValidator();
        address[] memory signers = new address[](2);
        signers[0] = validator1;
        signers[1] = address(0);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.ZeroAddress.selector));
        tv.configureVault(makeAddr("v"), signers, 1);
    }

    function test_tv_addSigner_zeroAddress() public {
        TradeValidator tv = new TradeValidator();
        address v = makeAddr("v2");
        address[] memory signers = new address[](1);
        signers[0] = validator1;
        tv.configureVault(v, signers, 1);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.ZeroAddress.selector));
        tv.addSigner(v, address(0));
    }

    function test_tv_addSigner_duplicate() public {
        TradeValidator tv = new TradeValidator();
        address v = makeAddr("v3");
        address[] memory signers = new address[](1);
        signers[0] = validator1;
        tv.configureVault(v, signers, 1);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.DuplicateSigner.selector, validator1));
        tv.addSigner(v, validator1);
    }

    function test_tv_removeSigner_wouldBreachThreshold() public {
        TradeValidator tv = new TradeValidator();
        address v = makeAddr("v4");
        address[] memory signers = new address[](2);
        signers[0] = validator1;
        signers[1] = validator2;
        tv.configureVault(v, signers, 2);

        // Can't remove when signers.length (2) <= requiredSigs (2)
        vm.expectRevert(abi.encodeWithSelector(TradeValidator.WouldBreachThreshold.selector));
        tv.removeSigner(v, validator1);
    }

    function test_tv_setRequiredSignatures_zero() public {
        TradeValidator tv = new TradeValidator();
        address v = makeAddr("v5");
        address[] memory signers = new address[](2);
        signers[0] = validator1;
        signers[1] = validator2;
        tv.configureVault(v, signers, 1);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.InvalidRequiredSignatures.selector));
        tv.setRequiredSignatures(v, 0);
    }

    function test_tv_setRequiredSignatures_exceedsSignerCount() public {
        TradeValidator tv = new TradeValidator();
        address v = makeAddr("v6");
        address[] memory signers = new address[](2);
        signers[0] = validator1;
        signers[1] = validator2;
        tv.configureVault(v, signers, 1);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.InvalidRequiredSignatures.selector));
        tv.setRequiredSignatures(v, 5);
    }

    function test_tv_setMinScoreThreshold_invalidThreshold() public {
        TradeValidator tv = new TradeValidator();
        address v = makeAddr("v7");
        address[] memory signers = new address[](1);
        signers[0] = validator1;
        tv.configureVault(v, signers, 1);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.InvalidScoreThreshold.selector));
        tv.setMinScoreThreshold(v, 101);
    }

    function test_tv_setVaultConfigOwner_zeroAddress() public {
        TradeValidator tv = new TradeValidator();
        address v = makeAddr("v8");
        address[] memory signers = new address[](1);
        signers[0] = validator1;
        tv.configureVault(v, signers, 1);

        vm.expectRevert(abi.encodeWithSelector(TradeValidator.ZeroAddress.selector));
        tv.setVaultConfigOwner(v, address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TradingVault: InsufficientLiquidity
    // ═══════════════════════════════════════════════════════════════════════════

    function test_withdraw_insufficientLiquidity() public {
        // Put some value in held tokens so liquid < entitled
        tokenB.mint(address(vault), 8000 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        vm.prank(operator);
        vault.updateHeldTokens(tokens);

        // Now liquidAssets = 10000 (tokenA), but totalAssets = 18000
        // User holds shares worth ~10000 assets. Try to withdraw more than liquid
        // First, simulate that the user has enough shares by depositing more
        vm.startPrank(owner);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(8000 ether, owner);
        vm.stopPrank();

        // Now withdraw exactly liquid + 1 from user. totalAssets = 26000, liquid = 18000
        uint256 liquid = vault.liquidAssets();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.InsufficientLiquidity.selector, liquid + 1, liquid));
        vault.withdraw(liquid + 1, user, user);
    }

    function test_redeem_insufficientLiquidity() public {
        // Put most value in held tokens
        tokenB.mint(address(vault), 50_000 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        vm.prank(operator);
        vault.updateHeldTokens(tokens);

        // totalAssets = 60000, liquidAssets = 10000
        // User has shares worth 10000 of the 60000 total.
        // Try to redeem all shares — the asset equivalent may exceed liquid
        uint256 userShares = shareToken.balanceOf(user);
        uint256 assetsWorth = vault.convertToAssets(userShares);
        uint256 liquid = vault.liquidAssets();

        if (assetsWorth > liquid) {
            vm.prank(user);
            vm.expectRevert(abi.encodeWithSelector(TradingVault.InsufficientLiquidity.selector, assetsWorth, liquid));
            vault.redeem(userShares, user, user);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TradingVault: DepositAssetBelowReserve
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_depositAssetBelowReserve() public {
        // Set 90% reserve requirement — most asset must remain as deposit token
        vm.prank(owner);
        vault.setDepositAssetReserveBps(9000);

        // Execute a trade that swaps most of the deposit asset away
        bytes32 intentHash = keccak256("reserve test");
        uint256 deadline = block.timestamp + 1 hours;
        uint256 outputAmount = 9500 ether; // Swap gets 9500 tokenB, but vault spends no tokenA (mock mints)

        // The mock target mints output but doesn't consume input. After trade:
        // depositAsset balance = 10000, totalAssets = 10000 + 9500 = 19500
        // Reserve check: 10000 * 10000 < 19500 * 9000 → 100M < 175.5M → true → revert
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), outputAmount),
            value: 0,
            minOutput: outputAmount,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.DepositAssetBelowReserve.selector));
        vault.execute(params, sigs, scores);
    }

    function test_execute_zeroReserveBps_alwaysPasses() public {
        // Reserve BPS = 0 (default) → no reserve enforcement, any trade is fine
        assertEq(vault.depositAssetReserveBps(), 0, "Default reserve is 0");

        // Execute a trade that converts most deposit asset to another token
        bytes32 intentHash = keccak256("zero reserve test");
        uint256 deadline = block.timestamp + 1 hours;
        uint256 outputAmount = 9000 ether;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), outputAmount),
            value: 0,
            minOutput: outputAmount,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        // Should succeed — no reserve check when BPS = 0
        vm.prank(operator);
        vault.execute(params, sigs, scores);
    }

    function test_execute_100pctReserveBps_reverts() public {
        // Reserve BPS = 10000 (100%) → every trade that adds non-deposit tokens reverts
        vm.prank(owner);
        vault.setDepositAssetReserveBps(10000);

        bytes32 intentHash = keccak256("100pct reserve test");
        uint256 deadline = block.timestamp + 1 hours;
        uint256 outputAmount = 100 ether; // Even a small swap to tokenB breaks 100% reserve

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), outputAmount),
            value: 0,
            minOutput: outputAmount,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        // Should revert — deposit asset balance (10000) < total (10100) * 100%
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.DepositAssetBelowReserve.selector));
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TradingVault: HeldTokenDecimalMismatch
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_emitsHeldTokenDecimalMismatch() public {
        // Deploy a 6-decimal output token
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        MockTarget usdcTarget = new MockTarget(usdc);

        // Whitelist the new token and target
        vm.startPrank(address(vaultFactory));
        policyEngine.whitelistToken(address(vault), address(usdc), true);
        policyEngine.setPositionLimit(address(vault), address(usdc), 100_000e6);
        address[] memory t = new address[](1);
        t[0] = address(usdcTarget);
        policyEngine.setTargetWhitelist(address(vault), t, true);
        vm.stopPrank();

        bytes32 intentHash = keccak256("decimal mismatch test");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(usdcTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 1000e6),
            value: 0,
            minOutput: 1000e6,
            outputToken: address(usdc),
            intentHash: intentHash,
            deadline: deadline
        });

        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        sigs[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        sigs[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        // Should emit HeldTokenDecimalMismatch for 6-decimal token in 18-decimal vault
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit TradingVault.HeldTokenDecimalMismatch(address(usdc), 6, 18);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TradingVault: MAX_HELD_TOKENS cap
    // ═══════════════════════════════════════════════════════════════════════════

    function test_maxHeldTokensCap() public {
        // Create 21 tokens and try to add all as held
        address[] memory tokens = new address[](21);
        for (uint256 i = 0; i < 21; i++) {
            tokens[i] = address(new MockERC20(string(abi.encodePacked("T", vm.toString(i))), "T", 18));
        }

        // Only first 20 should be added (MAX_HELD_TOKENS = 20)
        vm.prank(operator);
        vault.updateHeldTokens(tokens);

        assertEq(vault.heldTokenCount(), 20, "Should cap at MAX_HELD_TOKENS");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VaultFactory: NotAuthorized
    // ═══════════════════════════════════════════════════════════════════════════

    function test_vf_createVault_notAuthorized() public {
        address[] memory signers = new address[](1);
        signers[0] = validator1;

        vm.prank(user); // user is not authorized
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.NotAuthorized.selector));
        vaultFactory.createVault(
            99, address(tokenA), owner, operator, signers, 1, "Test", "T", bytes32("s"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
    }

    function test_vf_createBotVault_notAuthorized() public {
        address[] memory signers = new address[](1);
        signers[0] = validator1;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.NotAuthorized.selector));
        vaultFactory.createBotVault(
            99, address(tokenA), owner, operator, signers, 1, "Test", "T", bytes32("s"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
    }

    function test_vf_createVault_zeroAssetToken() public {
        address[] memory signers = new address[](1);
        signers[0] = validator1;

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.ZeroAddress.selector));
        vaultFactory.createVault(
            99, address(0), owner, operator, signers, 1, "Test", "T", bytes32("s"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
    }

    function test_vf_createVault_zeroAdmin() public {
        address[] memory signers = new address[](1);
        signers[0] = validator1;

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.ZeroAddress.selector));
        vaultFactory.createVault(
            99, address(tokenA), address(0), operator, signers, 1, "Test", "T", bytes32("s"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
    }

    function test_vf_createVault_emptySigners() public {
        address[] memory signers = new address[](0);

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.InvalidSignerConfig.selector));
        vaultFactory.createVault(
            99, address(tokenA), owner, operator, signers, 1, "Test", "T", bytes32("s"),
            _defaultPolicyConfig(), _defaultFeeConfig()
        );
    }
}
