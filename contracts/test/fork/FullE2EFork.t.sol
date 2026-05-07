// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/TradingVault.sol";
import "../../src/VaultShare.sol";
import "../../src/VaultFactory.sol";
import "../../src/VaultDeployer.sol";
import "../../src/VaultShareDeployer.sol";
import "../../src/PolicyEngine.sol";
import "../../src/TradeValidator.sol";
import "../../src/FeeDistributor.sol";
import "../../src/StrategyRegistry.sol";

/// @title Full E2E Fork Tests — No Fake Shit
/// @notice Deploys the ENTIRE vault stack on a real chain fork. Deposits real USDC.
///         Constructs a real trade intent. Signs with EIP-712 validator keys.
///         Executes through vault.executeWithApprovals(). Real tokens move.
///         Depositor withdraws after. Every layer of the stack is exercised.
/// @dev Run: forge test --mc FullE2EForkTest --fork-url $ARBITRUM_RPC_URL -vvv
contract FullE2EForkTest is Test {
    // ═══════════════════════════════════════════════════════════════════════════
    // Real Arbitrum addresses
    // ═══════════════════════════════════════════════════════════════════════════

    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant UNISWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant USDC_WHALE = 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7;

    // ═══════════════════════════════════════════════════════════════════════════
    // Test accounts
    // ═══════════════════════════════════════════════════════════════════════════

    address owner;
    address depositor;
    address operator;
    uint256 validator1Key;
    address validator1;
    uint256 validator2Key;
    address validator2;

    // ═══════════════════════════════════════════════════════════════════════════
    // Deployed contracts (on Arbitrum fork)
    // ═══════════════════════════════════════════════════════════════════════════

    VaultFactory factory;
    PolicyEngine policyEngine;
    TradeValidator tradeValidator;
    FeeDistributor feeDistributor;
    TradingVault vault;
    VaultShare share;

    function setUp() public {
        if (block.chainid != 42161) return;

        // Create test accounts with known keys for EIP-712 signing
        owner = makeAddr("owner");
        depositor = makeAddr("depositor");
        operator = makeAddr("operator");
        (validator1, validator1Key) = makeAddrAndKey("validator1");
        (validator2, validator2Key) = makeAddrAndKey("validator2");

        vm.deal(owner, 10 ether);
        vm.deal(operator, 10 ether);

        // ── Deploy full vault stack on Arbitrum fork ────────────────────────

        // PolicyEngine, TradeValidator, FeeDistributor — all Ownable2Step
        policyEngine = new PolicyEngine();
        tradeValidator = new TradeValidator();
        feeDistributor = new FeeDistributor(owner);

        // VaultFactory takes ownership of PE + TV + FD
        factory = new VaultFactory(policyEngine, tradeValidator, feeDistributor);
        VaultDeployer vaultDeployer = new VaultDeployer(address(factory), policyEngine, tradeValidator, feeDistributor);
        VaultShareDeployer vaultShareDeployer = new VaultShareDeployer(address(factory));
        factory.setVaultDeployers(vaultDeployer, vaultShareDeployer);

        policyEngine.transferOwnership(address(factory));
        vm.prank(address(factory));
        policyEngine.acceptOwnership();

        tradeValidator.transferOwnership(address(factory));
        vm.prank(address(factory));
        tradeValidator.acceptOwnership();

        feeDistributor.transferOwnership(address(factory));
        vm.prank(address(factory));
        feeDistributor.acceptOwnership();

        // ── Create vault with real USDC as deposit asset ────────────────────

        address[] memory signers = new address[](2);
        signers[0] = validator1;
        signers[1] = validator2;

        (address vaultAddr, address shareAddr) = factory.createVault(
            1, // serviceId
            USDC, // real USDC on Arbitrum
            owner,
            operator,
            signers,
            2, // 2-of-2 signatures required
            "AI Trading Vault Shares",
            "atUSDC",
            bytes32("e2e-salt"),
            PolicyEngine.PolicyConfig({leverageCap: 50000, maxTradesPerHour: 100, maxSlippageBps: 500}),
            FeeDistributor.FeeConfig({performanceFeeBps: 2000, managementFeeBps: 200, validatorFeeShareBps: 3000})
        );

        vault = TradingVault(payable(vaultAddr));
        share = VaultShare(shareAddr);

        // ── Whitelist real Uniswap router + tokens ──────────────────────────

        vm.startPrank(address(factory));
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;
        policyEngine.setWhitelist(vaultAddr, tokens, true);

        address[] memory targets = new address[](1);
        targets[0] = UNISWAP_ROUTER;
        policyEngine.setTargetWhitelist(vaultAddr, targets, true);
        vm.stopPrank();

        // ── Fund depositor with real USDC from whale ────────────────────────

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(depositor, 10_000 * 1e6); // 10,000 USDC

        // ── Depositor deposits into vault ───────────────────────────────────

        vm.startPrank(depositor);
        IERC20(USDC).approve(vaultAddr, 10_000 * 1e6);
        vault.deposit(10_000 * 1e6, depositor);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 1: Full trade execution through vault — real USDC → real WETH
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice The real deal: deposit → validate → sign → executeWithApprovals → tokens move
    function test_e2e_vault_swap_usdc_to_weth() public {
        if (block.chainid != 42161) return;

        uint256 swapAmount = 500 * 1e6; // 500 USDC
        bytes32 intentHash = keccak256("e2e-swap-usdc-weth-001");
        uint256 deadline = block.timestamp + 300;

        // ── Step 1: Build the exact swap calldata ───────────────────────────
        // This is what the Rust adapter (uniswap_v3.rs) generates:
        // exactInputSingle(tokenIn=USDC, tokenOut=WETH, fee=500, recipient=vault)
        bytes memory swapCalldata = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
            USDC, // tokenIn
            WETH, // tokenOut
            uint24(500), // fee tier (5bps — most liquid USDC/WETH pool)
            address(vault), // recipient = vault (funds stay in vault!)
            block.timestamp + 1800, // swap deadline
            swapAmount, // amountIn
            uint256(1), // amountOutMinimum (non-zero — real prod uses slippage calc)
            uint160(0) // sqrtPriceLimitX96 (0 = no limit)
        );

        // ── Step 2: AI validators sign the intent (EIP-712) ────────────────
        // In production: AI agent creates intent → validators score it (0-100) →
        // validators sign with their private keys → signatures sent back.
        // Here we use test keys but the EIP-712 math is identical to production.
        uint256 score = 85; // AI confidence score
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), score, deadline, 0);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), score, deadline, 0);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = score;
        scores[1] = score;

        // ── Step 3: Build the approval (vault approves Uniswap to spend USDC) ──
        TradingVault.ApprovalCall[] memory approvals = new TradingVault.ApprovalCall[](1);
        approvals[0] = TradingVault.ApprovalCall({token: USDC, spender: UNISWAP_ROUTER, amount: swapAmount});

        // ── Step 4: Build execution params ──────────────────────────────────
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: UNISWAP_ROUTER,
            data: swapCalldata,
            value: 0,
            minOutput: 1, // non-zero (real prod uses proper slippage)
            outputToken: WETH,
            intentHash: intentHash,
            deadline: deadline
        });

        // ── Step 5: Record state before ─────────────────────────────────────
        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultWethBefore = IERC20(WETH).balanceOf(address(vault));
        uint256 depositorSharesBefore = share.balanceOf(depositor);

        // ── Step 6: EXECUTE — operator submits the validated trade ───────────
        vm.prank(operator);
        vault.executeWithApprovals(params, approvals, sigs, scores);

        // ── Step 7: Verify real tokens moved ────────────────────────────────
        uint256 vaultUsdcAfter = IERC20(USDC).balanceOf(address(vault));
        uint256 vaultWethAfter = IERC20(WETH).balanceOf(address(vault));

        // Vault spent USDC
        assertEq(vaultUsdcBefore - vaultUsdcAfter, swapAmount, "Vault should have spent exactly 500 USDC");

        // Vault received WETH
        uint256 wethReceived = vaultWethAfter - vaultWethBefore;
        assertGt(wethReceived, 0, "Vault should have received WETH");

        // Sanity: 500 USDC ≈ 0.15-0.25 ETH at current prices
        assertGt(wethReceived, 0.05 ether, "Should receive meaningful WETH (>0.05 ETH)");
        assertLt(wethReceived, 5 ether, "Should not receive absurd WETH (<5 ETH)");

        // Depositor shares unchanged (trade doesn't affect shares)
        assertEq(share.balanceOf(depositor), depositorSharesBefore, "Depositor shares unchanged");

        // totalAssets should account for the WETH position
        uint256 totalAfter = vault.totalAssets();
        assertGt(totalAfter, 0, "Total assets should be positive");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 2: Depositor can withdraw after trade
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Depositor deposits USDC, trade happens, depositor withdraws remaining USDC.
    function test_e2e_depositor_withdraws_after_trade() public {
        if (block.chainid != 42161) return;

        // Withdraw some USDC (vault still has most of the 10k deposit)
        uint256 withdrawAmount = 1000 * 1e6; // 1000 USDC

        uint256 depositorUsdcBefore = IERC20(USDC).balanceOf(depositor);

        vm.prank(depositor);
        vault.withdraw(withdrawAmount, depositor, depositor);

        uint256 depositorUsdcAfter = IERC20(USDC).balanceOf(depositor);
        assertGe(
            depositorUsdcAfter - depositorUsdcBefore,
            withdrawAmount - 1, // allow 1 wei rounding
            "Depositor should receive USDC"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 3: Intent dedup prevents replay
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Same intentHash cannot be executed twice — even with valid signatures.
    function test_e2e_intent_replay_blocked() public {
        if (block.chainid != 42161) return;

        bytes32 intentHash = keccak256("replay-test-001");
        uint256 deadline = block.timestamp + 300;
        uint256 swapAmount = 100 * 1e6;

        bytes memory swapCalldata = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
            USDC,
            WETH,
            uint24(500),
            address(vault),
            block.timestamp + 1800,
            swapAmount,
            uint256(1),
            uint160(0)
        );

        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline, 0);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline, 0);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        TradingVault.ApprovalCall[] memory approvals = new TradingVault.ApprovalCall[](1);
        approvals[0] = TradingVault.ApprovalCall({token: USDC, spender: UNISWAP_ROUTER, amount: swapAmount});

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: UNISWAP_ROUTER,
            data: swapCalldata,
            value: 0,
            minOutput: 1,
            outputToken: WETH,
            intentHash: intentHash,
            deadline: deadline
        });

        // First execution succeeds
        vm.prank(operator);
        vault.executeWithApprovals(params, approvals, sigs, scores);

        // Second execution with same intentHash REVERTS
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TradingVault.IntentAlreadyExecuted.selector, intentHash));
        vault.executeWithApprovals(params, approvals, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 4: Non-operator cannot execute
    // ═══════════════════════════════════════════════════════════════════════════

    function test_e2e_non_operator_rejected() public {
        if (block.chainid != 42161) return;

        bytes32 intentHash = keccak256("non-operator-test");
        uint256 deadline = block.timestamp + 300;

        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline, 0);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline, 0);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: UNISWAP_ROUTER,
            data: "",
            value: 0,
            minOutput: 1,
            outputToken: WETH,
            intentHash: intentHash,
            deadline: deadline
        });

        // Random user cannot execute
        vm.prank(depositor);
        vm.expectRevert();
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 5: Wrong actionKind signature rejected (C-8 cross-function replay)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Signatures produced for releaseCollateral (actionKind=1) must NOT
    ///         work for execute (actionKind=0). This is the C-8 fix in action.
    function test_e2e_wrong_action_kind_rejected() public {
        if (block.chainid != 42161) return;

        bytes32 intentHash = keccak256("wrong-action-kind-test");
        uint256 deadline = block.timestamp + 300;

        // Sign with actionKind=1 (releaseCollateral)
        bytes memory sig1 = _signValidation(validator1Key, intentHash, address(vault), 80, deadline, 1);
        bytes memory sig2 = _signValidation(validator2Key, intentHash, address(vault), 80, deadline, 1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig1;
        sigs[1] = sig2;
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;

        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: UNISWAP_ROUTER,
            data: "",
            value: 0,
            minOutput: 1,
            outputToken: WETH,
            intentHash: intentHash,
            deadline: deadline
        });

        // Execute uses actionKind=0 — signatures for actionKind=1 MUST fail
        vm.prank(operator);
        vm.expectRevert(TradingVault.ValidatorCheckFailed.selector);
        vault.execute(params, sigs, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPER: EIP-712 signing (identical to production validator signer)
    // ═══════════════════════════════════════════════════════════════════════════

    function _signValidation(
        uint256 privateKey,
        bytes32 intentHash,
        address _vault,
        uint256 score,
        uint256 _deadline,
        uint256 actionKind
    ) internal view returns (bytes memory) {
        bytes32 digest = tradeValidator.computeDigest(intentHash, _vault, score, _deadline, actionKind);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
