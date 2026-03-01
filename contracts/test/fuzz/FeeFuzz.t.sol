// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../helpers/Setup.sol";

contract FeeFuzzTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;

    function setUp() public override {
        super.setUp();

        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Deposit tokens into the vault to simulate AUM
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 ether, user);
        vm.stopPrank();

        // Approve fee distributor to pull fees from vault
        vm.prank(owner);
        vault.approveFeeAllowance(type(uint256).max);
    }

    /// @notice Fuzz fee rates: fees should never exceed vault balance
    function testFuzz_feeRatesCappedToVaultBalance(
        uint256 perfBps,
        uint256 mgmtBps,
        uint256 valShareBps,
        uint256 gains,
        uint256 elapsed
    ) public {
        // Bound fee rates to valid BPS range (0-10000)
        perfBps = bound(perfBps, 0, 10000);
        mgmtBps = bound(mgmtBps, 0, 10000);
        valShareBps = bound(valShareBps, 0, 10000);
        gains = bound(gains, 0, 100_000 ether);
        elapsed = bound(elapsed, 1, 365 days);

        // Set custom fee rates
        vm.prank(owner);
        feeDistributor.setVaultFeeConfig(
            address(vault),
            FeeDistributor.FeeConfig({
                performanceFeeBps: perfBps,
                managementFeeBps: mgmtBps,
                validatorFeeShareBps: valShareBps
            })
        );

        // First settlement initializes HWM
        feeDistributor.settleFees(address(vault), address(tokenA));

        // Simulate gains
        if (gains > 0) {
            tokenA.mint(address(vault), gains);
        }
        vm.warp(block.timestamp + elapsed);

        uint256 vaultBalBefore = tokenA.balanceOf(address(vault));

        // Settlement should succeed without reverting
        (uint256 perfFee, uint256 mgmtFee) = feeDistributor.settleFees(address(vault), address(tokenA));
        uint256 totalFee = perfFee + mgmtFee;

        // Core invariant: fees never exceed vault balance
        assertLe(totalFee, vaultBalBefore, "Total fee must not exceed vault balance");

        // Verify fee distributor received exactly totalFee
        if (totalFee > 0) {
            assertEq(
                tokenA.balanceOf(address(feeDistributor)),
                totalFee,
                "Fee distributor should hold exactly totalFee"
            );
        }
    }

    /// @notice Fuzz fee rates: HWM should never decrease
    function testFuzz_hwmNeverDecreases(uint256 perfBps, uint256 gains1, uint256 loss, uint256 gains2) public {
        perfBps = bound(perfBps, 0, 10000);
        gains1 = bound(gains1, 1 ether, 50_000 ether);
        loss = bound(loss, 0, 8_000 ether); // can't lose more than vault has
        gains2 = bound(gains2, 0, 50_000 ether);

        vm.prank(owner);
        feeDistributor.setVaultFeeConfig(
            address(vault),
            FeeDistributor.FeeConfig({
                performanceFeeBps: perfBps,
                managementFeeBps: 0, // isolate perf fee behavior
                validatorFeeShareBps: 3000
            })
        );

        // Initialize HWM
        feeDistributor.settleFees(address(vault), address(tokenA));
        uint256 hwm0 = feeDistributor.highWaterMark(address(vault));

        // Gain phase
        tokenA.mint(address(vault), gains1);
        vm.warp(block.timestamp + 1 days);
        feeDistributor.settleFees(address(vault), address(tokenA));
        uint256 hwm1 = feeDistributor.highWaterMark(address(vault));
        assertGe(hwm1, hwm0, "HWM should not decrease after gains");

        // Loss phase
        if (loss > 0 && loss <= tokenA.balanceOf(address(vault))) {
            vm.prank(address(vault));
            tokenA.transfer(address(1), loss);
        }
        vm.warp(block.timestamp + 1 days);
        feeDistributor.settleFees(address(vault), address(tokenA));
        uint256 hwm2 = feeDistributor.highWaterMark(address(vault));
        assertGe(hwm2, hwm1, "HWM should not decrease after loss");

        // Recovery phase
        tokenA.mint(address(vault), gains2);
        vm.warp(block.timestamp + 1 days);
        feeDistributor.settleFees(address(vault), address(tokenA));
        uint256 hwm3 = feeDistributor.highWaterMark(address(vault));
        assertGe(hwm3, hwm2, "HWM should not decrease after recovery");
    }

    /// @notice Fuzz: validator fee share is always <= total fee
    function testFuzz_validatorShareBounded(uint256 perfBps, uint256 valShareBps, uint256 gains) public {
        perfBps = bound(perfBps, 100, 10000); // at least 1% to get some fees
        valShareBps = bound(valShareBps, 0, 10000);
        gains = bound(gains, 1 ether, 100_000 ether);

        vm.prank(owner);
        feeDistributor.setVaultFeeConfig(
            address(vault),
            FeeDistributor.FeeConfig({
                performanceFeeBps: perfBps,
                managementFeeBps: 0,
                validatorFeeShareBps: valShareBps
            })
        );

        feeDistributor.settleFees(address(vault), address(tokenA));
        tokenA.mint(address(vault), gains);
        vm.warp(block.timestamp + 1 days);

        feeDistributor.settleFees(address(vault), address(tokenA));

        uint256 accumulated = feeDistributor.accumulatedFees(address(tokenA));
        uint256 valFees = feeDistributor.validatorFees(address(tokenA));

        // Core invariant: validator fees <= accumulated fees
        assertLe(valFees, accumulated, "Validator fees must be <= accumulated fees");
    }
}
