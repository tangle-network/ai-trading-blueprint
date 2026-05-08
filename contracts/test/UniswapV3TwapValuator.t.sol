// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/UniswapV3TwapValuator.sol";

contract MockUniswapV3Factory {
    mapping(bytes32 => address) public pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[_key(tokenA, tokenB, fee)] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function _key(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        return tokenA < tokenB
            ? keccak256(abi.encodePacked(tokenA, tokenB, fee))
            : keccak256(abi.encodePacked(tokenB, tokenA, fee));
    }
}

contract MockUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    int24 public spotTick;
    int56 public pastTickCumulative;
    int56 public nowTickCumulative;
    uint160 public pastSecondsPerLiquidityCumulativeX128;
    uint160 public nowSecondsPerLiquidityCumulativeX128;
    bool public observeReverts;
    uint16 public observationCardinality_ = 64;

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function setObservationCardinality(uint16 v) external {
        observationCardinality_ = v;
    }

    function setOracle(int24 meanTick, int24 spotTick_, uint32 window, uint128 harmonicLiquidity) external {
        spotTick = spotTick_;
        pastTickCumulative = 0;
        nowTickCumulative = int56(meanTick) * int56(uint56(window));
        pastSecondsPerLiquidityCumulativeX128 = 0;
        nowSecondsPerLiquidityCumulativeX128 = uint160((uint256(window) << 128) / harmonicLiquidity);
    }

    function setObserveReverts(bool value) external {
        observeReverts = value;
    }

    function observe(uint32[] calldata)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!observeReverts, "OLD");
        tickCumulatives = new int56[](2);
        secondsPerLiquidityCumulativeX128s = new uint160[](2);
        tickCumulatives[0] = pastTickCumulative;
        tickCumulatives[1] = nowTickCumulative;
        secondsPerLiquidityCumulativeX128s[0] = pastSecondsPerLiquidityCumulativeX128;
        secondsPerLiquidityCumulativeX128s[1] = nowSecondsPerLiquidityCumulativeX128;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        sqrtPriceX96 = 0;
        tick = spotTick;
        observationIndex = 0;
        observationCardinality = observationCardinality_;
        observationCardinalityNext = observationCardinality_;
        feeProtocol = 0;
        unlocked = true;
    }
}

contract UniswapV3TwapValuatorTest is Test {
    address internal constant TOKEN = address(0x1000);
    address internal constant ASSET = address(0x2000);
    uint24 internal constant FEE = 3000;
    uint32 internal constant WINDOW = 1800;

    MockUniswapV3Factory internal factory;
    MockUniswapV3Pool internal pool;
    UniswapV3TwapValuator internal valuator;

    function setUp() public {
        factory = new MockUniswapV3Factory();
        pool = new MockUniswapV3Pool(TOKEN, ASSET, FEE);
        pool.setOracle(0, 0, WINDOW, 1_000_000);
        factory.setPool(TOKEN, ASSET, FEE, address(pool));
        // 1800s window, harmonic-liquidity floor 100_000 (well above the contract's
        // 1000 tripwire), 5% deviation cap.
        valuator = new UniswapV3TwapValuator(address(this), address(factory), WINDOW, 100_000, 500);
    }

    function test_set_pair_and_value_one_to_one() public {
        valuator.setPairFromFactory(TOKEN, ASSET, FEE);

        assertTrue(valuator.isSupported(TOKEN, ASSET));
        assertEq(valuator.valueInAsset(TOKEN, 1 ether, ASSET), 1 ether);
    }

    function test_value_reverts_when_pair_not_configured() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapV3TwapValuator.PairNotConfigured.selector, TOKEN, ASSET));
        valuator.valueInAsset(TOKEN, 1 ether, ASSET);
    }

    function test_set_pair_reverts_when_pool_missing() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapV3TwapValuator.PoolNotFound.selector, TOKEN, ASSET, uint24(500)));
        valuator.setPairFromFactory(TOKEN, ASSET, 500);
    }

    function test_set_pair_reverts_when_historical_liquidity_is_low() public {
        // 50_000 is below the configured per-pair floor of 100_000 but above the
        // contract-level MIN_HARMONIC_LIQUIDITY_FLOOR (1000), so the per-pair gate
        // is what fires.
        pool.setOracle(0, 0, WINDOW, 50_000);

        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3TwapValuator.InsufficientHistoricalLiquidity.selector, uint128(50_000), uint128(100_000)
            )
        );
        valuator.setPairFromFactory(TOKEN, ASSET, FEE);
    }

    function test_set_pair_reverts_when_spot_deviates_from_twap() public {
        pool.setOracle(0, 1000, WINDOW, 1_000_000);

        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3TwapValuator.SpotTwapDeviation.selector, uint256(1051), uint256(500))
        );
        valuator.setPairFromFactory(TOKEN, ASSET, FEE);
    }

    function test_is_supported_turns_false_when_oracle_history_becomes_unavailable() public {
        valuator.setPairFromFactory(TOKEN, ASSET, FEE);
        assertTrue(valuator.isSupported(TOKEN, ASSET));

        pool.setObserveReverts(true);

        assertFalse(valuator.isSupported(TOKEN, ASSET));
    }

    // ── audit FIX-2 hardening tests ──────────────────────────────────────────

    /// @notice Constructor refuses a TWAP window below MIN_TWAP_WINDOW.
    function test_constructor_rejects_short_twap_window() public {
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3TwapValuator.TwapWindowTooShort.selector, uint32(60), uint32(600))
        );
        new UniswapV3TwapValuator(address(this), address(factory), 60, 100_000, 500);
    }

    /// @notice Constructor refuses a harmonic-liquidity floor below MIN_HARMONIC_LIQUIDITY_FLOOR.
    function test_constructor_rejects_low_harmonic_liquidity_floor() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3TwapValuator.MinHarmonicLiquidityTooLow.selector, uint128(1), uint128(1000)
            )
        );
        new UniswapV3TwapValuator(address(this), address(factory), WINDOW, 1, 500);
    }

    /// @notice setPairWithConfig refuses any pool the canonical factory does not
    ///         return for (token, asset, pool.fee()) — closes the fake-pool
    ///         attack where owner registers a contract that mimics the pool ABI.
    function test_setPairWithConfig_rejects_pool_not_from_factory() public {
        // Deploy a parallel pool that mimics the ABI and has the same tokens
        // and fee, but is NOT registered with the factory.
        MockUniswapV3Pool rogue = new MockUniswapV3Pool(TOKEN, ASSET, FEE);
        rogue.setOracle(0, 0, WINDOW, 1_000_000);

        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3TwapValuator.PoolNotFromFactory.selector, address(rogue), address(pool))
        );
        valuator.setPairWithConfig(TOKEN, ASSET, address(rogue), WINDOW, 100_000, 500);
    }

    /// @notice setPairWithConfig refuses a TWAP window below the floor.
    function test_setPairWithConfig_rejects_short_twap_window() public {
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3TwapValuator.TwapWindowTooShort.selector, uint32(300), uint32(600))
        );
        valuator.setPairWithConfig(TOKEN, ASSET, address(pool), 300, 100_000, 500);
    }

    /// @notice setPairWithConfig refuses a harmonic-liquidity floor below the tripwire.
    function test_setPairWithConfig_rejects_low_harmonic_liquidity_floor() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3TwapValuator.MinHarmonicLiquidityTooLow.selector, uint128(500), uint128(1000)
            )
        );
        valuator.setPairWithConfig(TOKEN, ASSET, address(pool), WINDOW, 500, 500);
    }

    /// @notice _previewPool refuses a pool with cardinality below MIN_OBSERVATION_CARDINALITY.
    function test_setPair_rejects_low_observation_cardinality() public {
        pool.setObservationCardinality(8);

        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3TwapValuator.InsufficientObservationCardinality.selector, uint16(8), uint16(32)
            )
        );
        valuator.setPairFromFactory(TOKEN, ASSET, FEE);
    }
}
