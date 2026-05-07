// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";

/// @notice Tests cover all 10 (protocol, action) validateXxxEnvelope paths
///         + envelope structural rejection (expired, wrong vault, etc.)
///         + signature dedup + score weighting.
contract EnvelopeValidatorTest is Setup {
    TradeValidator public tv;
    address public testVault;

    bytes32 constant BOT_ID_HASH = keccak256("bot-test");

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000); // baseline so issuedAt - 100 doesn't underflow
        tv = new TradeValidator();
        testVault = makeAddr("testVault");
        address[] memory signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
        tv.configureVault(testVault, signers, 2);
    }

    // ── helpers ──

    function _baseEnvelope(bytes32 enforcementHash) internal view returns (TradeValidator.Envelope memory) {
        address[] memory sorted = _sortedThreeValidators();
        bytes memory packed;
        for (uint256 i = 0; i < sorted.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(sorted[i]));
        }
        return TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: testVault,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("uniswap_v3"),
            policyHash: keccak256("policy"),
            enforcementHash: enforcementHash,
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: keccak256(packed),
            minSignatures: 2
        });
    }

    function _sortedThreeValidators() internal view returns (address[] memory) {
        address[] memory addrs = new address[](3);
        addrs[0] = validator1;
        addrs[1] = validator2;
        addrs[2] = validator3;
        // sort ascending
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

    function _signEnvelope(uint256 pk, TradeValidator.Envelope memory env) internal view returns (bytes memory) {
        bytes32 digest = tv.envelopeDigest(env);
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

    // ── per-protocol enforcement helpers ──

    function _uniV3() internal pure returns (TradeValidator.UniswapV3SwapEnforcement memory) {
        return TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 1e18,
            maxTotalAmountIn: 10e18,
            maxValue: 0,
            minOutputPerInput: 2_900e6,
            router: address(0xE592427A0AEce92De3Edee1F18E0157C05861564),
            tokenIn: address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2),
            tokenOut: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            sqrtPriceLimitX96: 0
        });
    }

    function _uniV4() internal pure returns (TradeValidator.UniswapV4SwapEnforcement memory) {
        return TradeValidator.UniswapV4SwapEnforcement({
            currency0: address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2),
            currency1: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0),
            zeroForOne: true,
            maxSingleAmountIn: 1e18,
            maxTotalAmountIn: 10e18,
            maxValue: 0,
            minOutputPerInput: 2_900e6,
            universalRouter: address(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af),
            hookDataHash: keccak256("")
        });
    }

    function _aero() internal pure returns (TradeValidator.AerodromeSwapEnforcement memory) {
        return TradeValidator.AerodromeSwapEnforcement({
            maxSingleAmountIn: 1e18,
            maxTotalAmountIn: 10e18,
            maxValue: 0,
            minOutputPerInput: 2_900e6,
            router: address(0xBe6d8F0d05Cc4be24D5167A3eF062215Be6D8f0d),
            tickSpacing: 60,
            tokenIn: address(0x4200000000000000000000000000000000000006),
            tokenOut: address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913),
            sqrtPriceLimitX96: 0
        });
    }

    function _pancakeV3() internal pure returns (TradeValidator.PancakeswapV3SwapEnforcement memory) {
        return TradeValidator.PancakeswapV3SwapEnforcement({
            feeTier: 500,
            maxSingleAmountIn: 1e18,
            maxTotalAmountIn: 10e18,
            maxValue: 0,
            minOutputPerInput: 2_900e6,
            router: address(0x13f4EA83D0bd40E75C8222255bc855a974568Dd4),
            tokenIn: address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2),
            tokenOut: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            sqrtPriceLimitX96: 0
        });
    }

    function _curve() internal pure returns (TradeValidator.CurveStableSwapEnforcement memory) {
        return TradeValidator.CurveStableSwapEnforcement({
            i: int128(0),
            j: int128(1),
            maxSingleAmountIn: 1000e6,
            maxTotalAmountIn: 10000e6,
            maxValue: 0,
            minOutputPerInput: 0.99e18,
            pool: address(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7),
            tokenIn: address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2),
            tokenOut: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)
        });
    }

    function _aaveSupply() internal pure returns (TradeValidator.AaveSupplyEnforcement memory) {
        return TradeValidator.AaveSupplyEnforcement({
            asset: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            pool: address(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
        });
    }

    function _aaveWithdraw() internal pure returns (TradeValidator.AaveWithdrawEnforcement memory) {
        return TradeValidator.AaveWithdrawEnforcement({
            asset: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            minHealthFactor: 1.5e18,
            pool: address(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
        });
    }

    function _aaveBorrow() internal pure returns (TradeValidator.AaveBorrowEnforcement memory) {
        return TradeValidator.AaveBorrowEnforcement({
            asset: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            interestRateMode: 2,
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            minHealthFactor: 1.5e18,
            pool: address(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
        });
    }

    function _aaveRepay() internal pure returns (TradeValidator.AaveRepayEnforcement memory) {
        return TradeValidator.AaveRepayEnforcement({
            asset: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            debtToken: address(0x72E95b8931767C79bA4EeE721354d6E99a61D004),
            interestRateMode: 2,
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            pool: address(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
        });
    }

    function _morphoSupply() internal pure returns (TradeValidator.MorphoSupplyEnforcement memory) {
        return TradeValidator.MorphoSupplyEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            marketId: keccak256("morpho-market-1"),
            morpho: address(0xbBBBBbBbBb9CC5e90E3B3AF64BdaF62C37eEFffB)
        });
    }

    function _morphoWithdraw() internal pure returns (TradeValidator.MorphoWithdrawEnforcement memory) {
        return TradeValidator.MorphoWithdrawEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            marketId: keccak256("morpho-market-1"),
            minCollateralRatio: 1.5e18,
            morpho: address(0xbBBBBbBbBb9CC5e90E3B3AF64BdaF62C37eEFffB)
        });
    }

    function _morphoBorrow() internal pure returns (TradeValidator.MorphoBorrowEnforcement memory) {
        return TradeValidator.MorphoBorrowEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            marketId: keccak256("morpho-market-1"),
            minCollateralRatio: 1.5e18,
            morpho: address(0xbBBBBbBbBb9CC5e90E3B3AF64BdaF62C37eEFffB)
        });
    }

    function _morphoRepay() internal pure returns (TradeValidator.MorphoRepayEnforcement memory) {
        return TradeValidator.MorphoRepayEnforcement({
            maxSingleAmount: 1000e6,
            maxTotalAmount: 10000e6,
            maxValue: 0,
            marketId: keccak256("morpho-market-1"),
            morpho: address(0xbBBBBbBbBb9CC5e90E3B3AF64BdaF62C37eEFffB)
        });
    }

    // ── happy paths for each (protocol, action) ──

    function _validateAndAssert(TradeValidator.Envelope memory env, bytes[] memory sigs, uint256[] memory scores)
        internal
        view
        returns (bool approved, uint256 validCount)
    {
        // each test case calls the right `validateXxx` directly because the
        // call signature differs per protocol — kept inline below
        approved = false;
        validCount = 0;
    }

    function test_uniswapV3Swap_happyPath() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok, uint256 valid) = tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
        assertEq(valid, 2);
    }

    function test_uniswapV4Swap_happyPath() public {
        TradeValidator.UniswapV4SwapEnforcement memory enf = _uniV4();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV4Swap(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok, uint256 valid) = tv.validateUniswapV4SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
        assertEq(valid, 2);
    }

    function test_aerodromeSwap_happyPath() public {
        TradeValidator.AerodromeSwapEnforcement memory enf = _aero();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashAerodromeSwap(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok, uint256 valid) = tv.validateAerodromeSwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
        assertEq(valid, 2);
    }

    function test_pancakeswapV3Swap_happyPath() public {
        TradeValidator.PancakeswapV3SwapEnforcement memory enf = _pancakeV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashPancakeswapV3Swap(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok, uint256 valid) =
            tv.validatePancakeswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
        assertEq(valid, 2);
    }

    function test_curveStableSwap_happyPath() public {
        TradeValidator.CurveStableSwapEnforcement memory enf = _curve();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashCurveStableSwap(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok, uint256 valid) = tv.validateCurveStableSwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
        assertEq(valid, 2);
    }

    function test_aaveSupply_happyPath() public {
        TradeValidator.AaveSupplyEnforcement memory enf = _aaveSupply();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashAaveSupply(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateAaveSupplyEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    function test_aaveWithdraw_happyPath() public {
        TradeValidator.AaveWithdrawEnforcement memory enf = _aaveWithdraw();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashAaveWithdraw(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateAaveWithdrawEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    function test_aaveBorrow_happyPath() public {
        TradeValidator.AaveBorrowEnforcement memory enf = _aaveBorrow();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashAaveBorrow(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateAaveBorrowEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    function test_aaveRepay_happyPath() public {
        TradeValidator.AaveRepayEnforcement memory enf = _aaveRepay();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashAaveRepay(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateAaveRepayEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    function test_morphoSupply_happyPath() public {
        TradeValidator.MorphoSupplyEnforcement memory enf = _morphoSupply();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashMorphoSupply(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateMorphoSupplyEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    function test_morphoWithdraw_happyPath() public {
        TradeValidator.MorphoWithdrawEnforcement memory enf = _morphoWithdraw();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashMorphoWithdraw(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateMorphoWithdrawEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    function test_morphoBorrow_happyPath() public {
        TradeValidator.MorphoBorrowEnforcement memory enf = _morphoBorrow();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashMorphoBorrow(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateMorphoBorrowEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    function test_morphoRepay_happyPath() public {
        TradeValidator.MorphoRepayEnforcement memory enf = _morphoRepay();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashMorphoRepay(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        (bool ok,) = tv.validateMorphoRepayEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
    }

    // ── adversarial cases ──

    function test_revert_envelopeExpired() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        env.expiresAt = uint64(block.timestamp - 1);
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    /// @notice Audit fix L-1 — `_validateEnvelopeWithEnforcementHash` must
    ///         reject any envelope whose `chainId` differs from
    ///         `block.chainid`. Replay protection is already provided by
    ///         the EIP-712 domain separator, but the validator's `view`
    ///         path otherwise returns `(true, ...)` for a wrong-chain
    ///         envelope, which a simulator could misread as
    ///         "ready to execute".
    function test_revert_chain_id_not_block_chainid() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        env.chainId = uint64(block.chainid + 1);
        // The signed digest still matches because `_signEnvelope` uses
        // `tv.envelopeDigest(env)`, which encodes the (now-tampered)
        // chainId into the message. The structural revert must fire
        // before the signature loop.
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    /// @notice Audit fix L-2 — `_validateEnvelopeWithEnforcementHash` must
    ///         reject envelopes whose `issuedAt > block.timestamp`. Without
    ///         this check the validator's `view` path approved
    ///         future-dated envelopes that the executor would later
    ///         reject — a UX inconsistency a UI could misread.
    function test_revert_future_issued_at() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        env.issuedAt = uint64(block.timestamp + 1000);
        // Keep `expiresAt` strictly after `issuedAt` so the existing
        // `expiresAt < block.timestamp` clause does not fire first.
        env.expiresAt = uint64(block.timestamp + 2000);
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    function test_revert_wrongEnforcementHash() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.UniswapV3SwapEnforcement memory other = _uniV3();
        other.maxSingleAmountIn = 999;
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(other));
        // sign envelope as-is but pass enf (enforcementHash mismatch)
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        vm.expectRevert(TradeValidator.EnvelopeEnforcementMismatch.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    function test_revert_versionNot2() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        env.version = 1;
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    function test_revert_unsortedSigners() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        // pass unsorted (descending)
        address[] memory unsorted = new address[](3);
        address[] memory sorted = _sortedThreeValidators();
        unsorted[0] = sorted[2];
        unsorted[1] = sorted[1];
        unsorted[2] = sorted[0];
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, unsorted, sigs, scores);
    }

    function test_dedup_sameSignerTwiceCountsOnce() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        // pass validator1's sig twice + validator2's sig
        bytes[] memory sigs = new bytes[](3);
        uint256[] memory scores = new uint256[](3);
        sigs[0] = _signEnvelope(validator1Key, env);
        sigs[1] = _signEnvelope(validator1Key, env); // duplicate
        sigs[2] = _signEnvelope(validator2Key, env);
        scores[0] = 80;
        scores[1] = 80;
        scores[2] = 90;
        (bool ok, uint256 valid) = tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertTrue(ok);
        assertEq(valid, 2); // dedup prevented triple-counting
    }

    function test_revert_belowMinSignatures() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        bytes[] memory sigs = new bytes[](1);
        uint256[] memory scores = new uint256[](1);
        sigs[0] = _signEnvelope(validator1Key, env);
        scores[0] = 80;
        // only 1 valid sig; vault requires 2
        (bool ok, uint256 valid) = tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertFalse(ok);
        assertEq(valid, 1);
    }

    function test_distinctEnforcementHashesAcrossProtocols() public view {
        // Constructed with same amount caps but different protocol → must hash differently.
        bytes32 a = tv.hashUniswapV3Swap(_uniV3());
        bytes32 b = tv.hashAerodromeSwap(_aero());
        bytes32 c = tv.hashAaveSupply(_aaveSupply());
        bytes32 d = tv.hashMorphoSupply(_morphoSupply());
        assertTrue(a != b && b != c && c != d && a != c && a != d && b != d);
    }

    /// @notice Critical regression guard — PancakeSwap V3 reuses Uniswap V3's
    ///         field shape, so the only distinguishing factor between the two
    ///         enforcement hashes is the typehash. If we ever collapsed them
    ///         to a single typehash the on-chain dispatcher couldn't tell them
    ///         apart and an envelope minted for one DEX could be replayed on
    ///         the other.
    function test_pancakeswapV3AndUniswapV3HashesAreDistinctForSameFields() public view {
        TradeValidator.UniswapV3SwapEnforcement memory u = _uniV3();
        TradeValidator.PancakeswapV3SwapEnforcement memory p = TradeValidator.PancakeswapV3SwapEnforcement({
            feeTier: u.feeTier,
            maxSingleAmountIn: u.maxSingleAmountIn,
            maxTotalAmountIn: u.maxTotalAmountIn,
            maxValue: u.maxValue,
            minOutputPerInput: u.minOutputPerInput,
            router: u.router,
            tokenIn: u.tokenIn,
            tokenOut: u.tokenOut,
            sqrtPriceLimitX96: u.sqrtPriceLimitX96
        });
        bytes32 uniHash = tv.hashUniswapV3Swap(u);
        bytes32 pancakeHash = tv.hashPancakeswapV3Swap(p);
        assertTrue(uniHash != pancakeHash, "Pancake and Uniswap V3 must produce distinct enforcement hashes");
    }

    function test_curveStableSwap_indexSwapChangesHash() public view {
        // (i=0, j=1) and (i=1, j=0) must produce distinct enforcement hashes so
        // the on-chain executor cannot reuse one envelope for the opposite-direction
        // swap.
        TradeValidator.CurveStableSwapEnforcement memory a = _curve();
        TradeValidator.CurveStableSwapEnforcement memory b = TradeValidator.CurveStableSwapEnforcement({
            i: a.j,
            j: a.i,
            maxSingleAmountIn: a.maxSingleAmountIn,
            maxTotalAmountIn: a.maxTotalAmountIn,
            maxValue: a.maxValue,
            minOutputPerInput: a.minOutputPerInput,
            pool: a.pool,
            tokenIn: a.tokenIn,
            tokenOut: a.tokenOut
        });
        assertTrue(tv.hashCurveStableSwap(a) != tv.hashCurveStableSwap(b));
    }

    function test_curveStableSwap_negativeIndexHashesDifferentlyFromPositive() public view {
        TradeValidator.CurveStableSwapEnforcement memory pos = _curve();
        TradeValidator.CurveStableSwapEnforcement memory neg = TradeValidator.CurveStableSwapEnforcement({
            i: -int128(1),
            j: pos.j,
            maxSingleAmountIn: pos.maxSingleAmountIn,
            maxTotalAmountIn: pos.maxTotalAmountIn,
            maxValue: pos.maxValue,
            minOutputPerInput: pos.minOutputPerInput,
            pool: pos.pool,
            tokenIn: pos.tokenIn,
            tokenOut: pos.tokenOut
        });
        assertTrue(tv.hashCurveStableSwap(pos) != tv.hashCurveStableSwap(neg));
    }

    function test_distinctEnforcementHashesAcrossAllSwapProtocols() public view {
        // All five swap protocols must produce distinct hashes — defense in depth
        // beyond just the Pancake-vs-Uniswap comparison above.
        bytes32 u3 = tv.hashUniswapV3Swap(_uniV3());
        bytes32 u4 = tv.hashUniswapV4Swap(_uniV4());
        bytes32 ae = tv.hashAerodromeSwap(_aero());
        bytes32 pa = tv.hashPancakeswapV3Swap(_pancakeV3());
        bytes32 cu = tv.hashCurveStableSwap(_curve());
        // pairwise check
        bytes32[5] memory hashes = [u3, u4, ae, pa, cu];
        for (uint256 i = 0; i < hashes.length; ++i) {
            for (uint256 j = i + 1; j < hashes.length; ++j) {
                assertTrue(hashes[i] != hashes[j], "swap hashes must be pairwise distinct");
            }
        }
    }

    // ── hardening — signer-set + scoring boundary cases ──

    function test_revert_untrustedSignerStillValidEnvelope() public {
        // sign with a key NOT in the vault config; envelope structurally valid,
        // sig recovers to a non-trusted address → not counted, falls below quorum.
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));

        (address evil, uint256 evilKey) = makeAddrAndKey("evil");
        // ensure evil is not in approval set + does not collide with sorted constraint
        // by NOT appending it to env.approvalSigners — just sign and submit.
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        bytes32 digest = tv.envelopeDigest(env);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(evilKey, digest);
        sigs[0] = abi.encodePacked(r, s, v);
        sigs[1] = _signEnvelope(validator1Key, env);
        scores[0] = 100;
        scores[1] = 100;

        (bool ok, uint256 valid) = tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertFalse(ok);
        assertEq(valid, 1); // only validator1 counted; evil signer ignored
        // silence unused
        evil;
    }

    function test_scoreThreshold_blocksLowScoreAverage() public {
        // configure a min-score threshold; submit two valid sigs with avg < threshold.
        tv.setMinScoreThreshold(testVault, 80);
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](2);
        sigs[0] = _signEnvelope(validator1Key, env);
        sigs[1] = _signEnvelope(validator2Key, env);
        scores[0] = 50;
        scores[1] = 60; // avg 55 < 80
        (bool ok,) = tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
        assertFalse(ok);
    }

    function test_aaveActionsHaveDistinctHashes() public view {
        // Same pool + asset across all four Aave actions must produce distinct hashes.
        bytes32 a = tv.hashAaveSupply(_aaveSupply());
        bytes32 b = tv.hashAaveWithdraw(_aaveWithdraw());
        bytes32 c = tv.hashAaveBorrow(_aaveBorrow());
        bytes32 d = tv.hashAaveRepay(_aaveRepay());
        assertTrue(a != b && a != c && a != d && b != c && b != d && c != d);
    }

    function test_morphoActionsHaveDistinctHashes() public view {
        bytes32 a = tv.hashMorphoSupply(_morphoSupply());
        bytes32 b = tv.hashMorphoWithdraw(_morphoWithdraw());
        bytes32 c = tv.hashMorphoBorrow(_morphoBorrow());
        bytes32 d = tv.hashMorphoRepay(_morphoRepay());
        assertTrue(a != b && a != c && a != d && b != c && b != d && c != d);
    }

    function test_envelopeDigestIsPureFunction() public view {
        // Same envelope struct must produce the same digest across calls.
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        assertEq(tv.envelopeDigest(env), tv.envelopeDigest(env));
        assertEq(tv.hashEnvelope(env), tv.hashEnvelope(env));
    }

    function test_revert_signaturesScoresLengthMismatch() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory scores = new uint256[](1); // mismatched lengths
        sigs[0] = _signEnvelope(validator1Key, env);
        sigs[1] = _signEnvelope(validator2Key, env);
        scores[0] = 80;
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    function test_revert_emptySignatures() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        bytes[] memory sigs = new bytes[](0);
        uint256[] memory scores = new uint256[](0);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    function test_revert_minSignaturesExceedsApprovalSigners() public {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory env = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        env.minSignatures = 99; // way more than approvalSigners.length (3)
        (bytes[] memory sigs, uint256[] memory scores) = _twoSigs(env);
        vm.expectRevert(TradeValidator.InvalidEnvelope.selector);
        tv.validateUniswapV3SwapEnvelope(env, enf, _sortedThreeValidators(), sigs, scores);
    }

    // ── envelope digest field-sensitivity (defense vs sneaky tampering) ──

    function test_digestChangesPerField() public view {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3();
        TradeValidator.Envelope memory base = _baseEnvelope(tv.hashUniswapV3Swap(enf));
        bytes32 baseDigest = tv.envelopeDigest(base);

        TradeValidator.Envelope memory diff;

        diff = base;
        diff.nonce = base.nonce + 1;
        assertTrue(tv.envelopeDigest(diff) != baseDigest);

        diff = base;
        diff.expiresAt = base.expiresAt + 1;
        assertTrue(tv.envelopeDigest(diff) != baseDigest);

        diff = base;
        diff.botIdHash = keccak256("other");
        assertTrue(tv.envelopeDigest(diff) != baseDigest);

        diff = base;
        diff.policyHash = keccak256("policy-tampered");
        assertTrue(tv.envelopeDigest(diff) != baseDigest);

        diff = base;
        diff.enforcementHash = keccak256("enforcement-tampered");
        assertTrue(tv.envelopeDigest(diff) != baseDigest);
    }
}
