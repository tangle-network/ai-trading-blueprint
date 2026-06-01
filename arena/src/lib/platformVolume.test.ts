import { describe, expect, it } from 'vitest';
import {
  buildPlatformVolumeSeries,
  buildPlatformVolumeSeriesFromBuckets,
  getPlatformVolumeRangeConfig,
} from './platformVolume';

describe('platform volume series', () => {
  it('buckets 1D volume hourly and splits live from paper notional', () => {
    const now = Date.parse('2026-06-01T12:30:00Z');
    const series = buildPlatformVolumeSeries([
      {
        timestamp: Date.parse('2026-06-01T10:10:00Z'),
        notionalUsd: 100,
        paperTrade: true,
      },
      {
        timestamp: Date.parse('2026-06-01T10:40:00Z'),
        notionalUsd: 50,
        paperTrade: false,
      },
      {
        timestamp: Date.parse('2026-06-01T11:00:00Z'),
        notionalUsd: null,
        paperTrade: false,
      },
    ], '1d', now);

    const tenAmBucket = series.buckets.find((bucket) =>
      bucket.timestamp === Date.parse('2026-06-01T10:00:00Z'));
    expect(getPlatformVolumeRangeConfig('1d').bucketLabel).toBe('Hourly');
    expect(tenAmBucket?.bucketUsd).toBe(150);
    expect(tenAmBucket?.paperUsd).toBe(100);
    expect(tenAmBucket?.liveUsd).toBe(50);
    expect(series.summary.totalUsd).toBe(150);
    expect(series.summary.pricedTradeCount).toBe(2);
    expect(series.summary.totalTradeCount).toBe(3);
  });

  it('computes cumulative and rolling seven day volume over daily buckets', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    const series = buildPlatformVolumeSeries([
      {
        timestamp: Date.parse('2026-06-01T15:00:00Z'),
        notionalUsd: 100,
      },
      {
        timestamp: Date.parse('2026-06-05T15:00:00Z'),
        notionalUsd: 50,
      },
      {
        timestamp: Date.parse('2026-06-10T08:00:00Z'),
        notionalUsd: 25,
      },
    ], '30d', now);

    const june10 = series.buckets.find((bucket) =>
      bucket.timestamp === Date.parse('2026-06-10T00:00:00Z'));
    expect(june10?.cumulativeUsd).toBe(175);
    expect(june10?.rolling7dUsd).toBe(75);
  });

  it('ignores out-of-range trades and non-positive notional', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    const series = buildPlatformVolumeSeries([
      {
        timestamp: Date.parse('2025-06-01T15:00:00Z'),
        notionalUsd: 10_000,
      },
      {
        timestamp: Date.parse('2026-06-10T08:00:00Z'),
        notionalUsd: 0,
      },
      {
        timestamp: Date.parse('2026-06-10T09:00:00Z'),
        notionalUsd: Number.NaN,
      },
    ], '7d', now);

    expect(series.summary.totalUsd).toBe(0);
    expect(series.summary.pricedTradeCount).toBe(0);
    expect(series.summary.totalTradeCount).toBe(2);
  });

  it('merges pre-aggregated operator buckets without losing unpriced counts', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    const series = buildPlatformVolumeSeriesFromBuckets([
      {
        timestamp: Date.parse('2026-06-10T00:00:00Z'),
        bucketUsd: 125,
        paperUsd: 75,
        liveUsd: 50,
        pricedTradeCount: 2,
        totalTradeCount: 3,
      },
      {
        timestamp: Date.parse('2026-06-10T03:00:00Z'),
        bucketUsd: 25,
        paperUsd: 0,
        liveUsd: 25,
        pricedTradeCount: 1,
        totalTradeCount: 1,
      },
    ], '7d', now);

    const june10 = series.buckets.find((bucket) =>
      bucket.timestamp === Date.parse('2026-06-10T00:00:00Z'));
    expect(june10?.bucketUsd).toBe(150);
    expect(june10?.tradeCount).toBe(3);
    expect(june10?.totalTradeCount).toBe(4);
    expect(series.summary.paperUsd).toBe(75);
    expect(series.summary.liveUsd).toBe(75);
    expect(series.summary.totalTradeCount).toBe(4);
  });
});
