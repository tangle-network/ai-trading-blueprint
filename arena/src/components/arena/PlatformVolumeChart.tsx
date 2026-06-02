import { useEffect, useMemo, useRef, useState } from 'react';
import type { AreaData, HistogramData, IChartApi, ISeriesApi, Time, UTCTimestamp } from 'lightweight-charts';
import { Skeleton } from '@tangle-network/blueprint-ui/components';
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
  const runtimeRef = useRef<{
    chart: IChartApi;
    charts: Awaited<ReturnType<typeof loadLightweightCharts>>;
    series: ISeriesApi<'Histogram'> | ISeriesApi<'Area'> | null;
    mode: PlatformVolumeMode | null;
    resizeObserver: ResizeObserver;
  } | null>(null);
  const latestInputRef = useRef({ buckets, mode, bucketMs, chartTheme });
  const lastFitKeyRef = useRef<string | null>(null);
  latestInputRef.current = { buckets, mode, bucketMs, chartTheme };

  function createSeries(
    runtime: NonNullable<typeof runtimeRef.current>,
    nextMode: PlatformVolumeMode,
    nextChartTheme: typeof chartTheme,
  ): ISeriesApi<'Histogram'> | ISeriesApi<'Area'> {
    if (nextMode === 'bucket') {
      return runtime.chart.addSeries(runtime.charts.HistogramSeries, {
        priceFormat: { type: 'custom', formatter: formatUsd },
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: nextChartTheme.positive,
        priceLineWidth: 1,
        priceLineStyle: runtime.charts.LineStyle.Dashed,
      });
    }

    const lineColor = nextMode === 'cumulative' ? '#8b5cf6' : nextChartTheme.positive;
    return runtime.chart.addSeries(runtime.charts.AreaSeries, {
      lineColor,
      topColor: nextMode === 'cumulative' ? 'rgba(139,92,246,0.18)' : nextChartTheme.positiveGradientStart,
      bottomColor: nextChartTheme.gradientEnd,
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: nextChartTheme.hoverBorderColor,
      crosshairMarkerBackgroundColor: lineColor,
      lastPriceAnimation: runtime.charts.LastPriceAnimationMode.OnDataUpdate,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: lineColor,
      priceLineWidth: 1,
      priceLineStyle: runtime.charts.LineStyle.Dashed,
    });
  }

  function applyChartData(runtime: NonNullable<typeof runtimeRef.current>, shouldFitContent: boolean) {
    const {
      buckets: nextBuckets,
      mode: nextMode,
      bucketMs: nextBucketMs,
      chartTheme: nextChartTheme,
    } = latestInputRef.current;

    runtime.chart.applyOptions({
      timeScale: {
        barSpacing: nextBuckets.length < 8 ? 28 : nextBuckets.length < 40 ? 12 : 5,
        timeVisible: nextBucketMs < 24 * 60 * 60 * 1000,
        secondsVisible: false,
      },
    });

    if (!runtime.series || runtime.mode !== nextMode) {
      if (runtime.series) {
        runtime.chart.removeSeries(runtime.series as ISeriesApi<'Area'>);
      }
      runtime.series = createSeries(runtime, nextMode, nextChartTheme);
      runtime.mode = nextMode;
    }

    if (nextMode === 'bucket') {
      (runtime.series as ISeriesApi<'Histogram'>).setData(
        toHistogramData(nextBuckets, nextMode, nextChartTheme.positive),
      );
    } else {
      (runtime.series as ISeriesApi<'Area'>).setData(toAreaData(nextBuckets, nextMode));
    }

    if (shouldFitContent) runtime.chart.timeScale().fitContent();
  }

  useEffect(() => {
    let disposed = false;

    loadLightweightCharts().then((charts) => {
      if (disposed || !containerRef.current) return;
      const {
        buckets: initialBuckets,
        bucketMs: initialBucketMs,
        chartTheme: initialChartTheme,
      } = latestInputRef.current;

      const chart = charts.createChart(containerRef.current, {
        autoSize: true,
        height: containerRef.current.clientHeight || 240,
        layout: {
          background: { type: charts.ColorType.Solid, color: 'transparent' },
          textColor: initialChartTheme.tickColor,
          attributionLogo: false,
          fontFamily: "'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        grid: {
          vertLines: { color: 'transparent' },
          horzLines: { color: initialChartTheme.gridColor },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.12, bottom: 0.1 },
        },
        timeScale: {
          borderVisible: false,
          rightOffset: 2,
          barSpacing: initialBuckets.length < 8 ? 28 : initialBuckets.length < 40 ? 12 : 5,
          timeVisible: initialBucketMs < 24 * 60 * 60 * 1000,
          secondsVisible: false,
        },
        crosshair: {
          mode: charts.CrosshairMode.Magnet,
          vertLine: {
            color: initialChartTheme.tickColor,
            labelBackgroundColor: initialChartTheme.tooltipBg,
            style: charts.LineStyle.Dashed,
          },
          horzLine: {
            color: initialChartTheme.tickColor,
            labelBackgroundColor: initialChartTheme.tooltipBg,
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

      const resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current) return;
        chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      });
      resizeObserver.observe(containerRef.current);

      runtimeRef.current = {
        chart,
        charts,
        series: null,
        mode: null,
        resizeObserver,
      };
      applyChartData(runtimeRef.current, true);
    });

    return () => {
      disposed = true;
      if (runtimeRef.current) {
        runtimeRef.current.resizeObserver.disconnect();
        runtimeRef.current.chart.remove();
        runtimeRef.current = null;
      }
    };
  }, [chartTheme]); // Recreate only when the theme changes.

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const firstTimestamp = buckets[0]?.timestamp ?? 'none';
    const lastTimestamp = buckets[buckets.length - 1]?.timestamp ?? 'none';
    const fitKey = `${mode}:${bucketMs}:${buckets.length}:${firstTimestamp}:${lastTimestamp}`;
    const shouldFitContent = lastFitKeyRef.current !== fitKey;
    lastFitKeyRef.current = fitKey;
    applyChartData(runtime, shouldFitContent);
  }, [bucketMs, buckets, chartTheme, mode]);

  return (
    <div
      ref={containerRef}
      className={`${heightClassName} w-full overflow-hidden`}
      role="img"
      aria-label="Platform notional chart"
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
  const { series, isLoading, isFetching } = usePlatformVolumeSeries(bots, range);
  const selectedRange = PLATFORM_VOLUME_RANGES.find((item) => item.value === range) ?? PLATFORM_VOLUME_RANGES[2];
  const modeLabel = mode === 'bucket' ? selectedRange.bucketLabel : MODES.find((item) => item.value === mode)?.label ?? 'Volume';
  const buckets = series.buckets;
  const values = useMemo(() => buckets.map((bucket) => bucketValue(bucket, mode)), [buckets, mode]);
  const latestValue = values[values.length - 1] ?? 0;
  const hasVolume = series.summary.totalUsd > 0;
  const isCommand = variant === 'command';

  return (
    <section className={`${isCommand ? 'flex h-full flex-col' : 'mb-4'} overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/60 ${className}`}>
      <div className="flex flex-col gap-3 border-b border-arena-elements-dividerColor/60 px-4 py-3 sm:px-5 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
              Volume
            </h2>
            {isFetching && !isLoading && (
              <span
                className="i-ph:arrows-clockwise text-sm text-arena-elements-textTertiary animate-spin"
                aria-label="Refreshing volume"
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 2xl:justify-end">
          <div
            className="inline-flex rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/60 p-1"
            aria-label="Volume range"
            role="group"
          >
            {PLATFORM_VOLUME_RANGES.map((item) => {
              const selected = item.value === range;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setRange(item.value)}
                  className={`inline-flex h-8 items-center rounded-md px-3 font-data text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                    selected
                      ? 'bg-arena-elements-item-backgroundActive text-arena-elements-textPrimary'
                      : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                  }`}
                  aria-pressed={selected}
                >
                  {item.label}
                </button>
              );
            })}
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

      <div className={`grid gap-0 ${isCommand ? 'min-h-0 flex-1' : 'xl:grid-cols-[minmax(0,1fr)_220px]'}`}>
        <div className={`${isCommand ? 'flex min-h-0 flex-col' : 'min-h-[292px]'} p-4 sm:p-5`}>
          {isLoading ? (
            <Skeleton className={`${isCommand ? 'min-h-0 flex-1' : 'h-[260px]'} w-full`} />
          ) : hasVolume ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="mb-2 flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium text-arena-elements-textTertiary">
                    {modeLabel} (USD)
                  </div>
                  <div className="mt-1 font-data text-3xl font-bold tracking-tight text-arena-elements-textPrimary">
                    {formatUsd(latestValue)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-medium text-arena-elements-textTertiary">
                    Total
                  </div>
                  <div className="mt-1 font-data text-xl font-bold text-arena-elements-textPrimary">
                    {formatUsd(series.summary.totalUsd)}
                  </div>
                </div>
              </div>

              <PlatformVolumeTradingChart
                buckets={buckets}
                mode={mode}
                bucketMs={series.bucketMs}
                heightClassName={isCommand ? 'min-h-0 flex-1' : 'h-[222px]'}
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
        </aside>
      </div>
    </section>
  );
}
