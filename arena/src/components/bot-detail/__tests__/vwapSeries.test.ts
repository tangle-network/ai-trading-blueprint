import { describe, expect, it } from 'vitest';
import { vwapSeries } from '../TradingPerformanceChart';
import type { MarketCandle } from '~/lib/hooks/useBotApi';

const DAY_MS = 86_400_000;

function candle(timestamp: number, price: number, volume = 100): MarketCandle {
  return {
    timestamp,
    token: 'WETH',
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
  };
}

describe('vwapSeries', () => {
  it('anchors to the UTC session instead of the loaded window', () => {
    // Day 1 trades at 2000, day 2 trades at 1600. A window-anchored VWAP
    // would hold near 2000 and float far above day-2 candles; a
    // session-anchored VWAP must track each day's own prices.
    const day1 = [candle(0, 2000), candle(3_600_000, 2000)];
    const day2 = [candle(DAY_MS, 1600), candle(DAY_MS + 3_600_000, 1600)];
    const points = vwapSeries([...day1, ...day2]);

    expect(points).toHaveLength(4);
    expect(points[1].value).toBeCloseTo(2000, 6);
    // First candle of the new session resets the anchor: pure day-2 price.
    expect(points[2].value).toBeCloseTo(1600, 6);
    expect(points[3].value).toBeCloseTo(1600, 6);
  });

  it('stays within the session price envelope on mixed prices', () => {
    const points = vwapSeries([
      candle(DAY_MS, 1700, 50),
      candle(DAY_MS + 3_600_000, 1650, 200),
      candle(DAY_MS + 7_200_000, 1600, 100),
    ]);
    const last = points[points.length - 1].value;
    expect(last).toBeGreaterThanOrEqual(1600);
    expect(last).toBeLessThanOrEqual(1700);
    // Volume-weighted toward the heavy 1650 print.
    expect(last).toBeLessThan(1670);
  });

  it('skips zero-volume candles without emitting points', () => {
    const points = vwapSeries([candle(0, 2000, 0), candle(3_600_000, 1900, 10)]);
    expect(points).toHaveLength(1);
    expect(points[0].value).toBeCloseTo(1900, 6);
  });
});
