// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

contract FeeDistributorTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;

    function setUp() public override {
        super.setUp();

        // Create vault via factory (handles all wiring including FeeDistributor initialization)
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Deposit tokens into the vault to simulate AUM
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(10000 ether, user);
        vm.stopPrank();

        // Approve fee distributor to pull fees from vault
        vm.prank(owner);
        vault.approveFeeAllowance(type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PER-VAULT FEE CONFIG TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_vaultFeeInitialized() public view {
        assertTrue(feeDistributor.vaultFeeInitialized(address(vault)));
        (uint256 perfBps, uint256 mgmtBps, uint256 valShareBps) = feeDistributor.vaultFeeConfig(address(vault));
        assertEq(perfBps, 2000); // 20%
        assertEq(mgmtBps, 200); // 2%
        assertEq(valShareBps, 3000); // 30%
    }

    function test_vaultFeeAdmin() public view {
        assertEq(feeDistributor.vaultFeeAdmin(address(vault)), owner);
    }

    function test_vaultAdminCanUpdateFeeConfig() public {
        vm.prank(owner);
        feeDistributor.setVaultFeeConfig(
            address(vault), FeeDistributor.FeeConfig({performanceFeeBps: 1500, managementFeeBps: 100, validatorFeeShareBps: 5000})
        );

        (uint256 perfBps, uint256 mgmtBps, uint256 valShareBps) = feeDistributor.vaultFeeConfig(address(vault));
        assertEq(perfBps, 1500);
        assertEq(mgmtBps, 100);
        assertEq(valShareBps, 5000);
    }

    function test_nonAdminCannotUpdateFeeConfig() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.NotVaultFeeAdminOrOwner.selector));
        feeDistributor.setVaultFeeConfig(
            address(vault), FeeDistributor.FeeConfig({performanceFeeBps: 1500, managementFeeBps: 100, validatorFeeShareBps: 5000})
        );
    }

    function test_transferVaultFeeAdmin() public {
        vm.prank(owner);
        feeDistributor.setVaultFeeAdmin(address(vault), user);
        assertEq(feeDistributor.vaultFeeAdmin(address(vault)), user);

        // New admin can update config
        vm.prank(user);
        feeDistributor.setVaultFeeConfig(
            address(vault), FeeDistributor.FeeConfig({performanceFeeBps: 1000, managementFeeBps: 50, validatorFeeShareBps: 2000})
        );

        (uint256 perfBps,,) = feeDistributor.vaultFeeConfig(address(vault));
        assertEq(perfBps, 1000);

        // Old admin cannot update
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.NotVaultFeeAdminOrOwner.selector));
        feeDistributor.setVaultFeeConfig(
            address(vault), FeeDistributor.FeeConfig({performanceFeeBps: 500, managementFeeBps: 50, validatorFeeShareBps: 2000})
        );
    }

    function test_doubleInitReverts() public {
        // Vault is already initialized via factory in setUp
        // Trying to re-initialize should revert
        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.VaultAlreadyInitialized.selector, address(vault)));
        feeDistributor.initializeVaultFees(
            address(vault),
            owner,
            FeeDistributor.FeeConfig({performanceFeeBps: 1000, managementFeeBps: 50, validatorFeeShareBps: 2000})
        );
    }

    function test_uninitializedVaultCannotSetConfig() public {
        address fakeVault = makeAddr("fakeVault");
        // Test contract is not owner (VaultFactory is) and not vaultFeeAdmin (default zero)
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.NotVaultFeeAdminOrOwner.selector));
        feeDistributor.setVaultFeeConfig(
            fakeVault, FeeDistributor.FeeConfig({performanceFeeBps: 1000, managementFeeBps: 50, validatorFeeShareBps: 2000})
        );
    }

    function test_uninitializedVaultCannotSettle() public {
        address fakeVault = makeAddr("fakeVault");
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.VaultFeeNotInitialized.selector));
        feeDistributor.settleFees(fakeVault, address(tokenA));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PERMISSIONLESS SETTLEMENT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_settleFees_permissionless() public {
        // Anyone can call settleFees — access control is the vault's ERC-20 approval
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));

        // First settlement: HWM is initialized to currentAUM, so no perf fee on initial capital
        assertEq(perfFee, 0, "No perf fee on first settlement - initial capital is not gains");
        assertEq(mgmtFee, 0);

        // No fees transferred on first settlement
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0);

        // HWM should be set to initial AUM
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);
        assertEq(feeDistributor.lastSettled(address(vault)), block.timestamp);
    }

    function test_settleFees_anyoneCanCall() public {
        // Even a random address can trigger settlement
        address randomCaller = makeAddr("randomCaller");
        vm.prank(randomCaller);
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(perfFee, 0);
        assertEq(mgmtFee, 0);
    }

    function test_settleFees_revertsForUninitializedVault() public {
        address fakeVault = makeAddr("fakeVault");
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.VaultFeeNotInitialized.selector));
        feeDistributor.settleFees(fakeVault, address(tokenA));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PERFORMANCE FEE TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_performanceFee() public {
        // First settlement sets HWM
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains by minting more tokens to vault
        vm.warp(block.timestamp + 30 days);
        tokenA.mint(address(vault), 5000 ether);

        uint256 currentAUM = tokenA.balanceOf(address(vault));

        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));

        // Performance fee should be on gains above HWM (10000)
        if (currentAUM > 10000 ether) {
            uint256 gains = currentAUM - 10000 ether;
            uint256 expectedPerfFee = (gains * 2000) / 10000;
            assertEq(perfFee, expectedPerfFee);
        }

        // Management fee should be positive after 30 days
        assertTrue(mgmtFee > 0);
    }

    function test_managementFee() public {
        // First settlement sets baseline
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Advance time 365 days
        vm.warp(block.timestamp + 365 days);

        uint256 currentAUM = tokenA.balanceOf(address(vault));

        (, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));

        // Management fee = AUM * 200 / 10000 * (365 days / 365 days) = AUM * 2%
        uint256 expectedMgmt = (currentAUM * 200 * 365 days) / (10000 * 365 days);
        assertEq(mgmtFee, expectedMgmt);
    }

    function test_noFeesBelowHWM() public {
        // First settlement sets HWM to 10000 (no fees taken)
        feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);

        // Simulate loss: remove some tokens from vault
        vm.prank(address(vault));
        tokenA.transfer(address(1), 2000 ether);

        // Advance time
        vm.warp(block.timestamp + 30 days);

        uint256 currentAUM = tokenA.balanceOf(address(vault));
        assertTrue(currentAUM < 10000 ether, "AUM should be below HWM after loss");

        (uint256 perfFee,) = feeDistributor.settleFees(address(vault), address(tokenA));

        // No perf fee when below HWM
        assertEq(perfFee, 0);
        // HWM should NOT be updated (still 10000)
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);
    }

    function test_highWaterMarkUpdated() public {
        // First settlement initializes HWM to current AUM
        feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);

        // Add more tokens to vault, making AUM exceed HWM
        tokenA.mint(address(vault), 20000 ether);
        uint256 preFeeAUM = tokenA.balanceOf(address(vault));

        vm.warp(block.timestamp + 1 days);

        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));
        uint256 totalFee = perfFee + mgmtFee;

        // HWM is updated to post-fee AUM (not pre-fee) to avoid under-collecting future perf fees
        uint256 expectedHWM = preFeeAUM - totalFee;
        assertEq(feeDistributor.highWaterMark(address(vault)), expectedHWM);
    }

    function test_validatorFeeShare() public {
        // First settlement initializes HWM
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains above HWM
        tokenA.mint(address(vault), 5000 ether);
        vm.warp(block.timestamp + 1 days);

        // Second settlement produces real perf fees
        (uint256 perfFee,) = feeDistributor.settleFees(address(vault), address(tokenA));
        assertTrue(perfFee > 0, "Should have perf fee from gains");

        // Validator share = perfFee * validatorFeeShareBps / BPS_DENOMINATOR
        uint256 expectedValidatorShare = (perfFee * 3000) / 10000;
        assertEq(feeDistributor.validatorFees(address(tokenA)), expectedValidatorShare);
    }

    function test_customFeeRates() public {
        // Admin sets lower fees
        vm.prank(owner);
        feeDistributor.setVaultFeeConfig(
            address(vault), FeeDistributor.FeeConfig({performanceFeeBps: 1000, managementFeeBps: 100, validatorFeeShareBps: 2000})
        );

        // First settlement sets HWM
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains
        tokenA.mint(address(vault), 5000 ether);
        vm.warp(block.timestamp + 1 days);

        (uint256 perfFee,) = feeDistributor.settleFees(address(vault), address(tokenA));

        // With 10% perf fee (1000 bps), perf fee = gains * 1000 / 10000
        uint256 expectedPerfFee = (5000 ether * 1000) / 10000;
        assertEq(perfFee, expectedPerfFee);

        // Validator share at 20% (2000 bps) of perf fee
        uint256 expectedValidatorShare = (perfFee * 2000) / 10000;
        assertEq(feeDistributor.validatorFees(address(tokenA)), expectedValidatorShare);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // KEY EVENT TESTS — FeesSettled
    // ═══════════════════════════════════════════════════════════════════════════

    function test_settleFees_emitsFeesSettled() public {
        // First settlement sets HWM
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains above HWM
        tokenA.mint(address(vault), 5000 ether);
        vm.warp(block.timestamp + 30 days);

        // Calculate expected values
        uint256 currentAUM = tokenA.balanceOf(address(vault));
        uint256 expectedPerfFee = ((currentAUM - 10000 ether) * 2000) / 10000; // 20% of gains
        uint256 expectedMgmtFee = (currentAUM * 200 * 30 days) / (10000 * 365 days);
        uint256 expectedTotal = expectedPerfFee + expectedMgmtFee;
        uint256 expectedValShare = (expectedPerfFee * 3000) / 10000;
        uint256 expectedProtocolShare = expectedTotal - expectedValShare;

        vm.expectEmit(true, true, false, true);
        emit FeeDistributor.FeesSettled(
            address(vault), address(tokenA), expectedPerfFee, expectedMgmtFee, expectedValShare, expectedProtocolShare
        );

        feeDistributor.settleFees(address(vault), address(tokenA));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAWAL TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_withdrawFees() public {
        // First settlement initializes HWM (no fees)
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains above HWM
        tokenA.mint(address(vault), 5000 ether);
        vm.warp(block.timestamp + 1 days);

        // Second settlement produces real fees
        feeDistributor.settleFees(address(vault), address(tokenA));

        uint256 feeBalance = tokenA.balanceOf(address(feeDistributor));
        assertTrue(feeBalance > 0, "Should have fees from gains above HWM");

        // withdrawFees is capped to protocol portion (total - validator share)
        uint256 accumulated = feeDistributor.accumulatedFees(address(tokenA));
        uint256 valFees = feeDistributor.validatorFees(address(tokenA));
        uint256 protocolPortion = accumulated - valFees;
        assertTrue(protocolPortion > 0, "Protocol portion should be positive");

        uint256 treasuryBalBefore = tokenA.balanceOf(owner);

        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        feeDistributor.withdrawFees(address(tokenA), feeBalance); // capped to protocolPortion

        // Only protocol portion is withdrawn (not validator fees)
        assertEq(tokenA.balanceOf(owner) - treasuryBalBefore, protocolPortion);
    }

    function test_hwm_lossRecoveryCycle() public {
        // Full HWM state machine: gain → loss → gain
        // Verify perf fee only charged on NEW gains above the previous HWM

        // Step 1: First settlement initializes HWM to 10000
        feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);

        // Step 2: Gain to 15000 → settlement charges perf fee on 5000 gain
        tokenA.mint(address(vault), 5000 ether);
        vm.warp(block.timestamp + 1 days);
        (uint256 perfFee1,) = feeDistributor.settleFees(address(vault), address(tokenA));
        assertTrue(perfFee1 > 0, "Should charge perf fee on first gain");
        uint256 hwmAfterGain = feeDistributor.highWaterMark(address(vault));
        assertTrue(hwmAfterGain > 10000 ether, "HWM should be updated above initial");

        // Step 3: Loss — vault drops below HWM
        vm.prank(address(vault));
        tokenA.transfer(address(1), 3000 ether);
        vm.warp(block.timestamp + 1 days);
        (uint256 perfFee2,) = feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(perfFee2, 0, "No perf fee when below HWM");
        // HWM should NOT decrease
        assertEq(feeDistributor.highWaterMark(address(vault)), hwmAfterGain, "HWM should not decrease on loss");

        // Step 4: Recovery — vault gains back to above previous HWM
        tokenA.mint(address(vault), 6000 ether);
        vm.warp(block.timestamp + 1 days);
        uint256 currentAUM = tokenA.balanceOf(address(vault));
        assertTrue(currentAUM > hwmAfterGain, "AUM should exceed previous HWM after recovery");
        (uint256 perfFee3,) = feeDistributor.settleFees(address(vault), address(tokenA));
        // Perf fee only on gains ABOVE previous HWM, not on the entire recovery
        assertTrue(perfFee3 > 0, "Should charge perf fee on gains above old HWM");
        uint256 expectedGains = currentAUM - hwmAfterGain;
        uint256 expectedPerfFee = (expectedGains * 2000) / 10000;
        assertEq(perfFee3, expectedPerfFee, "Perf fee should be exactly 20% of gains above old HWM");
    }

    function test_withdrawValidatorFees() public {
        // First settlement initializes HWM (no fees)
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains above HWM
        tokenA.mint(address(vault), 5000 ether);
        vm.warp(block.timestamp + 1 days);

        // Second settlement produces real perf fees → validator share
        feeDistributor.settleFees(address(vault), address(tokenA));

        uint256 valFees = feeDistributor.validatorFees(address(tokenA));
        assertTrue(valFees > 0, "Should have validator fees from perf fee share");

        address validatorRecipient = makeAddr("validatorRecipient");
        uint256 recipientBalBefore = tokenA.balanceOf(validatorRecipient);

        address fdOwner = feeDistributor.owner();
        vm.prank(fdOwner);
        feeDistributor.withdrawValidatorFees(address(tokenA), validatorRecipient, valFees);

        assertEq(tokenA.balanceOf(validatorRecipient) - recipientBalBefore, valFees);
        assertEq(feeDistributor.validatorFees(address(tokenA)), 0);
    }
}
