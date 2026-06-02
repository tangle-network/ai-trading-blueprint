import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AreaData,
  CandlestickData,
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  MouseEventParams,
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

type AreaSeriesApi = ISeriesApi<'Area'>;
type CandleSeriesApi = ISeriesApi<'Candlestick'>;
type VolumeSeriesApi = ISeriesApi<'Histogram'>;
type MarkerApi = ISeriesMarkersPluginApi<Time>;

interface ChartRuntime {
  chart: IChartApi;
  mode: 'nav' | 'market';
  areaSeries?: AreaSeriesApi;
  navPaneSeries?: AreaSeriesApi;
  candleSeries?: CandleSeriesApi;
  volumeSeries?: VolumeSeriesApi;
  markerApi?: MarkerApi;
  startPriceLine?: IPriceLine;
  navPaneStartPriceLine?: IPriceLine;
}

const SYNTHETIC_TIME_BASE_SECONDS = 1_700_000_000;
const DENSE_MARKER_THRESHOLD = 16;
const DENSE_MARKER_BUCKET_TARGET = 10;
const TERMINAL_SURFACE = '#0f1a1f';
const TERMINAL_GRID = 'rgba(148, 158, 156, 0.085)';
const TERMINAL_TICK = '#949e9c';
const TERMINAL_TOOLTIP = 'rgba(15, 26, 31, 0.95)';
const TERMINAL_BORDER = 'rgba(39, 48, 53, 0.96)';
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
  markerPlacements: MarkerPlacement[],
): PreparedPoint[] {
  const preparedPoints = prepareBaseChartPoints(points);
  const existingTimes = new Set(preparedPoints.map((point) => point.time));

  for (const placement of markerPlacements) {
    const time = placement.time;
    if (time <= 0 || existingTimes.has(time)) continue;
    const timestampMs = time * 1000;

    existingTimes.add(time);
    preparedPoints.push({
      time,
      point: {
        label: markerTimeFormatter.format(new Date(timestampMs)),
        tooltipLabel: placement.count > 1
          ? `${placement.marker.text} x${placement.count}`
          : placement.marker.tooltip,
        value: estimateValueAtTimestamp(preparedPoints, timestampMs),
        timestampMs,
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
  const firstTime = marketTimes[0];
  const lastTime = marketTimes[marketTimes.length - 1];
  if (firstTime == null || lastTime == null) return null;
  const target = Math.floor(timestampMs / 1000);
  let low = 0;
  let high = marketTimes.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const time = marketTimes[middle];
    if (time === target) return time;
    if (time < target) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const previous = marketTimes[Math.max(0, high)] ?? firstTime;
  const next = marketTimes[Math.min(marketTimes.length - 1, low)] ?? lastTime;
  return Math.abs(previous - target) <= Math.abs(next - target) ? previous : next;
}

interface MarkerCandidate {
  marker: TradeChartMarker;
  time: UTCTimestamp;
}

interface MarkerPlacement {
  id: string;
  marker: TradeChartMarker;
  time: UTCTimestamp;
  count: number;
  members: TradeChartMarker[];
}

function markerSide(marker: TradeChartMarker): 'buy' | 'sell' | 'other' {
  if (marker.position === 'belowBar' || marker.shape === 'arrowUp') return 'buy';
  if (marker.position === 'aboveBar' || marker.shape === 'arrowDown') return 'sell';
  return 'other';
}

function placementId(marker: TradeChartMarker, time: UTCTimestamp, count: number): string {
  return `${marker.id}-${time}-${count}`;
}

function exactMarkerPlacements(candidates: MarkerCandidate[]): MarkerPlacement[] {
  const groups = new Map<string, MarkerPlacement>();

  for (const candidate of candidates) {
    const key = [
      candidate.time,
      candidate.marker.position,
      candidate.marker.shape,
      candidate.marker.color,
      candidate.marker.text,
    ].join(':');
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.members.push(candidate.marker);
      group.id = placementId(group.marker, group.time, group.count);
      continue;
    }
    groups.set(key, {
      id: placementId(candidate.marker, candidate.time, 1),
      marker: candidate.marker,
      time: candidate.time,
      count: 1,
      members: [candidate.marker],
    });
  }

  return Array.from(groups.values());
}

function denseMarkerPlacements(candidates: MarkerCandidate[]): MarkerPlacement[] {
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((left, right) => left.time - right.time);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return [];
  const minTime = first.time;
  const maxTime = last.time;
  const bucketCount = Math.min(
    DENSE_MARKER_BUCKET_TARGET,
    Math.max(1, Math.ceil(Math.sqrt(sorted.length))),
  );
  const bucketSpan = Math.max(1, Math.ceil((maxTime - minTime + 1) / bucketCount));
  const groups = new Map<string, MarkerCandidate[]>();

  for (const candidate of sorted) {
    const bucket = Math.floor((candidate.time - minTime) / bucketSpan);
    const key = `${bucket}:${markerSide(candidate.marker)}`;
    const group = groups.get(key);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  }

  return Array.from(groups.values()).map((group) => {
    const middle = group[Math.floor(group.length / 2)];
    if (!middle) throw new Error('Dense marker group unexpectedly empty');
    return {
      id: placementId(middle.marker, middle.time, group.length),
      marker: middle.marker,
      time: middle.time,
      count: group.length,
      members: group.map((candidate) => candidate.marker),
    };
  });
}

function markerPlacements(candidates: MarkerCandidate[], dense: boolean): MarkerPlacement[] {
  return (dense ? denseMarkerPlacements(candidates) : exactMarkerPlacements(candidates))
    .sort((left, right) => left.time - right.time);
}

function toMarkerLabel(marker: TradeChartMarker, count: number, dense: boolean): string {
  if (!dense) return count > 1 ? `${marker.text} x${count}` : marker.text;
  return '';
}

function toMarkerSize(count: number, dense: boolean, denseSingletonSize: number): number {
  if (!dense) return count > 1 ? 1.7 : 1.35;
  if (count === 1) return denseSingletonSize;
  return Math.min(1.55, 0.95 + Math.log2(count + 1) * 0.18);
}

function toSeriesMarkerPlacements(
  tradeMarkers: TradeChartMarker[],
): MarkerPlacement[] {
  const dense = tradeMarkers.length > DENSE_MARKER_THRESHOLD;
  const candidates = tradeMarkers
    .filter((marker) => Number.isFinite(marker.timestampMs))
    .map((marker) => ({
      marker,
      time: Math.floor(marker.timestampMs / 1000) as UTCTimestamp,
    }));

  return markerPlacements(candidates, dense);
}

function toMarketMarkerPlacements(
  tradeMarkers: TradeChartMarker[],
  marketCandles: MarketCandle[],
): MarkerPlacement[] {
  const dense = tradeMarkers.length > DENSE_MARKER_THRESHOLD;
  const marketTimes = marketCandles
    .map((candle) => Math.floor(candle.timestamp / 1000) as UTCTimestamp)
    .sort((left, right) => left - right);
  const candidates = tradeMarkers.flatMap((marker) => {
    const time = nearestMarketTime(marketTimes, marker.timestampMs);
    return time == null ? [] : [{ marker, time }];
  });

  return markerPlacements(candidates, dense);
}

function toSeriesMarkers(
  placements: MarkerPlacement[],
  {
    dense,
    denseSingletonSize,
    showLabels = true,
  }: {
    dense: boolean;
    denseSingletonSize: number;
    showLabels?: boolean;
  },
): Array<SeriesMarker<Time>> {
  return placements.map(({ id, marker, time, count }) => ({
    id,
    time,
    position: marker.position,
    shape: marker.shape,
    color: marker.color,
    text: showLabels ? toMarkerLabel(marker, count, dense) : '',
    size: toMarkerSize(count, dense, denseSingletonSize),
  }));
}

function markerPlacementDetail(placement: MarkerPlacement): string {
  const startTimestamp = Math.min(...placement.members.map((marker) => marker.timestampMs));
  const endTimestamp = Math.max(...placement.members.map((marker) => marker.timestampMs));
  const timeRange = startTimestamp === endTimestamp
    ? markerTimeFormatter.format(new Date(startTimestamp))
    : `${markerTimeFormatter.format(new Date(startTimestamp))} - ${markerTimeFormatter.format(new Date(endTimestamp))}`;
  const sample = placement.members
    .slice(0, 3)
    .map((marker) => marker.tooltip)
    .join(' · ');
  const remainder = placement.members.length > 3
    ? ` · +${placement.members.length - 3} more`
    : '';
  return `${timeRange} · ${sample}${remainder}`;
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
  const hasIntegratedNavPane = activeMode === 'market' && points.length > 0;
  const denseTradeMarkers = tradeMarkers.length > DENSE_MARKER_THRESHOLD;
  const navMarkerPlacements = useMemo(
    () => toSeriesMarkerPlacements(tradeMarkers),
    [tradeMarkers],
  );
  const preparedPoints = useMemo(
    () => prepareChartPoints(points, navMarkerPlacements),
    [navMarkerPlacements, points],
  );
  const latestPoint = preparedPoints[preparedPoints.length - 1]?.point ?? null;
  const firstPoint = preparedPoints[0]?.point ?? null;
  const positive = latestPoint && firstPoint ? latestPoint.value >= firstPoint.value : true;
  const lineColor = positive ? chartTheme.positive : chartTheme.negative;
  const fillTopColor = positive ? chartTheme.positiveGradientStart : chartTheme.negativeGradientStart;
  const chartMarkers = useMemo(
    () => toSeriesMarkers(navMarkerPlacements, {
      dense: denseTradeMarkers,
      denseSingletonSize: 0.72,
    }),
    [denseTradeMarkers, navMarkerPlacements],
  );
  const marketSeriesData = useMemo(
    () => toMarketSeriesData(marketCandles),
    [marketCandles],
  );
  const volumeSeriesData = useMemo(
    () => toVolumeSeriesData(marketCandles, chartTheme),
    [chartTheme, marketCandles],
  );
  const marketMarkerPlacements = useMemo(
    () => toMarketMarkerPlacements(tradeMarkers, marketCandles),
    [marketCandles, tradeMarkers],
  );
  const marketMarkers = useMemo(
    () => toSeriesMarkers(marketMarkerPlacements, {
      dense: denseTradeMarkers,
      denseSingletonSize: 0.78,
      showLabels: false,
    }),
    [denseTradeMarkers, marketMarkerPlacements],
  );
  const markerReadoutsById = useMemo(
    () => new Map(
      (activeMode === 'market' ? marketMarkerPlacements : navMarkerPlacements)
        .map((placement) => [placement.id, placement]),
    ),
    [activeMode, marketMarkerPlacements, navMarkerPlacements],
  );
  const navSeriesData = useMemo(() => toSeriesData(preparedPoints), [preparedPoints]);
  const runtimeRef = useRef<ChartRuntime | null>(null);
  const fitOnNextDataRef = useRef(false);
  const pointByTimeRef = useRef(new Map<string, PerformanceChartPoint>());
  const candleByTimeRef = useRef(new Map<string, MarketCandle>());
  const markerReadoutsByIdRef = useRef(new Map<string, MarkerPlacement>());
  const activeModeRef = useRef(activeMode);
  const marketLabelRef = useRef<string | null | undefined>(marketLabel);
  const firstMarketTimeRef = useRef<Time | undefined>(undefined);
  const lastMarketTimeRef = useRef<Time | undefined>(undefined);

  useEffect(() => {
    activeModeRef.current = activeMode;
    marketLabelRef.current = marketLabel;
    pointByTimeRef.current = new Map(preparedPoints.map((preparedPoint) => [
      String(preparedPoint.time),
      preparedPoint.point,
    ]));
    candleByTimeRef.current = new Map(marketCandles.map((candle) => [
      String(Math.floor(candle.timestamp / 1000)),
      candle,
    ]));
    markerReadoutsByIdRef.current = markerReadoutsById;
    firstMarketTimeRef.current = marketSeriesData[0]?.time;
    lastMarketTimeRef.current = marketSeriesData[marketSeriesData.length - 1]?.time;
  }, [activeMode, marketCandles, marketLabel, markerReadoutsById, marketSeriesData, preparedPoints]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (activeMode === 'nav' && preparedPoints.length === 0) return;
    if (activeMode === 'market' && marketSeriesData.length === 0) return;

    let cancelled = false;
    let crosshairHandler: ((param: MouseEventParams<Time>) => void) | null = null;

    void loadLightweightCharts().then((charts) => {
      if (cancelled || !containerRef.current) return;

      const chart = charts.createChart(containerRef.current, {
        autoSize: true,
        height: containerRef.current.clientHeight || 520,
        layout: {
          background: { type: charts.ColorType.Solid, color: TERMINAL_SURFACE },
          textColor: TERMINAL_TICK,
          attributionLogo: false,
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        grid: {
          vertLines: { color: 'transparent' },
          horzLines: { color: TERMINAL_GRID },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.08, bottom: activeMode === 'market' ? 0.2 : 0.14 },
        },
        timeScale: {
          borderVisible: false,
          rightOffset: activeMode === 'market' ? 7 : 5,
          barSpacing: activeMode === 'market'
            ? marketSeriesData.length < 20 ? 16 : 8
            : preparedPoints.length < 3 ? 72 : 11,
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: Time) => {
            if (activeModeRef.current === 'market' && (time === firstMarketTimeRef.current || time === lastMarketTimeRef.current)) {
              return '';
            }
            const key = timeKey(time);
            const navPoint = pointByTimeRef.current.get(key);
            if (navPoint) return navPoint.label;
            const candle = candleByTimeRef.current.get(key);
            return candle ? markerTimeFormatter.format(new Date(candle.timestamp)) : '';
          },
        },
        crosshair: {
          mode: charts.CrosshairMode.Magnet,
          vertLine: {
            color: 'rgba(148, 158, 156, 0.48)',
            labelBackgroundColor: TERMINAL_TOOLTIP,
            style: charts.LineStyle.Dashed,
          },
          horzLine: {
            color: 'rgba(148, 158, 156, 0.38)',
            labelBackgroundColor: TERMINAL_TOOLTIP,
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

      let runtime: ChartRuntime;
      if (activeMode === 'market') {
        const navPane = navSeriesData.length > 0 ? chart.addPane() : null;
        if (navPane) {
          chart.panes()[0]?.setStretchFactor(0.76);
          navPane.setStretchFactor(0.24);
        }
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
        const navPaneSeries = navPane
          ? chart.addSeries(charts.AreaSeries, {
              lineColor,
              topColor: fillTopColor,
              bottomColor: chartTheme.gradientEnd,
              lineWidth: 1,
              crosshairMarkerVisible: true,
              crosshairMarkerRadius: 3,
              crosshairMarkerBorderColor: chartTheme.hoverBorderColor,
              crosshairMarkerBackgroundColor: lineColor,
              lastValueVisible: false,
              priceLineVisible: false,
            }, navPane.paneIndex())
          : undefined;
        const markerApi = charts.createSeriesMarkers(candleSeries, [], {
          autoScale: true,
        });
        runtime = {
          chart,
          mode: 'market',
          candleSeries,
          volumeSeries,
          navPaneSeries,
          markerApi,
        };
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
        const markerApi = charts.createSeriesMarkers(areaSeries, [], {
          autoScale: true,
        });
        runtime = {
          chart,
          mode: 'nav',
          areaSeries,
          markerApi,
        };
      }

      runtimeRef.current = runtime;
      fitOnNextDataRef.current = true;

      if (runtime.mode === 'market' && runtime.candleSeries && runtime.volumeSeries) {
        runtime.candleSeries.setData(marketSeriesData);
        runtime.volumeSeries.setData(volumeSeriesData);
        if (runtime.navPaneSeries) {
          runtime.navPaneSeries.setData(navSeriesData);
          if (navSeriesData.length > 1) {
            runtime.navPaneStartPriceLine = runtime.navPaneSeries.createPriceLine({
              price: navSeriesData[0].value,
              color: TERMINAL_TICK,
              lineWidth: 1,
              lineStyle: charts.LineStyle.Dashed,
              axisLabelVisible: false,
              title: 'NAV',
            });
          }
        }
        runtime.markerApi?.setMarkers(marketMarkers);
        chart.timeScale().fitContent();
        fitOnNextDataRef.current = false;
      }

      if (runtime.mode === 'nav' && runtime.areaSeries) {
        runtime.areaSeries.setData(navSeriesData);
        runtime.markerApi?.setMarkers(chartMarkers);
        if (navSeriesData.length > 1) {
          runtime.startPriceLine = runtime.areaSeries.createPriceLine({
            price: navSeriesData[0].value,
            color: TERMINAL_TICK,
            lineWidth: 1,
            lineStyle: charts.LineStyle.Dashed,
            axisLabelVisible: false,
            title: 'NAV',
          });
        }
        chart.timeScale().fitContent();
        fitOnNextDataRef.current = false;
      }

      crosshairHandler = (param: MouseEventParams<Time>) => {
        if (!param.time) {
          setHoverReadout(null);
          return;
        }

        const hoveredObjectId = (param as {
          hoveredObjectId?: string;
          hoveredInfo?: { objectId?: string };
        }).hoveredInfo?.objectId ?? (param as { hoveredObjectId?: string }).hoveredObjectId;
        const markerPlacement = hoveredObjectId ? markerReadoutsByIdRef.current.get(hoveredObjectId) : null;
        if (markerPlacement) {
          const placementKey = String(markerPlacement.time);
          const candle = candleByTimeRef.current.get(placementKey);
          const point = pointByTimeRef.current.get(placementKey);
          const value = activeModeRef.current === 'market'
            ? candle?.close
            : point?.value;
          if (value != null) {
            setHoverReadout({
              label: markerPlacement.count > 1
                ? `${markerPlacement.marker.text} x${markerPlacement.count}`
                : markerPlacement.marker.tooltip,
              value,
              detail: markerPlacementDetail(markerPlacement),
            });
            return;
          }
        }

        const key = timeKey(param.time);
        if (activeModeRef.current === 'market') {
          const candle = candleByTimeRef.current.get(key);
          if (!candle) {
            setHoverReadout(null);
            return;
          }
          setHoverReadout({
            label: marketLabelRef.current ?? candle.token,
            value: candle.close,
            detail: formatMarketReadout(candle),
          });
          return;
        }

        const point = pointByTimeRef.current.get(key);
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
    });

    return () => {
      cancelled = true;
      const runtime = runtimeRef.current;
      if (runtime?.mode === activeMode) {
        if (crosshairHandler) runtime.chart.unsubscribeCrosshairMove(crosshairHandler);
        runtime.markerApi?.detach();
        runtime.chart.remove();
        runtimeRef.current = null;
      }
    };
  }, [
    activeMode,
    chartTheme.gradientEnd,
    chartTheme.hoverBorderColor,
    chartTheme.negative,
    chartTheme.positive,
    fillTopColor,
    hasIntegratedNavPane,
    lineColor,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.mode !== 'nav' || !runtime.areaSeries) return;
    if (navSeriesData.length === 0) return;

    runtime.areaSeries.applyOptions({
      lineColor,
      topColor: fillTopColor,
      bottomColor: chartTheme.gradientEnd,
      crosshairMarkerBorderColor: chartTheme.hoverBorderColor,
      crosshairMarkerBackgroundColor: lineColor,
      priceLineColor: lineColor,
    });
    runtime.areaSeries.setData(navSeriesData);
    runtime.markerApi?.setMarkers(chartMarkers);

    if (runtime.startPriceLine) {
      runtime.areaSeries.removePriceLine(runtime.startPriceLine);
      runtime.startPriceLine = undefined;
    }
    if (navSeriesData.length > 1) {
      runtime.startPriceLine = runtime.areaSeries.createPriceLine({
        price: navSeriesData[0].value,
        color: TERMINAL_TICK,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: 'NAV',
      });
    }

    if (fitOnNextDataRef.current) {
      runtime.chart.timeScale().fitContent();
      fitOnNextDataRef.current = false;
    }
  }, [
    activeMode,
    chartMarkers,
    chartTheme.gradientEnd,
    chartTheme.hoverBorderColor,
    fillTopColor,
    lineColor,
    navSeriesData,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.mode !== 'market' || !runtime.candleSeries || !runtime.volumeSeries) return;
    if (marketSeriesData.length === 0) return;

    runtime.candleSeries.applyOptions({
      upColor: chartTheme.positive,
      downColor: chartTheme.negative,
      borderUpColor: chartTheme.positive,
      borderDownColor: chartTheme.negative,
      wickUpColor: chartTheme.positive,
      wickDownColor: chartTheme.negative,
      priceLineColor: marketSeriesData[marketSeriesData.length - 1].close >= marketSeriesData[0].open
        ? chartTheme.positive
        : chartTheme.negative,
    });
    runtime.candleSeries.setData(marketSeriesData);
    runtime.volumeSeries.setData(volumeSeriesData);
    if (runtime.navPaneSeries) {
      runtime.navPaneSeries.applyOptions({
        lineColor,
        topColor: fillTopColor,
        bottomColor: chartTheme.gradientEnd,
        crosshairMarkerBorderColor: chartTheme.hoverBorderColor,
        crosshairMarkerBackgroundColor: lineColor,
      });
      runtime.navPaneSeries.setData(navSeriesData);

      if (runtime.navPaneStartPriceLine) {
        runtime.navPaneSeries.removePriceLine(runtime.navPaneStartPriceLine);
        runtime.navPaneStartPriceLine = undefined;
      }
      if (navSeriesData.length > 1) {
        runtime.navPaneStartPriceLine = runtime.navPaneSeries.createPriceLine({
          price: navSeriesData[0].value,
          color: TERMINAL_TICK,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: false,
          title: 'NAV',
        });
      }
    }
    runtime.markerApi?.setMarkers(marketMarkers);

    if (fitOnNextDataRef.current) {
      runtime.chart.timeScale().fitContent();
      fitOnNextDataRef.current = false;
    }
  }, [
    activeMode,
    chartTheme.gradientEnd,
    chartTheme.hoverBorderColor,
    chartTheme.negative,
    chartTheme.positive,
    fillTopColor,
    lineColor,
    marketMarkers,
    marketSeriesData,
    navSeriesData,
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
    <div className="relative h-full min-h-[320px] w-full overflow-hidden bg-[#0f1a1f]" data-testid="tradingview-performance-chart">
      <div ref={containerRef} className="absolute inset-0" />
      {readout && (
        <div
          className="pointer-events-none absolute left-3 top-3 rounded-md border px-3 py-2 shadow-[0_18px_40px_rgba(0,0,0,0.32)]"
          style={{ background: TERMINAL_TOOLTIP, borderColor: TERMINAL_BORDER }}
        >
          <div className="font-data text-[11px] text-[#949e9c]">
            {readout.label}
          </div>
          <div className="mt-0.5 font-data text-xl font-semibold tabular-nums text-[#f6fefd]">
            {formatAxisCurrency(readout.value)}
          </div>
          {readout.detail && (
            <div className="mt-1 font-data text-[11px] text-[#949e9c]">
              {readout.detail}
            </div>
          )}
        </div>
      )}
      {activeMode === 'market' && navSeriesData.length > 0 && (
        <div
          className="pointer-events-none absolute bottom-2 left-3 rounded-sm border px-2 py-0.5 font-data text-[10px] font-semibold text-[#949e9c]"
          style={{ background: 'rgba(15, 26, 31, 0.78)', borderColor: TERMINAL_BORDER }}
        >
          NAV
        </div>
      )}
    </div>
  );
}
