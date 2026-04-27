import { describe, expect, it } from 'vitest';
import { buildPerformanceChartPoints } from '../performanceChart';

describe('buildPerformanceChartPoints', () => {
  it('uses intraday time labels when API snapshots are from the same day', () => {
    const points = buildPerformanceChartPoints(
      [
        { account_value_usd: 1000, timestamp: '2026-04-06T09:00:00.000Z' },
        { account_value_usd: 1005, timestamp: '2026-04-06T09:01:00.000Z' },
      ],
      [],
    );

    expect(points.map((point) => point.label)).toSatisfy((labels: string[]) =>
      labels.every((label) => label.includes(':') && !label.startsWith('Day ')),
    );
    expect(points.map((point) => point.tooltipLabel)).toSatisfy((labels: string[]) =>
      labels.every((label) => label.includes('2026') && label.includes(':')),
    );
  });

  it('uses calendar-day labels when snapshots span multiple days', () => {
    const points = buildPerformanceChartPoints(
      [
        { account_value_usd: 1000, timestamp: '2026-04-05T09:00:00.000Z' },
        { account_value_usd: 1005, timestamp: '2026-04-06T09:00:00.000Z' },
      ],
      [],
    );

    expect(points.map((point) => point.label)).toSatisfy((labels: string[]) =>
      labels.every((label) => !label.includes(':') && !label.startsWith('Day ')),
    );
  });

  it('falls back to neutral snapshot labels when timestamps are unavailable', () => {
    const points = buildPerformanceChartPoints(undefined, [1000, 1005, 1010]);

    expect(points).toEqual([
      { label: 'Snapshot 1', tooltipLabel: 'Snapshot 1', value: 1000 },
      { label: 'Snapshot 2', tooltipLabel: 'Snapshot 2', value: 1005 },
      { label: 'Snapshot 3', tooltipLabel: 'Snapshot 3', value: 1010 },
    ]);
  });

  it('ignores all-zero API snapshots so the UI can stay in the empty-state path', () => {
    const points = buildPerformanceChartPoints(
      [
        { account_value_usd: 0, timestamp: '2026-04-10T13:21:09.808593Z' },
        { account_value_usd: 0, timestamp: '2026-04-10T13:22:11.825639Z' },
      ],
      [],
    );

    expect(points).toEqual([]);
  });

  it('drops unusable zero-value snapshots once positive snapshots are available', () => {
    const points = buildPerformanceChartPoints(
      [
        { account_value_usd: '0', timestamp: '2026-04-10T13:21:09.808593Z' },
        { account_value_usd: '0', timestamp: '2026-04-10T13:22:11.825639Z' },
        { account_value_usd: '2212.61', timestamp: '2026-04-10T13:45:31.753572Z' },
        { account_value_usd: '2223.61', timestamp: '2026-04-10T14:00:49.545344Z' },
      ],
      [],
    );

    expect(points).toHaveLength(2);
    expect(points[0]?.value).toBe(2212.61);
    expect(points[1]?.value).toBe(2223.61);
  });

  it('prepends trusted initial capital before real snapshots', () => {
    const points = buildPerformanceChartPoints(
      [
        { account_value_usd: 9994.04, timestamp: '2026-04-23T10:40:51.844085Z' },
        { account_value_usd: 9992.13, timestamp: '2026-04-23T11:02:02.514536Z' },
      ],
      [],
      { value: 10000, timestamp: '2026-04-23T10:34:39.000Z' },
    );

    expect(points).toHaveLength(3);
    expect(points[0]?.value).toBe(10000);
    expect(points[1]?.value).toBe(9994.04);
    expect(points[2]?.value).toBe(9992.13);
  });
});
