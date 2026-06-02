import { describe, expect, it } from 'vitest';
import {
  normalizeTradeHistoryCount,
  portfolioTvlUsd,
  resolveCanonicalTradeCount,
} from './useBotEnrichment';

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

  it('uses the trade ledger total as the canonical displayed trade count', () => {
    expect(resolveCanonicalTradeCount({
      ledgerCount: 4,
      metricsCount: 9,
      rosterCount: 12,
    })).toBe(4);
  });

  it('falls back to metrics or roster counts when the trade ledger is unavailable', () => {
    expect(resolveCanonicalTradeCount({
      ledgerCount: null,
      metricsCount: 9,
      rosterCount: 12,
    })).toBe(9);

    expect(resolveCanonicalTradeCount({
      ledgerCount: null,
      metricsCount: null,
      rosterCount: 12,
    })).toBe(12);
  });
});
