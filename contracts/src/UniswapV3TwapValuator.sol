// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IAssetValuator.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
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
        );
}

/// @title UniswapV3TwapValuator
/// @notice Values custom ERC-20s against a vault asset using direct Uniswap V3 TWAP pools.
/// @dev Intended as a fallback when Chainlink is unavailable. The pair config is checked on every NAV read.
contract UniswapV3TwapValuator is IAssetValuator, Ownable {
    error ZeroAddress();
    error InvalidConfig();
    error PoolNotFound(address token, address asset, uint24 fee);
    error PoolTokenMismatch(address pool, address token, address asset);
    error PairNotConfigured(address token, address asset);
    error InsufficientHistoricalLiquidity(uint128 observed, uint128 required);
    error SpotTwapDeviation(uint256 observedBps, uint256 maxBps);
    error InvalidOraclePrice(address token, address asset);

    struct PairConfig {
        address pool;
        uint32 twapWindow;
        uint128 minHarmonicLiquidity;
        uint32 maxSpotTwapDeviationBps;
        bool enabled;
    }

    IUniswapV3Factory public immutable factory;
    uint32 public immutable defaultTwapWindow;
    uint128 public immutable defaultMinHarmonicLiquidity;
    uint32 public immutable defaultMaxSpotTwapDeviationBps;

    mapping(bytes32 => PairConfig) public pairConfigs;

    event PairConfigured(
        address indexed token,
        address indexed asset,
        address indexed pool,
        uint32 twapWindow,
        uint128 minHarmonicLiquidity,
        uint32 maxSpotTwapDeviationBps
    );
    event PairDisabled(address indexed token, address indexed asset);

    constructor(
        address owner_,
        address factory_,
        uint32 defaultTwapWindow_,
        uint128 defaultMinHarmonicLiquidity_,
        uint32 defaultMaxSpotTwapDeviationBps_
    ) Ownable(owner_) {
        if (owner_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        if (defaultTwapWindow_ == 0 || defaultMaxSpotTwapDeviationBps_ > 10_000) {
            revert InvalidConfig();
        }
        factory = IUniswapV3Factory(factory_);
        defaultTwapWindow = defaultTwapWindow_;
        defaultMinHarmonicLiquidity = defaultMinHarmonicLiquidity_;
        defaultMaxSpotTwapDeviationBps = defaultMaxSpotTwapDeviationBps_;
    }

    function setPairFromFactory(address token, address asset, uint24 fee) external onlyOwner {
        setPairFromFactoryWithConfig(
            token, asset, fee, defaultTwapWindow, defaultMinHarmonicLiquidity, defaultMaxSpotTwapDeviationBps
        );
    }

    function setPairFromFactoryWithConfig(
        address token,
        address asset,
        uint24 fee,
        uint32 twapWindow,
        uint128 minHarmonicLiquidity,
        uint32 maxSpotTwapDeviationBps
    ) public onlyOwner {
        address pool = factory.getPool(token, asset, fee);
        if (pool == address(0)) revert PoolNotFound(token, asset, fee);
        setPairWithConfig(token, asset, pool, twapWindow, minHarmonicLiquidity, maxSpotTwapDeviationBps);
    }

    function setPairWithConfig(
        address token,
        address asset,
        address pool,
        uint32 twapWindow,
        uint128 minHarmonicLiquidity,
        uint32 maxSpotTwapDeviationBps
    ) public onlyOwner {
        _validatePairShape(token, asset, pool);
        if (twapWindow == 0 || maxSpotTwapDeviationBps > 10_000) revert InvalidConfig();
        _previewPool(pool, token, asset, twapWindow, minHarmonicLiquidity, maxSpotTwapDeviationBps);

        pairConfigs[_pairKey(token, asset)] = PairConfig({
            pool: pool,
            twapWindow: twapWindow,
            minHarmonicLiquidity: minHarmonicLiquidity,
            maxSpotTwapDeviationBps: maxSpotTwapDeviationBps,
            enabled: true
        });
        emit PairConfigured(token, asset, pool, twapWindow, minHarmonicLiquidity, maxSpotTwapDeviationBps);
    }

    function disablePair(address token, address asset) external onlyOwner {
        delete pairConfigs[_pairKey(token, asset)];
        emit PairDisabled(token, asset);
    }

    function previewPool(
        address token,
        address asset,
        uint24 fee,
        uint32 twapWindow,
        uint128 minHarmonicLiquidity,
        uint32 maxSpotTwapDeviationBps
    ) external view returns (address pool, int24 arithmeticMeanTick, uint128 harmonicMeanLiquidity, int24 spotTick) {
        pool = factory.getPool(token, asset, fee);
        if (pool == address(0)) revert PoolNotFound(token, asset, fee);
        _validatePairShape(token, asset, pool);
        (arithmeticMeanTick, harmonicMeanLiquidity, spotTick) =
            _previewPool(pool, token, asset, twapWindow, minHarmonicLiquidity, maxSpotTwapDeviationBps);
    }

    function previewConfigured(address token, address asset)
        external
        view
        returns (int24 arithmeticMeanTick, uint128 harmonicMeanLiquidity, int24 spotTick)
    {
        PairConfig memory config = pairConfigs[_pairKey(token, asset)];
        if (!config.enabled) revert PairNotConfigured(token, asset);
        return _previewPool(
            config.pool, token, asset, config.twapWindow, config.minHarmonicLiquidity, config.maxSpotTwapDeviationBps
        );
    }

    function isSupported(address token, address asset) external view override returns (bool) {
        if (token == asset) return true;
        try this.previewConfigured(token, asset) returns (int24, uint128, int24) {
            return true;
        } catch {
            return false;
        }
    }

    function valueInAsset(address token, uint256 amount, address asset) external view override returns (uint256 value) {
        if (amount == 0 || token == asset) return amount;
        PairConfig memory config = pairConfigs[_pairKey(token, asset)];
        if (!config.enabled) revert PairNotConfigured(token, asset);
        (int24 arithmeticMeanTick,,) = _previewPool(
            config.pool, token, asset, config.twapWindow, config.minHarmonicLiquidity, config.maxSpotTwapDeviationBps
        );
        return _quoteAtTick(arithmeticMeanTick, amount, token, asset);
    }

    function _previewPool(
        address pool,
        address token,
        address asset,
        uint32 twapWindow,
        uint128 minHarmonicLiquidity,
        uint32 maxSpotTwapDeviationBps
    ) internal view returns (int24 arithmeticMeanTick, uint128 harmonicMeanLiquidity, int24 spotTick) {
        if (twapWindow == 0 || maxSpotTwapDeviationBps > 10_000) revert InvalidConfig();
        (arithmeticMeanTick, harmonicMeanLiquidity) = _consult(pool, twapWindow);
        if (harmonicMeanLiquidity < minHarmonicLiquidity) {
            revert InsufficientHistoricalLiquidity(harmonicMeanLiquidity, minHarmonicLiquidity);
        }

        (, spotTick,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 deviationBps = _spotTwapDeviationBps(spotTick, arithmeticMeanTick, token, asset);
        if (deviationBps > maxSpotTwapDeviationBps) {
            revert SpotTwapDeviation(deviationBps, maxSpotTwapDeviationBps);
        }
    }

    function _consult(address pool, uint32 secondsAgo)
        internal
        view
        returns (int24 arithmeticMeanTick, uint128 harmonicMeanLiquidity)
    {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s) =
            IUniswapV3Pool(pool).observe(secondsAgos);

        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        arithmeticMeanTick = int24(tickCumulativesDelta / int56(uint56(secondsAgo)));
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % int56(uint56(secondsAgo)) != 0)) {
            arithmeticMeanTick--;
        }

        uint160 secondsPerLiquidityDelta;
        unchecked {
            secondsPerLiquidityDelta = secondsPerLiquidityCumulativeX128s[1] - secondsPerLiquidityCumulativeX128s[0];
        }
        if (secondsPerLiquidityDelta == 0) revert InvalidOraclePrice(address(0), address(0));
        uint256 liquidity = (uint256(secondsAgo) << 128) / uint256(secondsPerLiquidityDelta);
        harmonicMeanLiquidity = liquidity > type(uint128).max ? type(uint128).max : uint128(liquidity);
    }

    function _spotTwapDeviationBps(int24 spotTick, int24 twapTick, address token, address asset)
        internal
        pure
        returns (uint256)
    {
        uint256 probeAmount = 1e18;
        uint256 spotQuote = _quoteAtTick(spotTick, probeAmount, token, asset);
        uint256 twapQuote = _quoteAtTick(twapTick, probeAmount, token, asset);
        if (spotQuote == 0 || twapQuote == 0) revert InvalidOraclePrice(token, asset);
        return spotQuote > twapQuote
            ? Math.mulDiv(spotQuote - twapQuote, 10_000, twapQuote)
            : Math.mulDiv(twapQuote - spotQuote, 10_000, twapQuote);
    }

    function _quoteAtTick(int24 tick, uint256 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX192, baseAmount, 1 << 192)
                : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX128, baseAmount, 1 << 128)
                : Math.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    function _validatePairShape(address token, address asset, address pool) internal view {
        if (token == address(0) || asset == address(0) || pool == address(0)) revert ZeroAddress();
        if (token == asset) revert InvalidConfig();
        address token0 = IUniswapV3Pool(pool).token0();
        address token1 = IUniswapV3Pool(pool).token1();
        bool matchesPair = (token0 == token && token1 == asset) || (token0 == asset && token1 == token);
        if (!matchesPair) revert PoolTokenMismatch(pool, token, asset);
    }

    function _pairKey(address token, address asset) internal pure returns (bytes32) {
        return token < asset ? keccak256(abi.encodePacked(token, asset)) : keccak256(abi.encodePacked(asset, token));
    }
}

/// @dev Minimal Uniswap V3 TickMath implementation used to convert average ticks into quotes.
library TickMath {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(uint24(-tick)) : uint256(uint24(tick));
        require(absTick <= uint256(uint24(MAX_TICK)), "T");

        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
