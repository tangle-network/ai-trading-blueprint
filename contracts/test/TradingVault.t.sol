// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract MockUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        MockERC20(params.tokenOut).mint(params.recipient, params.amountOutMinimum);
        return params.amountOutMinimum;
    }
}

contract TradingVaultTest is Setup {
    TradingVault public vault;
    VaultShare public shareToken;
    MockTarget public mockTarget;
    MockUniswapV3Router public mockUniswapRouter;

    function setUp() public override {
        super.setUp();

        // Create vault via factory (handles all wiring)
        (address vaultAddr, address shareAddr) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        shareToken = VaultShare(shareAddr);

        // Deploy mock target that outputs tokenB
        mockTarget = new MockTarget(tokenB);
        mockUniswapRouter = new MockUniswapV3Router();

        // Approve vault for deposits
        vm.prank(user);
        tokenA.approve(address(vault), type(uint256).max);

        vm.prank(owner);
        tokenA.approve(address(vault), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Configure policy so execute() can pass policy checks
    function _configurePolicyForTrade() internal {
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

    function _configurePolicyForTarget(address target, address token, uint256 limit) internal {
        vm.startPrank(address(vaultFactory));

        address[] memory tokens = new address[](1);
        tokens[0] = token;
        policyEngine.setWhitelist(address(vault), tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = target;
        policyEngine.setTargetWhitelist(address(vault), targets, true);

        policyEngine.setPositionLimit(address(vault), token, limit);

        vm.stopPrank();
    }

    /// @dev Build ExecuteParams struct for execute()
    function _buildExecuteParams(uint256 outputAmount, uint256 minOutput, bytes32 intentHash, uint256 deadline)
        internal
        view
        returns (TradingVault.ExecuteParams memory)
    {
        bytes memory data = abi.encodeWithSelector(MockTarget.swap.selector, address(vault), outputAmount);

        return TradingVault.ExecuteParams({
            target: address(mockTarget),
            data: data,
            value: 0,
            minOutput: minOutput,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });
    }

    function _emptyApprovals() internal pure returns (TradingVault.ApprovalCall[] memory approvals) {
        approvals = new TradingVault.ApprovalCall[](0);
    }

    /// @dev Create validator signatures for an exact trade payload
    function _createValidatorSigs(TradingVault.ExecuteParams memory params, uint256 deadline)
        internal
        view
        returns (bytes[] memory signatures, uint256[] memory scores)
    {
        return _createValidatorSigs(params, _emptyApprovals(), deadline);
    }

    function _createValidatorSigs(
        TradingVault.ExecuteParams memory params,
        TradingVault.ApprovalCall[] memory approvals,
        uint256 deadline
    ) internal view returns (bytes[] memory signatures, uint256[] memory scores) {
        signatures = new bytes[](2);
        scores = new uint256[](2);

        scores[0] = 80;
        scores[1] = 75;
        bytes32 executionHash = vault.computeExecutionHash(params, approvals);
        signatures[0] =
            _signValidation(validator1Key, params.intentHash, executionHash, address(vault), scores[0], deadline);
        signatures[1] =
            _signValidation(validator2Key, params.intentHash, executionHash, address(vault), scores[1], deadline);
    }

    function _buildApprovalCalls(address token, address spender, uint256 amount)
        internal
        pure
        returns (TradingVault.ApprovalCall[] memory approvals)
    {
        approvals = new TradingVault.ApprovalCall[](1);
        approvals[0] = TradingVault.ApprovalCall({token: token, spender: spender, amount: amount});
    }

    function _createDebtReductionSigs(TradingVault.DebtReductionParams memory params, uint256 deadline)
        internal
        view
        returns (bytes[] memory signatures, uint256[] memory scores)
    {
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(params.inputToken, params.target, params.maxInput);

        signatures = new bytes[](2);
        scores = new uint256[](2);

        scores[0] = 80;
        scores[1] = 75;
        bytes32 executionHash = vault.computeDebtReductionHash(params, approvals);
        signatures[0] =
            _signValidation(validator1Key, params.intentHash, executionHash, address(vault), scores[0], deadline);
        signatures[1] =
            _signValidation(validator2Key, params.intentHash, executionHash, address(vault), scores[1], deadline);
    }

    function _createHealthFactorSigs(TradingVault.HealthFactorParams memory params, uint256 deadline)
        internal
        view
        returns (bytes[] memory signatures, uint256[] memory scores)
    {
        TradingVault.ApprovalCall[] memory approvals = _emptyApprovals();

        signatures = new bytes[](2);
        scores = new uint256[](2);

        scores[0] = 80;
        scores[1] = 75;
        bytes32 executionHash = vault.computeHealthFactorHash(params, approvals);
        signatures[0] =
            _signValidation(validator1Key, params.intentHash, executionHash, address(vault), scores[0], deadline);
        signatures[1] =
            _signValidation(validator2Key, params.intentHash, executionHash, address(vault), scores[1], deadline);
    }

    function _buildUniswapEnvelope(uint256 maxSingle, uint256 maxTotal, uint256 validUntil)
        internal
        view
        returns (TradeValidator.UniswapEnvelope memory envelope, address[] memory approvalSigners)
    {
        approvalSigners = new address[](2);
        approvalSigners[0] = validator1;
        approvalSigners[1] = validator2;
        envelope = TradeValidator.UniswapEnvelope({
            envelopeId: keccak256("uniswap-envelope-1"),
            botIdHash: keccak256("bot-1"),
            vault: address(vault),
            chainId: block.chainid,
            router: address(mockUniswapRouter),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            action: vault.UNISWAP_ACTION_SWAP(),
            maxSingleAmountIn: maxSingle,
            maxTotalAmountIn: maxTotal,
            maxSlippageBps: 100,
            minOutputPerInput: 0.9 ether,
            validFrom: block.timestamp,
            validUntil: validUntil,
            nonce: 1,
            approvalSignersHash: keccak256(abi.encodePacked(validator1, validator2)),
            minSignatures: 2
        });
    }

    function _signUniswapEnvelope(TradeValidator.UniswapEnvelope memory envelope)
        internal
        view
        returns (bytes[] memory signatures, uint256[] memory scores)
    {
        signatures = new bytes[](2);
        scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 75;
        bytes32 digest1 = tradeValidator.computeUniswapEnvelopeDigest(envelope, scores[0]);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest1);
        signatures[0] = abi.encodePacked(r1, s1, v1);
        bytes32 digest2 = tradeValidator.computeUniswapEnvelopeDigest(envelope, scores[1]);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest2);
        signatures[1] = abi.encodePacked(r2, s2, v2);
    }

    function _buildUniswapParams(uint256 amountIn, uint256 minOut, bytes32 intentHash, uint256 deadline)
        internal
        view
        returns (TradingVault.ExecuteParams memory params)
    {
        bytes memory data = abi.encodeWithSelector(
            MockUniswapV3Router.exactInputSingle.selector,
            MockUniswapV3Router.ExactInputSingleParams({
                tokenIn: address(tokenA),
                tokenOut: address(tokenB),
                fee: 3000,
                recipient: address(vault),
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        params = TradingVault.ExecuteParams({
            target: address(mockUniswapRouter),
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: intentHash,
            deadline: deadline
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_deposit() public {
        vm.prank(user);
        uint256 shares = vault.deposit(1000 ether, user);

        // First deposit: 1:1 ratio
        assertEq(shares, 1000 ether);
        assertEq(shareToken.balanceOf(user), 1000 ether);
        assertEq(vault.totalAssets(), 1000 ether);
    }

    function test_withdraw() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        uint256 balBefore = tokenA.balanceOf(user);

        vm.prank(user);
        uint256 shares = vault.withdraw(500 ether, user, user);

        assertEq(shares, 500 ether);
        assertEq(tokenA.balanceOf(user) - balBefore, 500 ether);
        assertEq(vault.totalAssets(), 500 ether);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_redeem() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        uint256 balBefore = tokenA.balanceOf(user);

        vm.prank(user);
        uint256 assets = vault.redeem(500 ether, user, user);

        assertEq(assets, 500 ether);
        assertEq(tokenA.balanceOf(user) - balBefore, 500 ether);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_admin_can_approve_spender_for_vault_assets() public {
        address spender = makeAddr("spender");

        vm.prank(owner);
        vault.approveSpender(address(tokenA), spender, 123 ether);

        assertEq(tokenA.allowance(address(vault), spender), 123 ether);
    }

    function test_operator_cannot_approve_spender() public {
        address spender = makeAddr("spender");

        vm.expectRevert();
        vm.prank(operator);
        vault.approveSpender(address(tokenA), spender, 123 ether);
    }

    function test_non_admin_cannot_approve_spender() public {
        address spender = makeAddr("spender");

        vm.expectRevert();
        vm.prank(user);
        vault.approveSpender(address(tokenA), spender, 123 ether);
    }

    function test_multipleDepositors() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        vm.prank(owner);
        vault.deposit(2000 ether, owner);

        assertEq(shareToken.balanceOf(user), 1000 ether);
        assertEq(shareToken.balanceOf(owner), 2000 ether);
        assertEq(vault.totalAssets(), 3000 ether);
    }

    function test_sharePrice() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);
        assertEq(shareToken.balanceOf(user), 1000 ether);

        // Simulate gains: mint more tokens directly to vault (doubling the NAV)
        tokenA.mint(address(vault), 1000 ether);

        // Now NAV = 2000, supply = 1000, so 1 share ~= 2 tokens
        // Virtual offset introduces up to 1 wei rounding (favors vault - prevents donation attacks)
        uint256 assetsPerShare = vault.convertToAssets(1 ether);
        assertApproxEqAbs(assetsPerShare, 2 ether, 1);

        // New deposit should get fewer shares: ~1000 (within 1 wei due to virtual offset)
        vm.prank(owner);
        uint256 newShares = vault.deposit(2000 ether, owner);
        assertApproxEqAbs(newShares, 1000 ether, 1);
    }

    function test_execute() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        _configurePolicyForTrade();

        uint256 expectedOutput = 500 ether;
        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params =
            _buildExecuteParams(expectedOutput, expectedOutput, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vault.execute(params, sigs, scores);

        assertEq(vault.getBalance(address(tokenB)), expectedOutput);
    }

    function test_executeWithApprovals() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        _configurePolicyForTrade();

        uint256 expectedOutput = 500 ether;
        bytes32 intentHash = keccak256("test trade approvals");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params =
            _buildExecuteParams(expectedOutput, expectedOutput, intentHash, deadline);
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(mockTarget), 123 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, approvals, deadline);

        vm.prank(operator);
        vault.executeWithApprovals(params, approvals, sigs, scores);

        assertEq(vault.getBalance(address(tokenB)), expectedOutput);
        assertEq(tokenA.allowance(address(vault), address(mockTarget)), 123 ether);
    }

    function test_executeUniswapEnvelope() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTarget(address(mockUniswapRouter), address(tokenB), 100_000 ether);

        (TradeValidator.UniswapEnvelope memory envelope, address[] memory approvalSigners) =
            _buildUniswapEnvelope(1000 ether, 1500 ether, block.timestamp + 1 hours);
        (bytes[] memory sigs, uint256[] memory scores) = _signUniswapEnvelope(envelope);
        TradingVault.ExecuteParams memory params =
            _buildUniswapParams(100 ether, 95 ether, keccak256("uniswap envelope trade"), block.timestamp + 30 minutes);

        vm.prank(operator);
        vault.executeUniswapEnvelope(params, envelope, approvalSigners, sigs, scores);

        bytes32 envelopeHash = tradeValidator.hashUniswapEnvelope(envelope);
        assertEq(tokenB.balanceOf(address(vault)), 95 ether);
        assertEq(vault.envelopeConsumedAmountIn(envelopeHash), 100 ether);
    }

    function test_executeUniswapEnvelopeRevertsExpired() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTarget(address(mockUniswapRouter), address(tokenB), 100_000 ether);

        (TradeValidator.UniswapEnvelope memory envelope, address[] memory approvalSigners) =
            _buildUniswapEnvelope(1000 ether, 1500 ether, block.timestamp + 1 hours);
        (bytes[] memory sigs, uint256[] memory scores) = _signUniswapEnvelope(envelope);
        vm.warp(block.timestamp + 2 hours);
        TradingVault.ExecuteParams memory params =
            _buildUniswapParams(100 ether, 95 ether, keccak256("expired envelope"), block.timestamp + 30 minutes);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeExpired.selector);
        vault.executeUniswapEnvelope(params, envelope, approvalSigners, sigs, scores);
    }

    function test_executeUniswapEnvelopeRevertsWhenTotalExhausted() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTarget(address(mockUniswapRouter), address(tokenB), 100_000 ether);

        (TradeValidator.UniswapEnvelope memory envelope, address[] memory approvalSigners) =
            _buildUniswapEnvelope(100 ether, 150 ether, block.timestamp + 1 hours);
        (bytes[] memory sigs, uint256[] memory scores) = _signUniswapEnvelope(envelope);

        TradingVault.ExecuteParams memory first =
            _buildUniswapParams(100 ether, 95 ether, keccak256("first envelope trade"), block.timestamp + 30 minutes);
        vm.prank(operator);
        vault.executeUniswapEnvelope(first, envelope, approvalSigners, sigs, scores);

        TradingVault.ExecuteParams memory second =
            _buildUniswapParams(60 ether, 57 ether, keccak256("second envelope trade"), block.timestamp + 30 minutes);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.EnvelopeTotalExceeded.selector, 60 ether, 50 ether));
        vault.executeUniswapEnvelope(second, envelope, approvalSigners, sigs, scores);
    }

    function test_executeRevertsWithoutPolicy() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        // Policy is initialized by factory with defaults but no token/target whitelists
        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.PolicyCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    function test_executeWithApprovalsRevertsWithoutPolicyAndLeavesNoAllowance() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        bytes32 intentHash = keccak256("test trade approvals without policy");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(mockTarget), 123 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, approvals, deadline);

        vm.prank(operator);
        vm.expectRevert(TradingVault.PolicyCheckFailed.selector);
        vault.executeWithApprovals(params, approvals, sigs, scores);

        assertEq(tokenA.allowance(address(vault), address(mockTarget)), 0);
    }

    function test_executeRevertsWithoutValidatorSigs() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);

        // Only provide 1 signature (need 2-of-3)
        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);
        scores[0] = 80;
        sigs[0] = _signValidation(
            validator1Key,
            intentHash,
            vault.computeExecutionHash(params, _emptyApprovals()),
            address(vault),
            scores[0],
            deadline
        );

        vm.prank(operator);
        vm.expectRevert(TradingVault.ValidatorCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    function test_executeWithApprovalsRevertsWithoutValidatorSigsAndLeavesNoAllowance() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("test trade approvals without sigs");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(mockTarget), 123 ether);

        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);
        scores[0] = 80;
        sigs[0] = _signValidation(
            validator1Key,
            intentHash,
            vault.computeExecutionHash(params, approvals),
            address(vault),
            scores[0],
            deadline
        );

        vm.prank(operator);
        vm.expectRevert(TradingVault.ValidatorCheckFailed.selector);
        vault.executeWithApprovals(params, approvals, sigs, scores);

        assertEq(tokenA.allowance(address(vault), address(mockTarget)), 0);
    }

    function test_executeMinOutputCheck() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 actualOutput = 100 ether;
        uint256 minOutput = 500 ether;
        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(actualOutput, minOutput, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.MinOutputNotMet.selector, actualOutput, minOutput));
        vault.execute(params, sigs, scores);
    }

    function test_executeRevertsWhenActualOutputExceedsPositionLimit() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTarget(address(mockTarget), address(tokenB), 100 ether);
        tokenB.mint(address(vault), 90 ether);

        bytes32 intentHash = keccak256("actual output exceeds position");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.ExecuteParams memory params = _buildExecuteParams(50 ether, 10 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TradingVault.PositionLimitExceeded.selector, address(tokenB), 140 ether, 100 ether)
        );
        vault.execute(params, sigs, scores);
    }

    function test_executeAllowsActualOutputAtPositionLimit() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTarget(address(mockTarget), address(tokenB), 100 ether);
        tokenB.mint(address(vault), 90 ether);

        bytes32 intentHash = keccak256("actual output at position");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.ExecuteParams memory params = _buildExecuteParams(10 ether, 10 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vault.execute(params, sigs, scores);

        assertEq(tokenB.balanceOf(address(vault)), 100 ether);
    }

    function test_executeSkipsFinalPositionCheckWhenLimitDisabled() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTarget(address(mockTarget), address(tokenB), 0);
        tokenB.mint(address(vault), 90 ether);

        bytes32 intentHash = keccak256("no position limit");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.ExecuteParams memory params = _buildExecuteParams(50 ether, 10 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vault.execute(params, sigs, scores);

        assertEq(tokenB.balanceOf(address(vault)), 140 ether);
    }

    function test_executeWithApprovalsMinOutputCheckLeavesNoAllowance() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 actualOutput = 100 ether;
        uint256 minOutput = 500 ether;
        bytes32 intentHash = keccak256("test trade approvals min output");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(actualOutput, minOutput, intentHash, deadline);
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(mockTarget), 123 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, approvals, deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.MinOutputNotMet.selector, actualOutput, minOutput));
        vault.executeWithApprovals(params, approvals, sigs, scores);

        assertEq(tokenA.allowance(address(vault), address(mockTarget)), 0);
    }

    function test_executeDebtReductionWithApprovals() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        MockDebtToken debtToken = new MockDebtToken();
        MockDebtRepayTarget repayTarget = new MockDebtRepayTarget(tokenA, debtToken);
        _configurePolicyForTarget(address(repayTarget), address(tokenA), 100_000 ether);

        debtToken.mint(address(vault), 700 ether);

        bytes32 intentHash = keccak256("debt reduction");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.DebtReductionParams memory params = TradingVault.DebtReductionParams({
            target: address(repayTarget),
            data: abi.encodeWithSelector(MockDebtRepayTarget.repay.selector, address(vault), 500 ether, 500 ether),
            value: 0,
            inputToken: address(tokenA),
            maxInput: 500 ether,
            debtToken: address(debtToken),
            minDebtDecrease: 500 ether,
            intentHash: intentHash,
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(repayTarget), 500 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _createDebtReductionSigs(params, deadline);

        vm.prank(operator);
        vault.executeDebtReductionWithApprovals(params, approvals, sigs, scores);

        assertEq(debtToken.balanceOf(address(vault)), 200 ether);
        assertEq(tokenA.balanceOf(address(repayTarget)), 500 ether);
    }

    function test_executeDebtReductionRevertsWhenDebtDoesNotDecrease() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        MockDebtToken debtToken = new MockDebtToken();
        MockDebtRepayTarget repayTarget = new MockDebtRepayTarget(tokenA, debtToken);
        _configurePolicyForTarget(address(repayTarget), address(tokenA), 100_000 ether);

        debtToken.mint(address(vault), 700 ether);

        bytes32 intentHash = keccak256("no debt reduction");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.DebtReductionParams memory params = TradingVault.DebtReductionParams({
            target: address(repayTarget),
            data: abi.encodeWithSelector(MockDebtRepayTarget.repay.selector, address(vault), 500 ether, 0),
            value: 0,
            inputToken: address(tokenA),
            maxInput: 500 ether,
            debtToken: address(debtToken),
            minDebtDecrease: 500 ether,
            intentHash: intentHash,
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(repayTarget), 500 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _createDebtReductionSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.DebtDecreaseNotMet.selector, 0, 500 ether));
        vault.executeDebtReductionWithApprovals(params, approvals, sigs, scores);
    }

    function test_executeDebtReductionRevertsWhenDebtDecreaseBelowMinimum() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);

        MockDebtToken debtToken = new MockDebtToken();
        MockDebtRepayTarget repayTarget = new MockDebtRepayTarget(tokenA, debtToken);
        _configurePolicyForTarget(address(repayTarget), address(tokenA), 100_000 ether);

        debtToken.mint(address(vault), 700 ether);

        bytes32 intentHash = keccak256("small debt reduction");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.DebtReductionParams memory params = TradingVault.DebtReductionParams({
            target: address(repayTarget),
            data: abi.encodeWithSelector(MockDebtRepayTarget.repay.selector, address(vault), 500 ether, 499 ether),
            value: 0,
            inputToken: address(tokenA),
            maxInput: 500 ether,
            debtToken: address(debtToken),
            minDebtDecrease: 500 ether,
            intentHash: intentHash,
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(repayTarget), 500 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _createDebtReductionSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.DebtDecreaseNotMet.selector, 499 ether, 500 ether));
        vault.executeDebtReductionWithApprovals(params, approvals, sigs, scores);
    }

    function test_debtReductionHashChangesWhenPostconditionChanges() public {
        MockDebtToken debtToken = new MockDebtToken();
        MockDebtRepayTarget repayTarget = new MockDebtRepayTarget(tokenA, debtToken);
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.DebtReductionParams memory params = TradingVault.DebtReductionParams({
            target: address(repayTarget),
            data: abi.encodeWithSelector(MockDebtRepayTarget.repay.selector, address(vault), 500 ether, 500 ether),
            value: 0,
            inputToken: address(tokenA),
            maxInput: 500 ether,
            debtToken: address(debtToken),
            minDebtDecrease: 500 ether,
            intentHash: keccak256("hash debt reduction"),
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals =
            _buildApprovalCalls(address(tokenA), address(repayTarget), 500 ether);

        bytes32 baseHash = vault.computeDebtReductionHash(params, approvals);
        params.minDebtDecrease = 499 ether;

        assertTrue(baseHash != vault.computeDebtReductionHash(params, approvals));
    }

    function test_executeHealthFactorWithApprovals() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        MockAavePoolHealth pool = new MockAavePoolHealth(2 ether);
        bytes32 intentHash = keccak256("health factor execution");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 500 ether),
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            pool: address(pool),
            account: address(vault),
            minHealthFactor: 1.5 ether,
            intentHash: intentHash,
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals = _emptyApprovals();
        (bytes[] memory sigs, uint256[] memory scores) = _createHealthFactorSigs(params, deadline);

        vm.prank(operator);
        vault.executeHealthFactorWithApprovals(params, approvals, sigs, scores);

        assertEq(tokenB.balanceOf(address(vault)), 500 ether);
    }

    function test_executeHealthFactorRevertsWhenHealthTooLow() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        MockAavePoolHealth pool = new MockAavePoolHealth(1.2 ether);
        bytes32 intentHash = keccak256("low health factor");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 500 ether),
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            pool: address(pool),
            account: address(vault),
            minHealthFactor: 1.5 ether,
            intentHash: intentHash,
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals = _emptyApprovals();
        (bytes[] memory sigs, uint256[] memory scores) = _createHealthFactorSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.HealthFactorTooLow.selector, 1.2 ether, 1.5 ether));
        vault.executeHealthFactorWithApprovals(params, approvals, sigs, scores);
    }

    function test_executeHealthFactorRevertsWhenActualOutputExceedsPositionLimit() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTarget(address(mockTarget), address(tokenB), 100 ether);
        tokenB.mint(address(vault), 90 ether);

        MockAavePoolHealth pool = new MockAavePoolHealth(2 ether);
        bytes32 intentHash = keccak256("health factor position limit");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 50 ether),
            value: 0,
            minOutput: 10 ether,
            outputToken: address(tokenB),
            pool: address(pool),
            account: address(vault),
            minHealthFactor: 1.5 ether,
            intentHash: intentHash,
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals = _emptyApprovals();
        (bytes[] memory sigs, uint256[] memory scores) = _createHealthFactorSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TradingVault.PositionLimitExceeded.selector, address(tokenB), 140 ether, 100 ether)
        );
        vault.executeHealthFactorWithApprovals(params, approvals, sigs, scores);
    }

    function test_healthFactorHashChangesWhenThresholdChanges() public {
        MockAavePoolHealth pool = new MockAavePoolHealth(2 ether);
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: address(mockTarget),
            data: abi.encodeWithSelector(MockTarget.swap.selector, address(vault), 500 ether),
            value: 0,
            minOutput: 500 ether,
            outputToken: address(tokenB),
            pool: address(pool),
            account: address(vault),
            minHealthFactor: 1.5 ether,
            intentHash: keccak256("hash health factor"),
            deadline: deadline
        });
        TradingVault.ApprovalCall[] memory approvals = _emptyApprovals();

        bytes32 baseHash = vault.computeHealthFactorHash(params, approvals);
        params.minHealthFactor = 1.4 ether;

        assertTrue(baseHash != vault.computeHealthFactorHash(params, approvals));
    }

    function test_emergencyWithdraw() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        uint256 balBefore = tokenA.balanceOf(owner);

        vm.prank(owner);
        vault.emergencyWithdraw(address(tokenA), owner);

        assertEq(tokenA.balanceOf(owner) - balBefore, 1000 ether);
        assertEq(vault.getBalance(address(tokenA)), 0);
    }

    function test_pause() public {
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());

        // Deposits blocked — no external call in selector, safe with prank
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1000 ether, user);

        // Unpause
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());

        // Deposit works again
        vm.prank(user);
        vault.deposit(1000 ether, user);
        assertEq(shareToken.balanceOf(user), 1000 ether);
    }

    function test_onlyOperatorCanExecute() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        bytes32 intentHash = keccak256("test trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        // Non-operator (user) tries to execute
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, operatorRole)
        );
        vault.execute(params, sigs, scores);
    }

    function test_onlyAdminCanEmergencyWithdraw() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, adminRole)
        );
        vault.emergencyWithdraw(address(tokenA), user);
    }

    function test_depositWhenPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1000 ether, user);
    }

    function test_getBalance() public {
        vm.prank(user);
        vault.deposit(123 ether, user);
        assertEq(vault.getBalance(address(tokenA)), 123 ether);

        vm.deal(address(vault), 5 ether);
        assertEq(vault.getBalance(address(0)), 5 ether);
    }

    function test_intentDedup_preventsDoubleExecution() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 expectedOutput = 500 ether;
        bytes32 intentHash = keccak256("dedup test");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params =
            _buildExecuteParams(expectedOutput, expectedOutput, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        // First execution succeeds
        vm.prank(operator);
        vault.execute(params, sigs, scores);
        assertTrue(vault.executedIntents(intentHash));

        // Second execution with same intentHash reverts
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.IntentAlreadyExecuted.selector, intentHash));
        vault.execute(params, sigs, scores);
    }

    function test_intentDedup_differentHashesWork() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 expectedOutput = 500 ether;
        uint256 deadline = block.timestamp + 1 hours;

        // Trade 1
        bytes32 hash1 = keccak256("trade 1");
        TradingVault.ExecuteParams memory params1 = _buildExecuteParams(expectedOutput, expectedOutput, hash1, deadline);
        (bytes[] memory sigs1, uint256[] memory scores1) = _createValidatorSigs(params1, deadline);

        vm.prank(operator);
        vault.execute(params1, sigs1, scores1);

        // Trade 2 with different hash — should succeed
        bytes32 hash2 = keccak256("trade 2");
        TradingVault.ExecuteParams memory params2 = _buildExecuteParams(expectedOutput, expectedOutput, hash2, deadline);
        (bytes[] memory sigs2, uint256[] memory scores2) = _createValidatorSigs(params2, deadline);

        vm.prank(operator);
        vault.execute(params2, sigs2, scores2);

        assertTrue(vault.executedIntents(hash1));
        assertTrue(vault.executedIntents(hash2));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT LOCKUP TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_depositLockup_blocksEarlyWithdraw() public {
        // Admin sets 1 day lockup
        vm.prank(owner);
        vault.setDepositLockup(1 days);
        assertEq(vault.depositLockupDuration(), 1 days);

        // User deposits
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Immediate withdraw reverts
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, block.timestamp + 1 days));
        vault.withdraw(500 ether, user, user);

        // Immediate redeem also reverts
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, block.timestamp + 1 days));
        vault.redeem(500 ether, user, user);
    }

    function test_depositLockup_allowsAfterDuration() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Advance past lockup
        vm.warp(block.timestamp + 1 days + 1);

        // Withdraw succeeds
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_depositLockup_resetsOnNewDeposit() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // Start at a known timestamp
        vm.warp(100000);

        vm.prank(user);
        vault.deposit(1000 ether, user);
        // lockup expires at 100000 + 86400 = 186400

        // Advance 23 hours
        vm.warp(100000 + 23 hours);

        // New deposit resets the lockup timer
        vm.prank(user);
        vault.deposit(500 ether, user);
        // lockup now expires at (100000 + 23h) + 86400

        uint256 secondDepositTime = block.timestamp;

        // Advance 23 hours from second deposit
        vm.warp(secondDepositTime + 23 hours);

        // Still locked (second deposit was 23h ago, lockup is 24h)
        uint256 unlockTime = vault.lastDepositTime(user) + vault.depositLockupDuration();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, unlockTime));
        vault.withdraw(500 ether, user, user);

        // Advance past lockup from second deposit
        vm.warp(secondDepositTime + 1 days + 1);

        // Now succeeds
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
    }

    function test_depositLockup_zeroMeansNoLockup() public {
        // Default is 0 (no lockup)
        assertEq(vault.depositLockupDuration(), 0);

        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Immediate withdraw works
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
        assertEq(shareToken.balanceOf(user), 500 ether);
    }

    function test_depositLockup_perDepositorIsolation() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // User deposits first
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Advance 2 days
        vm.warp(block.timestamp + 2 days);

        // Owner deposits (starts their own lockup)
        vm.prank(owner);
        vault.deposit(1000 ether, owner);

        // User can withdraw (past lockup)
        vm.prank(user);
        vault.withdraw(500 ether, user, user);

        // Owner cannot (just deposited)
        uint256 ownerUnlock = vault.lastDepositTime(owner) + vault.depositLockupDuration();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, ownerUnlock));
        vault.withdraw(500 ether, owner, owner);
    }

    function test_depositLockup_fairnessScenario() public {
        // THE EXACT SCENARIO THE USER DESCRIBED:
        // User A deposits, positions taken, User B deposits liquid,
        // User A tries to immediately withdraw B's liquidity

        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // User A deposits 1000
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // Simulate trading gains: vault now has 1500 (500 profit)
        tokenA.mint(address(vault), 500 ether);

        // User B (owner) deposits 1000 at the higher share price
        vm.prank(owner);
        vault.deposit(1000 ether, owner);

        // User A tries to immediately withdraw profit using B's liquidity.
        // A deposited at t=1, lockup is 1 day — still active.
        uint256 userUnlock2 = vault.lastDepositTime(user) + vault.depositLockupDuration();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.WithdrawalLocked.selector, userUnlock2));
        vault.withdraw(500 ether, user, user);

        // After lockup expires, withdrawal is allowed
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(user);
        vault.withdraw(500 ether, user, user);
    }

    function test_depositLockup_onlyAdminCanSet() public {
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, adminRole)
        );
        vault.setDepositLockup(1 days);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LOCKUP: GRIEFING PREVENTION + ERC-4626 COMPLIANCE
    // ═══════════════════════════════════════════════════════════════════════════

    function test_depositLockup_thirdPartyDepositDoesNotGriefReceiver() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        // User deposits for themselves first
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(1000 ether, user);
        vm.stopPrank();

        // Warp past lockup
        vm.warp(block.timestamp + 1 days + 1);

        // Attacker deposits 1 wei to user's address (third-party deposit)
        address attacker = makeAddr("attacker");
        tokenA.mint(attacker, 1 ether);
        vm.startPrank(attacker);
        tokenA.approve(address(vault), 1 ether);
        vault.deposit(1 ether, user); // msg.sender != receiver
        vm.stopPrank();

        // User should STILL be able to withdraw (lockup not reset by third-party deposit)
        vm.prank(user);
        vault.redeem(100 ether, user, user); // should not revert
    }

    function test_depositLockup_maxWithdraw_returnsZeroDuringLockup() public {
        vm.prank(owner);
        vault.setDepositLockup(1 days);

        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(1000 ether, user);
        vm.stopPrank();

        // During lockup period
        assertEq(vault.maxWithdraw(user), 0, "maxWithdraw should return 0 during lockup");
        assertEq(vault.maxRedeem(user), 0, "maxRedeem should return 0 during lockup");

        // After lockup expires
        vm.warp(block.timestamp + 1 days + 1);
        assertTrue(vault.maxWithdraw(user) > 0, "maxWithdraw should be positive after lockup");
        assertTrue(vault.maxRedeem(user) > 0, "maxRedeem should be positive after lockup");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAW ROUNDING (ERC-4626 COMPLIANCE)
    // ═══════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════════
    // THIRD-PARTY WITHDRAWAL VIA SHARE ALLOWANCE (ERC-4626 _spendShareAllowance)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_thirdPartyWithdraw_viaShareAllowance() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        // User approves a third-party spender on the share token
        address spender = makeAddr("spender");
        vm.prank(user);
        shareToken.approve(spender, 500 ether);

        uint256 userSharesBefore = shareToken.balanceOf(user);
        uint256 spenderTokensBefore = tokenA.balanceOf(spender);

        // Spender calls withdraw on behalf of user, assets sent to spender
        vm.prank(spender);
        uint256 sharesBurned = vault.withdraw(500 ether, spender, user);

        assertEq(sharesBurned, 500 ether, "Should burn exact shares for first-deposit ratio");
        assertEq(shareToken.balanceOf(user), userSharesBefore - sharesBurned, "Shares burned from owner");
        assertEq(tokenA.balanceOf(spender) - spenderTokensBefore, 500 ether, "Assets sent to spender");
        // Allowance should be decremented
        assertEq(shareToken.allowance(user, spender), 0, "Allowance fully consumed");
    }

    function test_thirdPartyRedeem_viaShareAllowance() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        address spender = makeAddr("spender");
        vm.prank(user);
        shareToken.approve(spender, 300 ether);

        uint256 spenderTokensBefore = tokenA.balanceOf(spender);

        // Spender redeems shares on behalf of user
        vm.prank(spender);
        uint256 assets = vault.redeem(300 ether, spender, user);

        assertEq(assets, 300 ether, "First-deposit 1:1 ratio");
        assertEq(tokenA.balanceOf(spender) - spenderTokensBefore, 300 ether);
        assertEq(shareToken.allowance(user, spender), 0, "Allowance fully consumed");
    }

    function test_thirdPartyWithdraw_insufficientAllowance_reverts() public {
        vm.prank(user);
        vault.deposit(1000 ether, user);

        address spender = makeAddr("spender");
        vm.prank(user);
        shareToken.approve(spender, 100 ether); // only 100 approved

        // Spender tries to withdraw 500 (needs 500 shares) — should revert with ERC20InsufficientAllowance
        vm.prank(spender);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, 100 ether, 500 ether)
        );
        vault.withdraw(500 ether, spender, user);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTE WHEN PAUSED
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_whenPaused_reverts() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        vm.prank(owner);
        vault.pause();

        bytes32 intentHash = keccak256("paused trade");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.ExecuteParams memory params = _buildExecuteParams(500 ether, 500 ether, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NATIVE ETH EXECUTION PATH
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_nativeETH_output() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        // Deploy an ETH-returning target
        MockETHTarget ethTarget = new MockETHTarget();
        vm.deal(address(ethTarget), 100 ether);

        // Whitelist the ETH target and address(0) as output token
        vm.startPrank(address(vaultFactory));
        address[] memory targets = new address[](1);
        targets[0] = address(ethTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);
        // Whitelist address(0) as token for ETH output
        policyEngine.whitelistToken(address(vault), address(0), true);
        policyEngine.setPositionLimit(address(vault), address(0), 100 ether);
        vm.stopPrank();

        bytes32 intentHash = keccak256("eth trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(ethTarget),
            data: abi.encodeWithSelector(MockETHTarget.sendETH.selector, address(vault), 5 ether),
            value: 0,
            minOutput: 5 ether,
            outputToken: address(0), // ETH output path
            intentHash: intentHash,
            deadline: deadline
        });

        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        uint256 vaultETHBefore = address(vault).balance;

        vm.prank(operator);
        vault.execute(params, sigs, scores);

        assertEq(address(vault).balance - vaultETHBefore, 5 ether, "Vault should receive ETH");
    }

    function test_execute_nativeETH_revertsWhenActualOutputExceedsPositionLimit() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        MockETHTarget ethTarget = new MockETHTarget();
        vm.deal(address(ethTarget), 100 ether);

        vm.startPrank(address(vaultFactory));
        address[] memory targets = new address[](1);
        targets[0] = address(ethTarget);
        policyEngine.setTargetWhitelist(address(vault), targets, true);
        policyEngine.whitelistToken(address(vault), address(0), true);
        policyEngine.setPositionLimit(address(vault), address(0), 10 ether);
        vm.stopPrank();

        bytes32 intentHash = keccak256("eth position limit");
        uint256 deadline = block.timestamp + 1 hours;
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(ethTarget),
            data: abi.encodeWithSelector(MockETHTarget.sendETH.selector, address(vault), 20 ether),
            value: 0,
            minOutput: 5 ether,
            outputToken: address(0),
            intentHash: intentHash,
            deadline: deadline
        });
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TradingVault.PositionLimitExceeded.selector, address(0), 20 ether, 10 ether)
        );
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // KEY EVENT TESTS — TradeExecuted
    // ═══════════════════════════════════════════════════════════════════════════

    function test_execute_emitsTradeExecuted() public {
        vm.prank(user);
        vault.deposit(10000 ether, user);
        _configurePolicyForTrade();

        uint256 outputAmount = 500 ether;
        bytes32 intentHash = keccak256("event trade");
        uint256 deadline = block.timestamp + 1 hours;

        TradingVault.ExecuteParams memory params = _buildExecuteParams(outputAmount, outputAmount, intentHash, deadline);
        (bytes[] memory sigs, uint256[] memory scores) = _createValidatorSigs(params, deadline);

        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit TradingVault.TradeExecuted(address(mockTarget), 0, outputAmount, address(tokenB), intentHash);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAW ROUNDING (ERC-4626 COMPLIANCE)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_withdraw_roundsSharesUp() public {
        // Deposit to establish share ratio
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(1000 ether, user);
        vm.stopPrank();

        // Simulate gains to make share ratio non-trivial
        tokenA.mint(address(vault), 500 ether);

        // Calculate: shares for 1 wei of assets should round up
        uint256 previewShares = vault.previewWithdraw(1);
        uint256 convertShares = vault.convertToShares(1);

        // previewWithdraw rounds UP, convertToShares rounds DOWN
        // For amounts that don't divide evenly, previewWithdraw >= convertToShares
        assertTrue(previewShares >= convertShares, "previewWithdraw must be >= convertToShares (rounding up)");

        // Verify actual withdraw burns the right (rounded up) amount
        uint256 withdrawAmount = 333 ether; // unlikely to divide evenly
        uint256 sharesBefore = shareToken.balanceOf(user);

        vm.prank(user);
        uint256 sharesBurned = vault.withdraw(withdrawAmount, user, user);

        uint256 sharesAfter = shareToken.balanceOf(user);
        assertEq(sharesBefore - sharesAfter, sharesBurned, "Burned shares should match return value");

        // The shares burned should be >= what convertToShares would give (rounded UP)
        // This protects the vault from rounding exploits
        assertTrue(
            sharesBurned >= vault.convertToShares(withdrawAmount), "withdraw must burn >= convertToShares (round UP)"
        );
    }
}

/// @title MockETHTarget
/// @notice Mock target that sends ETH back to a vault (for testing native ETH execution path)
contract MockETHTarget {
    function sendETH(address to, uint256 amount) external {
        (bool success,) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}

contract MockDebtToken is MockERC20 {
    constructor() MockERC20("Debt Token", "DEBT", 18) {}

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockDebtRepayTarget {
    MockERC20 public inputToken;
    MockDebtToken public debtToken;

    constructor(MockERC20 _inputToken, MockDebtToken _debtToken) {
        inputToken = _inputToken;
        debtToken = _debtToken;
    }

    function repay(address vault, uint256 inputAmount, uint256 debtDecrease) external {
        inputToken.transferFrom(vault, address(this), inputAmount);
        if (debtDecrease > 0) {
            debtToken.burn(vault, debtDecrease);
        }
    }
}

contract MockAavePoolHealth {
    uint256 public healthFactor;

    constructor(uint256 _healthFactor) {
        healthFactor = _healthFactor;
    }

    function setHealthFactor(uint256 _healthFactor) external {
        healthFactor = _healthFactor;
    }

    function getUserAccountData(address)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 returnedHealthFactor
        )
    {
        return (0, 0, 0, 0, 0, healthFactor);
    }
}
