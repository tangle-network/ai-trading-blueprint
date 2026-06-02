import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AreaData,
  CandlestickData,
  HistogramData,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import { formatNumber } from '~/lib/format';
import type { useChartTheme } from '~/lib/hooks/useChartTheme';
import type { MarketCandle } from '~/lib/hooks/useBotApi';
import { loadLightweightCharts } from './lightweightChartRuntime';
import type { PerformanceChartPoint } from './performanceChart';

type ChartTheme = ReturnType<typeof useChartTheme>;

export interface TradeChartMarker {
  id: string;
  timestampMs: number;
  tooltip: string;
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  position: 'aboveBar' | 'belowBar' | 'inBar';
  text: string;
}

interface TradingPerformanceChartProps {
  points: PerformanceChartPoint[];
  tradeMarkers: TradeChartMarker[];
  chartTheme: ChartTheme;
  mode?: 'nav' | 'market';
  marketCandles?: MarketCandle[];
  marketLabel?: string | null;
}

interface PreparedPoint {
  point: PerformanceChartPoint;
  time: UTCTimestamp;
}

interface HoverReadout {
  label: string;
  value: number;
  detail?: string;
}

const SYNTHETIC_TIME_BASE_SECONDS = 1_700_000_000;
const DENSE_MARKER_THRESHOLD = 32;
const markerTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatAxisCurrency(value: number): string {
  return `$${formatNumber(value, { maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
}

function timeKey(time: Time): string {
  if (typeof time === 'number') return String(time);
  if (typeof time === 'string') return time;
  return `${time.year}-${time.month}-${time.day}`;
}

function prepareBaseChartPoints(points: PerformanceChartPoint[]): PreparedPoint[] {
  let lastTimestamp = 0;

  return points.map((point, index) => {
    const rawTimestamp = point.timestampMs != null
      ? Math.floor(point.timestampMs / 1000)
      : SYNTHETIC_TIME_BASE_SECONDS + index;
    const timestamp = Math.max(rawTimestamp, lastTimestamp + 1);
    lastTimestamp = timestamp;

    return {
      point,
      time: timestamp as UTCTimestamp,
    };
  });
}

function estimateValueAtTimestamp(preparedPoints: PreparedPoint[], timestampMs: number): number {
  if (preparedPoints.length === 0) return 0;
  const timestampSeconds = timestampMs / 1000;
  const sortedPoints = [...preparedPoints].sort((left, right) => left.time - right.time);
  const firstPoint = sortedPoints[0];
  const lastPoint = sortedPoints[sortedPoints.length - 1];

  if (timestampSeconds <= firstPoint.time) return firstPoint.point.value;
  if (timestampSeconds >= lastPoint.time) return lastPoint.point.value;

  for (let index = 1; index < sortedPoints.length; index += 1) {
    const previous = sortedPoints[index - 1];
    const next = sortedPoints[index];
    if (timestampSeconds > next.time) continue;

    const span = next.time - previous.time;
    if (span <= 0) return previous.point.value;

    const progress = (timestampSeconds - previous.time) / span;
    return previous.point.value + (next.point.value - previous.point.value) * progress;
  }

  return lastPoint.point.value;
}

function prepareChartPoints(
  points: PerformanceChartPoint[],
  tradeMarkers: TradeChartMarker[],
): PreparedPoint[] {
  const preparedPoints = prepareBaseChartPoints(points);
  const existingTimes = new Set(preparedPoints.map((point) => point.time));

  for (const marker of tradeMarkers) {
    if (!Number.isFinite(marker.timestampMs)) continue;
    const time = Math.floor(marker.timestampMs / 1000) as UTCTimestamp;
    if (time <= 0 || existingTimes.has(time)) continue;

    existingTimes.add(time);
    preparedPoints.push({
      time,
      point: {
        label: markerTimeFormatter.format(new Date(marker.timestampMs)),
        tooltipLabel: marker.tooltip,
        value: estimateValueAtTimestamp(preparedPoints, marker.timestampMs),
        timestampMs: marker.timestampMs,
        kind: 'snapshot',
      },
    });
  }

  return preparedPoints.sort((left, right) => left.time - right.time);
}

function toSeriesData(preparedPoints: PreparedPoint[]): AreaData<Time>[] {
  return preparedPoints.map(({ point, time }) => ({
    time,
    value: point.value,
  }));
}

function toMarketSeriesData(candles: MarketCandle[]): CandlestickData<Time>[] {
  return candles.map((candle) => ({
    time: Math.floor(candle.timestamp / 1000) as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }));
}

function toVolumeSeriesData(candles: MarketCandle[], chartTheme: ChartTheme): HistogramData<Time>[] {
  return candles.map((candle) => ({
    time: Math.floor(candle.timestamp / 1000) as UTCTimestamp,
    value: candle.volume,
    color: candle.close >= candle.open
      ? `${chartTheme.positive}55`
      : `${chartTheme.negative}55`,
  }));
}

function nearestMarketTime(marketTimes: UTCTimestamp[], timestampMs: number): UTCTimestamp | null {
  if (marketTimes.length === 0 || !Number.isFinite(timestampMs)) return null;
  const target = Math.floor(timestampMs / 1000);
  let nearest = marketTimes[0];
  let bestDistance = Math.abs(nearest - target);

  for (const time of marketTimes) {
    const distance = Math.abs(time - target);
    if (distance >= bestDistance) continue;
    nearest = time;
    bestDistance = distance;
  }

  return nearest;
}

function toSeriesMarkers(
  tradeMarkers: TradeChartMarker[],
): Array<SeriesMarker<Time>> {
  const dense = tradeMarkers.length > DENSE_MARKER_THRESHOLD;
  const groups = new Map<string, { marker: TradeChartMarker; time: UTCTimestamp; count: number }>();

  for (const marker of tradeMarkers) {
    if (!Number.isFinite(marker.timestampMs)) continue;
    const time = Math.floor(marker.timestampMs / 1000) as UTCTimestamp;
    const key = `${time}:${marker.position}:${marker.shape}:${marker.color}:${marker.text}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      continue;
    }
    groups.set(key, { marker, time, count: 1 });
  }

  return Array.from(groups.values())
    .sort((left, right) => left.time - right.time)
    .map(({ marker, time, count }) => ({
      id: `${marker.id}-${time}-${count}`,
      time,
      position: marker.position,
      shape: marker.shape,
      color: marker.color,
      text: dense && count === 1 ? '' : count > 1 ? `${marker.text} x${count}` : marker.text,
      size: dense ? count > 1 ? 1.25 : 0.78 : count > 1 ? 1.7 : 1.35,
    }));
}

function toMarketSeriesMarkers(
  tradeMarkers: TradeChartMarker[],
  marketCandles: MarketCandle[],
): Array<SeriesMarker<Time>> {
  const dense = tradeMarkers.length > DENSE_MARKER_THRESHOLD;
  const marketTimes = marketCandles.map((candle) =>
    Math.floor(candle.timestamp / 1000) as UTCTimestamp);
  const groups = new Map<string, { marker: TradeChartMarker; time: UTCTimestamp; count: number }>();

  for (const marker of tradeMarkers) {
    const time = nearestMarketTime(marketTimes, marker.timestampMs);
    if (time == null) continue;
    const key = `${time}:${marker.position}:${marker.shape}:${marker.color}:${marker.text}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      continue;
    }
    groups.set(key, { marker, time, count: 1 });
  }

  return Array.from(groups.values())
    .sort((left, right) => left.time - right.time)
    .map(({ marker, time, count }) => ({
      id: `${marker.id}-${time}-${count}`,
      time,
      position: marker.position,
      shape: marker.shape,
      color: marker.color,
      text: dense && count === 1 ? '' : count > 1 ? `${marker.text} x${count}` : marker.text,
      size: dense ? count > 1 ? 1.3 : 0.82 : count > 1 ? 1.8 : 1.45,
    }));
}

function formatMarketReadout(candle: MarketCandle): string {
  return `O ${formatAxisCurrency(candle.open)}  H ${formatAxisCurrency(candle.high)}  L ${formatAxisCurrency(candle.low)}`;
}

export function TradingPerformanceChart({
  points,
  tradeMarkers,
  chartTheme,
  mode = 'nav',
  marketCandles = [],
  marketLabel,
}: TradingPerformanceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverReadout, setHoverReadout] = useState<HoverReadout | null>(null);
  const activeMode = mode === 'market' && marketCandles.length > 0 ? 'market' : 'nav';
  const preparedPoints = useMemo(
    () => prepareChartPoints(points, tradeMarkers),
    [points, tradeMarkers],
  );
  const latestPoint = preparedPoints[preparedPoints.length - 1]?.point ?? null;
  const firstPoint = preparedPoints[0]?.point ?? null;
  const positive = latestPoint && firstPoint ? latestPoint.value >= firstPoint.value : true;
  const lineColor = positive ? chartTheme.positive : chartTheme.negative;
  const fillTopColor = positive ? chartTheme.positiveGradientStart : chartTheme.negativeGradientStart;
  const chartMarkers = useMemo(
    () => toSeriesMarkers(tradeMarkers),
    [tradeMarkers],
  );
  const marketSeriesData = useMemo(
    () => toMarketSeriesData(marketCandles),
    [marketCandles],
  );
  const volumeSeriesData = useMemo(
    () => toVolumeSeriesData(marketCandles, chartTheme),
    [chartTheme, marketCandles],
  );
  const marketMarkers = useMemo(
    () => toMarketSeriesMarkers(tradeMarkers, marketCandles),
    [marketCandles, tradeMarkers],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    if (activeMode === 'nav' && preparedPoints.length === 0) return;
    if (activeMode === 'market' && marketSeriesData.length === 0) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void loadLightweightCharts().then((charts) => {
      if (cancelled || !containerRef.current) return;

      const data = toSeriesData(preparedPoints);
      const pointByTime = new Map(preparedPoints.map((preparedPoint) => [
        String(preparedPoint.time),
        preparedPoint.point,
      ]));
      const candleByTime = new Map(marketCandles.map((candle) => [
        String(Math.floor(candle.timestamp / 1000)),
        candle,
      ]));
      const chart = charts.createChart(containerRef.current, {
        autoSize: true,
        height: containerRef.current.clientHeight || 520,
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
          scaleMargins: { top: 0.14, bottom: 0.18 },
        },
        timeScale: {
          borderVisible: false,
          rightOffset: 6,
          barSpacing: activeMode === 'market'
            ? marketSeriesData.length < 20 ? 18 : 9
            : preparedPoints.length < 3 ? 80 : 12,
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: Time) => {
            const key = timeKey(time);
            const navPoint = pointByTime.get(key);
            if (navPoint) return navPoint.label;
            const candle = candleByTime.get(key);
            return candle ? markerTimeFormatter.format(new Date(candle.timestamp)) : '';
          },
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
          priceFormatter: formatAxisCurrency,
        },
      });

      if (activeMode === 'market') {
        const candleSeries = chart.addSeries(charts.CandlestickSeries, {
          upColor: chartTheme.positive,
          downColor: chartTheme.negative,
          borderUpColor: chartTheme.positive,
          borderDownColor: chartTheme.negative,
          wickUpColor: chartTheme.positive,
          wickDownColor: chartTheme.negative,
          lastValueVisible: true,
          priceLineVisible: true,
          priceLineColor: marketSeriesData[marketSeriesData.length - 1].close >= marketSeriesData[0].open
            ? chartTheme.positive
            : chartTheme.negative,
          priceLineWidth: 1,
          priceLineStyle: charts.LineStyle.Dashed,
        });
        const volumeSeries = chart.addSeries(charts.HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          lastValueVisible: false,
          priceLineVisible: false,
        });
        chart.priceScale('volume').applyOptions({
          scaleMargins: { top: 0.82, bottom: 0 },
          borderVisible: false,
        });
        candleSeries.setData(marketSeriesData);
        volumeSeries.setData(volumeSeriesData);
        charts.createSeriesMarkers(candleSeries, marketMarkers, {
          autoScale: true,
        });
      } else {
        const areaSeries = chart.addSeries(charts.AreaSeries, {
          lineColor,
          topColor: fillTopColor,
          bottomColor: chartTheme.gradientEnd,
          lineWidth: 2,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 5,
          crosshairMarkerBorderColor: chartTheme.hoverBorderColor,
          crosshairMarkerBackgroundColor: lineColor,
          lastPriceAnimation: charts.LastPriceAnimationMode.OnDataUpdate,
          lastValueVisible: true,
          priceLineVisible: true,
          priceLineColor: lineColor,
          priceLineWidth: 1,
          priceLineStyle: charts.LineStyle.Dashed,
        });

        areaSeries.setData(data);
        charts.createSeriesMarkers(areaSeries, chartMarkers, {
          autoScale: true,
        });

        if (data.length > 1) {
          areaSeries.createPriceLine({
            price: data[0].value,
            color: chartTheme.tickColor,
            lineWidth: 1,
            lineStyle: charts.LineStyle.Dashed,
            axisLabelVisible: false,
            title: 'Start NAV',
          });
        }
      }

      chart.timeScale().fitContent();

      const crosshairHandler = (param: Parameters<typeof chart.subscribeCrosshairMove>[0] extends (value: infer T) => void ? T : never) => {
        if (!param.time) {
          setHoverReadout(null);
          return;
        }

        const key = timeKey(param.time);
        if (activeMode === 'market') {
          const candle = candleByTime.get(key);
          if (!candle) {
            setHoverReadout(null);
            return;
          }
          setHoverReadout({
            label: marketLabel ?? candle.token,
            value: candle.close,
            detail: formatMarketReadout(candle),
          });
          return;
        }

        const point = pointByTime.get(key);
        if (!point) {
          setHoverReadout(null);
          return;
        }

        setHoverReadout({
          label: point.tooltipLabel,
          value: point.value,
        });
      };

      chart.subscribeCrosshairMove(crosshairHandler);

      cleanup = () => {
        chart.unsubscribeCrosshairMove(crosshairHandler);
        chart.remove();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [
    activeMode,
    chartMarkers,
    chartTheme.gradientEnd,
    chartTheme.gridColor,
    chartTheme.hoverBorderColor,
    chartTheme.tickColor,
    chartTheme.tooltipBg,
    fillTopColor,
    lineColor,
    marketCandles,
    marketLabel,
    marketMarkers,
    marketSeriesData,
    preparedPoints,
    volumeSeriesData,
  ]);

  const latestMarketCandle = marketCandles[marketCandles.length - 1] ?? null;
  const readout = hoverReadout ?? (activeMode === 'market' && latestMarketCandle
    ? {
        label: marketLabel ?? latestMarketCandle.token,
        value: latestMarketCandle.close,
        detail: formatMarketReadout(latestMarketCandle),
      }
    : latestPoint
      ? {
          label: latestPoint.tooltipLabel,
          value: latestPoint.value,
        }
      : null);

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-lg" data-testid="tradingview-performance-chart">
      <div ref={containerRef} className="absolute inset-0" />
      {readout && (
        <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/88 px-3 py-2 shadow-[0_12px_34px_rgba(0,0,0,0.22)] backdrop-blur">
          <div className="font-data text-[11px] uppercase tracking-wider text-arena-elements-textTertiary">
            {readout.label}
          </div>
          <div className="mt-1 font-data text-xl font-bold text-arena-elements-textPrimary">
            {formatAxisCurrency(readout.value)}
          </div>
          {readout.detail && (
            <div className="mt-1 font-data text-[11px] text-arena-elements-textSecondary">
              {readout.detail}
            </div>
          )}
        </div>
      )}
      <a
        href="https://www.tradingview.com/lightweight-charts/"
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-2 right-3 rounded-sm bg-arena-elements-background-depth-1/45 px-1.5 py-0.5 font-data text-[9px] uppercase tracking-wider text-arena-elements-textTertiary/70 transition-colors hover:text-arena-elements-textPrimary"
      >
        Charts by TradingView
      </a>
    </div>
  );
}
