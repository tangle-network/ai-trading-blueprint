// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../helpers/Setup.sol";

/// @title FullLifecycleTest
/// @notice End-to-end integration test:
///   create vault via factory -> configure policy -> user deposits via ERC-7575 ->
///   validate trade via policy -> get 2-of-3 validator EIP-712 signatures ->
///   execute trade with signatures -> verify trade output -> settle fees (verify tokens moved) ->
///   redeem shares -> emergency withdraw
contract FullLifecycleTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;
    MockTarget public mockTarget;
    uint64 constant SERVICE_ID = 1;

    function setUp() public override {
        super.setUp();
        mockTarget = new MockTarget(tokenB);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // HELPERS - broken out to avoid stack-too-deep
    // ═════════════════════════════════════════════════════════════════════════

    function _createVault() internal returns (address vaultAddr, address shareAddr) {
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;

        (vaultAddr, shareAddr) = vaultFactory.createVault(
            SERVICE_ID,
            address(tokenA),
            owner,
            operator,
            signers,
            2, // 2-of-3
            "Lifecycle Test Shares",
            "ltSHR",
            bytes32("lifecycle-test")
        );

        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        assertTrue(vaultAddr != address(0), "Vault address should be non-zero");
        assertTrue(shareAddr != address(0), "Share address should be non-zero");
        assertTrue(policyEngine.isInitialized(vaultAddr), "Policy should be initialized");
        assertEq(tradeValidator.getRequiredSignatures(vaultAddr), 2, "Should require 2 sigs");
    }

    function _configurePolicy() internal {
        vm.startPrank(address(vaultFactory));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = address(mockTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);

        policyEngine.setPositionLimit(address(vault), address(tokenA), 100_000 ether);
        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);
        policyEngine.setLeverageCap(address(vault), 30000); // 3x

        vm.stopPrank();
    }

    function _depositFunds() internal {
        uint256 depositAmount = 10_000 ether;
        vm.startPrank(user);
        tokenA.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, user);
        vm.stopPrank();

        assertEq(shares, depositAmount, "First deposit should be 1:1");
        assertEq(vault.totalAssets(), depositAmount, "Vault should hold deposited assets");
        assertEq(shareToken.balanceOf(user), depositAmount, "User should have shares");
    }

    function _validateTradePolicy() internal {
        bool policyValid = policyEngine.validateTrade(
            address(vault), address(tokenB), 1000 ether, address(mockTarget), 20000
        );
        assertTrue(policyValid, "Policy validation should pass");
    }

    function _executeTrade()
        internal
        returns (uint256 expectedOutput, bytes32 intentHash)
    {
        expectedOutput = 950 ether;
        intentHash = keccak256(abi.encodePacked(
            address(tokenA), uint256(1000 ether), address(mockTarget), uint256(20000)
        ));
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory signatures = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 85;
        scores[1] = 75;
        signatures[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        signatures[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);

        bytes memory swapData = abi.encodeWithSelector(
            MockTarget.swap.selector, address(vault), expectedOutput
        );

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: swapData,
            value: 0,
            minOutput: 900 ether,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });

        vm.prank(operator);
        vault.execute(params, signatures, scores);

        assertEq(vault.getBalance(address(tokenB)), expectedOutput, "Output token balance incorrect");
    }

    function _settleFees() internal {
        address fdOwner = feeDistributor.owner();

        // Capture AUM before settlement (fees will reduce it)
        uint256 tokenAAUM = tokenA.balanceOf(address(vault));

        // First settlement establishes the baseline
        vm.prank(fdOwner);
        (uint256 perfFee1,) = feeDistributor.settleFees(address(vault), address(tokenA));

        // HWM was 0, so gains = full AUM, perfFee = AUM * 20%
        uint256 expectedPerfFee = (tokenAAUM * 2000) / 10000;
        assertEq(perfFee1, expectedPerfFee, "Performance fee incorrect on first settlement");

        // Verify tokens actually moved to FeeDistributor
        assertTrue(
            tokenA.balanceOf(address(feeDistributor)) >= perfFee1,
            "Fee tokens should be in FeeDistributor"
        );

        // Advance time 30 days then settle again
        vm.warp(block.timestamp + 30 days);

        vm.prank(fdOwner);
        (uint256 perfFee2, uint256 mgmtFee) = feeDistributor.settleFees(
            address(vault), address(tokenA)
        );

        // No new gains since HWM was set, so perf fee = 0
        assertEq(perfFee2, 0, "No perf fee when at or below HWM");
        assertTrue(mgmtFee > 0, "Management fee should be positive after 30 days");
    }

    function _redeemShares() internal {
        uint256 userShares = shareToken.balanceOf(user);
        assertTrue(userShares > 0, "User should have shares to redeem");

        uint256 sharesToRedeem = userShares / 2;
        uint256 userBalBefore = tokenA.balanceOf(user);

        vm.prank(user);
        uint256 assetsReturned = vault.redeem(sharesToRedeem, user, user);

        assertTrue(assetsReturned > 0, "Should receive some assets");
        assertEq(tokenA.balanceOf(user) - userBalBefore, assetsReturned, "Assets should transfer");
        assertEq(shareToken.balanceOf(user), userShares - sharesToRedeem, "Shares should be burned");
    }

    function _emergencyWithdraw() internal {
        vm.startPrank(owner);
        vault.pause();
        assertTrue(vault.paused(), "Vault should be paused");
        vm.stopPrank();

        // Normal operations blocked
        vm.prank(user);
        vm.expectRevert();
        vault.redeem(1 ether, user, user);

        // Emergency withdraw (admin only, works when paused)
        vm.startPrank(owner);
        vault.emergencyWithdraw(address(tokenA), owner);
        assertEq(vault.getBalance(address(tokenA)), 0, "Emergency withdraw should drain tokenA");

        vault.emergencyWithdraw(address(tokenB), owner);
        assertEq(vault.getBalance(address(tokenB)), 0, "Emergency withdraw should drain tokenB");

        vault.unpause();
        assertFalse(vault.paused(), "Vault should be unpaused");
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // MAIN TEST
    // ═════════════════════════════════════════════════════════════════════════

    function test_fullLifecycle() public {
        // Step 1: Create vault via factory
        _createVault();

        // Step 2: Configure policy engine
        _configurePolicy();

        // Step 3: User deposits via ERC-7575
        _depositFunds();

        // Step 4: Validate trade via policy
        _validateTradePolicy();

        // Step 5+6: Get 2-of-3 validator EIP-712 signatures + execute trade
        _executeTrade();

        // Step 7: Settle fees (verify tokens moved)
        _settleFees();

        // Step 8: Redeem shares
        _redeemShares();

        // Step 9: Emergency withdraw
        _emergencyWithdraw();
    }
}
