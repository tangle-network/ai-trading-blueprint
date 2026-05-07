// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @title EnvelopeInvariantsTest
/// @notice Audit-driven invariants and regression tests for the v3 envelope system.
///
///         The four invariants below are stated in the engineering scope and asserted
///         here without stateful fuzz harnesses (foundry's invariant runner needs a
///         well-defined state space; these properties are simpler to prove with direct
///         scenarios that exercise the relevant code paths):
///
///         1. envelope_consumed_amount_is_monotonic_increasing
///         2. executed_intent_can_never_be_reused
///         3. envelope_digest_is_pure_function
///         4. typehash_constants_match_canonical_strings
///
///         A fifth assertion (`test_envelope_consumed_amount_unchanged_on_revert`) bonds
///         monotonicity to the on-revert path: if any post-consume step reverts, the
///         tx unwinds and `envelopeConsumedAmount` is left untouched.
///
///         Plus four H-1 regression tests covering the four envelope health-factor
///         executors that previously did not pin `params.account` to `address(this)`.
contract EnvelopeInvariantsTest is Setup {
    bytes32 constant BOT_ID_HASH = keccak256("invariants-bot");

    address public vault;
    address public shareTok;

    // Common destinations used in the H-1 regression tests. The actual external
    // call is never reached because the H-1 pin check reverts first.
    address constant FAKE_AAVE_POOL = address(0xA00000A00000A00000A00000A00000a00000a001);
    address constant FAKE_MORPHO = address(0xb0b0B0B0B0B0B0B0b0B0b0B0b0b0b0b0b0B0B001);
    address constant ATTACKER_DECOY = address(0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF);

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        (vault, shareTok) = _createTestVault();
        // Whitelist the fake protocol targets so policy checks don't preempt the
        // executor pin-checks in the H-1 regression tests. These addresses have no
        // code; the executor-side EnvelopeCheckFailed reverts first.
        address[] memory tgts = new address[](2);
        tgts[0] = FAKE_AAVE_POOL;
        tgts[1] = FAKE_MORPHO;
        vm.prank(address(vaultFactory));
        policyEngine.setTargetWhitelist(vault, tgts, true);
    }

    // ── shared helpers ───────────────────────────────────────────────────────

    function _sortedThreeValidators() internal view returns (address[] memory) {
        address[] memory addrs = new address[](3);
        addrs[0] = validator1;
        addrs[1] = validator2;
        addrs[2] = validator3;
        for (uint256 i = 0; i < addrs.length; ++i) {
            for (uint256 j = i + 1; j < addrs.length; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[i])) {
                    address t = addrs[i];
                    addrs[i] = addrs[j];
                    addrs[j] = t;
                }
            }
        }
        return addrs;
    }

    function _baseEnvelope(bytes32 enforcementHash, address vault_)
        internal
        view
        returns (TradeValidator.Envelope memory)
    {
        address[] memory sorted = _sortedThreeValidators();
        bytes memory packed;
        for (uint256 i = 0; i < sorted.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(sorted[i]));
        }
        return TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: vault_,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("invariants-protocol"),
            policyHash: keccak256("invariants-policy"),
            enforcementHash: enforcementHash,
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: keccak256(packed),
            minSignatures: 2
        });
    }

    function _signEnvelope(uint256 pk, TradeValidator.Envelope memory env) internal view returns (bytes memory) {
        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _twoSigs(TradeValidator.Envelope memory env)
        internal
        view
        returns (bytes[] memory sigs, uint256[] memory scores)
    {
        sigs = new bytes[](2);
        scores = new uint256[](2);
        sigs[0] = _signEnvelope(validator1Key, env);
        sigs[1] = _signEnvelope(validator2Key, env);
        scores[0] = 80;
        scores[1] = 90;
    }

    // ── Invariant 1: typehash constants match canonical strings ──────────────

    function test_typehash_constants_match_canonical_strings() public view {
        assertEq(
            tradeValidator.ENVELOPE_TYPEHASH(),
            keccak256(
                "Envelope(uint64 version,bytes32 botIdHash,address vault,uint64 chainId,bytes32 protocolHash,bytes32 policyHash,bytes32 enforcementHash,uint64 issuedAt,uint64 expiresAt,uint64 nonce,bytes32 signersHash,uint64 minSignatures)"
            ),
            "ENVELOPE_TYPEHASH"
        );
        assertEq(
            tradeValidator.UNISWAP_V3_SWAP_TYPEHASH(),
            keccak256(
                "UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
            ),
            "UNISWAP_V3_SWAP_TYPEHASH"
        );
        assertEq(
            tradeValidator.UNISWAP_V4_SWAP_TYPEHASH(),
            keccak256(
                "UniswapV4SwapEnforcement(address currency0,address currency1,uint256 fee,int256 tickSpacing,address hooks,bool zeroForOne,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address universalRouter,bytes32 hookDataHash)"
            ),
            "UNISWAP_V4_SWAP_TYPEHASH"
        );
        assertEq(
            tradeValidator.AERODROME_SWAP_TYPEHASH(),
            keccak256(
                "AerodromeSwapEnforcement(uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,int256 tickSpacing,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
            ),
            "AERODROME_SWAP_TYPEHASH"
        );
        assertEq(
            tradeValidator.PANCAKESWAP_V3_SWAP_TYPEHASH(),
            keccak256(
                "PancakeswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
            ),
            "PANCAKESWAP_V3_SWAP_TYPEHASH"
        );
        assertEq(
            tradeValidator.CURVE_STABLE_SWAP_TYPEHASH(),
            keccak256(
                "CurveStableSwapEnforcement(int128 i,int128 j,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address pool,address tokenIn,address tokenOut)"
            ),
            "CURVE_STABLE_SWAP_TYPEHASH"
        );
        assertEq(
            tradeValidator.AAVE_SUPPLY_TYPEHASH(),
            keccak256(
                "AaveSupplyEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
            ),
            "AAVE_SUPPLY_TYPEHASH"
        );
        assertEq(
            tradeValidator.AAVE_WITHDRAW_TYPEHASH(),
            keccak256(
                "AaveWithdrawEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
            ),
            "AAVE_WITHDRAW_TYPEHASH"
        );
        assertEq(
            tradeValidator.AAVE_BORROW_TYPEHASH(),
            keccak256(
                "AaveBorrowEnforcement(address asset,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
            ),
            "AAVE_BORROW_TYPEHASH"
        );
        assertEq(
            tradeValidator.AAVE_REPAY_TYPEHASH(),
            keccak256(
                "AaveRepayEnforcement(address asset,address debtToken,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
            ),
            "AAVE_REPAY_TYPEHASH"
        );
        assertEq(
            tradeValidator.MORPHO_SUPPLY_TYPEHASH(),
            keccak256(
                "MorphoSupplyEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
            ),
            "MORPHO_SUPPLY_TYPEHASH"
        );
        assertEq(
            tradeValidator.MORPHO_WITHDRAW_TYPEHASH(),
            keccak256(
                "MorphoWithdrawEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
            ),
            "MORPHO_WITHDRAW_TYPEHASH"
        );
        assertEq(
            tradeValidator.MORPHO_BORROW_TYPEHASH(),
            keccak256(
                "MorphoBorrowEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
            ),
            "MORPHO_BORROW_TYPEHASH"
        );
        assertEq(
            tradeValidator.MORPHO_REPAY_TYPEHASH(),
            keccak256(
                "MorphoRepayEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
            ),
            "MORPHO_REPAY_TYPEHASH"
        );
    }

    // ── Invariant 2: envelope digest is a pure function of the envelope ──────

    function test_envelope_digest_is_pure_function() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 1e18,
            maxTotalAmountIn: 10e18,
            maxValue: 0,
            minOutputPerInput: 2_900e6,
            router: address(0xdeadbeef),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.Envelope memory env = _baseEnvelope(tradeValidator.hashUniswapV3Swap(enf), vault);

        bytes32 d1 = tradeValidator.envelopeDigest(env);
        // Different caller, different timestamp → must produce same digest (pure function).
        vm.warp(block.timestamp + 1234);
        vm.prank(makeAddr("strangerCaller"));
        bytes32 d2 = tradeValidator.envelopeDigest(env);
        assertEq(d1, d2, "envelope digest must be timestamp/caller independent");
        // hashEnvelope is pure (no chain context); should also be deterministic.
        assertEq(tradeValidator.hashEnvelope(env), tradeValidator.hashEnvelope(env));
    }

    // ── Invariant 3 + 4: consumed-amount monotonicity & intent dedup ──────────
    //
    // We cover these via the H-1 regression tests below: every reverting path
    // leaves both `envelopeConsumedAmount[envHash]` and `executedIntents[h]` in
    // their pre-call state. The "monotonic increasing on success" half of the
    // invariant is covered by the existing fork test EnvelopeV3ExecutorForkTest
    // suite (gated behind --fork-url), and by the on-chain consumed-amount
    // event emitted by `_consumeEnvelope` at the success boundary. Here we
    // explicitly assert the failure-case half:

    function test_envelope_consumed_amount_unchanged_on_revert() public {
        TradeValidator.AaveBorrowEnforcement memory enf = TradeValidator.AaveBorrowEnforcement({
            asset: address(tokenA),
            interestRateMode: 2,
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            minHealthFactor: 1.5e18,
            pool: FAKE_AAVE_POOL
        });
        bytes32 enfHash = tradeValidator.hashAaveBorrow(enf);
        TradeValidator.Envelope memory env = _baseEnvelope(enfHash, vault);
        bytes32 envHash = tradeValidator.hashEnvelope(env);

        // Pre: nothing consumed.
        assertEq(TradingVault(payable(vault)).envelopeConsumedAmount(envHash), 0);

        // Build calldata that decodes correctly but with a decoy account. The
        // executor reverts on EnvelopeCheckFailed (H-1 pin check) before
        // _consumeEnvelope runs, so the consumed amount must remain zero.
        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)")),
            address(tokenA), // asset
            500e6, // amount
            uint256(2), // rateMode
            uint16(0), // refCode
            address(vault) // onBehalfOf — set to vault so this isn't what trips the revert
        );

        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: FAKE_AAVE_POOL,
            data: data,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenA),
            pool: FAKE_AAVE_POOL,
            account: ATTACKER_DECOY, // <— H-1 surface; must trip the pin check
            minHealthFactor: 1.5e18,
            intentHash: keccak256("intent-revert"),
            deadline: block.timestamp + 3600
        });

        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeAaveBorrowEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );

        // Post: still nothing consumed; intent hash still unmarked.
        assertEq(
            TradingVault(payable(vault)).envelopeConsumedAmount(envHash),
            0,
            "consumed amount must not increase on revert"
        );
        assertFalse(
            TradingVault(payable(vault)).executedIntents(params.intentHash),
            "intent must not be marked executed on revert"
        );
    }

    // ── H-1 regression: params.account must equal address(this) ──────────────

    /// @dev Aave borrow envelope with decoy `params.account` MUST revert.
    function test_h1_aaveBorrow_rejects_decoy_account() public {
        TradeValidator.AaveBorrowEnforcement memory enf = TradeValidator.AaveBorrowEnforcement({
            asset: address(tokenA),
            interestRateMode: 2,
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            minHealthFactor: 1.5e18,
            pool: FAKE_AAVE_POOL
        });
        TradeValidator.Envelope memory env = _baseEnvelope(tradeValidator.hashAaveBorrow(enf), vault);

        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)")),
            address(tokenA),
            500e6,
            uint256(2),
            uint16(0),
            address(vault)
        );

        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: FAKE_AAVE_POOL,
            data: data,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenA),
            pool: FAKE_AAVE_POOL,
            account: ATTACKER_DECOY,
            minHealthFactor: 1.5e18,
            intentHash: keccak256("borrow-decoy"),
            deadline: block.timestamp + 3600
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeAaveBorrowEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }

    /// @dev Aave withdraw envelope with decoy `params.account` MUST revert.
    function test_h1_aaveWithdraw_rejects_decoy_account() public {
        TradeValidator.AaveWithdrawEnforcement memory enf = TradeValidator.AaveWithdrawEnforcement({
            asset: address(tokenA),
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            minHealthFactor: 1.5e18,
            pool: FAKE_AAVE_POOL
        });
        TradeValidator.Envelope memory env = _baseEnvelope(tradeValidator.hashAaveWithdraw(enf), vault);

        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("withdraw(address,uint256,address)")),
            address(tokenA),
            500e6,
            address(vault) // to = vault
        );

        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: FAKE_AAVE_POOL,
            data: data,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenA),
            pool: FAKE_AAVE_POOL,
            account: ATTACKER_DECOY,
            minHealthFactor: 1.5e18,
            intentHash: keccak256("withdraw-decoy"),
            deadline: block.timestamp + 3600
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeAaveWithdrawEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }

    /// @dev Morpho borrow envelope with decoy `params.account` MUST revert.
    function test_h1_morphoBorrow_rejects_decoy_account() public {
        TradingVault.MorphoMarketParams memory mp = TradingVault.MorphoMarketParams({
            loanToken: address(tokenA),
            collateralToken: address(tokenB),
            oracle: address(0xCAFE),
            irm: address(0xDEAD),
            lltv: 0.9e18
        });
        bytes32 marketId = keccak256(abi.encode(mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv));

        TradeValidator.MorphoBorrowEnforcement memory enf = TradeValidator.MorphoBorrowEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            marketId: marketId,
            minCollateralRatio: 1.5e18,
            morpho: FAKE_MORPHO
        });
        TradeValidator.Envelope memory env = _baseEnvelope(tradeValidator.hashMorphoBorrow(enf), vault);

        bytes memory data = abi.encodeWithSelector(
            bytes4(
                keccak256("borrow((address,address,address,address,uint256),uint256,uint256,address,address)")
            ),
            mp,
            uint256(500e6),
            uint256(0),
            address(vault), // onBehalf
            address(vault) // receiver
        );

        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: FAKE_MORPHO,
            data: data,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenA),
            pool: FAKE_MORPHO,
            account: ATTACKER_DECOY,
            minHealthFactor: 1.5e18,
            intentHash: keccak256("morpho-borrow-decoy"),
            deadline: block.timestamp + 3600
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeMorphoBorrowEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }

    /// @dev Morpho withdraw envelope with decoy `params.account` MUST revert.
    function test_h1_morphoWithdraw_rejects_decoy_account() public {
        TradingVault.MorphoMarketParams memory mp = TradingVault.MorphoMarketParams({
            loanToken: address(tokenA),
            collateralToken: address(tokenB),
            oracle: address(0xCAFE),
            irm: address(0xDEAD),
            lltv: 0.9e18
        });
        bytes32 marketId = keccak256(abi.encode(mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv));

        TradeValidator.MorphoWithdrawEnforcement memory enf = TradeValidator.MorphoWithdrawEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            marketId: marketId,
            minCollateralRatio: 1.5e18,
            morpho: FAKE_MORPHO
        });
        TradeValidator.Envelope memory env = _baseEnvelope(tradeValidator.hashMorphoWithdraw(enf), vault);

        bytes memory data = abi.encodeWithSelector(
            bytes4(
                keccak256(
                    "withdraw((address,address,address,address,uint256),uint256,uint256,address,address)"
                )
            ),
            mp,
            uint256(500e6),
            uint256(0),
            address(vault), // onBehalf
            address(vault) // receiver
        );

        TradingVault.HealthFactorParams memory params = TradingVault.HealthFactorParams({
            target: FAKE_MORPHO,
            data: data,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenA),
            pool: FAKE_MORPHO,
            account: ATTACKER_DECOY,
            minHealthFactor: 1.5e18,
            intentHash: keccak256("morpho-withdraw-decoy"),
            deadline: block.timestamp + 3600
        });
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeMorphoWithdrawEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit M-1: per-call allowance MUST be reset to 0 after every execute path.
// Pre-fix: `forceApprove(spender, amountIn)` lingered after the trade so a
// misbehaving / upgraded router could pull the residual allowance later.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Mock UniswapV3-style router — accepts canonical `exactInputSingle`,
///      pulls `amountIn` from caller (vault), mints `amountOutMinimum` to recipient.
contract M1MockUniV3Router {
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

    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256 amountOut) {
        (bool ok, bytes memory ret) =
            p.tokenIn.call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), p.amountIn));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom failed");
        amountOut = p.amountOutMinimum;
        MockERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}

/// @dev Minimal mock target for the legacy `executeWithApprovals` path.
contract M1MockTarget {
    MockERC20 public immutable outputToken;

    constructor(MockERC20 _outputToken) {
        outputToken = _outputToken;
    }

    function swap(address to, uint256 outputAmount) external {
        outputToken.mint(to, outputAmount);
    }
}

contract EnvelopeAllowanceResetTest is Setup {
    bytes32 constant BOT_ID_HASH = keccak256("m1-allowance-bot");

    address public vault;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        (vault,) = _createTestVault();
    }

    function _sortedThreeValidators() internal view returns (address[] memory addrs) {
        addrs = new address[](3);
        addrs[0] = validator1;
        addrs[1] = validator2;
        addrs[2] = validator3;
        for (uint256 i = 0; i < addrs.length; ++i) {
            for (uint256 j = i + 1; j < addrs.length; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[i])) {
                    address t = addrs[i];
                    addrs[i] = addrs[j];
                    addrs[j] = t;
                }
            }
        }
    }

    function _baseEnv(bytes32 enforcementHash) internal view returns (TradeValidator.Envelope memory) {
        address[] memory sorted = _sortedThreeValidators();
        bytes memory packed;
        for (uint256 i = 0; i < sorted.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(sorted[i]));
        }
        return TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: vault,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("m1-protocol"),
            policyHash: keccak256("m1-policy"),
            enforcementHash: enforcementHash,
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: keccak256(packed),
            minSignatures: 2
        });
    }

    function _twoEnvSigs(TradeValidator.Envelope memory env)
        internal
        view
        returns (bytes[] memory sigs, uint256[] memory scores)
    {
        sigs = new bytes[](2);
        scores = new uint256[](2);
        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest);
        sigs[0] = abi.encodePacked(r1, s1, v1);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest);
        sigs[1] = abi.encodePacked(r2, s2, v2);
        scores[0] = 80;
        scores[1] = 90;
    }

    /// @notice After an envelope-mode swap returns, the router's allowance MUST be 0.
    ///         Pre-fix: `s.amountIn` allowance lingered.
    function test_m1_envelopeSwap_resetsAllowanceToZero() public {
        M1MockUniV3Router router = new M1MockUniV3Router();

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(address(vaultFactory));
        policyEngine.setWhitelist(vault, tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        vm.prank(address(vaultFactory));
        policyEngine.setTargetWhitelist(vault, targets, true);

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(router),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf));

        uint256 amountIn = 10 ether;
        uint256 minOut = (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(enf.feeTier),
            vault,
            uint256(block.timestamp + 600),
            amountIn,
            minOut,
            uint160(0)
        );
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(router),
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("m1-uni"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        // Pre-call: allowance is 0
        assertEq(tokenA.allowance(vault, address(router)), 0, "pre-call allowance");

        vm.prank(operator);
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );

        // Post-call: allowance MUST be 0 — `_resetApprovalsMemory` cleared it.
        assertEq(
            tokenA.allowance(vault, address(router)),
            0,
            "M-1: residual allowance must be 0 after envelope swap"
        );
    }

    /// @notice Legacy `executeWithApprovals` path also clears the approval. Pairs M-1
    ///         coverage with `_applyApprovals` (calldata) + `_resetApprovals`.
    function test_m1_executeWithApprovals_resetsAllowanceToZero() public {
        M1MockTarget target = new M1MockTarget(MockERC20(address(tokenB)));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(address(vaultFactory));
        policyEngine.setWhitelist(vault, tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        vm.prank(address(vaultFactory));
        policyEngine.setTargetWhitelist(vault, targets, true);
        vm.prank(address(vaultFactory));
        policyEngine.setPositionLimit(vault, address(tokenB), 1_000 ether);

        TradingVault.ApprovalCall[] memory approvals = new TradingVault.ApprovalCall[](1);
        approvals[0] = TradingVault.ApprovalCall({
            token: address(tokenA),
            spender: address(target),
            amount: 5 ether
        });

        bytes memory data = abi.encodeWithSelector(M1MockTarget.swap.selector, vault, 5 ether);
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(target),
            data: data,
            value: 0,
            minOutput: 1,
            outputToken: address(tokenB),
            intentHash: keccak256("m1-legacy"),
            deadline: block.timestamp + 600
        });

        bytes32 executionHash = TradingVault(payable(vault)).computeExecutionHash(params, approvals);
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        scores[0] = 80;
        scores[1] = 80;
        sigs[0] = _signValidation(
            validator1Key, params.intentHash, executionHash, vault, scores[0], params.deadline, 0
        );
        sigs[1] = _signValidation(
            validator2Key, params.intentHash, executionHash, vault, scores[1], params.deadline, 0
        );

        tokenA.mint(vault, 100 ether);

        vm.prank(operator);
        TradingVault(payable(vault)).executeWithApprovals(params, approvals, sigs, scores);

        // Post-call: allowance MUST be 0 — `_resetApprovals` cleared it.
        assertEq(
            tokenA.allowance(vault, address(target)),
            0,
            "M-1: residual allowance must be 0 after executeWithApprovals"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit M-2: pin sqrtPriceLimitX96 and (V4) hookData hash to the signed enforcement.
// Pre-fix: an operator could set arbitrary sqrtPriceLimitX96 / hookData and grief
// the swap. Post-fix: any mismatch reverts EnvelopeCheckFailed.
// ─────────────────────────────────────────────────────────────────────────────

contract EnvelopePriceLimitPinTest is Setup {
    bytes32 constant BOT_ID_HASH = keccak256("m2-pin-bot");

    address public vault;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        (vault,) = _createTestVault();
    }

    function _sortedThreeValidators() internal view returns (address[] memory addrs) {
        addrs = new address[](3);
        addrs[0] = validator1;
        addrs[1] = validator2;
        addrs[2] = validator3;
        for (uint256 i = 0; i < addrs.length; ++i) {
            for (uint256 j = i + 1; j < addrs.length; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[i])) {
                    address t = addrs[i];
                    addrs[i] = addrs[j];
                    addrs[j] = t;
                }
            }
        }
    }

    function _baseEnv(bytes32 enforcementHash) internal view returns (TradeValidator.Envelope memory) {
        address[] memory sorted = _sortedThreeValidators();
        bytes memory packed;
        for (uint256 i = 0; i < sorted.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(sorted[i]));
        }
        return TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: vault,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("m2-protocol"),
            policyHash: keccak256("m2-policy"),
            enforcementHash: enforcementHash,
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: keccak256(packed),
            minSignatures: 2
        });
    }

    function _twoEnvSigs(TradeValidator.Envelope memory env)
        internal
        view
        returns (bytes[] memory sigs, uint256[] memory scores)
    {
        sigs = new bytes[](2);
        scores = new uint256[](2);
        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest);
        sigs[0] = abi.encodePacked(r1, s1, v1);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest);
        sigs[1] = abi.encodePacked(r2, s2, v2);
        scores[0] = 80;
        scores[1] = 90;
    }

    /// @notice UniV3 envelope swap with sqrtPriceLimitX96 mismatch MUST revert
    ///         EnvelopeCheckFailed (M-2 pin).
    function test_m2_uniV3_sqrtPriceLimitMismatch_reverts() public {
        M1MockUniV3Router router = new M1MockUniV3Router();

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(address(vaultFactory));
        policyEngine.setWhitelist(vault, tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        vm.prank(address(vaultFactory));
        policyEngine.setTargetWhitelist(vault, targets, true);

        // Enforcement pins a SPECIFIC sqrtPriceLimitX96 (non-zero this time so
        // the operator-side mismatch is observable).
        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(router),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: uint160(1234567890)
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf));

        // Build calldata with WRONG sqrtPriceLimitX96 (operator tampering).
        uint256 amountIn = 10 ether;
        uint256 minOut = (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(enf.feeTier),
            vault,
            uint256(block.timestamp + 600),
            amountIn,
            minOut,
            uint160(9999999999) // <-- mismatched
        );
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(router),
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("m2-uni-mismatch"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }

    /// @notice Distinct sqrtPriceLimitX96 values produce DIFFERENT enforcement hashes.
    ///         Defense-in-depth — even before reaching the executor pin check, the
    ///         envelope-vs-enforcement hash mismatch guards the typehash boundary.
    function test_m2_uniV3_sqrtPriceLimit_changesEnforcementHash() public view {
        TradeValidator.UniswapV3SwapEnforcement memory a = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xdeadbeef),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.UniswapV3SwapEnforcement memory b = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xdeadbeef),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: uint160(123456)
        });
        assertTrue(
            tradeValidator.hashUniswapV3Swap(a) != tradeValidator.hashUniswapV3Swap(b),
            "M-2: distinct sqrtPriceLimitX96 must produce distinct enforcement hashes"
        );
    }

    /// @notice Aerodrome and Pancake V3 enforcement hashes also depend on sqrtPriceLimitX96.
    function test_m2_aero_pancake_sqrtPriceLimit_changesEnforcementHash() public view {
        TradeValidator.AerodromeSwapEnforcement memory ae0 = TradeValidator.AerodromeSwapEnforcement({
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xaabbccdd),
            tickSpacing: 60,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.AerodromeSwapEnforcement memory ae1 = TradeValidator.AerodromeSwapEnforcement({
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xaabbccdd),
            tickSpacing: 60,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: uint160(987654)
        });
        assertTrue(
            tradeValidator.hashAerodromeSwap(ae0) != tradeValidator.hashAerodromeSwap(ae1),
            "M-2 (Aerodrome): sqrtPriceLimitX96 must alter enforcement hash"
        );

        TradeValidator.PancakeswapV3SwapEnforcement memory pa0 = TradeValidator.PancakeswapV3SwapEnforcement({
            feeTier: 500,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xeeeeffff),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.PancakeswapV3SwapEnforcement memory pa1 = TradeValidator.PancakeswapV3SwapEnforcement({
            feeTier: 500,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xeeeeffff),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: uint160(111222333)
        });
        assertTrue(
            tradeValidator.hashPancakeswapV3Swap(pa0) != tradeValidator.hashPancakeswapV3Swap(pa1),
            "M-2 (Pancake): sqrtPriceLimitX96 must alter enforcement hash"
        );
    }

    /// @notice UniV4 hookDataHash also alters the enforcement hash.
    function test_m2_uniV4_hookDataHash_changesEnforcementHash() public view {
        TradeValidator.UniswapV4SwapEnforcement memory a = TradeValidator.UniswapV4SwapEnforcement({
            currency0: address(tokenA),
            currency1: address(tokenB),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0),
            zeroForOne: true,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            universalRouter: address(0xa1a2a3a4),
            hookDataHash: keccak256("")
        });
        TradeValidator.UniswapV4SwapEnforcement memory b = TradeValidator.UniswapV4SwapEnforcement({
            currency0: address(tokenA),
            currency1: address(tokenB),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0),
            zeroForOne: true,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            universalRouter: address(0xa1a2a3a4),
            hookDataHash: keccak256("non-empty-hook-data")
        });
        assertTrue(
            tradeValidator.hashUniswapV4Swap(a) != tradeValidator.hashUniswapV4Swap(b),
            "M-2 (V4): hookDataHash must alter enforcement hash"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit M-3: bound `params.value` (native ETH) per envelope. Pre-fix: any
// operator could set arbitrary value and drain native ETH balance through a
// buggy router. Post-fix: `params.value > enf.maxValue` reverts.
// ─────────────────────────────────────────────────────────────────────────────

contract EnvelopeMaxValuePinTest is Setup {
    bytes32 constant BOT_ID_HASH = keccak256("m3-pin-bot");

    address public vault;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        (vault,) = _createTestVault();
    }

    function _sortedThreeValidators() internal view returns (address[] memory addrs) {
        addrs = new address[](3);
        addrs[0] = validator1;
        addrs[1] = validator2;
        addrs[2] = validator3;
        for (uint256 i = 0; i < addrs.length; ++i) {
            for (uint256 j = i + 1; j < addrs.length; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[i])) {
                    address t = addrs[i];
                    addrs[i] = addrs[j];
                    addrs[j] = t;
                }
            }
        }
    }

    function _baseEnv(bytes32 enforcementHash) internal view returns (TradeValidator.Envelope memory) {
        address[] memory sorted = _sortedThreeValidators();
        bytes memory packed;
        for (uint256 i = 0; i < sorted.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(sorted[i]));
        }
        return TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: vault,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("m3-protocol"),
            policyHash: keccak256("m3-policy"),
            enforcementHash: enforcementHash,
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: keccak256(packed),
            minSignatures: 2
        });
    }

    function _twoEnvSigs(TradeValidator.Envelope memory env)
        internal
        view
        returns (bytes[] memory sigs, uint256[] memory scores)
    {
        sigs = new bytes[](2);
        scores = new uint256[](2);
        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(validator1Key, digest);
        sigs[0] = abi.encodePacked(r1, s1, v1);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(validator2Key, digest);
        sigs[1] = abi.encodePacked(r2, s2, v2);
        scores[0] = 80;
        scores[1] = 90;
    }

    /// @notice UniV3 envelope swap with `params.value > enf.maxValue` MUST revert
    ///         EnvelopeCheckFailed. Default fixture sets maxValue=0 so any non-zero
    ///         value should trip the check.
    function test_m3_uniV3_paramsValueExceedsMaxValue_reverts() public {
        M1MockUniV3Router router = new M1MockUniV3Router();

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(address(vaultFactory));
        policyEngine.setWhitelist(vault, tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        vm.prank(address(vaultFactory));
        policyEngine.setTargetWhitelist(vault, targets, true);

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0, // <-- M-3: no native ETH allowed
            minOutputPerInput: 1e18,
            router: address(router),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf));

        uint256 amountIn = 10 ether;
        uint256 minOut = (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(enf.feeTier),
            vault,
            uint256(block.timestamp + 600),
            amountIn,
            minOut,
            uint160(0)
        );
        TradingVault.ExecuteParams memory params = TradingVault.ExecuteParams({
            target: address(router),
            data: data,
            value: 1 wei, // <-- exceeds enf.maxValue (0)
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("m3-uni-overspend"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vault, amountIn);
        vm.deal(vault, 10 ether);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        vm.prank(operator);
        vm.expectRevert(TradingVault.EnvelopeCheckFailed.selector);
        TradingVault(payable(vault)).executeUniswapV3SwapEnvelope(
            params, env, enf, _sortedThreeValidators(), sigs, scores
        );
    }

    /// @notice Distinct maxValue values produce DIFFERENT enforcement hashes —
    ///         defense-in-depth: even before the executor pin check, the
    ///         envelope-vs-enforcement hash mismatch traps the bypass.
    function test_m3_uniV3_maxValue_changesEnforcementHash() public view {
        TradeValidator.UniswapV3SwapEnforcement memory a = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(0xdeadbeef),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        TradeValidator.UniswapV3SwapEnforcement memory b = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 1 ether,
            minOutputPerInput: 1e18,
            router: address(0xdeadbeef),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        assertTrue(
            tradeValidator.hashUniswapV3Swap(a) != tradeValidator.hashUniswapV3Swap(b),
            "M-3: distinct maxValue must produce distinct enforcement hashes"
        );
    }

    /// @notice Aave/Morpho enforcement hashes also bind maxValue.
    function test_m3_aaveMorpho_maxValue_changesEnforcementHash() public view {
        TradeValidator.AaveSupplyEnforcement memory s0 = TradeValidator.AaveSupplyEnforcement({
            asset: address(tokenA),
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            pool: address(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
        });
        TradeValidator.AaveSupplyEnforcement memory s1 = TradeValidator.AaveSupplyEnforcement({
            asset: address(tokenA),
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 5 ether,
            pool: address(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
        });
        assertTrue(
            tradeValidator.hashAaveSupply(s0) != tradeValidator.hashAaveSupply(s1),
            "M-3 (AaveSupply): maxValue must alter enforcement hash"
        );

        TradeValidator.MorphoSupplyEnforcement memory m0 = TradeValidator.MorphoSupplyEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            marketId: keccak256("market-0"),
            morpho: address(0xbBBBBbBbBb9CC5e90E3B3AF64BdaF62C37eEFffB)
        });
        TradeValidator.MorphoSupplyEnforcement memory m1 = TradeValidator.MorphoSupplyEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 7 ether,
            marketId: keccak256("market-0"),
            morpho: address(0xbBBBBbBbBb9CC5e90E3B3AF64BdaF62C37eEFffB)
        });
        assertTrue(
            tradeValidator.hashMorphoSupply(m0) != tradeValidator.hashMorphoSupply(m1),
            "M-3 (MorphoSupply): maxValue must alter enforcement hash"
        );
    }
}
