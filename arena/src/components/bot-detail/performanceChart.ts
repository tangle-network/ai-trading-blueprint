interface PerformanceMetricSnapshotLike {
  account_value_usd: number | string;
  timestamp?: string;
}

type PerformanceChartMetric = {
  account_value_usd: number;
  timestamp?: string;
  kind: 'snapshot' | 'live_nav';
  label?: string;
};

export interface PerformanceLivePoint {
  value: number;
  timestamp?: string;
  label?: string;
}

export interface PerformanceInitialPoint {
  value: number;
  timestamp?: string;
}

export interface PerformanceChartPoint {
  label: string;
  tooltipLabel: string;
  value: number;
  kind?: 'snapshot' | 'live_nav';
}

const intradayLabelFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

const dayLabelFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const dayWithYearLabelFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const tooltipLabelFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function parseTimestamp(timestamp?: string): Date | null {
  if (!timestamp) return null;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getSnapshotLabel(index: number): string {
  return `Snapshot ${index + 1}`;
}

function getCalendarDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function pickTickFormatter(dates: Date[]): Intl.DateTimeFormat {
  if (dates.length === 0) return intradayLabelFormatter;

  const uniqueDays = new Set(dates.map(getCalendarDayKey));
  if (uniqueDays.size === 1) return intradayLabelFormatter;

  const uniqueYears = new Set(dates.map((date) => date.getFullYear()));
  return uniqueYears.size === 1 ? dayLabelFormatter : dayWithYearLabelFormatter;
}

export function buildPerformanceChartPoints(
  apiMetrics: PerformanceMetricSnapshotLike[] | undefined,
  fallbackValues: number[],
  initialPoint?: PerformanceInitialPoint | null,
  livePoint?: PerformanceLivePoint | null,
): PerformanceChartPoint[] {
  const normalizedApiMetrics = (apiMetrics ?? [])
    .map((metric) => ({
      timestamp: metric.timestamp,
      account_value_usd: Number(metric.account_value_usd),
    }))
    .filter((metric) => Number.isFinite(metric.account_value_usd));

  const positiveApiMetrics = normalizedApiMetrics.filter((metric) => metric.account_value_usd > 0);
  const liveChartMetric: PerformanceChartMetric | null = livePoint && Number.isFinite(livePoint.value) && livePoint.value > 0
    ? {
        timestamp: livePoint.timestamp,
        account_value_usd: livePoint.value,
        kind: 'live_nav',
        label: livePoint.label,
      }
    : null;

  if (positiveApiMetrics.length === 0) {
    const fallbackPoints = fallbackValues.map((value, index) => ({
      label: getSnapshotLabel(index),
      tooltipLabel: getSnapshotLabel(index),
      value,
      kind: 'snapshot' as const,
    }));
    if (!liveChartMetric) return fallbackPoints;

    const date = parseTimestamp(liveChartMetric.timestamp);
    return [
      ...fallbackPoints,
      {
        label: liveChartMetric.label ?? 'Live',
        tooltipLabel: date ? `Live NAV: ${tooltipLabelFormatter.format(date)}` : 'Live NAV',
        value: liveChartMetric.account_value_usd,
        kind: 'live_nav',
      },
    ];
  }

  const renderableMetrics = positiveApiMetrics.length < normalizedApiMetrics.length
    ? positiveApiMetrics
    : normalizedApiMetrics;
  const shouldPrependInitialPoint = initialPoint
    && Number.isFinite(initialPoint.value)
    && initialPoint.value > 0
    && renderableMetrics.length > 0;
  const chartMetrics = shouldPrependInitialPoint
    ? [
        {
          timestamp: initialPoint.timestamp,
          account_value_usd: initialPoint.value,
          kind: 'snapshot' as const,
        },
        ...renderableMetrics.map((metric) => ({ ...metric, kind: 'snapshot' as const })),
      ]
    : renderableMetrics.map((metric) => ({ ...metric, kind: 'snapshot' as const }));
  const chartMetricsWithLivePoint: PerformanceChartMetric[] = liveChartMetric
    ? [...chartMetrics, liveChartMetric]
    : chartMetrics;

  const parsedDates = chartMetricsWithLivePoint.map((metric) => parseTimestamp(metric.timestamp));
  const validDates = parsedDates.filter((date): date is Date => date !== null);
  const tickFormatter = pickTickFormatter(validDates);

  return chartMetricsWithLivePoint.map((metric, index) => {
    const date = parsedDates[index];
    if (metric.kind === 'live_nav') {
      return {
        label: metric.label ?? 'Live',
        tooltipLabel: date ? `Live NAV: ${tooltipLabelFormatter.format(date)}` : 'Live NAV',
        value: metric.account_value_usd,
        kind: 'live_nav',
      };
    }

    if (!date) {
      return {
        label: getSnapshotLabel(index),
        tooltipLabel: getSnapshotLabel(index),
        value: metric.account_value_usd,
        kind: 'snapshot',
      };
    }

    return {
      label: tickFormatter.format(date),
      tooltipLabel: tooltipLabelFormatter.format(date),
      value: metric.account_value_usd,
      kind: 'snapshot',
    };
  });
}
