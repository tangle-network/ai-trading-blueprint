// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

contract FeeDistributorTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;

    function setUp() public override {
        super.setUp();

        // Create vault via factory (handles all wiring including FeeDistributor approval)
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Deposit tokens into the vault to simulate AUM
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(10000 ether, user);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_defaultFees() public view {
        assertEq(feeDistributor.performanceFeeBps(), 2000); // 20%
        assertEq(feeDistributor.managementFeeBps(), 200); // 2%
        assertEq(feeDistributor.validatorFeeShareBps(), 3000); // 30%
    }

    function test_setFeeConfig() public {
        // FeeDistributor is owned by test contract (via constructor arg: owner)
        // Actually, feeDistributor was deployed as: new FeeDistributor(owner)
        // The Ownable(msg.sender) makes the test contract the owner, treasury=owner.
        // Let's check who owns it:
        address fdOwner = feeDistributor.owner();

        vm.startPrank(fdOwner);
        feeDistributor.setPerformanceFee(1500);
        feeDistributor.setManagementFee(100);
        feeDistributor.setValidatorFeeShare(5000);
        vm.stopPrank();

        assertEq(feeDistributor.performanceFeeBps(), 1500);
        assertEq(feeDistributor.managementFeeBps(), 100);
        assertEq(feeDistributor.validatorFeeShareBps(), 5000);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SETTLEMENT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_settleFees() public {
        address fdOwner = feeDistributor.owner();

        vm.prank(fdOwner);
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(
            address(vault), address(tokenA)
        );

        // First settlement: HWM was 0, AUM is 10000 ether
        // Perf fee = 10000 * 2000 / 10000 = 2000
        assertEq(perfFee, 2000 ether);
        // Mgmt fee = 0 (first settlement, lastSettled == block.timestamp)
        assertEq(mgmtFee, 0);

        // Verify tokens actually transferred to FeeDistributor
        assertEq(tokenA.balanceOf(address(feeDistributor)), 2000 ether);

        // HWM should be updated
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);
        assertEq(feeDistributor.lastSettled(address(vault)), block.timestamp);
    }

    function test_performanceFee() public {
        address fdOwner = feeDistributor.owner();

        // First settlement sets HWM
        vm.prank(fdOwner);
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains by minting more tokens to vault
        vm.warp(block.timestamp + 30 days);
        tokenA.mint(address(vault), 5000 ether); // AUM now ~13000 (10000-2000fees+5000minted)

        uint256 currentAUM = tokenA.balanceOf(address(vault));

        vm.prank(fdOwner);
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(
            address(vault), address(tokenA)
        );

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
        address fdOwner = feeDistributor.owner();

        // First settlement sets baseline
        vm.prank(fdOwner);
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Advance time 365 days
        vm.warp(block.timestamp + 365 days);

        uint256 currentAUM = tokenA.balanceOf(address(vault));

        vm.prank(fdOwner);
        (, uint256 mgmtFee) = feeDistributor.settleFees(
            address(vault), address(tokenA)
        );

        // Management fee = AUM * 200 / 10000 * (365 days / 365 days) = AUM * 2%
        uint256 expectedMgmt = (currentAUM * 200 * 365 days) / (10000 * 365 days);
        assertEq(mgmtFee, expectedMgmt);
    }

    function test_noFeesBelowHWM() public {
        address fdOwner = feeDistributor.owner();

        // First settlement sets HWM to 10000
        vm.prank(fdOwner);
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Advance time
        vm.warp(block.timestamp + 30 days);

        // Current AUM is now less than HWM (after fees were taken)
        uint256 currentAUM = tokenA.balanceOf(address(vault));
        assertTrue(currentAUM < 10000 ether, "AUM should be below HWM after fee deduction");

        vm.prank(fdOwner);
        (uint256 perfFee,) = feeDistributor.settleFees(
            address(vault), address(tokenA)
        );

        // No perf fee when below HWM
        assertEq(perfFee, 0);
        // HWM should NOT be updated (still 10000)
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);
    }

    function test_highWaterMarkUpdated() public {
        address fdOwner = feeDistributor.owner();

        // First settlement
        vm.prank(fdOwner);
        feeDistributor.settleFees(address(vault), address(tokenA));
        assertEq(feeDistributor.highWaterMark(address(vault)), 10000 ether);

        // Add more tokens to vault, making AUM exceed HWM
        tokenA.mint(address(vault), 20000 ether);
        uint256 newAUM = tokenA.balanceOf(address(vault));

        vm.warp(block.timestamp + 1 days);

        vm.prank(fdOwner);
        feeDistributor.settleFees(address(vault), address(tokenA));

        // HWM should be updated to new AUM
        assertEq(feeDistributor.highWaterMark(address(vault)), newAUM);
    }

    function test_validatorFeeShare() public {
        address fdOwner = feeDistributor.owner();

        vm.prank(fdOwner);
        (uint256 perfFee,) = feeDistributor.settleFees(address(vault), address(tokenA));

        // Validator share = perfFee * validatorFeeShareBps / BPS_DENOMINATOR
        uint256 expectedValidatorShare = (perfFee * 3000) / 10000;
        assertEq(feeDistributor.validatorFees(address(tokenA)), expectedValidatorShare);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAWAL TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_withdrawFees() public {
        address fdOwner = feeDistributor.owner();

        // Settle fees first
        vm.prank(fdOwner);
        feeDistributor.settleFees(address(vault), address(tokenA));

        uint256 feeBalance = tokenA.balanceOf(address(feeDistributor));
        assertTrue(feeBalance > 0);

        uint256 treasuryBalBefore = tokenA.balanceOf(owner);

        vm.prank(fdOwner);
        feeDistributor.withdrawFees(address(tokenA), feeBalance);

        // Fees should be sent to treasury (which is `owner`)
        assertEq(tokenA.balanceOf(owner) - treasuryBalBefore, feeBalance);
    }

    function test_withdrawValidatorFees() public {
        address fdOwner = feeDistributor.owner();

        // Settle fees to accumulate validator fees
        vm.prank(fdOwner);
        feeDistributor.settleFees(address(vault), address(tokenA));

        uint256 valFees = feeDistributor.validatorFees(address(tokenA));
        assertTrue(valFees > 0);

        address validatorRecipient = makeAddr("validatorRecipient");
        uint256 recipientBalBefore = tokenA.balanceOf(validatorRecipient);

        vm.prank(fdOwner);
        feeDistributor.withdrawValidatorFees(address(tokenA), validatorRecipient, valFees);

        assertEq(tokenA.balanceOf(validatorRecipient) - recipientBalBefore, valFees);
        assertEq(feeDistributor.validatorFees(address(tokenA)), 0);
    }
}
