// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/UniswapV3TwapValuator.sol";

/// @title UniswapV3TwapValuator Fork Tests
/// @notice Audit FIX-8: exercises the valuator against real Ethereum mainnet pool
///         state so the fixed-point arithmetic in `_consult` and `_quoteAtTick`
///         is validated on actual non-linear cumulative growth — not the
///         single-observation linear mocks.
/// @dev    Requires ETHEREUM_RPC_URL env var (or override via --fork-url).
///         Run: forge test --mc UniswapV3TwapValuatorForkTest --fork-url $ETHEREUM_RPC_URL
///         Tests no-op when not running on chain id 1 (mainnet).
contract UniswapV3TwapValuatorForkTest is Test {
    // Canonical Ethereum mainnet addresses.
    address constant UNISWAP_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;

    // The two largest USDC/WETH V3 pools.
    address constant USDC_WETH_005 = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640; // 0.05% (5bps)
    address constant USDC_WETH_03 = 0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8; // 0.3%  (30bps)

    address constant OWNER = address(0xABCD);

    UniswapV3TwapValuator valuator;

    function setUp() public {
        if (block.chainid != 1) return;
        valuator = new UniswapV3TwapValuator(
            OWNER,
            UNISWAP_V3_FACTORY,
            1800, // 30-min TWAP window
            1_000_000, // harmonic-liquidity floor — well above MIN_HARMONIC_LIQUIDITY_FLOOR
            200 // 200 BPS spot/TWAP deviation cap
        );
    }

    /// @notice Real pool registers cleanly: factory provenance, cardinality,
    ///         harmonic liquidity, and spot/TWAP deviation all pass on the
    ///         canonical USDC/WETH 0.3% pool at current mainnet state.
    function test_fork_register_real_usdc_weth_pool() public {
        if (block.chainid != 1) return;

        vm.prank(OWNER);
        valuator.setPairFromFactory(WETH, USDC, 3000);

        assertTrue(valuator.isSupported(WETH, USDC), "real WETH/USDC 0.3% should be supported");
    }

    /// @notice Sanity bound on the produced quote: 1 WETH should be priced
    ///         within $500..$50,000 USDC (in 6-dec USDC units). Catches
    ///         regression in `_quoteAtTick` decimals / overflow envelope.
    function test_fork_value_one_weth_in_usdc_is_within_sane_bounds() public {
        if (block.chainid != 1) return;

        vm.prank(OWNER);
        valuator.setPairFromFactory(WETH, USDC, 3000);

        uint256 oneWeth = 1e18;
        uint256 quote = valuator.valueInAsset(WETH, oneWeth, USDC);

        // USDC is 6-dec → 500 USDC = 500e6, 50_000 USDC = 50_000e6.
        assertGt(quote, 500e6, "1 WETH < $500 -- quote logic is broken");
        assertLt(quote, 50_000e6, "1 WETH > $50k -- quote logic is broken");
    }

    /// @notice Factory-provenance gate (FIX-2) rejects a deployed-but-not-from-factory
    ///         pool address even when the token shape matches.
    function test_fork_rejects_non_factory_pool() public {
        if (block.chainid != 1) return;

        // Pretend the 0.05% pool is what we want under the 0.3% fee tier.
        // factory.getPool(WETH, USDC, 0.3%) returns the 0.3% pool — registering
        // the 0.05% pool's address against the 0.3% fee path must fail.
        // (Use setPairWithConfig to bypass the factory-derive lookup that
        // setPairFromFactory does.)
        vm.prank(OWNER);
        vm.expectRevert();
        valuator.setPairWithConfig(WETH, USDC, USDC_WETH_005, 1800, 1_000_000, 200);
    }

    /// @notice Symmetry: pricing 1 USDC into WETH and 1 WETH into USDC and
    ///         multiplying back should round-trip within ~50bps of identity
    ///         (slippage budget = the deviation cap + decimal rounding).
    function test_fork_round_trip_quote_within_tolerance() public {
        if (block.chainid != 1) return;

        vm.prank(OWNER);
        valuator.setPairFromFactory(WETH, USDC, 3000);

        uint256 oneUsdc = 1e6;
        uint256 wethForOneUsdc = valuator.valueInAsset(USDC, oneUsdc, WETH);
        // Round-trip back via WETH → USDC at the same TWAP.
        uint256 backToUsdc = valuator.valueInAsset(WETH, wethForOneUsdc, USDC);

        // Allow up to 50 bps of round-trip drift (decimal rounding + tick math).
        uint256 diff = oneUsdc > backToUsdc ? oneUsdc - backToUsdc : backToUsdc - oneUsdc;
        assertLt(diff * 10_000, oneUsdc * 50, "round-trip quote must agree within 50 BPS");
    }

    /// @notice DAI/WETH 0.3% — second canonical pool, validates the
    ///         valuator works across multiple pools without state leakage.
    function test_fork_register_dai_weth_pool() public {
        if (block.chainid != 1) return;

        vm.prank(OWNER);
        valuator.setPairFromFactory(WETH, DAI, 3000);

        assertTrue(valuator.isSupported(WETH, DAI), "real WETH/DAI 0.3% should be supported");
    }
}
