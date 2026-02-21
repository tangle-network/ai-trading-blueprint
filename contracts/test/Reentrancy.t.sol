// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @title ReentrantExecuteTarget
/// @notice When called via swap(), attempts to re-enter vault.execute() with different params.
///         The nonReentrant guard on execute() causes the inner call to revert,
///         which makes the outer target.call() return success=false -> ExecutionFailed().
contract ReentrantExecuteTarget {
    MockERC20 public outputToken;
    TradingVault public vault;
    address public attackerOperator;

    TradingVault.ExecuteParams public reentrantParams;
    bytes[] public reentrantSigs;
    uint256[] public reentrantScores;

    constructor(MockERC20 _outputToken, TradingVault _vault, address _operator) {
        outputToken = _outputToken;
        vault = _vault;
        attackerOperator = _operator;
    }

    /// @notice Store the params/sigs that will be used for the reentrant call.
    ///         Must be set before the outer execute() is called.
    function setReentrantPayload(
        TradingVault.ExecuteParams calldata params,
        bytes[] calldata sigs,
        uint256[] calldata scores
    ) external {
        reentrantParams = params;
        // Copy dynamic arrays into storage
        delete reentrantSigs;
        delete reentrantScores;
        for (uint256 i = 0; i < sigs.length; i++) {
            reentrantSigs.push(sigs[i]);
            reentrantScores.push(scores[i]);
        }
    }

    /// @notice Called by vault during execute(). Tries to re-enter vault.execute().
    function swap(address, uint256) external payable {
        // Attempt reentrancy into execute()
        vault.execute(reentrantParams, reentrantSigs, reentrantScores);
    }

    receive() external payable {}
}

/// @title ReentrantDepositTarget
/// @notice When called via swap(), attempts to re-enter vault.deposit().
contract ReentrantDepositTarget {
    MockERC20 public outputToken;
    TradingVault public vault;
    MockERC20 public depositToken;

    constructor(MockERC20 _outputToken, TradingVault _vault, MockERC20 _depositToken) {
        outputToken = _outputToken;
        vault = _vault;
        depositToken = _depositToken;
    }

    /// @notice Called by vault during execute(). Tries to re-enter vault.deposit().
    function swap(address, uint256) external payable {
        // Approve vault to pull tokens for the deposit
        depositToken.approve(address(vault), type(uint256).max);
        // Attempt reentrancy into deposit()
        vault.deposit(1 ether, address(this));
    }

    receive() external payable {}
}

/// @title ReentrantWithdrawTarget
/// @notice When called via swap(), attempts to re-enter vault.withdraw().
contract ReentrantWithdrawTarget {
    MockERC20 public outputToken;
    TradingVault public vault;

    constructor(MockERC20 _outputToken, TradingVault _vault) {
        outputToken = _outputToken;
        vault = _vault;
    }

    /// @notice Called by vault during execute(). Tries to re-enter vault.withdraw().
    function swap(address, uint256) external payable {
        // Attempt reentrancy into withdraw()
        vault.withdraw(1 ether, address(this), address(this));
    }

    receive() external payable {}
}

/// @title ReentrancyTest
/// @notice Tests that the nonReentrant guard on TradingVault prevents reentrancy
///         through execute(), deposit(), and withdraw() during an active execute() call.
contract ReentrancyTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;

    function setUp() public override {
        super.setUp();

        // Create vault via factory
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Approve vault for deposits
        vm.prank(user);
        tokenA.approve(address(vault), type(uint256).max);

        // User deposits so the vault has funds
        vm.prank(user);
        vault.deposit(10_000 ether, user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Configure policy: whitelist tokens, targets, and set position limits.
    function _configurePolicyForTarget(address target) internal {
        vm.startPrank(address(vaultFactory));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = target;
        policyEngine.setTargetWhitelist(address(vault), targets, true);

        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);

        vm.stopPrank();
    }

    /// @dev Build ExecuteParams pointing at a specific target contract.
    ///      The swap call sends output tokens to the vault address, and uses tokenB as outputToken
    ///      so that policy checks pass before the external call is reached.
    function _buildParams(
        address target,
        uint256 outputAmount,
        bytes32 intentHash,
        uint256 deadline
    ) internal view returns (TradingVault.ExecuteParams memory) {
        bytes memory data = abi.encodeWithSelector(
            MockTarget.swap.selector,
            address(vault),
            outputAmount
        );

        return TradingVault.ExecuteParams({
            target: target,
            data: data,
            value: 0,
            minOutput: outputAmount,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });
    }

    /// @dev Create 2-of-3 validator signatures.
    function _createSigs(bytes32 intentHash, uint256 deadline)
        internal
        view
        returns (bytes[] memory signatures, uint256[] memory scores)
    {
        signatures = new bytes[](2);
        scores = new uint256[](2);

        scores[0] = 80;
        scores[1] = 75;
        signatures[0] = _signValidation(validator1Key, intentHash, address(vault), scores[0], deadline);
        signatures[1] = _signValidation(validator2Key, intentHash, address(vault), scores[1], deadline);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: execute() -> execute() reentrancy
    // ═══════════════════════════════════════════════════════════════════════════

    function test_reentrancy_executeToExecute() public {
        ReentrantExecuteTarget malicious = new ReentrantExecuteTarget(tokenB, vault, operator);

        _configurePolicyForTarget(address(malicious));

        uint256 deadline = block.timestamp + 1 hours;

        // Build the reentrant (inner) call params with a different intent hash
        bytes32 innerIntentHash = keccak256("inner reentrant trade");
        TradingVault.ExecuteParams memory innerParams = _buildParams(
            address(malicious), 100 ether, innerIntentHash, deadline
        );
        (bytes[] memory innerSigs, uint256[] memory innerScores) = _createSigs(innerIntentHash, deadline);

        // Store inner payload in the malicious contract
        malicious.setReentrantPayload(innerParams, innerSigs, innerScores);

        // Build the outer call params
        bytes32 outerIntentHash = keccak256("outer trade");
        TradingVault.ExecuteParams memory outerParams = _buildParams(
            address(malicious), 100 ether, outerIntentHash, deadline
        );
        (bytes[] memory outerSigs, uint256[] memory outerScores) = _createSigs(outerIntentHash, deadline);

        // Record balances before
        uint256 vaultTokenABefore = tokenA.balanceOf(address(vault));
        uint256 sharesBefore = shareToken.balanceOf(user);

        // The outer execute() calls malicious.swap(), which tries vault.execute() again.
        // The inner execute() reverts due to nonReentrant, so target.call returns false,
        // causing the outer execute() to revert with ExecutionFailed().
        vm.prank(operator);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        vault.execute(outerParams, outerSigs, outerScores);

        // Verify vault state is unchanged after the reverted transaction
        assertEq(tokenA.balanceOf(address(vault)), vaultTokenABefore, "vault tokenA balance changed");
        assertEq(shareToken.balanceOf(user), sharesBefore, "user shares changed");
        // The outer intent hash should NOT be marked as executed since the tx reverted
        assertFalse(vault.executedIntents(outerIntentHash), "outer intent incorrectly marked executed");
        assertFalse(vault.executedIntents(innerIntentHash), "inner intent incorrectly marked executed");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: execute() -> deposit() reentrancy
    // ═══════════════════════════════════════════════════════════════════════════

    function test_reentrancy_executeToDeposit() public {
        ReentrantDepositTarget malicious = new ReentrantDepositTarget(tokenB, vault, tokenA);

        _configurePolicyForTarget(address(malicious));

        // Give the malicious contract tokens so it could deposit (if reentrancy succeeded)
        tokenA.mint(address(malicious), 10_000 ether);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentHash = keccak256("deposit reentrant trade");

        TradingVault.ExecuteParams memory params = _buildParams(
            address(malicious), 100 ether, intentHash, deadline
        );
        (bytes[] memory sigs, uint256[] memory scores) = _createSigs(intentHash, deadline);

        // Record balances before
        uint256 vaultTokenABefore = tokenA.balanceOf(address(vault));
        uint256 totalSharesBefore = shareToken.totalSupply();

        // The outer execute() calls malicious.swap(), which tries vault.deposit().
        // deposit() reverts due to nonReentrant, target.call returns false -> ExecutionFailed().
        vm.prank(operator);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        vault.execute(params, sigs, scores);

        // Verify no shares were minted and no tokens moved
        assertEq(tokenA.balanceOf(address(vault)), vaultTokenABefore, "vault tokenA balance changed");
        assertEq(shareToken.totalSupply(), totalSharesBefore, "total share supply changed");
        assertFalse(vault.executedIntents(intentHash), "intent incorrectly marked executed");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: execute() -> withdraw() reentrancy
    // ═══════════════════════════════════════════════════════════════════════════

    function test_reentrancy_executeToWithdraw() public {
        ReentrantWithdrawTarget malicious = new ReentrantWithdrawTarget(tokenB, vault);

        _configurePolicyForTarget(address(malicious));

        // Give the malicious contract shares so it could withdraw (if reentrancy succeeded).
        // First deposit as user, then transfer shares to the malicious contract.
        vm.prank(user);
        shareToken.transfer(address(malicious), 1_000 ether);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentHash = keccak256("withdraw reentrant trade");

        TradingVault.ExecuteParams memory params = _buildParams(
            address(malicious), 100 ether, intentHash, deadline
        );
        (bytes[] memory sigs, uint256[] memory scores) = _createSigs(intentHash, deadline);

        // Record balances before
        uint256 vaultTokenABefore = tokenA.balanceOf(address(vault));
        uint256 maliciousSharesBefore = shareToken.balanceOf(address(malicious));
        uint256 maliciousTokenABefore = tokenA.balanceOf(address(malicious));

        // The outer execute() calls malicious.swap(), which tries vault.withdraw().
        // withdraw() reverts due to nonReentrant, target.call returns false -> ExecutionFailed().
        vm.prank(operator);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        vault.execute(params, sigs, scores);

        // Verify no tokens were withdrawn and shares unchanged
        assertEq(tokenA.balanceOf(address(vault)), vaultTokenABefore, "vault tokenA balance changed");
        assertEq(
            shareToken.balanceOf(address(malicious)),
            maliciousSharesBefore,
            "malicious contract shares changed"
        );
        assertEq(
            tokenA.balanceOf(address(malicious)),
            maliciousTokenABefore,
            "malicious contract tokenA balance changed"
        );
        assertFalse(vault.executedIntents(intentHash), "intent incorrectly marked executed");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST: Legitimate execute still works (sanity check)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Confirms that a normal (non-reentrant) execute succeeds after reentrancy tests.
    ///         This ensures the nonReentrant guard only blocks actual reentrancy and does not
    ///         permanently lock the vault.
    function test_legitimateExecuteAfterReentrancyAttempt() public {
        // First, run a failed reentrancy attempt
        ReentrantDepositTarget malicious = new ReentrantDepositTarget(tokenB, vault, tokenA);
        MockTarget legitimateTarget = new MockTarget(tokenB);

        // Whitelist both targets
        vm.startPrank(address(vaultFactory));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](2);
        targets[0] = address(malicious);
        targets[1] = address(legitimateTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);

        policyEngine.setPositionLimit(address(vault), address(tokenB), 100_000 ether);

        vm.stopPrank();

        tokenA.mint(address(malicious), 10_000 ether);

        uint256 deadline = block.timestamp + 1 hours;

        // Attempt the reentrancy (should fail with ExecutionFailed)
        bytes32 maliciousHash = keccak256("malicious trade");
        TradingVault.ExecuteParams memory maliciousParams = _buildParams(
            address(malicious), 100 ether, maliciousHash, deadline
        );
        (bytes[] memory mSigs, uint256[] memory mScores) = _createSigs(maliciousHash, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.ExecutionFailed.selector);
        vault.execute(maliciousParams, mSigs, mScores);

        // Now do a legitimate trade — should succeed
        uint256 outputAmount = 500 ether;
        bytes32 legitHash = keccak256("legit trade");
        TradingVault.ExecuteParams memory legitParams = _buildParams(
            address(legitimateTarget), outputAmount, legitHash, deadline
        );
        (bytes[] memory lSigs, uint256[] memory lScores) = _createSigs(legitHash, deadline);

        vm.prank(operator);
        vault.execute(legitParams, lSigs, lScores);

        // Verify the legitimate trade succeeded
        assertEq(vault.getBalance(address(tokenB)), outputAmount, "legitimate trade output mismatch");
        assertTrue(vault.executedIntents(legitHash), "legitimate intent not marked executed");
    }
}
