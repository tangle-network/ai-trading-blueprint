import { useEffect, useMemo, useRef, useState } from 'react';
import type { AreaData, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import { formatNumber } from '~/lib/format';
import type { useChartTheme } from '~/lib/hooks/useChartTheme';
import { loadLightweightCharts } from './lightweightChartRuntime';
import type { PerformanceChartPoint } from './performanceChart';

type ChartTheme = ReturnType<typeof useChartTheme>;

export interface TradeChartMarker {
  tooltip: string;
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  position: 'aboveBar' | 'belowBar' | 'inBar';
  text: string;
}

interface TradingPerformanceChartProps {
  points: PerformanceChartPoint[];
  tradeMarkers: Array<TradeChartMarker | null>;
  chartTheme: ChartTheme;
}

interface PreparedPoint {
  point: PerformanceChartPoint;
  time: UTCTimestamp;
}

interface HoverReadout {
  label: string;
  value: number;
}

const SYNTHETIC_TIME_BASE_SECONDS = 1_700_000_000;

function formatAxisCurrency(value: number): string {
  return `$${formatNumber(value, { maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
}

function timeKey(time: Time): string {
  if (typeof time === 'number') return String(time);
  if (typeof time === 'string') return time;
  return `${time.year}-${time.month}-${time.day}`;
}

function prepareChartPoints(points: PerformanceChartPoint[]): PreparedPoint[] {
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

function toSeriesData(preparedPoints: PreparedPoint[]): AreaData<Time>[] {
  return preparedPoints.map(({ point, time }) => ({
    time,
    value: point.value,
  }));
}

function toSeriesMarkers(
  preparedPoints: PreparedPoint[],
  tradeMarkers: Array<TradeChartMarker | null>,
): Array<SeriesMarker<Time>> {
  return tradeMarkers.flatMap((marker, index) => {
    const preparedPoint = preparedPoints[index];
    if (!marker || !preparedPoint) return [];

    return [{
      id: `${preparedPoint.time}-${index}-${marker.text}`,
      time: preparedPoint.time,
      position: marker.position,
      shape: marker.shape,
      color: marker.color,
      text: marker.text,
      size: 1.35,
    }];
  });
}

export function TradingPerformanceChart({
  points,
  tradeMarkers,
  chartTheme,
}: TradingPerformanceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverReadout, setHoverReadout] = useState<HoverReadout | null>(null);
  const preparedPoints = useMemo(() => prepareChartPoints(points), [points]);
  const latestPoint = preparedPoints[preparedPoints.length - 1]?.point ?? null;
  const firstPoint = preparedPoints[0]?.point ?? null;
  const positive = latestPoint && firstPoint ? latestPoint.value >= firstPoint.value : true;
  const lineColor = positive ? chartTheme.positive : chartTheme.negative;
  const fillTopColor = positive ? chartTheme.positiveGradientStart : chartTheme.negativeGradientStart;
  const chartMarkers = useMemo(
    () => toSeriesMarkers(preparedPoints, tradeMarkers),
    [preparedPoints, tradeMarkers],
  );

  useEffect(() => {
    if (!containerRef.current || preparedPoints.length === 0) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void loadLightweightCharts().then((charts) => {
      if (cancelled || !containerRef.current) return;

      const data = toSeriesData(preparedPoints);
      const pointByTime = new Map(preparedPoints.map((preparedPoint) => [
        String(preparedPoint.time),
        preparedPoint.point,
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
          barSpacing: preparedPoints.length < 3 ? 80 : 12,
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: Time) => pointByTime.get(timeKey(time))?.label ?? '',
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

      chart.timeScale().fitContent();

      const crosshairHandler = (param: Parameters<typeof chart.subscribeCrosshairMove>[0] extends (value: infer T) => void ? T : never) => {
        if (!param.time) {
          setHoverReadout(null);
          return;
        }

        const point = pointByTime.get(timeKey(param.time));
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
    chartMarkers,
    chartTheme.gradientEnd,
    chartTheme.gridColor,
    chartTheme.hoverBorderColor,
    chartTheme.tickColor,
    chartTheme.tooltipBg,
    fillTopColor,
    lineColor,
    preparedPoints,
  ]);

  const readout = hoverReadout ?? (latestPoint
    ? {
        label: latestPoint.tooltipLabel,
        value: latestPoint.value,
      }
    : null);

  return (
    <div className="relative h-full min-h-[520px] w-full overflow-hidden rounded-lg" data-testid="tradingview-performance-chart">
      <div ref={containerRef} className="absolute inset-0" />
      {readout && (
        <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/88 px-3 py-2 shadow-[0_12px_34px_rgba(0,0,0,0.22)] backdrop-blur">
          <div className="font-data text-[11px] uppercase tracking-wider text-arena-elements-textTertiary">
            {readout.label}
          </div>
          <div className="mt-1 font-data text-xl font-bold text-arena-elements-textPrimary">
            {formatAxisCurrency(readout.value)}
          </div>
        </div>
      )}
      <a
        href="https://www.tradingview.com/lightweight-charts/"
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-3 right-4 rounded-full border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/72 px-2.5 py-1 font-data text-[10px] uppercase tracking-wider text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textPrimary"
      >
        Charts by TradingView
      </a>
    </div>
  );
}
