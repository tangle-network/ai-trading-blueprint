import { describe, expect, it } from 'vitest';
import { resolveAssetDisplay } from './tradeTokenMetadata';

describe('tradeTokenMetadata', () => {
  it('resolves known token addresses into human-readable asset display data', () => {
    const asset = resolveAssetDisplay('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 1);

    expect(asset.symbol).toBe('USDC');
    expect(asset.name).toBe('USD Coin');
    expect(asset.primaryLabel).toBe('USD Coin');
    expect(asset.secondaryLabel).toBe('USDC');
    expect(asset.logoUri).toBe('/token-icons/usdc.svg');
    expect(asset.isKnown).toBe(true);
  });

  it('uses a friendly fallback for unknown asset addresses', () => {
    const asset = resolveAssetDisplay('0x1111111111111111111111111111111111111111');

    expect(asset.name).toBe('Unknown Asset');
    expect(asset.primaryLabel).toBe('Unknown Asset');
    expect(asset.secondaryLabel).toBe('0x1111...1111');
    expect(asset.isKnown).toBe(false);
  });
});
