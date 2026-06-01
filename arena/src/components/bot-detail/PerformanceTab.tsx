import { useMemo, useState } from 'react';
import { m } from 'framer-motion';
import type { Bot } from '~/lib/types/bot';
import { Card, CardHeader, CardTitle, CardContent } from '@tangle-network/blueprint-ui/components';
import { useChartTheme } from '~/lib/hooks/useChartTheme';
import { useBotMetrics, useBotMetricsSummary, useBotPortfolio, useBotTrades } from '~/lib/hooks/useBotApi';
import { Skeleton, SkeletonCard } from '~/components/ui/Skeleton';
import { formatNumber, normalizeDisplayNumber } from '~/lib/format';
import { buildPerformanceChartPoints, type PerformanceChartPoint } from './performanceChart';
import { getTradePairLabel, type Trade } from '~/lib/types/trade';
import { TradingPerformanceChart, type TradeChartMarker } from './TradingPerformanceChart';
import { UnverifiedDataNotice } from './shared/DataAccessNotices';
import {
  PERFORMANCE_RETURN_FALLBACK_COPY,
  PERFORMANCE_RETURN_WINDOW_COPY,
  PERFORMANCE_SECTION_COPY,
} from './metricCopy';

const LIVE_NAV_APPEND_THRESHOLD_MS = 60_000;
const TRADE_MARKER_LOOKBACK_LIMIT = 100;

type PerformanceRange = '7d' | '30d' | '1y';

const PERFORMANCE_RANGES: Array<{ value: PerformanceRange; label: string; days: number }> = [
  { value: '7d', label: '7D', days: 7 },
  { value: '30d', label: '30D', days: 30 },
  { value: '1y', label: '1Y', days: 365 },
];

const freshnessTimestampFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function readInitialCapitalUsd(strategyConfig?: Record<string, unknown>): number | null {
  const raw = strategyConfig?.initial_capital_usd
    ?? strategyConfig?.initial_capital
    ?? strategyConfig?.cash_balance;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function parseTimestampMs(timestamp?: string | null): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function formatFreshnessTimestamp(timestamp?: string | null): string {
  const parsed = parseTimestampMs(timestamp);
  if (parsed == null) return 'unavailable';
  return freshnessTimestampFormatter.format(new Date(parsed));
}

function formatChartCurrency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${formatNumber(value, { maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
}

function formatSignedChartCurrency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const formatted = formatChartCurrency(Math.abs(value));
  return value < 0 ? `-${formatted}` : `+${formatted}`;
}

function formatSignedChartPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${formatNumber(value, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}%`;
}

function formatTradeTime(timestamp: number): string {
  return freshnessTimestampFormatter.format(new Date(timestamp));
}

function isSellSideAction(action: Trade['action']): boolean {
  return action === 'sell' || action === 'close_long' || action === 'close_short';
}

function isBuySideAction(action: Trade['action']): boolean {
  return action === 'buy' || action === 'open_long' || action === 'open_short';
}

function tradeMarkerColor(trade: Trade, chartTheme: ReturnType<typeof useChartTheme>): string {
  if (isSellSideAction(trade.action)) return chartTheme.negative;
  if (isBuySideAction(trade.action)) return chartTheme.positive;
  return '#f59e0b';
}

function tradeMarkerShape(trade: Trade): TradeChartMarker['shape'] {
  if (isSellSideAction(trade.action)) return 'arrowDown';
  if (isBuySideAction(trade.action)) return 'arrowUp';
  return 'circle';
}

function tradeMarkerPosition(trade: Trade): TradeChartMarker['position'] {
  if (isSellSideAction(trade.action)) return 'aboveBar';
  if (isBuySideAction(trade.action)) return 'belowBar';
  return 'inBar';
}

function formatTradeAction(action: Trade['action']): string {
  return action.replace(/_/g, ' ').toUpperCase();
}

function formatTradeMarkerText(trade: Trade): string {
  if (isSellSideAction(trade.action)) return 'SELL';
  if (isBuySideAction(trade.action)) return 'BUY';
  return formatTradeAction(trade.action);
}

function formatTradeMarkerTooltip(trade: Trade, duplicateCount: number): string {
  const pair = getTradePairLabel(trade);
  const notional = trade.notionalUsd != null && trade.notionalUsd > 0
    ? ` · $${formatNumber(trade.notionalUsd)}`
    : '';
  const extras = duplicateCount > 1 ? ` · ${duplicateCount} trades near this checkpoint` : '';
  return `${formatTradeAction(trade.action)} ${pair}${notional}${extras}`;
}

function nearestChartPointIndex(points: PerformanceChartPoint[], timestampMs: number): number | null {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  points.forEach((point, index) => {
    if (point.timestampMs == null) return;
    const distance = Math.abs(point.timestampMs - timestampMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex >= 0 ? bestIndex : null;
}

function buildTradeMarkers(
  points: PerformanceChartPoint[],
  trades: Trade[] | undefined,
  chartTheme: ReturnType<typeof useChartTheme>,
): Array<TradeChartMarker | null> {
  const markers: Array<TradeChartMarker | null> = Array.from({ length: points.length }, () => null);
  const counts = new Map<number, number>();

  for (const trade of trades ?? []) {
    if (!Number.isFinite(trade.timestamp)) continue;
    const index = nearestChartPointIndex(points, trade.timestamp);
    if (index == null) continue;

    const count = (counts.get(index) ?? 0) + 1;
    counts.set(index, count);
    markers[index] = {
      tooltip: formatTradeMarkerTooltip(trade, count),
      color: tradeMarkerColor(trade, chartTheme),
      shape: tradeMarkerShape(trade),
      position: tradeMarkerPosition(trade),
      text: formatTradeMarkerText(trade),
    };
  }

  return markers;
}

interface PerformanceTabProps {
  bot: Bot;
  isLive: boolean;
}

export function PerformanceTab({ bot, isLive }: PerformanceTabProps) {
  const chartTheme = useChartTheme();
  const isHyperliquidPerpBot = bot.strategyType === 'hyperliquid_perp';
  const [range, setRange] = useState<PerformanceRange>('30d');
  const selectedRange = PERFORMANCE_RANGES.find((item) => item.value === range) ?? PERFORMANCE_RANGES[1];

  const {
    data: apiMetrics,
    isError: hasMetricsError,
    isLoading,
  } = useBotMetrics(bot.id, selectedRange.days, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 30_000 : false,
  });
  const { data: trades } = useBotTrades(bot.id, bot.name, TRADE_MARKER_LOOKBACK_LIMIT, {
    chainId: bot.chainId,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 30_000 : false,
  });
  const { data: metricsSummary } = useBotMetricsSummary(bot.id, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 30_000 : false,
  });
  const { data: livePortfolio } = useBotPortfolio(bot.id, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    chainId: bot.chainId,
    enabled: isLive && isHyperliquidPerpBot,
    refetchInterval: isLive ? 30_000 : false,
  });

  const initialCapitalUsd = readInitialCapitalUsd(bot.strategyConfig);
  const latestMetrics = apiMetrics && apiMetrics.length > 0 ? apiMetrics[apiMetrics.length - 1] : null;
  const renderableMetrics = useMemo(() => {
    const normalizedMetrics = apiMetrics ?? [];
    const positiveMetrics = normalizedMetrics.filter((metric) => metric.account_value_usd > 0);
    return positiveMetrics.length > 0 ? positiveMetrics : normalizedMetrics;
  }, [apiMetrics]);
  const firstRenderableMetric = renderableMetrics[0] ?? null;
  const latestRenderableMetric = renderableMetrics[renderableMetrics.length - 1] ?? latestMetrics;
  const latestSavedTimestampMs = parseTimestampMs(latestRenderableMetric?.timestamp);
  const liveObservedTimestampMs = parseTimestampMs(livePortfolio?.observedAt);
  const shouldAppendLiveNavPoint = isHyperliquidPerpBot
    && livePortfolio?.displayTotalValueUsd != null
    && livePortfolio.displayTotalValueUsd > 0
    && livePortfolio.stale !== true
    && liveObservedTimestampMs != null
    && (
      latestSavedTimestampMs == null
        || liveObservedTimestampMs - latestSavedTimestampMs >= LIVE_NAV_APPEND_THRESHOLD_MS
    );
  const liveNavPoint = useMemo(
    () => shouldAppendLiveNavPoint && livePortfolio?.displayTotalValueUsd != null
      ? {
          value: livePortfolio.displayTotalValueUsd,
          timestamp: livePortfolio.observedAt ?? undefined,
          label: 'Live',
        }
      : null,
    [livePortfolio?.displayTotalValueUsd, livePortfolio?.observedAt, shouldAppendLiveNavPoint],
  );
  const lastCheckpointLabel = latestRenderableMetric
    ? formatFreshnessTimestamp(latestRenderableMetric.timestamp)
    : null;
  const liveNavLabel = shouldAppendLiveNavPoint
    ? formatFreshnessTimestamp(livePortfolio?.observedAt)
    : null;

  const chartPoints = useMemo(
    () => buildPerformanceChartPoints(
      apiMetrics,
      [],
      initialCapitalUsd == null
        ? null
        : {
            value: initialCapitalUsd,
            timestamp: new Date(bot.createdAt).toISOString(),
          },
      liveNavPoint,
    ),
    [apiMetrics, bot.createdAt, initialCapitalUsd, liveNavPoint],
  );
  const tradeMarkers = useMemo(
    () => buildTradeMarkers(chartPoints, trades, chartTheme),
    [chartPoints, chartTheme, trades],
  );

  const hasWindowedReturn = latestRenderableMetric != null
    && firstRenderableMetric != null
    && renderableMetrics.length > 1;
  const snapshotPnlValue = latestRenderableMetric
    ? latestRenderableMetric.realized_pnl + latestRenderableMetric.unrealized_pnl
    : null;
  const totalReturnValue = latestRenderableMetric && initialCapitalUsd != null
    ? latestRenderableMetric.account_value_usd - initialCapitalUsd
    : latestRenderableMetric && firstRenderableMetric && hasWindowedReturn
      ? latestRenderableMetric.account_value_usd - firstRenderableMetric.account_value_usd
      : snapshotPnlValue ?? metricsSummary?.total_pnl ?? bot.pnlAbsolute;
  const totalTradesValue = latestRenderableMetric?.trade_count ?? metricsSummary?.trade_count ?? bot.totalTrades;
  const returnMetricCopy = hasWindowedReturn
    ? PERFORMANCE_RETURN_WINDOW_COPY
    : PERFORMANCE_RETURN_FALLBACK_COPY;

  const summaryCards = [
    {
      label: returnMetricCopy.label,
      value: `$${formatNumber(totalReturnValue)}`,
      color: normalizeDisplayNumber(totalReturnValue) >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error',
      title: returnMetricCopy.title,
    },
    {
      label: 'Total Trades',
      value: totalTradesValue.toString(),
      color: '',
    },
    {
      label: 'Active Since',
      value: new Date(bot.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      color: '',
    },
  ];
  const firstChartPoint = chartPoints[0] ?? null;
  const latestChartPoint = chartPoints[chartPoints.length - 1] ?? null;
  const latestChartValue = latestChartPoint?.value ?? null;
  const firstChartValue = firstChartPoint?.value ?? null;
  const chartReturnValue = latestChartValue != null && firstChartValue != null
    ? latestChartValue - firstChartValue
    : null;
  const chartReturnPercent = chartReturnValue != null && firstChartValue != null && firstChartValue > 0
    ? (chartReturnValue / firstChartValue) * 100
    : null;
  const chartHighValue = chartPoints.length > 0
    ? Math.max(...chartPoints.map((point) => point.value))
    : null;
  const chartLowValue = chartPoints.length > 0
    ? Math.min(...chartPoints.map((point) => point.value))
    : null;
  const recentTradeTape = (trades ?? []).slice(0, 6);
  const chartReturnTone = chartReturnValue == null
    ? 'text-arena-elements-textPrimary'
    : chartReturnValue >= 0
      ? 'text-arena-elements-icon-success'
      : 'text-arena-elements-icon-error';
  const chartStats = [
    {
      label: 'NAV',
      value: formatChartCurrency(latestChartValue),
      tone: 'text-arena-elements-textPrimary',
    },
    {
      label: `${selectedRange.label} Return`,
      value: formatSignedChartPercent(chartReturnPercent),
      tone: chartReturnTone,
    },
    {
      label: 'High',
      value: formatChartCurrency(chartHighValue),
      tone: 'text-arena-elements-textPrimary',
    },
    {
      label: 'Low',
      value: formatChartCurrency(chartLowValue),
      tone: 'text-arena-elements-textPrimary',
    },
  ];

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{PERFORMANCE_SECTION_COPY.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[320px] w-full" />
          </CardContent>
        </Card>
        <div className="grid sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (hasMetricsError) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:warning-circle text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        <h3 className="font-display font-semibold text-base text-arena-elements-textPrimary mb-2">
          Live performance unavailable
        </h3>
        <p className="text-sm">
          We couldn&apos;t load this bot&apos;s verified performance snapshots, so the chart is hidden instead of showing synthetic history.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {bot.verificationState === 'unverified' && (
        <UnverifiedDataNotice subject="performance snapshots" />
      )}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="glass-card-strong rounded-xl p-4 shadow-[0_24px_90px_rgba(0,0,0,0.22)]">
          <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <h2 className="font-display text-2xl font-bold tracking-tight">
                {PERFORMANCE_SECTION_COPY.title}
              </h2>
              <p className="mt-1 max-w-3xl text-base text-arena-elements-textSecondary">
                {PERFORMANCE_SECTION_COPY.description}
              </p>
              {(lastCheckpointLabel || liveNavLabel) && (
                <p className="mt-2 text-sm font-data text-arena-elements-textTertiary">
                  {lastCheckpointLabel ? `Last checkpoint: ${lastCheckpointLabel}` : 'Last checkpoint: unavailable'}
                  {liveNavLabel ? ` · Live NAV: ${liveNavLabel}` : ''}
                </p>
              )}
            </div>
            <div
              className="inline-flex w-fit rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/60 p-1"
              role="group"
              aria-label="Performance date range"
            >
              {PERFORMANCE_RANGES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`h-9 rounded-md px-4 text-sm font-data transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                    range === item.value
                      ? 'bg-arena-elements-item-backgroundActive text-arena-elements-textPrimary shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                  }`}
                  aria-pressed={range === item.value}
                  onClick={() => setRange(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {chartStats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/54 px-3 py-2"
              >
                <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                  {stat.label}
                </div>
                <div className={`mt-1 font-data text-xl font-bold ${stat.tone}`}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          <div
            className="rounded-xl border border-arena-elements-dividerColor/70 p-3"
            style={{
              background: 'radial-gradient(circle at top left, rgba(0,255,136,0.08), transparent 30%), linear-gradient(180deg, rgba(10,10,15,0.88), rgba(10,10,15,0.68))',
            }}
          >
            {chartPoints.length > 0 ? (
              <div className="h-[520px]">
                <TradingPerformanceChart
                  points={chartPoints}
                  tradeMarkers={tradeMarkers}
                  chartTheme={chartTheme}
                />
              </div>
            ) : (
              <div className="flex h-[520px] items-center justify-center">
                <div className="text-center">
                  <div className="i-ph:chart-line text-3xl text-arena-elements-textTertiary mb-3 mx-auto" />
                  <p className="text-sm text-arena-elements-textSecondary">
                    No performance snapshots available yet.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="glass-card rounded-xl p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="font-display text-lg font-semibold">Trade Tape</h3>
              <span className="rounded-full border border-arena-elements-dividerColor/70 px-2.5 py-1 text-xs font-data text-arena-elements-textTertiary">
                Last {Math.min(recentTradeTape.length, 6)}
              </span>
            </div>
            {recentTradeTape.length > 0 ? (
              <div className="space-y-2">
                {recentTradeTape.map((trade) => {
                  const buySide = isBuySideAction(trade.action);
                  const sellSide = isSellSideAction(trade.action);
                  const actionTone = buySide
                    ? 'text-arena-elements-icon-success'
                    : sellSide
                      ? 'text-arena-elements-icon-error'
                      : 'text-amber-600 dark:text-amber-300';

                  return (
                    <div
                      key={trade.id}
                      className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/40 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className={`font-data text-sm font-bold ${actionTone}`}>
                          {formatTradeAction(trade.action)}
                        </div>
                        <div className="font-data text-xs text-arena-elements-textTertiary">
                          {formatTradeTime(trade.timestamp)}
                        </div>
                      </div>
                      <div className="mt-1 truncate font-display text-base font-medium text-arena-elements-textPrimary">
                        {getTradePairLabel(trade)}
                      </div>
                      <div className="mt-1 font-data text-sm text-arena-elements-textSecondary">
                        {trade.notionalUsd != null && trade.notionalUsd > 0
                          ? formatChartCurrency(trade.notionalUsd)
                          : 'Notional unavailable'}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-arena-elements-dividerColor/70 px-3 py-8 text-center text-sm text-arena-elements-textTertiary">
                No recent trade markers in this range.
              </div>
            )}
          </div>

          <div className="glass-card rounded-xl p-4">
            <h3 className="font-display text-lg font-semibold">Checkpoint Readout</h3>
            <dl className="mt-3 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-arena-elements-textTertiary">First point</dt>
                <dd className="font-data text-arena-elements-textPrimary">{firstChartPoint?.tooltipLabel ?? 'Unavailable'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-arena-elements-textTertiary">Latest point</dt>
                <dd className="font-data text-arena-elements-textPrimary">{latestChartPoint?.tooltipLabel ?? 'Unavailable'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-arena-elements-textTertiary">Range PnL</dt>
                <dd className={`font-data ${chartReturnTone}`}>{formatSignedChartCurrency(chartReturnValue)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-arena-elements-textTertiary">Snapshots</dt>
                <dd className="font-data text-arena-elements-textPrimary">{chartPoints.length}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </section>

      <div className="grid sm:grid-cols-3 gap-4">
        {summaryCards.map((card, i) => (
          <m.div
            key={card.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 + i * 0.06 }}
          >
            <Card className="p-5">
              <div
                className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2"
                title={card.title}
              >
                {card.label}
              </div>
              <div className={`text-2xl font-display font-bold ${card.color}`}>
                {card.value}
              </div>
            </Card>
          </m.div>
        ))}
      </div>
    </div>
  );
}
