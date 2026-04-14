interface PerformanceMetricSnapshotLike {
  account_value_usd: number | string;
  timestamp?: string;
}

export interface PerformanceChartPoint {
  label: string;
  tooltipLabel: string;
  value: number;
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
): PerformanceChartPoint[] {
  const normalizedApiMetrics = (apiMetrics ?? [])
    .map((metric) => ({
      timestamp: metric.timestamp,
      account_value_usd: Number(metric.account_value_usd),
    }))
    .filter((metric) => Number.isFinite(metric.account_value_usd));

  const positiveApiMetrics = normalizedApiMetrics.filter((metric) => metric.account_value_usd > 0);

  if (positiveApiMetrics.length === 0) {
    return fallbackValues.map((value, index) => ({
      label: getSnapshotLabel(index),
      tooltipLabel: getSnapshotLabel(index),
      value,
    }));
  }

  const renderableMetrics = positiveApiMetrics.length < normalizedApiMetrics.length
    ? positiveApiMetrics
    : normalizedApiMetrics;

  const parsedDates = renderableMetrics.map((metric) => parseTimestamp(metric.timestamp));
  const validDates = parsedDates.filter((date): date is Date => date !== null);
  const tickFormatter = pickTickFormatter(validDates);

  return renderableMetrics.map((metric, index) => {
    const date = parsedDates[index];
    if (!date) {
      return {
        label: getSnapshotLabel(index),
        tooltipLabel: getSnapshotLabel(index),
        value: metric.account_value_usd,
      };
    }

    return {
      label: tickFormatter.format(date),
      tooltipLabel: tooltipLabelFormatter.format(date),
      value: metric.account_value_usd,
    };
  });
}
