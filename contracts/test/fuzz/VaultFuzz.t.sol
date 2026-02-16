// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../helpers/Setup.sol";

contract VaultFuzzTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;

    function setUp() public override {
        super.setUp();

        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);
    }

    /// @notice Fuzz deposit amounts: deposit -> redeem should return <= deposited (rounding)
    function testFuzz_depositRedeem(uint256 amount) public {
        // Bound to reasonable range: 1 wei to 100M tokens
        amount = bound(amount, 1, 100_000_000 ether);

        // Mint and approve
        tokenA.mint(user, amount);
        vm.startPrank(user);
        tokenA.approve(address(vault), amount);

        uint256 balBefore = tokenA.balanceOf(user);

        // Deposit
        uint256 shares = vault.deposit(amount, user);

        // Redeem all shares
        uint256 assetsReturned = vault.redeem(shares, user, user);

        vm.stopPrank();

        // Should get back <= deposited (accounting for rounding)
        assertLe(assetsReturned, amount, "Should not receive more than deposited");

        // Should get back at least amount - 1 (off-by-one rounding)
        assertGe(assetsReturned, amount - 1, "Rounding loss should be at most 1 wei");
    }

    /// @notice Fuzz multiple depositors: total shares should be proportional
    function testFuzz_multipleDepositors(uint256 amount1, uint256 amount2) public {
        // Bound to reasonable range
        amount1 = bound(amount1, 1 ether, 1_000_000 ether);
        amount2 = bound(amount2, 1 ether, 1_000_000 ether);

        // User 1 deposits
        tokenA.mint(user, amount1);
        vm.startPrank(user);
        tokenA.approve(address(vault), amount1);
        uint256 shares1 = vault.deposit(amount1, user);
        vm.stopPrank();

        // User 2 deposits
        tokenA.mint(owner, amount2);
        vm.startPrank(owner);
        tokenA.approve(address(vault), amount2);
        uint256 shares2 = vault.deposit(amount2, owner);
        vm.stopPrank();

        // Total shares should equal individual shares
        assertEq(shareToken.totalSupply(), shares1 + shares2, "Total supply should match");

        // Share ratio should be proportional to deposit ratio
        // shares1/shares2 ~= amount1/amount2 (with rounding)
        // Verify: shares1 * amount2 ~= shares2 * amount1 (cross multiplication)
        // Allow for rounding: |shares1 * amount2 - shares2 * amount1| <= max(amount1, amount2)
        uint256 lhs = shares1 * amount2;
        uint256 rhs = shares2 * amount1;
        uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
        uint256 maxAmount = amount1 > amount2 ? amount1 : amount2;

        assertLe(diff, maxAmount, "Share ratios should be approximately proportional");
    }
}
