export type PlatformVolumeRange = '1d' | '7d' | '30d' | '6m' | '1y';
export type PlatformVolumeMode = 'bucket' | 'rolling7d' | 'cumulative';

export interface PlatformVolumeRangeConfig {
  value: PlatformVolumeRange;
  label: string;
  days: number;
  bucketMs: number;
  bucketLabel: string;
  fetchPages: number;
}

export interface PlatformVolumeTradeInput {
  timestamp: number;
  notionalUsd?: number | null;
  paperTrade?: boolean;
}

export interface PlatformVolumeBucketInput {
  timestamp: number;
  bucketUsd: number;
  paperUsd: number;
  liveUsd: number;
  pricedTradeCount: number;
  totalTradeCount: number;
}

export interface PlatformVolumeBucket {
  timestamp: number;
  label: string;
  bucketUsd: number;
  rolling7dUsd: number;
  cumulativeUsd: number;
  tradeCount: number;
  totalTradeCount: number;
  paperUsd: number;
  liveUsd: number;
}

export interface PlatformVolumeSeries {
  buckets: PlatformVolumeBucket[];
  rangeStartMs: number;
  rangeEndMs: number;
  bucketMs: number;
  summary: {
    totalUsd: number;
    paperUsd: number;
    liveUsd: number;
    pricedTradeCount: number;
    totalTradeCount: number;
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const PLATFORM_VOLUME_RANGES: PlatformVolumeRangeConfig[] = [
  { value: '1d', label: '1D', days: 1, bucketMs: HOUR_MS, bucketLabel: 'Hourly', fetchPages: 1 },
  { value: '7d', label: '7D', days: 7, bucketMs: DAY_MS, bucketLabel: 'Daily', fetchPages: 2 },
  { value: '30d', label: '30D', days: 30, bucketMs: DAY_MS, bucketLabel: 'Daily', fetchPages: 3 },
  { value: '6m', label: '6M', days: 183, bucketMs: DAY_MS, bucketLabel: 'Daily', fetchPages: 5 },
  { value: '1y', label: '1Y', days: 365, bucketMs: DAY_MS, bucketLabel: 'Daily', fetchPages: 8 },
];

const hourLabelFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
});

const dayLabelFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export function getPlatformVolumeRangeConfig(range: PlatformVolumeRange): PlatformVolumeRangeConfig {
  return PLATFORM_VOLUME_RANGES.find((item) => item.value === range) ?? PLATFORM_VOLUME_RANGES[2];
}

function floorToBucket(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

function formatBucketLabel(timestamp: number, bucketMs: number): string {
  return bucketMs === HOUR_MS
    ? hourLabelFormatter.format(new Date(timestamp))
    : dayLabelFormatter.format(new Date(timestamp));
}

function readPositiveNotional(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

export function buildPlatformVolumeSeries(
  trades: PlatformVolumeTradeInput[],
  range: PlatformVolumeRange,
  nowMs = Date.now(),
): PlatformVolumeSeries {
  const config = getPlatformVolumeRangeConfig(range);
  const rangeEndMs = nowMs;
  const rangeStartMs = nowMs - config.days * DAY_MS;
  const bucketInputs = new Map<number, PlatformVolumeBucketInput>();

  for (const trade of trades) {
    if (!Number.isFinite(trade.timestamp)) continue;
    if (trade.timestamp < rangeStartMs || trade.timestamp > rangeEndMs) continue;

    const timestamp = floorToBucket(trade.timestamp, config.bucketMs);
    const existing = bucketInputs.get(timestamp) ?? {
      timestamp,
      bucketUsd: 0,
      paperUsd: 0,
      liveUsd: 0,
      pricedTradeCount: 0,
      totalTradeCount: 0,
    };
    existing.totalTradeCount += 1;

    const notional = readPositiveNotional(trade.notionalUsd);
    if (notional == null) {
      bucketInputs.set(timestamp, existing);
      continue;
    }

    existing.bucketUsd += notional;
    existing.pricedTradeCount += 1;
    if (trade.paperTrade) {
      existing.paperUsd += notional;
    } else {
      existing.liveUsd += notional;
    }
    bucketInputs.set(timestamp, existing);
  }

  return buildPlatformVolumeSeriesFromBuckets(Array.from(bucketInputs.values()), range, nowMs);
}

export function buildPlatformVolumeSeriesFromBuckets(
  bucketInputs: PlatformVolumeBucketInput[],
  range: PlatformVolumeRange,
  nowMs = Date.now(),
): PlatformVolumeSeries {
  const config = getPlatformVolumeRangeConfig(range);
  const rangeEndMs = nowMs;
  const rangeStartMs = nowMs - config.days * DAY_MS;
  const firstBucketMs = floorToBucket(rangeStartMs, config.bucketMs);
  const lastBucketMs = floorToBucket(rangeEndMs, config.bucketMs);
  const bucketMap = new Map<number, Omit<PlatformVolumeBucket, 'label' | 'rolling7dUsd' | 'cumulativeUsd'>>();

  for (let timestamp = firstBucketMs; timestamp <= lastBucketMs; timestamp += config.bucketMs) {
    bucketMap.set(timestamp, {
      timestamp,
      bucketUsd: 0,
      tradeCount: 0,
      totalTradeCount: 0,
      paperUsd: 0,
      liveUsd: 0,
    });
  }

  for (const input of bucketInputs) {
    if (!Number.isFinite(input.timestamp)) continue;
    if (input.timestamp < rangeStartMs || input.timestamp > rangeEndMs) continue;
    const bucketTimestamp = floorToBucket(input.timestamp, config.bucketMs);
    const bucket = bucketMap.get(bucketTimestamp);
    if (!bucket) continue;

    bucket.bucketUsd += input.bucketUsd;
    bucket.tradeCount += input.pricedTradeCount;
    bucket.totalTradeCount += input.totalTradeCount;
    bucket.paperUsd += input.paperUsd;
    bucket.liveUsd += input.liveUsd;
  }

  let cumulativeUsd = 0;
  const rollingWindowMs = 7 * DAY_MS;
  const buckets = Array.from(bucketMap.values())
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((bucket, index, allBuckets): PlatformVolumeBucket => {
      cumulativeUsd += bucket.bucketUsd;
      const rolling7dUsd = allBuckets.reduce((sum, candidate) => {
        const withinWindow = candidate.timestamp > bucket.timestamp - rollingWindowMs
          && candidate.timestamp <= bucket.timestamp;
        return withinWindow ? sum + candidate.bucketUsd : sum;
      }, 0);

      return {
        ...bucket,
        label: formatBucketLabel(bucket.timestamp, config.bucketMs),
        rolling7dUsd,
        cumulativeUsd,
      };
    });

  const summary = buckets.reduce(
    (acc, bucket) => ({
      totalUsd: acc.totalUsd + bucket.bucketUsd,
      paperUsd: acc.paperUsd + bucket.paperUsd,
      liveUsd: acc.liveUsd + bucket.liveUsd,
      pricedTradeCount: acc.pricedTradeCount + bucket.tradeCount,
      totalTradeCount: acc.totalTradeCount + bucket.totalTradeCount,
    }),
    {
      totalUsd: 0,
      paperUsd: 0,
      liveUsd: 0,
      pricedTradeCount: 0,
      totalTradeCount: 0,
    },
  );

  return {
    buckets,
    rangeStartMs,
    rangeEndMs,
    bucketMs: config.bucketMs,
    summary,
  };
}
