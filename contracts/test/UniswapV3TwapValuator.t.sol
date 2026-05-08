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

    int24 public spotTick;
    int56 public pastTickCumulative;
    int56 public nowTickCumulative;
    uint160 public pastSecondsPerLiquidityCumulativeX128;
    uint160 public nowSecondsPerLiquidityCumulativeX128;
    bool public observeReverts;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
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
        observationCardinality = 2;
        observationCardinalityNext = 2;
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
        pool = new MockUniswapV3Pool(TOKEN, ASSET);
        pool.setOracle(0, 0, WINDOW, 1_000_000);
        factory.setPool(TOKEN, ASSET, FEE, address(pool));
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
        pool.setOracle(0, 0, WINDOW, 10);

        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3TwapValuator.InsufficientHistoricalLiquidity.selector, uint128(10), uint128(100_000)
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
}
