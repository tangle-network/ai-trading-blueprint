import { describe, expect, it } from 'vitest';
import { portfolioTvlUsd } from './useBotEnrichment';

describe('portfolioTvlUsd', () => {
  it('returns the priced USD vault value instead of raw vault units', () => {
    expect(portfolioTvlUsd({ total_value_usd: '2450.75' })).toBe(2450.75);
  });

  it('hides TVL when the portfolio has unpriced positions', () => {
    expect(portfolioTvlUsd({
      total_value_usd: '3',
      has_unpriced_positions: true,
    })).toBeNull();
  });
});
