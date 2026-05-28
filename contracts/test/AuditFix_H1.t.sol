// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @notice Regression for the 2026-04-19 audit finding **H-1**: admin must not
///         be able to set `adminUnwindMaxDrawdownBps` to 0 (which silently
///         fell back to the default and read as a benign no-op while erasing
///         the explicit cap) or to a value above 100%.
contract AuditFixH1Test is Setup {
    TradingVault public vault;

    function setUp() public override {
        super.setUp();
        (address vaultAddr,) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
    }

    function test_setAdminUnwindMaxDrawdownBps_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(TradingVault.InvalidBps.selector);
        vault.setAdminUnwindMaxDrawdownBps(0);
    }

    function test_setAdminUnwindMaxDrawdownBps_revertsAbove10000() public {
        vm.prank(owner);
        vm.expectRevert(TradingVault.InvalidBps.selector);
        vault.setAdminUnwindMaxDrawdownBps(10001);
    }

    function test_setAdminUnwindMaxDrawdownBps_acceptsValidBound() public {
        vm.prank(owner);
        vault.setAdminUnwindMaxDrawdownBps(750); // 7.5%
        assertEq(vault.adminUnwindMaxDrawdownBps(), 750);
    }

    function test_setAdminUnwindMaxDrawdownBps_acceptsCeiling() public {
        vm.prank(owner);
        vault.setAdminUnwindMaxDrawdownBps(10000); // 100% — silly but accepted
        assertEq(vault.adminUnwindMaxDrawdownBps(), 10000);
    }
}
