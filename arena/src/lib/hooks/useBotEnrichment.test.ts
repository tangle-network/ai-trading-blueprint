import { describe, expect, it } from 'vitest';
import { normalizeTradeHistoryCount, portfolioTvlUsd } from './useBotEnrichment';

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

  it('reads exact trade totals from paginated trade history responses', () => {
    expect(normalizeTradeHistoryCount({
      trades: Array.from({ length: 12 }, (_, i) => ({ id: `trade-${i}` })),
      total: 27,
      limit: 12,
      offset: 0,
    })).toBe(27);
  });

  it('falls back to visible trade history length for legacy array responses', () => {
    expect(normalizeTradeHistoryCount([
      { id: 'trade-1' },
      { id: 'trade-2' },
      { id: 'trade-3' },
    ])).toBe(3);
  });
});
