// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/EnvelopeRegistry.sol";
import "../src/IEnvelopeAdapter.sol";
import "../src/TradeValidator.sol";
import "../src/adapters/UniswapV3SwapAdapter.sol";

/// @title EnvelopeRegistryTest
/// @notice Hash-stability + dispatch tests for the envelope plugin scaffold.
///
/// CRITICAL TEST: `test_uniswapV3SwapAdapterHashMatchesLegacy` proves that the
/// adapter-derived enforcement hash equals the legacy `TradeValidator.hashUniswapV3Swap`
/// for an identical enforcement struct. Migration would break already-signed
/// envelopes if this assertion fails.
contract EnvelopeRegistryTest is Test {
    EnvelopeRegistry public registry;
    UniswapV3SwapAdapter public uniV3Adapter;
    TradeValidator public tv;

    address public admin = address(0xA11CE);

    function setUp() public {
        // Move forward so `block.timestamp - 100` doesn't underflow.
        vm.warp(1_700_000_000);
        registry = new EnvelopeRegistry(admin);
        uniV3Adapter = new UniswapV3SwapAdapter();
        tv = new TradeValidator();
    }

    function _uniV3Enf() internal pure returns (TradeValidator.UniswapV3SwapEnforcement memory) {
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

    // ═══════════════════════════════════════════════════════════════════════════
    // HASH STABILITY (the critical migration invariant)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Adapter `enforcementHash(blob)` MUST equal legacy
    ///         `TradeValidator.hashUniswapV3Swap(struct)`. If this assertion ever
    ///         fails, validators' off-chain signatures collected pre-migration
    ///         would no longer verify on the new path.
    function test_uniswapV3SwapAdapterHashMatchesLegacy() public view {
        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3Enf();
        bytes32 legacyHash = tv.hashUniswapV3Swap(enf);
        bytes memory blob = abi.encode(enf);
        bytes32 adapterHash = uniV3Adapter.enforcementHash(blob);
        assertEq(legacyHash, adapterHash, "adapter hash MUST match legacy hash for migration safety");
    }

    /// @notice Hash stability under field perturbation — flipping any field MUST
    ///         change the hash on both paths in lockstep.
    function test_uniswapV3SwapHashFieldSensitivity() public view {
        // Two distinct memory structs (Solidity memory-to-memory assignment
        // aliases instead of copying, so we build them independently).
        TradeValidator.UniswapV3SwapEnforcement memory base = _uniV3Enf();
        TradeValidator.UniswapV3SwapEnforcement memory perturbed = _uniV3Enf();
        perturbed.feeTier = 500; // flip 3000 → 500

        bytes32 baseLegacy = tv.hashUniswapV3Swap(base);
        bytes32 baseAdapter = uniV3Adapter.enforcementHash(abi.encode(base));
        bytes32 perturbedLegacy = tv.hashUniswapV3Swap(perturbed);
        bytes32 perturbedAdapter = uniV3Adapter.enforcementHash(abi.encode(perturbed));

        assertEq(baseLegacy, baseAdapter, "base parity");
        assertEq(perturbedLegacy, perturbedAdapter, "perturbed parity");
        assertTrue(baseLegacy != perturbedLegacy, "feeTier flip MUST change hash");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REGISTRY CRUD
    // ═══════════════════════════════════════════════════════════════════════════

    function test_registerHappyPath() public {
        bytes32 expectedKind = keccak256("UniswapV3Swap");
        assertEq(uniV3Adapter.envelopeKind(), expectedKind);

        vm.prank(admin);
        registry.register(uniV3Adapter);

        assertEq(registry.count(), 1);
        IEnvelopeAdapter resolved = registry.getAdapter(expectedKind);
        assertEq(address(resolved), address(uniV3Adapter));
    }

    function test_registerRevertsOnDuplicate() public {
        vm.prank(admin);
        registry.register(uniV3Adapter);

        UniswapV3SwapAdapter dup = new UniswapV3SwapAdapter();
        vm.expectRevert(
            abi.encodeWithSelector(EnvelopeRegistry.AdapterAlreadyRegistered.selector, keccak256("UniswapV3Swap"))
        );
        vm.prank(admin);
        registry.register(dup);
    }

    function test_registerRevertsForNonAdmin() public {
        vm.expectRevert();
        registry.register(uniV3Adapter);
    }

    function test_replaceUpdatesAdapter() public {
        vm.prank(admin);
        registry.register(uniV3Adapter);

        UniswapV3SwapAdapter v2 = new UniswapV3SwapAdapter();
        vm.prank(admin);
        registry.replace(v2);

        IEnvelopeAdapter resolved = registry.getAdapter(keccak256("UniswapV3Swap"));
        assertEq(address(resolved), address(v2));
    }

    function test_replaceRevertsIfMissing() public {
        vm.expectRevert(
            abi.encodeWithSelector(EnvelopeRegistry.AdapterNotRegistered.selector, keccak256("UniswapV3Swap"))
        );
        vm.prank(admin);
        registry.replace(uniV3Adapter);
    }

    function test_deregisterRemovesAdapter() public {
        vm.prank(admin);
        registry.register(uniV3Adapter);
        assertEq(registry.count(), 1);

        vm.prank(admin);
        registry.deregister(keccak256("UniswapV3Swap"));
        assertEq(registry.count(), 0);

        IEnvelopeAdapter probe = registry.tryGetAdapter(keccak256("UniswapV3Swap"));
        assertEq(address(probe), address(0));
    }

    function test_listKindsReturnsAll() public {
        vm.prank(admin);
        registry.register(uniV3Adapter);
        bytes32[] memory kinds = registry.listKinds();
        assertEq(kinds.length, 1);
        assertEq(kinds[0], keccak256("UniswapV3Swap"));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADAPTER PRE-CALL CHECK — happy path through the registry
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Build a calldata-blob for `exactInputSingle((...))` matching the enforcement.
    function _buildExactInputSingleCalldata(TradeValidator.UniswapV3SwapEnforcement memory enf, uint256 amountIn)
        internal
        view
        returns (bytes memory)
    {
        // selector for exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
        bytes4 sel = 0x414bf389;
        UniswapV3SwapAdapter.ExactInputSingleParams memory p = UniswapV3SwapAdapter.ExactInputSingleParams({
            tokenIn: enf.tokenIn,
            tokenOut: enf.tokenOut,
            fee: uint24(enf.feeTier),
            recipient: address(0xBEEF), // vault would be address(this) in real flow
            deadline: block.timestamp + 600,
            amountIn: amountIn,
            amountOutMinimum: (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18,
            sqrtPriceLimitX96: uint256(enf.sqrtPriceLimitX96)
        });
        // ABI-encode by hand (uniswap router uses uint160 for the last field).
        bytes memory body = abi.encode(
            p.tokenIn,
            p.tokenOut,
            p.fee,
            p.recipient,
            p.deadline,
            p.amountIn,
            p.amountOutMinimum,
            uint160(p.sqrtPriceLimitX96)
        );
        return bytes.concat(sel, body);
    }

    function test_preCallCheckProducesMatchingHashAndConsumeAmount() public {
        // Resolve the adapter through the registry like the vault would.
        vm.prank(admin);
        registry.register(uniV3Adapter);
        IEnvelopeAdapter adapter = registry.getAdapter(keccak256("UniswapV3Swap"));

        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3Enf();
        bytes memory enforcementBlob = abi.encode(enf);
        uint256 amountIn = 0.5e18;

        UniswapV3SwapAdapter.ExecuteParams memory p = UniswapV3SwapAdapter.ExecuteParams({
            target: enf.router,
            data: _buildExactInputSingleCalldata(enf, amountIn),
            value: 0,
            minOutput: (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18,
            outputToken: enf.tokenOut,
            intentHash: bytes32(uint256(0xCAFE)),
            deadline: block.timestamp + 600
        });
        bytes memory paramsBlob = abi.encode(p);

        TradeValidator.Envelope memory env = TradeValidator.Envelope({
            version: 2,
            botIdHash: keccak256("bot-1"),
            vault: address(0xBEEF),
            chainId: uint64(block.chainid),
            protocolHash: keccak256("uniswap_v3"),
            policyHash: keccak256("policy"),
            enforcementHash: tv.hashUniswapV3Swap(enf),
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: bytes32(0),
            minSignatures: 2
        });

        IEnvelopeAdapter.PreCallReport memory report = adapter.preCallCheck(paramsBlob, enforcementBlob, env);

        // Hash MUST match the validator's signed hash (this is the critical gate
        // the vault would enforce as `env.enforcementHash == report.enforcementHash`).
        assertEq(report.enforcementHash, env.enforcementHash, "report hash must match envelope-signed hash");
        assertEq(report.consumeAmount, amountIn, "consume amount = amountIn");
        assertEq(report.maxSingleAmount, enf.maxSingleAmountIn, "caps surfaced from enforcement");
        assertEq(report.maxTotalAmount, enf.maxTotalAmountIn, "caps surfaced from enforcement");
        assertEq(uint256(report.shape), uint256(IEnvelopeAdapter.ExecShape.Trade), "uniV3 swap is Trade shape");
        assertEq(report.approvals.length, 1);
        assertEq(report.approvals[0].token, enf.tokenIn);
        assertEq(report.approvals[0].spender, enf.router);
        assertEq(report.approvals[0].amount, amountIn);
    }

    function test_preCallCheckRevertsOnSelectorMismatch() public {
        vm.prank(admin);
        registry.register(uniV3Adapter);
        IEnvelopeAdapter adapter = registry.getAdapter(keccak256("UniswapV3Swap"));

        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3Enf();
        bytes memory enforcementBlob = abi.encode(enf);

        UniswapV3SwapAdapter.ExecuteParams memory p = UniswapV3SwapAdapter.ExecuteParams({
            target: enf.router,
            data: hex"deadbeef0000", // wrong selector
            value: 0,
            minOutput: 1,
            outputToken: enf.tokenOut,
            intentHash: bytes32(uint256(0xCAFE)),
            deadline: block.timestamp + 600
        });
        bytes memory paramsBlob = abi.encode(p);

        TradeValidator.Envelope memory env;
        env.version = 2;
        env.enforcementHash = tv.hashUniswapV3Swap(enf);

        vm.expectRevert(UniswapV3SwapAdapter.EnvelopeWrongSelector.selector);
        adapter.preCallCheck(paramsBlob, enforcementBlob, env);
    }

    function test_preCallCheckRevertsOnEnforcementMismatch() public {
        vm.prank(admin);
        registry.register(uniV3Adapter);
        IEnvelopeAdapter adapter = registry.getAdapter(keccak256("UniswapV3Swap"));

        TradeValidator.UniswapV3SwapEnforcement memory enf = _uniV3Enf();
        bytes memory enforcementBlob = abi.encode(enf);

        // Build calldata with a router that doesn't match enf.router.
        UniswapV3SwapAdapter.ExecuteParams memory p = UniswapV3SwapAdapter.ExecuteParams({
            target: address(0xDEADBEEF), // wrong router
            data: _buildExactInputSingleCalldata(enf, 0.5e18),
            value: 0,
            minOutput: 1,
            outputToken: enf.tokenOut,
            intentHash: bytes32(uint256(0xCAFE)),
            deadline: block.timestamp + 600
        });
        bytes memory paramsBlob = abi.encode(p);

        TradeValidator.Envelope memory env;
        env.version = 2;
        env.enforcementHash = tv.hashUniswapV3Swap(enf);

        vm.expectRevert(UniswapV3SwapAdapter.EnvelopeCheckFailed.selector);
        adapter.preCallCheck(paramsBlob, enforcementBlob, env);
    }
}
