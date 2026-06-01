import { useEffect, useMemo, useRef, useState } from 'react';
import type { AreaData, HistogramData, Time, UTCTimestamp } from 'lightweight-charts';
import { Badge, Skeleton } from '@tangle-network/blueprint-ui/components';
import { loadLightweightCharts } from '~/components/bot-detail/lightweightChartRuntime';
import { formatNumber } from '~/lib/format';
import { useChartTheme } from '~/lib/hooks/useChartTheme';
import { usePlatformVolumeSeries } from '~/lib/hooks/useBotApi';
import {
  PLATFORM_VOLUME_RANGES,
  type PlatformVolumeBucket,
  type PlatformVolumeMode,
  type PlatformVolumeRange,
} from '~/lib/platformVolume';
import type { Bot } from '~/lib/types/bot';

interface PlatformVolumeChartProps {
  bots: Bot[];
  className?: string;
  variant?: 'standard' | 'command';
}

const MODES: Array<{ value: PlatformVolumeMode; label: string; icon: string }> = [
  { value: 'bucket', label: 'Daily', icon: 'i-ph:chart-bar' },
  { value: 'rolling7d', label: '7D', icon: 'i-ph:wave-sine' },
  { value: 'cumulative', label: 'Cumulative', icon: 'i-ph:trend-up' },
];

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value >= 1_000_000) {
    return `$${formatNumber(value / 1_000_000, {
      maximumFractionDigits: 2,
      minimumFractionDigits: value >= 10_000_000 ? 1 : 2,
    })}M`;
  }
  if (value >= 1_000) {
    return `$${formatNumber(value / 1_000, {
      maximumFractionDigits: 1,
      minimumFractionDigits: value >= 10_000 ? 0 : 1,
    })}K`;
  }
  return `$${formatNumber(value, { maximumFractionDigits: 2 })}`;
}

function bucketValue(bucket: PlatformVolumeBucket, mode: PlatformVolumeMode): number {
  switch (mode) {
    case 'bucket':
      return bucket.bucketUsd;
    case 'rolling7d':
      return bucket.rolling7dUsd;
    case 'cumulative':
      return bucket.cumulativeUsd;
  }
}

function toChartTime(timestamp: number): UTCTimestamp {
  return Math.floor(timestamp / 1000) as UTCTimestamp;
}

function toHistogramData(
  buckets: PlatformVolumeBucket[],
  mode: PlatformVolumeMode,
  positiveColor: string,
): HistogramData<Time>[] {
  return buckets.map((bucket) => ({
    time: toChartTime(bucket.timestamp),
    value: bucketValue(bucket, mode),
    color: `${positiveColor}c8`,
  }));
}

function toAreaData(
  buckets: PlatformVolumeBucket[],
  mode: PlatformVolumeMode,
): AreaData<Time>[] {
  return buckets.map((bucket) => ({
    time: toChartTime(bucket.timestamp),
    value: bucketValue(bucket, mode),
  }));
}

function PlatformVolumeTradingChart({
  buckets,
  mode,
  bucketMs,
  heightClassName,
}: {
  buckets: PlatformVolumeBucket[];
  mode: PlatformVolumeMode;
  bucketMs: number;
  heightClassName: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartTheme = useChartTheme();
  const dataFingerprint = buckets.map((bucket) =>
    `${bucket.timestamp}:${bucketValue(bucket, mode)}:${bucket.totalTradeCount}`,
  ).join('|');

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    loadLightweightCharts().then((charts) => {
      if (disposed || !containerRef.current) return;

      const chart = charts.createChart(containerRef.current, {
        autoSize: true,
        height: containerRef.current.clientHeight || 240,
        layout: {
          background: { type: charts.ColorType.Solid, color: 'transparent' },
          textColor: chartTheme.tickColor,
          attributionLogo: false,
          fontFamily: "'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        grid: {
          vertLines: { color: 'transparent' },
          horzLines: { color: chartTheme.gridColor },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.12, bottom: 0.1 },
        },
        timeScale: {
          borderVisible: false,
          rightOffset: 2,
          barSpacing: buckets.length < 8 ? 28 : buckets.length < 40 ? 12 : 5,
          timeVisible: bucketMs < 24 * 60 * 60 * 1000,
          secondsVisible: false,
        },
        crosshair: {
          mode: charts.CrosshairMode.Magnet,
          vertLine: {
            color: chartTheme.tickColor,
            labelBackgroundColor: chartTheme.tooltipBg,
            style: charts.LineStyle.Dashed,
          },
          horzLine: {
            color: chartTheme.tickColor,
            labelBackgroundColor: chartTheme.tooltipBg,
            style: charts.LineStyle.Dotted,
          },
        },
        handleScale: {
          axisPressedMouseMove: true,
          mouseWheel: true,
          pinch: true,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        localization: {
          priceFormatter: formatUsd,
        },
      });

      if (mode === 'bucket') {
        const histogramSeries = chart.addSeries(charts.HistogramSeries, {
          priceFormat: { type: 'custom', formatter: formatUsd },
          lastValueVisible: true,
          priceLineVisible: true,
          priceLineColor: chartTheme.positive,
          priceLineWidth: 1,
          priceLineStyle: charts.LineStyle.Dashed,
        });
        histogramSeries.setData(toHistogramData(buckets, mode, chartTheme.positive));
      } else {
        const lineColor = mode === 'cumulative' ? '#8b5cf6' : chartTheme.positive;
        const areaSeries = chart.addSeries(charts.AreaSeries, {
          lineColor,
          topColor: mode === 'cumulative' ? 'rgba(139,92,246,0.18)' : chartTheme.positiveGradientStart,
          bottomColor: chartTheme.gradientEnd,
          lineWidth: 2,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
          crosshairMarkerBorderColor: chartTheme.hoverBorderColor,
          crosshairMarkerBackgroundColor: lineColor,
          lastPriceAnimation: charts.LastPriceAnimationMode.OnDataUpdate,
          lastValueVisible: true,
          priceLineVisible: true,
          priceLineColor: lineColor,
          priceLineWidth: 1,
          priceLineStyle: charts.LineStyle.Dashed,
        });
        areaSeries.setData(toAreaData(buckets, mode));
      }

      chart.timeScale().fitContent();

      const resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current) return;
        chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      });
      resizeObserver.observe(containerRef.current);
      cleanup = () => {
        resizeObserver.disconnect();
        chart.remove();
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [bucketMs, buckets.length, chartTheme, dataFingerprint, mode]);

  return (
    <div
      ref={containerRef}
      className={`${heightClassName} w-full overflow-hidden`}
      aria-label="Platform volume chart"
    />
  );
}

export function PlatformVolumeChart({
  bots,
  className = '',
  variant = 'standard',
}: PlatformVolumeChartProps) {
  const [range, setRange] = useState<PlatformVolumeRange>('30d');
  const [mode, setMode] = useState<PlatformVolumeMode>('bucket');
  const { series, coverage, isLoading, isFetching } = usePlatformVolumeSeries(bots, range);
  const selectedRange = PLATFORM_VOLUME_RANGES.find((item) => item.value === range) ?? PLATFORM_VOLUME_RANGES[2];
  const modeLabel = mode === 'bucket' ? selectedRange.bucketLabel : MODES.find((item) => item.value === mode)?.label ?? 'Volume';
  const buckets = series.buckets;
  const values = useMemo(() => buckets.map((bucket) => bucketValue(bucket, mode)), [buckets, mode]);
  const latestValue = values[values.length - 1] ?? 0;
  const hasVolume = series.summary.totalUsd > 0;
  const isCommand = variant === 'command';
  const operatorCoverage = coverage.candidateOperators > 0
    ? `${coverage.fetchedOperators}/${coverage.candidateOperators} sources`
    : 'No sources';
  const summaryStats = [
    { label: 'Live', value: formatUsd(series.summary.liveUsd) },
    { label: 'Paper', value: formatUsd(series.summary.paperUsd) },
    { label: 'Priced Trades', value: series.summary.pricedTradeCount.toLocaleString() },
    { label: 'Coverage', value: operatorCoverage },
  ];

  return (
    <section className={`${isCommand ? 'h-full' : 'mb-4'} overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/46 ${className}`}>
      <div className="flex flex-col gap-3 border-b border-arena-elements-dividerColor/60 px-4 py-3 sm:px-5 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
              Platform Volume
            </h2>
            <Badge variant="outline" className="font-data text-xs">
              All configured operators
            </Badge>
            {coverage.candidateOperators > 0 && (
              <Badge variant="outline" className="font-data text-xs">
                {operatorCoverage}
              </Badge>
            )}
            {isFetching && !isLoading && (
              <Badge variant="secondary" className="font-data text-xs">
                refreshing
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-arena-elements-textSecondary">
            USD notional from each configured operator aggregate endpoint.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 2xl:justify-end">
          <label className="sr-only" htmlFor="platform-volume-range">
            Volume range
          </label>
          <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/72 px-2">
            <span className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
              Range
            </span>
            <select
              id="platform-volume-range"
              value={range}
              onChange={(event) => setRange(event.target.value as PlatformVolumeRange)}
              className="h-7 rounded-md bg-arena-elements-background-depth-1 px-2 font-data text-sm text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
            >
              {PLATFORM_VOLUME_RANGES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <div
            className="inline-flex rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/60 p-1"
            aria-label="Volume chart mode"
            role="group"
          >
            {MODES.map((item) => {
              const selected = item.value === mode;
              const label = item.value === 'bucket' ? selectedRange.bucketLabel : item.label;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setMode(item.value)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-data text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                    selected
                      ? 'bg-arena-elements-item-backgroundActive text-arena-elements-textPrimary'
                      : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                  }`}
                  aria-pressed={selected}
                >
                  <span className={`${item.icon} text-sm`} aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className={`grid gap-0 ${isCommand ? '' : 'xl:grid-cols-[minmax(0,1fr)_280px]'}`}>
        <div className={`${isCommand ? 'min-h-[318px]' : 'min-h-[292px]'} p-4 sm:p-5`}>
          {isLoading ? (
            <Skeleton className={`${isCommand ? 'h-[286px]' : 'h-[260px]'} w-full`} />
          ) : hasVolume ? (
            <div className="h-full rounded-xl border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/54 p-3">
              <div className="mb-3 flex items-start justify-between gap-4">
                <div>
                  <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                    {modeLabel} volume
                  </div>
                  <div className="mt-1 font-data text-3xl font-bold tracking-tight text-arena-elements-textPrimary">
                    {formatUsd(latestValue)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                    Total in range
                  </div>
                  <div className="mt-1 font-data text-xl font-bold text-arena-elements-textPrimary">
                    {formatUsd(series.summary.totalUsd)}
                  </div>
                </div>
              </div>

              {isCommand && (
                <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {summaryStats.map((stat) => (
                    <div
                      key={stat.label}
                      className="min-w-0 rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-2/44 px-2.5 py-2"
                    >
                      <div className="truncate font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                        {stat.label}
                      </div>
                      <div className="mt-0.5 truncate font-data text-sm font-bold text-arena-elements-textPrimary">
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <PlatformVolumeTradingChart
                buckets={buckets}
                mode={mode}
                bucketMs={series.bucketMs}
                heightClassName={isCommand ? 'h-[220px]' : 'h-[222px]'}
              />
            </div>
          ) : (
            <div
              className="flex h-[260px] items-center justify-center rounded-xl border border-dashed border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/42 text-center"
              style={{
                backgroundImage: 'linear-gradient(rgba(127,127,145,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(127,127,145,0.08) 1px, transparent 1px)',
                backgroundSize: '48px 48px',
              }}
            >
              <div>
                <div className="i-ph:chart-bar text-3xl text-arena-elements-textTertiary mb-2 mx-auto" />
                <p className="font-display text-base font-semibold text-arena-elements-textPrimary">
                  No priced volume
                </p>
                <p className="mt-1 text-sm text-arena-elements-textSecondary">
                  Awaiting USD-valued trades.
                </p>
              </div>
            </div>
          )}
        </div>

        <aside className={`${isCommand ? 'hidden' : ''} border-t border-arena-elements-dividerColor/60 p-4 sm:p-5 xl:border-l xl:border-t-0`}>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
            {[
              { label: 'Total volume', value: formatUsd(series.summary.totalUsd), icon: 'i-ph:chart-line-up' },
              { label: 'Live notional', value: formatUsd(series.summary.liveUsd), icon: 'i-ph:lightning' },
              { label: 'Paper notional', value: formatUsd(series.summary.paperUsd), icon: 'i-ph:notepad' },
              { label: 'Priced trades', value: series.summary.pricedTradeCount.toLocaleString(), icon: 'i-ph:swap' },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/54 px-3 py-2.5"
              >
                <div className="flex items-center gap-2 text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                  <span className={`${stat.icon} text-sm`} aria-hidden="true" />
                  {stat.label}
                </div>
                <div className="mt-1 font-data text-lg font-bold text-arena-elements-textPrimary">
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/36 px-3 py-2.5">
            <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
              Coverage
            </div>
            <div className="mt-2 space-y-1.5 text-sm text-arena-elements-textSecondary">
              <div className="flex items-center justify-between gap-3">
                <span>Agents</span>
                <span className="font-data text-arena-elements-textPrimary">
                  {coverage.fetchedBots}/{coverage.candidateBots}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Operators</span>
                <span className="font-data text-arena-elements-textPrimary">
                  {coverage.fetchedOperators}/{coverage.candidateOperators}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>History</span>
                <span className="font-data text-arena-elements-textPrimary">
                  {selectedRange.fetchPages * 200}/bot
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
