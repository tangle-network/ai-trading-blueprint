import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AreaData,
  CandlestickData,
  Coordinate,
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LineData,
  MouseEventParams,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import { formatNumber } from '~/lib/format';
import type { useChartTheme } from '~/lib/hooks/useChartTheme';
import type { ChartStudy, MarketCandle } from '~/lib/hooks/useBotApi';
import type { FillCountEvidence } from '~/lib/tradeEvidence';
import { loadLightweightCharts } from './lightweightChartRuntime';
import type { PerformanceChartPoint } from './performanceChart';

type ChartTheme = ReturnType<typeof useChartTheme>;

export interface TradeChartMarker {
  id: string;
  timestampMs: number;
  executionPriceUsd?: number | null;
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
  marketDataCoverage?: MarketDataCoverage | null;
  chartStudies?: ChartStudy[];
  fillCountEvidence?: FillCountEvidence | null;
}

interface PreparedPoint {
  point: PerformanceChartPoint;
  time: UTCTimestamp;
}

export interface MarketDataCoverage {
  sourceLabel: string;
  requestedRangeLabel: string;
  requestedFromMs: number;
  requestedToMs: number;
  botCreatedAtMs?: number | null;
}

interface HoverReadout {
  label: string;
  value: number;
  detail?: string;
}

type AreaSeriesApi = ISeriesApi<'Area'>;
type CandleSeriesApi = ISeriesApi<'Candlestick'>;
type LineSeriesApi = ISeriesApi<'Line'>;
type VolumeSeriesApi = ISeriesApi<'Histogram'>;
type MarkerApi = ISeriesMarkersPluginApi<Time>;
type MarketStudyId = 'vwap' | 'sma20' | 'sma50' | 'bb20';
type StudyLineId = 'vwap' | 'sma20' | 'sma50' | 'bbUpper' | 'bbLower';

interface ChartRuntime {
  chart: IChartApi;
  mode: 'nav' | 'market';
  areaSeries?: AreaSeriesApi;
  navPaneSeries?: AreaSeriesApi;
  candleSeries?: CandleSeriesApi;
  volumeSeries?: VolumeSeriesApi;
  studySeries?: Partial<Record<StudyLineId, LineSeriesApi>>;
  agentStudySeries?: LineSeriesApi[];
  markerApi?: MarkerApi;
  startPriceLine?: IPriceLine;
  navPaneStartPriceLine?: IPriceLine;
}

const SYNTHETIC_TIME_BASE_SECONDS = 1_700_000_000;
const DENSE_MARKER_THRESHOLD = 16;
const DENSE_MARKER_BUCKET_TARGET = 10;
const MARKET_MARKER_MIN_TOLERANCE_SECONDS = 90;
const MARKET_AXIS_DATE_THRESHOLD_MS = 20 * 60 * 60 * 1000;
const MARKET_AXIS_DAY_ONLY_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000;
const MARKET_AXIS_EDGE_SUPPRESSION_MIN_MS = 8 * 60 * 1000;
const MARKET_AXIS_EDGE_SUPPRESSION_MAX_MS = 6 * 60 * 60 * 1000;
const MARKET_AXIS_EDGE_SUPPRESSION_RANGE_FRACTION = 0.005;
const DEFAULT_MARKET_STUDIES: Record<MarketStudyId, boolean> = {
  vwap: true,
  sma20: true,
  sma50: false,
  bb20: false,
};
const MARKET_STUDY_CONTROLS: Array<{ id: MarketStudyId; label: string; lineIds: StudyLineId[] }> = [
  { id: 'vwap', label: 'VWAP', lineIds: ['vwap'] },
  { id: 'sma20', label: 'SMA 20', lineIds: ['sma20'] },
  { id: 'sma50', label: 'SMA 50', lineIds: ['sma50'] },
  { id: 'bb20', label: 'BB 20', lineIds: ['bbUpper', 'bbLower'] },
];
const AGENT_STUDY_SERIES_CAP = 8;
const STUDY_LINE_COLORS: Record<StudyLineId, string> = {
  vwap: '#B788FF',
  sma20: '#F2B84B',
  sma50: '#6EA8FF',
  bbUpper: '#8C96A3',
  bbLower: '#8C96A3',
};
const AGENT_STUDY_COLORS = ['#B788FF', '#F2B84B', '#6EA8FF', '#50D2C1', '#ED7088', '#9CA3AF'];
const markerTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const compactCandleTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});
const compactCandleDayFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});
const coverageTimeFormatter = new Intl.DateTimeFormat('en-US', {
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

function timestampMsFromChartTime(time: Time | undefined): number | null {
  if (time == null) return null;
  if (typeof time === 'number') return time * 1000;
  if (typeof time === 'string') {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return Date.UTC(time.year, time.month - 1, time.day);
}

function timeRangeMs(first: Time | undefined, last: Time | undefined): number {
  const firstTimestamp = timestampMsFromChartTime(first);
  const lastTimestamp = timestampMsFromChartTime(last);
  if (firstTimestamp == null || lastTimestamp == null) return 0;
  return Math.max(0, lastTimestamp - firstTimestamp);
}

function shouldSuppressChartEdgeTick(time: Time, first: Time | undefined, last: Time | undefined): boolean {
  const timestamp = timestampMsFromChartTime(time);
  const firstTimestamp = timestampMsFromChartTime(first);
  const lastTimestamp = timestampMsFromChartTime(last);
  if (timestamp == null || firstTimestamp == null || lastTimestamp == null || lastTimestamp <= firstTimestamp) {
    return false;
  }
  const rangeMs = lastTimestamp - firstTimestamp;
  const thresholdMs = Math.min(
    MARKET_AXIS_EDGE_SUPPRESSION_MAX_MS,
    Math.max(MARKET_AXIS_EDGE_SUPPRESSION_MIN_MS, rangeMs * MARKET_AXIS_EDGE_SUPPRESSION_RANGE_FRACTION),
  );
  return timestamp - firstTimestamp <= thresholdMs || lastTimestamp - timestamp <= thresholdMs;
}

function formatCandleDateTick(timestamp: number, rangeMs: number, lastTimestampMs: number | null): string {
  const date = new Date(timestamp);
  const isDayBoundary = date.getHours() === 0 && date.getMinutes() === 0;
  const isTailIntradayTick = lastTimestampMs != null && lastTimestampMs - timestamp < 24 * 60 * 60 * 1000;
  if (isTailIntradayTick && !isDayBoundary) {
    return compactCandleTimeFormatter.format(date);
  }
  if (rangeMs >= MARKET_AXIS_DAY_ONLY_THRESHOLD_MS) {
    return compactCandleDayFormatter.format(date);
  }
  if (isDayBoundary) return compactCandleDayFormatter.format(date);
  return compactCandleTimeFormatter.format(date);
}

function formatCandleAxisTick(timestamp: number, rangeMs = 0, lastTimestampMs: number | null = null): string {
  const date = new Date(timestamp);
  if (rangeMs >= MARKET_AXIS_DATE_THRESHOLD_MS) {
    return formatCandleDateTick(timestamp, rangeMs, lastTimestampMs);
  }
  if (date.getHours() === 0 && date.getMinutes() === 0) {
    return compactCandleDayFormatter.format(date);
  }
  return compactCandleTimeFormatter.format(date);
}

function formatNavAxisTick(
  point: PerformanceChartPoint,
  rangeMs = 0,
  lastTimestampMs: number | null = null,
): string {
  if (point.kind === 'live_nav') return 'Live';
  if (point.timestampMs != null) return formatCandleAxisTick(point.timestampMs, rangeMs, lastTimestampMs);
  return point.label.length <= 8 ? point.label : '';
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

function toStudyPoint(candle: MarketCandle, value: number): LineData<Time> {
  return {
    time: Math.floor(candle.timestamp / 1000) as UTCTimestamp,
    value,
  };
}

function rollingAverageSeries(candles: MarketCandle[], period: number): LineData<Time>[] {
  if (candles.length < period) return [];

  const result: LineData<Time>[] = [];
  let rollingSum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    rollingSum += candle.close;
    if (index >= period) {
      rollingSum -= candles[index - period].close;
    }
    if (index >= period - 1) {
      result.push(toStudyPoint(candle, rollingSum / period));
    }
  }

  return result;
}

function vwapSeries(candles: MarketCandle[]): LineData<Time>[] {
  const result: LineData<Time>[] = [];
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const volume = Math.max(0, candle.volume);
    if (volume <= 0) continue;
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typicalPrice * volume;
    cumulativeVolume += volume;
    if (cumulativeVolume > 0) {
      result.push(toStudyPoint(candle, cumulativePriceVolume / cumulativeVolume));
    }
  }

  return result;
}

function bollingerSeries(
  candles: MarketCandle[],
  period = 20,
  deviations = 2,
): { upper: LineData<Time>[]; lower: LineData<Time>[] } {
  if (candles.length < period) return { upper: [], lower: [] };

  const upper: LineData<Time>[] = [];
  const lower: LineData<Time>[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const window = candles.slice(index - period + 1, index + 1);
    const average = window.reduce((sum, item) => sum + item.close, 0) / period;
    const variance = window.reduce((sum, item) => sum + (item.close - average) ** 2, 0) / period;
    const bandWidth = Math.sqrt(variance) * deviations;
    upper.push(toStudyPoint(candle, average + bandWidth));
    lower.push(toStudyPoint(candle, average - bandWidth));
  }

  return { upper, lower };
}

function buildMarketStudyData(candles: MarketCandle[]): Record<StudyLineId, LineData<Time>[]> {
  const bollinger = bollingerSeries(candles);
  return {
    vwap: vwapSeries(candles),
    sma20: rollingAverageSeries(candles, 20),
    sma50: rollingAverageSeries(candles, 50),
    bbUpper: bollinger.upper,
    bbLower: bollinger.lower,
  };
}

function applyMarketStudyData(
  studySeries: Partial<Record<StudyLineId, LineSeriesApi>> | undefined,
  studyData: Record<StudyLineId, LineData<Time>[]>,
  enabledStudies: Record<MarketStudyId, boolean>,
): void {
  studySeries?.vwap?.setData(enabledStudies.vwap ? studyData.vwap : []);
  studySeries?.sma20?.setData(enabledStudies.sma20 ? studyData.sma20 : []);
  studySeries?.sma50?.setData(enabledStudies.sma50 ? studyData.sma50 : []);
  studySeries?.bbUpper?.setData(enabledStudies.bb20 ? studyData.bbUpper : []);
  studySeries?.bbLower?.setData(enabledStudies.bb20 ? studyData.bbLower : []);
}

function enabledStudyHasData(
  studyData: Record<StudyLineId, LineData<Time>[]>,
  control: { lineIds: StudyLineId[] },
): boolean {
  return control.lineIds.some((lineId) => studyData[lineId].length > 0);
}

interface AgentStudyLine {
  label: string;
  detail: string;
  color: string;
  data: LineData<Time>[];
}

function sanitizedStudyColor(color: string | null | undefined, index: number): string {
  const fallback = AGENT_STUDY_COLORS[index % AGENT_STUDY_COLORS.length];
  if (!color) return fallback;
  const trimmed = color.trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) ? trimmed : fallback;
}

function toLineDataPoint(point: { timestampMs: number; value: number }): LineData<Time> {
  return {
    time: Math.floor(point.timestampMs / 1000) as UTCTimestamp,
    value: point.value,
  };
}

function buildAgentStudyLines(
  studies: ChartStudy[],
  marketCandles: MarketCandle[],
): AgentStudyLine[] {
  if (studies.length === 0 || marketCandles.length === 0) return [];

  const firstCandle = marketCandles[0];
  const lastCandle = marketCandles[marketCandles.length - 1];
  if (!firstCandle || !lastCandle) return [];

  const lines: AgentStudyLine[] = [];
  for (const study of studies) {
    for (const overlay of study.overlays) {
      if (lines.length >= AGENT_STUDY_SERIES_CAP) return lines;
      const color = sanitizedStudyColor(overlay.color, lines.length);
      if (overlay.kind === 'line') {
        const data = overlay.points
          .map(toLineDataPoint)
          .sort((left, right) => Number(left.time) - Number(right.time));
        if (data.length >= 2) {
          lines.push({
            label: overlay.label,
            detail: `${study.title}: ${overlay.label}`,
            color,
            data,
          });
        }
        continue;
      }

      if (overlay.kind === 'level' && overlay.value != null) {
        const fromMs = study.validFromMs ?? firstCandle.timestamp;
        const toMs = study.validToMs ?? lastCandle.timestamp;
        if (fromMs <= toMs) {
          lines.push({
            label: overlay.label,
            detail: `${study.title}: ${overlay.label}`,
            color,
            data: [
              { time: Math.floor(fromMs / 1000) as UTCTimestamp, value: overlay.value },
              { time: Math.floor(toMs / 1000) as UTCTimestamp, value: overlay.value },
            ],
          });
        }
      }
    }
  }

  return lines;
}

function applyAgentStudyLines(
  series: LineSeriesApi[] | undefined,
  lines: AgentStudyLine[],
): void {
  if (!series) return;
  series.forEach((item, index) => {
    const line = lines[index];
    if (!line) {
      item.setData([]);
      return;
    }
    item.applyOptions({
      color: line.color,
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      title: line.label,
    });
    item.setData(line.data);
  });
}

function estimateMarketMarkerToleranceSeconds(marketTimes: UTCTimestamp[]): number {
  const intervals = marketTimes
    .slice(1)
    .map((time, index) => time - marketTimes[index])
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  if (intervals.length === 0) return MARKET_MARKER_MIN_TOLERANCE_SECONDS;
  const median = intervals[Math.floor(intervals.length / 2)] ?? MARKET_MARKER_MIN_TOLERANCE_SECONDS;
  return Math.max(MARKET_MARKER_MIN_TOLERANCE_SECONDS, Math.ceil(median * 0.75));
}

function nearestMarketTime(
  marketTimes: UTCTimestamp[],
  timestampMs: number,
  toleranceSeconds: number,
): UTCTimestamp | null {
  if (marketTimes.length === 0 || !Number.isFinite(timestampMs)) return null;
  const firstTime = marketTimes[0];
  const lastTime = marketTimes[marketTimes.length - 1];
  if (firstTime == null || lastTime == null) return null;
  const target = Math.floor(timestampMs / 1000);
  if (target < firstTime - toleranceSeconds || target > lastTime + toleranceSeconds) return null;
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
  const nearest = Math.abs(previous - target) <= Math.abs(next - target) ? previous : next;
  return Math.abs(nearest - target) <= toleranceSeconds ? nearest : null;
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

interface MarketMarkerPlacementResult {
  placements: MarkerPlacement[];
  omittedCount: number;
  totalCount: number;
}

interface ExactMarketMarkerOverlay {
  id: string;
  x: number;
  y: Coordinate;
  side: 'buy' | 'sell' | 'other';
  color: string;
  marker: TradeChartMarker;
  count: number;
  members: TradeChartMarker[];
  value: number;
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

function marketExactMarkerPlacements(candidates: MarkerCandidate[]): MarkerPlacement[] {
  const groups = new Map<string, MarkerPlacement>();

  for (const candidate of candidates) {
    const key = `${candidate.time}:${markerSide(candidate.marker)}`;
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

function marketMarkerPlacements(candidates: MarkerCandidate[], dense: boolean): MarkerPlacement[] {
  return (dense ? denseMarkerPlacements(candidates) : marketExactMarkerPlacements(candidates))
    .sort((left, right) => left.time - right.time);
}

function toMarkerLabel(
  marker: TradeChartMarker,
  count: number,
  dense: boolean,
  labelMode: 'action' | 'count' | 'none',
): string {
  if (labelMode === 'none') return '';
  if (labelMode === 'count') return count > 1 ? `x${count}` : '';
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
): MarketMarkerPlacementResult {
  const dense = tradeMarkers.length > DENSE_MARKER_THRESHOLD;
  const marketTimes = marketCandles
    .map((candle) => Math.floor(candle.timestamp / 1000) as UTCTimestamp)
    .sort((left, right) => left - right);
  const toleranceSeconds = estimateMarketMarkerToleranceSeconds(marketTimes);
  const candidates: MarkerCandidate[] = [];

  for (const marker of tradeMarkers) {
    const time = nearestMarketTime(marketTimes, marker.timestampMs, toleranceSeconds);
    if (time != null) candidates.push({ marker, time });
  }

  return {
    placements: marketMarkerPlacements(candidates, dense),
    omittedCount: tradeMarkers.length - candidates.length,
    totalCount: tradeMarkers.length,
  };
}

function toSeriesMarkers(
  placements: MarkerPlacement[],
  {
    dense,
    denseSingletonSize,
    labelMode = 'action',
  }: {
    dense: boolean;
    denseSingletonSize: number;
    labelMode?: 'action' | 'count' | 'none';
  },
): Array<SeriesMarker<Time>> {
  return placements.map(({ id, marker, time, count }) => ({
    id,
    time,
    position: marker.position,
    shape: marker.shape,
    color: marker.color,
    text: toMarkerLabel(marker, count, dense, labelMode),
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

function formatExecutionTime(timestampMs: number): string {
  return markerTimeFormatter.format(new Date(timestampMs));
}

function formatExecutionDetail(item: ExactMarketMarkerOverlay): string {
  if (item.count > 1) {
    const startTimestamp = Math.min(...item.members.map((marker) => marker.timestampMs));
    const endTimestamp = Math.max(...item.members.map((marker) => marker.timestampMs));
    const timeRange = startTimestamp === endTimestamp
      ? markerTimeFormatter.format(new Date(startTimestamp))
      : `${markerTimeFormatter.format(new Date(startTimestamp))} - ${markerTimeFormatter.format(new Date(endTimestamp))}`;
    const sample = item.members
      .slice(0, 2)
      .map((marker) => marker.tooltip)
      .join(' · ');
    const remainder = item.members.length > 2 ? ` · +${item.members.length - 2} more` : '';
    return `${timeRange} · ${sample}${remainder}`;
  }
  return `${formatExecutionTime(item.marker.timestampMs)} · ${item.marker.tooltip}`;
}

function executionReadout(item: ExactMarketMarkerOverlay): HoverReadout {
  return {
    label: item.count > 1 ? `${item.marker.text} x${item.count}` : item.marker.tooltip,
    value: item.value,
    detail: item.count > 1 ? formatExecutionDetail(item) : formatExecutionTime(item.marker.timestampMs),
  };
}

function surroundingTimes(marketTimes: UTCTimestamp[], target: UTCTimestamp): [UTCTimestamp, UTCTimestamp] | null {
  if (marketTimes.length === 0) return null;
  const first = marketTimes[0];
  const last = marketTimes[marketTimes.length - 1];
  if (first == null || last == null || target < first || target > last) return null;

  let low = 0;
  let high = marketTimes.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const time = marketTimes[middle];
    if (time === target) return [time, time];
    if (time < target) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const previous = marketTimes[Math.max(0, high)];
  const next = marketTimes[Math.min(marketTimes.length - 1, low)];
  return previous != null && next != null ? [previous, next] : null;
}

function interpolateMarketCoordinate(
  chart: IChartApi,
  marketTimes: UTCTimestamp[],
  target: UTCTimestamp,
): number | null {
  const timeScale = chart.timeScale() as ReturnType<IChartApi['timeScale']> & {
    timeToCoordinate?: (time: Time) => number | null;
  };
  if (!timeScale.timeToCoordinate) return null;
  const direct = timeScale.timeToCoordinate(target);
  if (direct != null) return direct;

  const bounds = surroundingTimes(marketTimes, target);
  if (!bounds) return null;

  const [previous, next] = bounds;
  const previousX = timeScale.timeToCoordinate(previous);
  const nextX = timeScale.timeToCoordinate(next);
  if (previousX == null || nextX == null) return null;
  if (previous === next) return previousX;

  const progress = (target - previous) / (next - previous);
  return previousX + (nextX - previousX) * progress;
}

function estimateMarketValueAtTimestamp(candles: MarketCandle[], timestampMs: number): number | null {
  if (candles.length === 0 || !Number.isFinite(timestampMs)) return null;
  const target = timestampMs / 1000;
  const sorted = [...candles].sort((left, right) => left.timestamp - right.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  const firstTime = first.timestamp / 1000;
  const lastTime = last.timestamp / 1000;
  if (target < firstTime || target > lastTime) return null;
  if (target <= firstTime) return first.close;
  if (target >= lastTime) return last.close;

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const next = sorted[index];
    if (!previous || !next || target > next.timestamp / 1000) continue;

    const previousTime = previous.timestamp / 1000;
    const nextTime = next.timestamp / 1000;
    if (nextTime <= previousTime) return previous.close;

    const progress = (target - previousTime) / (nextTime - previousTime);
    return previous.close + (next.close - previous.close) * progress;
  }

  return last.close;
}

function resolveMarketMarkerValue(candles: MarketCandle[], marker: TradeChartMarker): number | null {
  if (marker.executionPriceUsd != null && Number.isFinite(marker.executionPriceUsd) && marker.executionPriceUsd > 0) {
    return marker.executionPriceUsd;
  }
  return estimateMarketValueAtTimestamp(candles, marker.timestampMs);
}

function exactOverlayEquals(left: ExactMarketMarkerOverlay[], right: ExactMarketMarkerOverlay[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return other != null
      && item.id === other.id
      && item.count === other.count
      && Math.abs(item.x - other.x) < 0.5
      && Math.abs(item.y - other.y) < 0.5
      && item.value === other.value;
  });
}

function groupExactMarketMarkerOverlay(items: ExactMarketMarkerOverlay[]): ExactMarketMarkerOverlay[] {
  if (items.length <= DENSE_MARKER_THRESHOLD) return items;

  const bucketSizePx = 18;
  const groups = new Map<string, ExactMarketMarkerOverlay[]>();
  for (const item of items) {
    const key = `${item.side}:${Math.round(item.x / bucketSizePx)}:${Math.round(item.y / bucketSizePx)}`;
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      if (group.length === 1) return group[0];

      const sorted = [...group].sort((left, right) => left.marker.timestampMs - right.marker.timestampMs);
      const middle = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
      const members = sorted.flatMap((item) => item.members);
      const count = members.length;
      const x = sorted.reduce((sum, item) => sum + item.x, 0) / sorted.length;
      const y = sorted.reduce((sum, item) => sum + item.y, 0) / sorted.length;
      const value = sorted.reduce((sum, item) => sum + item.value, 0) / sorted.length;

      return {
        ...middle,
        id: `${middle.id}-group-${count}`,
        x,
        y: y as Coordinate,
        count,
        members,
        value,
      };
    })
    .sort((left, right) => left.x - right.x);
}

function buildExactMarketMarkerOverlay({
  chart,
  candleSeries,
  containerWidth,
  marketCandles,
  tradeMarkers,
}: {
  chart: IChartApi;
  candleSeries: CandleSeriesApi;
  containerWidth: number;
  marketCandles: MarketCandle[];
  tradeMarkers: TradeChartMarker[];
}): ExactMarketMarkerOverlay[] {
  const marketTimes = marketCandles
    .map((candle) => Math.floor(candle.timestamp / 1000) as UTCTimestamp)
    .sort((left, right) => left - right);
  if (marketTimes.length === 0) return [];

  const items = tradeMarkers
    .filter((marker) => Number.isFinite(marker.timestampMs))
    .map((marker) => {
      const target = Math.floor(marker.timestampMs / 1000) as UTCTimestamp;
      const firstTime = marketTimes[0];
      const lastTime = marketTimes[marketTimes.length - 1];
      if (firstTime == null || lastTime == null || target < firstTime || target > lastTime) return null;
      const x = interpolateMarketCoordinate(chart, marketTimes, target);
      const hasMeasuredWidth = containerWidth > 0;
      if (x == null || x < -16 || (hasMeasuredWidth && x > containerWidth + 16)) return null;
      const value = resolveMarketMarkerValue(marketCandles, marker);
      if (value == null) return null;
      const y = candleSeries.priceToCoordinate(value);
      if (y == null || !Number.isFinite(y)) return null;
      return {
        id: marker.id,
        x,
        y,
        side: markerSide(marker),
        color: marker.color,
        marker,
        count: 1,
        members: [marker],
        value,
      };
    })
    .filter((item): item is ExactMarketMarkerOverlay => item != null)
    .sort((left, right) => left.x - right.x);

  return groupExactMarketMarkerOverlay(items);
}

interface ExecutionCoverage {
  shown: number;
  total: number;
  detail: string;
  title: string;
}

interface MarketCoverageReadout {
  label: string;
  detail: string;
  title: string;
  tone: 'complete' | 'partial' | 'thin';
}

function formatCoverageSpan(spanMs: number): string {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 'single print';
  const minutes = Math.round(spanMs / 60_000);
  if (minutes < 90) return `${Math.max(1, minutes)}m span`;
  const hours = Math.round(spanMs / 3_600_000);
  if (hours < 48) return `${hours}h span`;
  const days = Math.round(spanMs / 86_400_000);
  return `${days}d span`;
}

function formatCoveragePercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0% range';
  if (value < 1) return '<1% range';
  if (value < 10) return `${formatNumber(value, { maximumFractionDigits: 1 })}% range`;
  return `${formatNumber(value, { maximumFractionDigits: 0 })}% range`;
}

function marketCoverageReadout(
  candles: MarketCandle[],
  coverage: MarketDataCoverage | null | undefined,
): MarketCoverageReadout | null {
  if (!coverage || candles.length === 0) return null;

  const first = candles[0];
  const latest = candles[candles.length - 1];
  if (!first || !latest) return null;

  const requestedSpanMs = Math.max(0, coverage.requestedToMs - coverage.requestedFromMs);
  const observedSpanMs = Math.max(0, latest.timestamp - first.timestamp);
  const rangePercent = requestedSpanMs > 0 ? observedSpanMs / requestedSpanMs * 100 : 0;
  const firstLabel = coverageTimeFormatter.format(new Date(first.timestamp));
  const latestLabel = coverageTimeFormatter.format(new Date(latest.timestamp));
  const historyState = coverage.botCreatedAtMs != null && first.timestamp < coverage.botCreatedAtMs - 60_000
    ? 'pre-agent'
    : 'post-launch';
  const tone = candles.length < 20 || rangePercent < 5
    ? 'thin'
    : rangePercent < 80
      ? 'partial'
      : 'complete';

  return {
    label: `${formatNumber(candles.length, { maximumFractionDigits: 0 })} candles · ${coverage.sourceLabel}`,
    detail: `${formatCoverageSpan(observedSpanMs)} · ${formatCoveragePercent(rangePercent)} · ${historyState}`,
    title: `${coverage.sourceLabel} returned ${candles.length} ${first.token} candles for ${coverage.requestedRangeLabel}. First: ${firstLabel}. Latest: ${latestLabel}. Requested: ${coverageTimeFormatter.format(new Date(coverage.requestedFromMs))} to ${coverageTimeFormatter.format(new Date(coverage.requestedToMs))}.`,
    tone,
  };
}

function buildExecutionCoverage({
  activeMode,
  exactOverlayFillCount,
  exactOverlayGroupCount,
  fillCountEvidence,
  marketCandles,
  marketMarkerVisibleCount,
  tradeMarkers,
}: {
  activeMode: 'nav' | 'market';
  exactOverlayFillCount: number;
  exactOverlayGroupCount: number;
  fillCountEvidence?: FillCountEvidence | null;
  marketCandles: MarketCandle[];
  marketMarkerVisibleCount: number;
  tradeMarkers: TradeChartMarker[];
}): ExecutionCoverage | null {
  const renderedRows = tradeMarkers.length;
  const total = Math.max(fillCountEvidence?.value ?? 0, fillCountEvidence?.total ?? 0, renderedRows);
  if (total <= 0) return null;

  const chartable = activeMode === 'market'
    ? marketMarkerVisibleCount
    : renderedRows;
  const shown = activeMode === 'market'
    ? exactOverlayFillCount || chartable
    : renderedRows;
  const loaded = Math.max(fillCountEvidence?.loaded ?? 0, renderedRows);
  const outsidePage = Math.max(fillCountEvidence?.outsidePage ?? 0, total - loaded, 0);
  const offWindow = activeMode === 'market'
    ? Math.max(0, renderedRows - chartable)
    : 0;
  const inferredUnpriced = tradeMarkers.filter((marker) =>
    marker.executionPriceUsd == null
      || !Number.isFinite(marker.executionPriceUsd)
      || marker.executionPriceUsd <= 0,
  ).length;
  const unpriced = Math.max(fillCountEvidence?.unpriced ?? 0, inferredUnpriced);
  const detailParts = [
    activeMode === 'market' && exactOverlayGroupCount > 0 && exactOverlayGroupCount < shown
      ? `${formatNumber(exactOverlayGroupCount, { maximumFractionDigits: 0 })} groups`
      : null,
    offWindow > 0 ? `${formatNumber(offWindow, { maximumFractionDigits: 0 })} off-window` : null,
    outsidePage > 0 ? `${formatNumber(outsidePage, { maximumFractionDigits: 0 })} outside page` : null,
    unpriced > 0 ? `${formatNumber(unpriced, { maximumFractionDigits: 0 })} unpriced` : null,
    activeMode === 'market' && marketCandles.length > 0
      ? `${formatNumber(marketCandles.length, { maximumFractionDigits: 0 })} candles`
      : null,
  ].filter((part): part is string => part != null);
  const shownText = formatNumber(shown, { maximumFractionDigits: 0 });
  const totalText = formatNumber(total, { maximumFractionDigits: 0 });

  return {
    shown,
    total,
    detail: detailParts.length > 0 ? detailParts.join(' · ') : 'fully covered',
    title: `${shownText} of ${totalText} fills shown. ${detailParts.length > 0 ? detailParts.join(', ') : 'All loaded fills are charted.'}`,
  };
}

export function TradingPerformanceChart({
  points,
  tradeMarkers,
  chartTheme,
  mode = 'nav',
  marketCandles = [],
  marketLabel,
  marketDataCoverage,
  chartStudies = [],
  fillCountEvidence,
}: TradingPerformanceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverReadout, setHoverReadout] = useState<HoverReadout | null>(null);
  const [exactMarketOverlay, setExactMarketOverlay] = useState<ExactMarketMarkerOverlay[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [enabledStudies, setEnabledStudies] = useState<Record<MarketStudyId, boolean>>(DEFAULT_MARKET_STUDIES);
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
  const marketStudyData = useMemo(
    () => buildMarketStudyData(marketCandles),
    [marketCandles],
  );
  const agentStudyLines = useMemo(
    () => buildAgentStudyLines(chartStudies, marketCandles),
    [chartStudies, marketCandles],
  );
  const marketMarkerPlacementResult = useMemo(
    () => toMarketMarkerPlacements(tradeMarkers, marketCandles),
    [marketCandles, tradeMarkers],
  );
  const marketMarkerPlacements = marketMarkerPlacementResult.placements;
  const marketMarkerVisibleCount = marketMarkerPlacements.reduce((sum, placement) => sum + placement.count, 0);
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
  const firstNavTimeRef = useRef<Time | undefined>(undefined);
  const lastNavTimeRef = useRef<Time | undefined>(undefined);
  const tradeMarkersRef = useRef(tradeMarkers);
  const marketCandlesRef = useRef(marketCandles);
  const agentStudyLinesRef = useRef(agentStudyLines);

  useEffect(() => {
    activeModeRef.current = activeMode;
    marketLabelRef.current = marketLabel;
    tradeMarkersRef.current = tradeMarkers;
    marketCandlesRef.current = marketCandles;
    agentStudyLinesRef.current = agentStudyLines;
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
    firstNavTimeRef.current = preparedPoints[0]?.time;
    lastNavTimeRef.current = preparedPoints[preparedPoints.length - 1]?.time;
  }, [activeMode, agentStudyLines, marketCandles, marketLabel, markerReadoutsById, marketSeriesData, preparedPoints, tradeMarkers]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (activeMode === 'nav' && preparedPoints.length === 0) return;
    if (activeMode === 'market' && marketSeriesData.length === 0) return;

    let cancelled = false;
    let crosshairHandler: ((param: MouseEventParams<Time>) => void) | null = null;
    let unsubscribeVisibleRange: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    void loadLightweightCharts().then((charts) => {
      if (cancelled || !containerRef.current) return;

      const chart = charts.createChart(containerRef.current, {
        autoSize: true,
        height: containerRef.current.clientHeight || 520,
        layout: {
          background: { type: charts.ColorType.Solid, color: chartTheme.chartSurface },
          textColor: chartTheme.tickColor,
          attributionLogo: false,
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        grid: {
          vertLines: { color: 'transparent' },
          horzLines: { color: chartTheme.gridColor },
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
            const key = timeKey(time);
            const candle = candleByTimeRef.current.get(key);
            const navPoint = pointByTimeRef.current.get(key);
            if (
              activeModeRef.current === 'market'
              && shouldSuppressChartEdgeTick(time, firstMarketTimeRef.current, lastMarketTimeRef.current)
            ) {
              return '';
            }
            if (
              activeModeRef.current === 'nav'
              && navPoint?.kind !== 'live_nav'
              && shouldSuppressChartEdgeTick(time, firstNavTimeRef.current, lastNavTimeRef.current)
            ) {
              return '';
            }
            if (activeModeRef.current === 'market' && candle) {
              return formatCandleAxisTick(
                candle.timestamp,
                timeRangeMs(firstMarketTimeRef.current, lastMarketTimeRef.current),
                timestampMsFromChartTime(lastMarketTimeRef.current),
              );
            }
            if (navPoint) {
              return formatNavAxisTick(
                navPoint,
                timeRangeMs(firstNavTimeRef.current, lastNavTimeRef.current),
                timestampMsFromChartTime(lastNavTimeRef.current),
              );
            }
            return candle ? formatCandleAxisTick(candle.timestamp) : '';
          },
        },
        crosshair: {
          mode: charts.CrosshairMode.Magnet,
          vertLine: {
            color: chartTheme.crosshairColor,
            labelBackgroundColor: chartTheme.tooltipBg,
            style: charts.LineStyle.Dashed,
          },
          horzLine: {
            color: chartTheme.crosshairColor,
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
        const studySeries: Partial<Record<StudyLineId, LineSeriesApi>> = {
          vwap: chart.addSeries(charts.LineSeries, {
            color: STUDY_LINE_COLORS.vwap,
            lineWidth: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
          sma20: chart.addSeries(charts.LineSeries, {
            color: STUDY_LINE_COLORS.sma20,
            lineWidth: 1,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
          sma50: chart.addSeries(charts.LineSeries, {
            color: STUDY_LINE_COLORS.sma50,
            lineWidth: 1,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
          bbUpper: chart.addSeries(charts.LineSeries, {
            color: `${STUDY_LINE_COLORS.bbUpper}AA`,
            lineWidth: 1,
            lineStyle: charts.LineStyle.Dotted,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
          bbLower: chart.addSeries(charts.LineSeries, {
            color: `${STUDY_LINE_COLORS.bbLower}AA`,
            lineWidth: 1,
            lineStyle: charts.LineStyle.Dotted,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
        };
        const agentStudySeries = Array.from({ length: AGENT_STUDY_SERIES_CAP }, (_, index) =>
          chart.addSeries(charts.LineSeries, {
            color: AGENT_STUDY_COLORS[index % AGENT_STUDY_COLORS.length],
            lineWidth: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
        );
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
          studySeries,
          agentStudySeries,
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

      const updateExactOverlay = () => {
        const currentRuntime = runtimeRef.current;
        if (!containerRef.current || currentRuntime?.mode !== 'market' || !currentRuntime.candleSeries) {
          setExactMarketOverlay((current) => current.length === 0 ? current : []);
          return;
        }
        const nextOverlay = buildExactMarketMarkerOverlay({
          chart,
          candleSeries: currentRuntime.candleSeries,
          containerWidth: containerRef.current.clientWidth,
          marketCandles: marketCandlesRef.current,
          tradeMarkers: tradeMarkersRef.current,
        });
        setExactMarketOverlay((current) => exactOverlayEquals(current, nextOverlay) ? current : nextOverlay);
      };

      if (runtime.mode === 'market' && runtime.candleSeries && runtime.volumeSeries) {
        runtime.candleSeries.setData(marketSeriesData);
        runtime.volumeSeries.setData(volumeSeriesData);
        applyMarketStudyData(runtime.studySeries, marketStudyData, enabledStudies);
        applyAgentStudyLines(runtime.agentStudySeries, agentStudyLinesRef.current);
        if (runtime.navPaneSeries) {
          runtime.navPaneSeries.setData(navSeriesData);
          if (navSeriesData.length > 1) {
            runtime.navPaneStartPriceLine = runtime.navPaneSeries.createPriceLine({
              price: navSeriesData[0].value,
              color: chartTheme.tickColor,
              lineWidth: 1,
              lineStyle: charts.LineStyle.Dashed,
              axisLabelVisible: false,
              title: 'NAV',
            });
          }
        }
        runtime.markerApi?.setMarkers([]);
        chart.timeScale().fitContent();
        updateExactOverlay();
        fitOnNextDataRef.current = false;
      }

      if (runtime.mode === 'nav' && runtime.areaSeries) {
        runtime.areaSeries.setData(navSeriesData);
        runtime.markerApi?.setMarkers(chartMarkers);
        if (navSeriesData.length > 1) {
          runtime.startPriceLine = runtime.areaSeries.createPriceLine({
            price: navSeriesData[0].value,
            color: chartTheme.tickColor,
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

      const timeScale = chart.timeScale() as ReturnType<IChartApi['timeScale']> & {
        subscribeVisibleLogicalRangeChange?: (handler: () => void) => void;
        unsubscribeVisibleLogicalRangeChange?: (handler: () => void) => void;
      };
      if (runtime.mode === 'market' && timeScale.subscribeVisibleLogicalRangeChange && timeScale.unsubscribeVisibleLogicalRangeChange) {
        timeScale.subscribeVisibleLogicalRangeChange(updateExactOverlay);
        unsubscribeVisibleRange = () => timeScale.unsubscribeVisibleLogicalRangeChange?.(updateExactOverlay);
      }
      if (runtime.mode === 'market' && typeof ResizeObserver !== 'undefined' && containerRef.current) {
        resizeObserver = new ResizeObserver(updateExactOverlay);
        resizeObserver.observe(containerRef.current);
      }
    });

    return () => {
      cancelled = true;
      unsubscribeVisibleRange?.();
      resizeObserver?.disconnect();
      const runtime = runtimeRef.current;
      if (runtime?.mode === activeMode) {
        if (crosshairHandler) runtime.chart.unsubscribeCrosshairMove(crosshairHandler);
        runtime.markerApi?.detach();
        runtime.chart.remove();
        runtimeRef.current = null;
      }
      setExactMarketOverlay((current) => current.length === 0 ? current : []);
    };
  }, [
    activeMode,
    chartTheme.gradientEnd,
    chartTheme.chartSurface,
    chartTheme.crosshairColor,
    chartTheme.gridColor,
    chartTheme.hoverBorderColor,
    chartTheme.negative,
    chartTheme.positive,
    chartTheme.tickColor,
    chartTheme.tooltipBg,
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
        color: chartTheme.tickColor,
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
    chartTheme.tickColor,
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
    applyMarketStudyData(runtime.studySeries, marketStudyData, enabledStudies);
    applyAgentStudyLines(runtime.agentStudySeries, agentStudyLines);
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
          color: chartTheme.tickColor,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: false,
          title: 'NAV',
        });
      }
    }
    runtime.markerApi?.setMarkers([]);

    if (fitOnNextDataRef.current) {
      runtime.chart.timeScale().fitContent();
      fitOnNextDataRef.current = false;
    }
    const nextOverlay = buildExactMarketMarkerOverlay({
      chart: runtime.chart,
      candleSeries: runtime.candleSeries,
      containerWidth: containerRef.current?.clientWidth ?? 0,
      marketCandles,
      tradeMarkers,
    });
    setExactMarketOverlay((current) => exactOverlayEquals(current, nextOverlay) ? current : nextOverlay);
  }, [
    activeMode,
    agentStudyLines,
    chartTheme.gradientEnd,
    chartTheme.hoverBorderColor,
    chartTheme.negative,
    chartTheme.positive,
    chartTheme.tickColor,
    enabledStudies,
    fillTopColor,
    lineColor,
    marketStudyData,
    marketSeriesData,
    navSeriesData,
    tradeMarkers,
    marketCandles,
    volumeSeriesData,
  ]);

  useEffect(() => {
    if (!selectedExecutionId) return;
    if (exactMarketOverlay.some((item) => item.id === selectedExecutionId)) return;
    setSelectedExecutionId(null);
  }, [exactMarketOverlay, selectedExecutionId]);

  const latestMarketCandle = marketCandles[marketCandles.length - 1] ?? null;
  const marketCoverage = marketCoverageReadout(marketCandles, marketDataCoverage);
  const exactOverlayFillCount = exactMarketOverlay.reduce((sum, item) => sum + item.count, 0);
  const executionCoverage = buildExecutionCoverage({
    activeMode,
    exactOverlayFillCount,
    exactOverlayGroupCount: exactMarketOverlay.length,
    fillCountEvidence,
    marketCandles,
    marketMarkerVisibleCount,
    tradeMarkers,
  });
  const selectedExecution = selectedExecutionId
    ? exactMarketOverlay.find((item) => item.id === selectedExecutionId) ?? null
    : null;
  const featuredExecution = selectedExecution ?? exactMarketOverlay[exactMarketOverlay.length - 1] ?? null;
  const selectedReadout = selectedExecution ? executionReadout(selectedExecution) : null;
  const readout = hoverReadout ?? selectedReadout ?? (activeMode === 'market' && latestMarketCandle
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
    <div
      className="relative h-full min-h-[320px] w-full overflow-hidden bg-[var(--arena-terminal-panel)]"
      style={{ backgroundColor: chartTheme.chartSurface }}
      data-testid="tradingview-performance-chart"
    >
      <div ref={containerRef} className="absolute inset-0" />
      {activeMode === 'market' && exactMarketOverlay.length > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10"
          style={{
            top: 0,
            bottom: hasIntegratedNavPane ? '31%' : '18%',
          }}
          aria-label="Execution lane"
        >
          {exactMarketOverlay.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`pointer-events-auto absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/70 ${
                selectedExecutionId === item.id ? 'ring-2 ring-[#50d2c1]/70' : ''
              }`}
              style={{ left: item.x, top: item.y }}
              aria-label={`${item.count > 1 ? `${item.marker.text} x${item.count}` : item.marker.tooltip} at ${markerTimeFormatter.format(new Date(item.marker.timestampMs))}`}
              title={`${item.count > 1 ? `${item.marker.text} x${item.count}` : item.marker.tooltip} · ${formatExecutionDetail(item)}`}
              onClick={() => {
                const nextSelectedId = selectedExecutionId === item.id ? null : item.id;
                setSelectedExecutionId(nextSelectedId);
                setHoverReadout(nextSelectedId ? executionReadout(item) : null);
              }}
              onFocus={() => {
                setHoverReadout(executionReadout(item));
              }}
              onMouseEnter={() => {
                setHoverReadout(executionReadout(item));
              }}
              onMouseLeave={() => {
                if (selectedExecutionId !== item.id) setHoverReadout(null);
              }}
              onBlur={() => {
                if (selectedExecutionId !== item.id) setHoverReadout(null);
              }}
            >
              <span
                className="absolute left-1/2 top-1/2 h-[58px] w-px -translate-x-1/2 -translate-y-1/2"
                style={{
                  background: `linear-gradient(to bottom, transparent, ${item.color} 18%, ${item.color} 82%, transparent)`,
                  opacity: item.side === 'other' ? 0.24 : 0.34,
                }}
                aria-hidden="true"
              />
              {item.count > 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-1/2 min-w-9 -translate-x-1/2 -translate-y-1/2 rounded-sm px-1.5 py-0.5 text-center font-data text-[10px] font-semibold tabular-nums"
                  style={{
                    backgroundColor: item.color,
                    color: chartTheme.chartSurface,
                    boxShadow: `0 0 0 1px ${chartTheme.hoverBorderColor}, 0 0 12px ${item.color}88`,
                  }}
                >
                  x{formatNumber(item.count, { maximumFractionDigits: 0 })}
                </span>
              ) : item.side === 'buy' ? (
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-1/2 h-0 w-0 -translate-x-1/2 -translate-y-[62%]"
                  style={{
                    borderLeft: '5px solid transparent',
                    borderRight: '5px solid transparent',
                    borderBottom: `9px solid ${item.color}`,
                    filter: `drop-shadow(0 0 7px ${item.color}77) drop-shadow(0 0 1px ${chartTheme.hoverBorderColor})`,
                  }}
                />
              ) : item.side === 'sell' ? (
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-1/2 h-0 w-0 -translate-x-1/2 -translate-y-[38%]"
                  style={{
                    borderLeft: '5px solid transparent',
                    borderRight: '5px solid transparent',
                    borderTop: `9px solid ${item.color}`,
                    filter: `drop-shadow(0 0 7px ${item.color}77) drop-shadow(0 0 1px ${chartTheme.hoverBorderColor})`,
                  }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    backgroundColor: item.color,
                    boxShadow: `0 0 0 1px ${chartTheme.hoverBorderColor}, 0 0 10px ${item.color}77`,
                  }}
                />
              )}
            </button>
          ))}
        </div>
      )}
      {readout && (
        <div
          className="pointer-events-none absolute left-3 top-3 rounded-md border px-3 py-2"
          style={{
            background: chartTheme.tooltipBg,
            borderColor: chartTheme.tooltipBorder,
            boxShadow: chartTheme.tooltipShadow,
          }}
        >
          <div className="font-data text-[11px]" style={{ color: chartTheme.tooltipTitleColor }}>
            {readout.label}
          </div>
          <div className="mt-0.5 font-data text-xl font-semibold tabular-nums" style={{ color: chartTheme.tooltipBodyColor }}>
            {formatAxisCurrency(readout.value)}
          </div>
          {readout.detail && (
            <div className="mt-1 font-data text-[11px]" style={{ color: chartTheme.tooltipTitleColor }}>
              {readout.detail}
            </div>
          )}
        </div>
      )}
      {activeMode === 'market' && (
        <div
          className="pointer-events-auto absolute left-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1.5"
          style={{
            bottom: hasIntegratedNavPane ? 'calc(31% + 10px)' : 52,
          }}
          aria-label="Market chart studies"
        >
          {MARKET_STUDY_CONTROLS.map((control) => {
            const enabled = enabledStudies[control.id];
            const hasData = enabledStudyHasData(marketStudyData, control);
            const pressed = enabled && hasData;
            return (
              <button
                key={control.id}
                type="button"
                className="h-7 rounded-sm border px-2 font-data text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                style={{
                  background: pressed
                    ? chartTheme.tooltipBodyColor
                    : chartTheme.tooltipBg,
                  borderColor: pressed
                    ? chartTheme.tooltipBodyColor
                    : chartTheme.tooltipBorder,
                  color: pressed
                    ? chartTheme.chartSurface
                    : chartTheme.tooltipTitleColor,
                }}
                aria-pressed={pressed}
                disabled={!hasData}
                title={hasData ? `${control.label} chart study` : `${control.label} needs more candle history`}
                onClick={() => {
                  setEnabledStudies((current) => ({
                    ...current,
                    [control.id]: !current[control.id],
                  }));
                }}
              >
                {control.label}
              </button>
            );
          })}
          {agentStudyLines.length > 0 && (
            <span
              className="inline-flex h-7 max-w-[220px] items-center truncate rounded-sm border px-2 font-data text-[11px] font-semibold"
              style={{
                background: chartTheme.tooltipBg,
                borderColor: STUDY_LINE_COLORS.vwap,
                color: chartTheme.tooltipBodyColor,
              }}
              title={agentStudyLines.map((line) => line.detail).join(' · ')}
              data-testid="chart-agent-studies-chip"
            >
              Agent {formatNumber(agentStudyLines.length, { maximumFractionDigits: 0 })}
            </span>
          )}
        </div>
      )}
      {activeMode === 'market' && navSeriesData.length > 0 && (
        <div
          className="pointer-events-none absolute bottom-2 left-3 rounded-sm border px-2 py-0.5 font-data text-[10px] font-semibold"
          style={{
            background: chartTheme.tooltipBg,
            borderColor: chartTheme.tooltipBorder,
            color: chartTheme.tooltipTitleColor,
          }}
        >
          NAV
        </div>
      )}
      {featuredExecution && (
        <div
          className="pointer-events-none absolute bottom-3 right-3 z-20 max-w-[min(360px,calc(100%-1.5rem))] rounded-md border px-3 py-2"
          style={{
            background: chartTheme.tooltipBg,
            borderColor: chartTheme.tooltipBorder,
            boxShadow: chartTheme.tooltipShadow,
          }}
          data-testid="chart-featured-execution"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: featuredExecution.color }}
              aria-hidden="true"
            />
            <span className="truncate font-data text-xs font-semibold" style={{ color: chartTheme.tooltipBodyColor }}>
              {featuredExecution.count > 1
                ? `${featuredExecution.marker.text} x${formatNumber(featuredExecution.count, { maximumFractionDigits: 0 })}`
                : featuredExecution.marker.text}
            </span>
            <span className="font-data text-xs font-semibold tabular-nums" style={{ color: chartTheme.tooltipBodyColor }}>
              {formatAxisCurrency(featuredExecution.value)}
            </span>
          </div>
          <div className="mt-1 truncate font-data text-[11px]" style={{ color: chartTheme.tooltipTitleColor }}>
            {formatExecutionDetail(featuredExecution)}
          </div>
        </div>
      )}
      {(marketCoverage || executionCoverage) && (
        <div className="pointer-events-none absolute right-3 top-3 z-20 flex max-w-[min(330px,calc(100%-1.5rem))] flex-col items-end gap-2">
          {marketCoverage && (
            <div
              className="rounded-md border px-3 py-2 font-data"
              style={{
                background: chartTheme.tooltipBg,
                borderColor: marketCoverage.tone === 'thin' ? `${STUDY_LINE_COLORS.sma20}77` : chartTheme.tooltipBorder,
                boxShadow: chartTheme.tooltipShadow,
              }}
              title={marketCoverage.title}
              data-testid="chart-market-coverage"
            >
              <div className="text-right text-xs font-semibold tabular-nums" style={{ color: chartTheme.tooltipBodyColor }}>
                {marketCoverage.label}
              </div>
              <div className="mt-0.5 max-w-[290px] truncate text-right text-[10px] font-medium" style={{ color: chartTheme.tooltipTitleColor }}>
                {marketCoverage.detail}
              </div>
            </div>
          )}
          {executionCoverage && (
            <div
              className="rounded-md border px-3 py-2 font-data"
              style={{
                background: chartTheme.tooltipBg,
                borderColor: chartTheme.tooltipBorder,
                boxShadow: chartTheme.tooltipShadow,
              }}
              title={executionCoverage.title}
              data-testid="chart-execution-coverage"
            >
              <div className="text-right text-xs font-semibold tabular-nums" style={{ color: chartTheme.tooltipBodyColor }}>
                {formatNumber(executionCoverage.shown, { maximumFractionDigits: 0 })}
                /{formatNumber(executionCoverage.total, { maximumFractionDigits: 0 })} fills
              </div>
              <div className="mt-0.5 max-w-[260px] truncate text-right text-[10px] font-medium" style={{ color: chartTheme.tooltipTitleColor }}>
                {executionCoverage.detail}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
