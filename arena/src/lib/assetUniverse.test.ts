import { describe, expect, it } from 'vitest';
import { buildDexAssetUniverse, resolveDexAssetInput } from './assetUniverse';

describe('assetUniverse', () => {
  it('keeps known assets on Chainlink valuation', () => {
    const usdc = resolveDexAssetInput('USDC', 1);
    const weth = resolveDexAssetInput('WETH', 1);

    expect(usdc?.known).toBe(true);
    expect(weth?.known).toBe(true);

    const universe = buildDexAssetUniverse({
      chainId: 1,
      baseAsset: usdc!.address,
      selectedAssets: [weth!.address],
    });

    expect(universe.valuation_policy).toBe('chainlink_or_uniswap_v3_twap');
    expect(universe.allowed_assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: 'USDC',
          valuation_adapter: 'chainlink_usd',
        }),
        expect.objectContaining({
          symbol: 'WETH',
          valuation_adapter: 'chainlink_usd',
        }),
      ]),
    );
  });

  it('marks manual token addresses for Chainlink first then Uniswap V3 TWAP fallback', () => {
    const usdc = resolveDexAssetInput('USDC', 1);
    const custom = resolveDexAssetInput(
      '0x1111111111111111111111111111111111111111',
      1,
    );

    expect(custom?.known).toBe(false);

    const universe = buildDexAssetUniverse({
      chainId: 1,
      baseAsset: usdc!.address,
      selectedAssets: [custom!.address],
    });

    expect(universe.allowed_assets).toContainEqual(
      expect.objectContaining({
        address: custom!.address,
        valuation_adapter: 'chainlink_or_uniswap_v3_twap',
      }),
    );
  });
});
