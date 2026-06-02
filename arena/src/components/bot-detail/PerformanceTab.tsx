import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { Bot } from '~/lib/types/bot';
import { Card, CardHeader, CardTitle, CardContent } from '@tangle-network/blueprint-ui/components';
import { useChartTheme } from '~/lib/hooks/useChartTheme';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import {
  useBotMarketCandles,
  useBotMetrics,
  useBotMetricsSummary,
  useBotPortfolio,
  useBotTradePage,
} from '~/lib/hooks/useBotApi';
import { Skeleton } from '~/components/ui/Skeleton';
import { formatNumber } from '~/lib/format';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { readStrategyNumber } from '~/lib/utils/botStrategy';
import { buildPerformanceChartPoints } from './performanceChart';
import type { Trade } from '~/lib/types/trade';
import {
  formatTradeActionLabel,
  formatTradeUsd,
  getHyperliquidMarketLabel,
  getTradeActionToneClass,
  getTradeInstrumentBadgeText,
  getTradeMarketLabel,
  isBuySideTradeAction,
  isSellSideTradeAction,
} from '~/lib/tradeDisplay';
import { TradingPerformanceChart, type TradeChartMarker } from './TradingPerformanceChart';
import { UnverifiedDataNotice } from './shared/DataAccessNotices';
import { PERFORMANCE_SECTION_COPY } from './metricCopy';
import { buildDecisionItemsFromTrades } from '~/lib/decisionFeed';
import { DecisionInspector } from './shared/DecisionInspector';

const LIVE_NAV_APPEND_THRESHOLD_MS = 60_000;
const TRADE_MARKER_LOOKBACK_LIMIT = 100;
const PerformanceCopilotPanel = lazy(() =>
  import('./PerformanceCopilotPanel').then((module) => ({
    default: module.PerformanceCopilotPanel,
  })),
);

type PerformanceRange = '1d' | '7d' | '30d' | '6m' | '1y';
type PerformanceChartMode = 'market' | 'nav';
type ExecutionCountSource = 'trade-total' | 'metric-total' | 'loaded-trades' | 'none';

const PERFORMANCE_RANGES: Array<{ value: PerformanceRange; label: string; days: number }> = [
  { value: '1d', label: '1D', days: 1 },
  { value: '7d', label: '7D', days: 7 },
  { value: '30d', label: '30D', days: 30 },
  { value: '6m', label: '6M', days: 183 },
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
  const value = readStrategyNumber(raw);
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function readStrategyString(strategyConfig: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!strategyConfig) return null;
  for (const key of keys) {
    const value = strategyConfig[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeCandleToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^0x[a-f0-9]{32,}$/i.test(trimmed)) return trimmed;
  return trimmed
    .replace(/-PERP$/i, '')
    .replace(/\/USD[CT]?$/i, '')
    .replace(/-USD[CT]?$/i, '')
    .toUpperCase();
}

function inferMarketCandleToken(bot: Bot, trades: Trade[] | undefined): string | null {
  const latestTrade = trades?.find((trade) => Number.isFinite(trade.timestamp));
  if (latestTrade?.hyperliquidMetadata?.asset) {
    return normalizeCandleToken(latestTrade.hyperliquidMetadata.asset);
  }
  if (bot.strategyType === 'hyperliquid_perp') {
    return normalizeCandleToken(readStrategyString(bot.strategyConfig, [
      'asset',
      'symbol',
      'market',
      'market_symbol',
      'base_asset',
    ]));
  }
  if (latestTrade?.predictionMetadata?.tokenId) {
    return normalizeCandleToken(latestTrade.predictionMetadata.tokenId);
  }
  return normalizeCandleToken(
    latestTrade?.tokenOut
      ?? readStrategyString(bot.strategyConfig, ['asset', 'symbol', 'token', 'base_asset']),
  );
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

function formatChartNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const maximumFractionDigits = value >= 1000 ? 0 : 2;
  return formatNumber(value, {
    maximumFractionDigits,
    minimumFractionDigits: value >= 1000 || Number.isInteger(value) ? 0 : Math.min(2, maximumFractionDigits),
  });
}

function resolveExecutionCount({
  metricCount,
  summaryCount,
  rosterCount,
  loadedTrades,
  tradeTotal,
}: {
  metricCount?: number | null;
  summaryCount?: number | null;
  rosterCount?: number | null;
  loadedTrades: number;
  tradeTotal?: number | null;
}): { value: number; source: ExecutionCountSource; loaded: number; total: number | null } {
  if (tradeTotal != null && tradeTotal > 0) {
    return {
      value: tradeTotal,
      source: 'trade-total',
      loaded: loadedTrades,
      total: tradeTotal,
    };
  }

  const bestMetricCount = Math.max(metricCount ?? 0, summaryCount ?? 0, rosterCount ?? 0);
  if (loadedTrades > bestMetricCount) {
    return {
      value: loadedTrades,
      source: 'loaded-trades',
      loaded: loadedTrades,
      total: null,
    };
  }

  if (bestMetricCount > 0) {
    return {
      value: bestMetricCount,
      source: 'metric-total',
      loaded: loadedTrades,
      total: null,
    };
  }

  if (loadedTrades > 0) {
    return {
      value: loadedTrades,
      source: 'loaded-trades',
      loaded: loadedTrades,
      total: null,
    };
  }

  return {
    value: 0,
    source: 'none',
    loaded: loadedTrades,
    total: null,
  };
}

function executionCountLabel(source: ExecutionCountSource): string {
  if (source === 'loaded-trades') return 'Loaded Trades';
  if (source === 'none') return 'Trades';
  return 'Total Trades';
}

function executionCountSubvalue({ source, loaded, total }: { source: ExecutionCountSource; loaded: number; total: number | null }): string | null {
  if (total != null && loaded > 0 && loaded < total) return `${loaded.toLocaleString()} loaded`;
  if (source === 'metric-total' && loaded > 0) return `${loaded.toLocaleString()} ledger rows`;
  return null;
}

function tradeMarkerColor(trade: Trade, chartTheme: ReturnType<typeof useChartTheme>): string {
  if (isSellSideTradeAction(trade.action)) return chartTheme.negative;
  if (isBuySideTradeAction(trade.action)) return chartTheme.positive;
  return '#f59e0b';
}

function tradeMarkerShape(trade: Trade): TradeChartMarker['shape'] {
  if (isSellSideTradeAction(trade.action)) return 'arrowDown';
  if (isBuySideTradeAction(trade.action)) return 'arrowUp';
  return 'circle';
}

function tradeMarkerPosition(trade: Trade): TradeChartMarker['position'] {
  if (isSellSideTradeAction(trade.action)) return 'aboveBar';
  if (isBuySideTradeAction(trade.action)) return 'belowBar';
  return 'inBar';
}

function formatTradeMarkerText(trade: Trade): string {
  if (trade.action === 'open_long') return 'LONG';
  if (trade.action === 'open_short') return 'SHORT';
  if (trade.action === 'close_long' || trade.action === 'close_short') return 'CLOSE';
  if (trade.action === 'sell') return 'SELL';
  if (trade.action === 'buy') return 'BUY';
  return formatTradeActionLabel(trade.action);
}

function formatTradeMarkerTooltip(trade: Trade): string {
  const pair = getTradeMarketLabel(trade);
  const notional = trade.notionalUsd != null && trade.notionalUsd > 0
    ? ` · ${formatTradeUsd(trade.notionalUsd)}`
    : '';
  return `${formatTradeActionLabel(trade.action)} ${pair}${notional}`;
}

function formatTradeStatus(value: string | null | undefined): string {
  if (!value) return 'Pending';
  return value.replace(/_/g, ' ').toUpperCase();
}

function formatTradeMicrostructure(trade: Trade): string {
  if (trade.execution?.slippageBps != null) {
    return `${formatNumber(trade.execution.slippageBps, { maximumFractionDigits: 1 })} bps slip`;
  }
  if (trade.gasUsed) return `Gas ${trade.gasUsed}`;
  if (trade.validatorScore != null) {
    return `Score ${formatNumber(trade.validatorScore, { maximumFractionDigits: 0 })}`;
  }
  return trade.paperTrade ? 'Paper fill' : formatTradeStatus(trade.execution?.status ?? trade.status);
}

function buildTradeMarkers(
  trades: Trade[] | undefined,
  chartTheme: ReturnType<typeof useChartTheme>,
): TradeChartMarker[] {
  return (trades ?? [])
    .filter((trade) => Number.isFinite(trade.timestamp))
    .map((trade) => ({
      id: trade.id,
      timestampMs: trade.timestamp,
      tooltip: formatTradeMarkerTooltip(trade),
      color: tradeMarkerColor(trade, chartTheme),
      shape: tradeMarkerShape(trade),
      position: tradeMarkerPosition(trade),
      text: formatTradeMarkerText(trade),
    }))
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

interface PerformanceTabProps {
  bot: Bot;
  isLive: boolean;
  canCommand?: boolean;
}

export function PerformanceTab({ bot, isLive, canCommand = false }: PerformanceTabProps) {
  const chartTheme = useChartTheme();
  const operatorAuth = useOperatorAuth(bot.operatorApiUrl ?? '');
  const isHyperliquidPerpBot = bot.strategyType === 'hyperliquid_perp';
  const [range, setRange] = useState<PerformanceRange>('30d');
  const [chartMode, setChartMode] = useState<PerformanceChartMode>('market');
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
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
  const { data: tradePage } = useBotTradePage(bot.id, bot.name, TRADE_MARKER_LOOKBACK_LIMIT, {
    chainId: bot.chainId,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 30_000 : false,
  });
  const tradePageIsPending = tradePage == null;
  const trades = tradePage?.trades;
  const marketCandleToken = useMemo(
    () => inferMarketCandleToken(bot, trades),
    [bot, trades],
  );
  const { data: marketCandles = [] } = useBotMarketCandles(bot.id, marketCandleToken, selectedRange.days, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 60_000 : false,
    limit: selectedRange.value === '1d' ? 360 : 800,
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
    () => buildTradeMarkers(trades, chartTheme),
    [chartTheme, trades],
  );
  const hasMarketCandles = marketCandles.length > 1;
  const effectiveChartMode = chartMode === 'market' && hasMarketCandles ? 'market' : 'nav';
  const chartIsRenderable = chartPoints.length > 0 || hasMarketCandles;

  const executionCount = resolveExecutionCount({
    metricCount: latestRenderableMetric?.trade_count,
    summaryCount: metricsSummary?.trade_count,
    rosterCount: bot.totalTrades,
    loadedTrades: tradePage?.loaded ?? trades?.length ?? 0,
    tradeTotal: tradePage?.total,
  });
  const totalTradesValue = executionCount.value;
  const executionStatLabel = executionCountLabel(executionCount.source);
  const executionStatSubvalue = executionCountSubvalue(executionCount);
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
  const firstMarketCandle = marketCandles[0] ?? null;
  const latestMarketCandle = marketCandles[marketCandles.length - 1] ?? null;
  const marketMove = firstMarketCandle && latestMarketCandle
    ? latestMarketCandle.close - firstMarketCandle.open
    : null;
  const marketMovePercent = marketMove != null && firstMarketCandle && firstMarketCandle.open > 0
    ? (marketMove / firstMarketCandle.open) * 100
    : null;
  const marketHighValue = marketCandles.length > 0
    ? Math.max(...marketCandles.map((candle) => candle.high))
    : null;
  const marketLowValue = marketCandles.length > 0
    ? Math.min(...marketCandles.map((candle) => candle.low))
    : null;
  const marketVolumeValue = marketCandles.length > 0
    ? marketCandles.reduce((sum, candle) => sum + candle.volume, 0)
    : null;
  const recentTradeTape = useMemo(() => (trades ?? []).slice(0, 6), [trades]);
  const tradeDecisionItems = useMemo(
    () => buildDecisionItemsFromTrades(recentTradeTape),
    [recentTradeTape],
  );
  const selectedDecision = tradeDecisionItems.find((item) => item.id === selectedDecisionId)
    ?? tradeDecisionItems[0]
    ?? null;

  useEffect(() => {
    if (tradeDecisionItems.length === 0) {
      if (selectedDecisionId !== null) setSelectedDecisionId(null);
      return;
    }

    if (!tradeDecisionItems.some((item) => item.id === selectedDecisionId)) {
      setSelectedDecisionId(tradeDecisionItems[0].id);
    }
  }, [selectedDecisionId, tradeDecisionItems]);

  const canUseCopilot = Boolean(canCommand && operatorAuth.isAuthenticated && operatorAuth.token);
  const marketMoveTone = marketMove == null
    ? 'text-arena-elements-textPrimary'
    : marketMove >= 0
      ? 'text-arena-elements-icon-success'
      : 'text-arena-elements-icon-error';
  const accountValueForDisplay = livePortfolio?.displayTotalValueUsd
    ?? latestChartValue
    ?? metricsSummary?.portfolio_value_usd
    ?? null;
  const accountPnlForDisplay = chartReturnValue
    ?? metricsSummary?.total_pnl
    ?? null;
  const accountReturnForDisplay = chartReturnPercent
    ?? bot.pnlPercent
    ?? null;
  const accountPnlTone = accountPnlForDisplay == null
    ? 'text-arena-elements-textPrimary'
    : accountPnlForDisplay >= 0
      ? 'text-arena-elements-icon-success'
      : 'text-arena-elements-icon-error';
  const accountReturnTone = accountReturnForDisplay == null
    ? 'text-arena-elements-textPrimary'
    : accountReturnForDisplay >= 0
      ? 'text-arena-elements-icon-success'
      : 'text-arena-elements-icon-error';
  const chartStats = effectiveChartMode === 'market'
    ? [
        {
          label: 'Last Price',
          value: formatChartCurrency(latestMarketCandle?.close ?? null),
          tone: marketMoveTone,
          subvalue: formatSignedChartPercent(marketMovePercent),
          subvaluePrefix: selectedRange.label,
        },
        {
          label: `${selectedRange.label} High / Low`,
          value: formatChartCurrency(marketHighValue),
          tone: 'text-arena-elements-textPrimary',
          subvalue: formatChartCurrency(marketLowValue),
          subvaluePrefix: 'Low',
        },
        {
          label: 'Volume',
          value: formatChartNumber(marketVolumeValue),
          tone: 'text-arena-elements-textPrimary',
        },
        {
          label: 'Range PnL',
          value: accountPnlForDisplay == null ? '—' : formatChartCurrency(accountPnlForDisplay),
          tone: accountPnlTone,
        },
        {
          label: executionStatLabel,
          value: totalTradesValue > 0 ? totalTradesValue.toLocaleString() : '—',
          tone: 'text-arena-elements-textPrimary',
          subvalue: executionStatSubvalue,
          subvaluePrefix: '',
        },
      ] as const
    : [
        {
          label: 'Account Value',
          value: formatChartCurrency(accountValueForDisplay),
          tone: 'text-arena-elements-textPrimary',
        },
        {
          label: 'Range PnL',
          value: accountPnlForDisplay == null ? '—' : formatChartCurrency(accountPnlForDisplay),
          tone: accountPnlTone,
        },
        {
          label: `${selectedRange.label} Return`,
          value: formatSignedChartPercent(accountReturnForDisplay),
          tone: accountReturnTone,
        },
        {
          label: executionStatLabel,
          value: totalTradesValue > 0 ? totalTradesValue.toLocaleString() : '—',
          tone: 'text-arena-elements-textPrimary',
          subvalue: executionStatSubvalue,
          subvaluePrefix: '',
        },
        {
          label: 'Account High / Low',
          value: formatChartCurrency(chartHighValue),
          tone: 'text-arena-elements-textPrimary',
          subvalue: formatChartCurrency(chartLowValue),
          subvaluePrefix: 'Low',
        },
      ] as const;

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <Card className="min-h-0 flex-1">
          <CardHeader>
            <CardTitle>{PERFORMANCE_SECTION_COPY.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[520px] w-full" />
          </CardContent>
        </Card>
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {bot.verificationState === 'unverified' && (
        <UnverifiedDataNotice subject="performance snapshots" />
      )}

      <section className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(190px,25dvh)] gap-3 overflow-hidden min-[1280px]:grid-cols-[minmax(0,1fr)_380px] min-[1280px]:grid-rows-none min-[1440px]:grid-cols-[minmax(0,1fr)_420px]">
        <div className="glass-card-strong flex min-h-0 flex-col overflow-hidden rounded-xl p-3 shadow-[0_24px_90px_rgba(0,0,0,0.22)]">
          <div className="mb-3 flex shrink-0 flex-col gap-3 min-[1180px]:flex-row min-[1180px]:items-start min-[1180px]:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-2xl font-bold tracking-tight">
                  {effectiveChartMode === 'market' && marketCandleToken
                    ? `${marketCandleToken} Price`
                    : 'Account Value (USDC)'}
                </h2>
                <span className="rounded-full border border-arena-elements-dividerColor/70 px-2 py-0.5 font-data text-[11px] uppercase tracking-wider text-arena-elements-textTertiary">
                  {effectiveChartMode === 'market' ? 'Market' : 'Account'}
                </span>
              </div>
              {(lastCheckpointLabel || liveNavLabel) && (
                <p className="mt-1.5 text-xs font-data text-arena-elements-textTertiary">
                  {lastCheckpointLabel ? `Last checkpoint: ${lastCheckpointLabel}` : 'Last checkpoint: unavailable'}
                  {liveNavLabel ? ` · Live NAV: ${liveNavLabel}` : ''}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <div
                className="inline-flex w-fit rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/60 p-1"
                role="group"
                aria-label="Chart mode"
              >
                    {(['market', 'nav'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`h-8 rounded-md px-3 text-sm font-data transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 disabled:cursor-not-allowed disabled:opacity-45 ${
                      chartMode === mode
                        ? 'bg-arena-elements-item-backgroundActive text-arena-elements-textPrimary'
                        : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                    }`}
                    aria-pressed={chartMode === mode}
                    disabled={mode === 'market' && !hasMarketCandles}
                    onClick={() => setChartMode(mode)}
                  >
                    {mode === 'market' ? 'Market' : 'Account'}
                  </button>
                ))}
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
                    className={`h-8 rounded-md px-3 text-sm font-data transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
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
          </div>

          <div className="mb-3 grid shrink-0 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {chartStats.map((stat) => (
              <div
                key={stat.label}
                className="min-h-[50px] rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/54 px-3 py-2"
              >
                <div className="truncate text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                  {stat.label}
                </div>
                <div className={`mt-1 truncate font-data text-base font-bold leading-none ${stat.tone}`}>
                  {stat.value}
                </div>
                {'subvalue' in stat && stat.subvalue && (
                  <div className="mt-1 truncate font-data text-xs text-arena-elements-textTertiary">
                    {stat.subvaluePrefix ? `${stat.subvaluePrefix} ` : ''}{stat.subvalue}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            className="min-h-0 flex-1 rounded-xl border border-arena-elements-dividerColor/70 p-2"
            style={{
              background: 'linear-gradient(180deg, rgba(10,10,15,0.92), rgba(10,10,15,0.70))',
            }}
          >
            {chartIsRenderable ? (
              <div className="h-full min-h-[220px] min-[1280px]:min-h-[320px]">
                <TradingPerformanceChart
                  points={chartPoints}
                  tradeMarkers={tradeMarkers}
                  chartTheme={chartTheme}
                  mode={effectiveChartMode}
                  marketCandles={marketCandles}
                  marketLabel={marketCandleToken}
                />
              </div>
            ) : (
              <div className="grid h-full min-h-[220px] place-items-center gap-4 p-3 min-[1280px]:min-h-[320px]">
                <div className="w-full max-w-3xl rounded-xl border border-arena-elements-dividerColor/60 bg-black/18 p-5 text-left shadow-inner">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-data text-[11px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                        Awaiting first checkpoint
                      </div>
                      <h3 className="mt-2 font-display text-2xl font-semibold text-arena-elements-textPrimary">
                        No performance snapshots available yet.
                      </h3>
                    </div>
                    <span className="rounded-full border border-arena-elements-dividerColor/70 px-3 py-1 font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
                      {bot.paperTrade ? 'Paper' : 'Live'}
                    </span>
                  </div>
                  <div className="mt-5 grid gap-2 sm:grid-cols-3">
                    {[
                      { label: 'Agent Trades', value: totalTradesValue > 0 ? totalTradesValue.toLocaleString() : '0' },
                      { label: 'Strategy', value: bot.strategyType },
                      { label: 'Market Feed', value: hasMarketCandles ? `${marketCandles.length}` : 'Account pending' },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="min-w-0 rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/36 px-3 py-2"
                      >
                        <div className="truncate font-data text-[10px] uppercase tracking-wider text-arena-elements-textTertiary">
                          {item.label}
                        </div>
                        <div className="mt-1 truncate font-data text-base font-semibold text-arena-elements-textPrimary">
                          {item.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="flex min-h-0 flex-col overflow-hidden min-[1280px]:gap-3">
          {tradePageIsPending ? (
            <div className="glass-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl p-3">
              <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
                <h3 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-arena-elements-textPrimary">
                  Recent Trades
                </h3>
                <span className="rounded-full border border-arena-elements-dividerColor/70 px-2.5 py-1 text-xs font-data text-arena-elements-textTertiary">
                  Loading
                </span>
              </div>
              <div className="space-y-2">
                {Array.from({ length: 6 }, (_, index) => (
                  <div
                    key={index}
                    className="rounded-lg border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/32 px-3 py-3"
                  >
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="mt-2 h-3 w-40" />
                  </div>
                ))}
              </div>
            </div>
          ) : recentTradeTape.length === 0 ? (
            <LatestAgentTrades
              bots={[bot]}
              enabled={isLive}
              variant="panel"
              limit={6}
              className="min-h-0 flex-1"
            />
          ) : (
            <div className="glass-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl p-3">
              <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
                <h3 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-arena-elements-textPrimary">
                  Recent Trades
                </h3>
                <span className="rounded-full border border-arena-elements-dividerColor/70 px-2.5 py-1 text-xs font-data text-arena-elements-textTertiary">
                  Last {Math.min(recentTradeTape.length, 6)}
                  {tradePage?.total != null
                    ? ` of ${tradePage.total.toLocaleString()}`
                    : trades && trades.length > recentTradeTape.length
                      ? ` of ${trades.length.toLocaleString()} loaded`
                      : ''}
                </span>
              </div>
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,0.9fr)_minmax(210px,1fr)] gap-3">
                <DecisionInspector
                  item={selectedDecision}
                  className="rounded-xl border border-arena-elements-dividerColor/50"
                />
                <div
                  className="min-h-0 overflow-y-auto rounded-xl border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/28"
                  aria-label="Trade decisions"
                  tabIndex={0}
                >
                  <div className="grid grid-cols-[58px_60px_minmax(0,1fr)_82px] gap-2 border-b border-arena-elements-dividerColor/50 px-3 py-2 font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                    <span>Time</span>
                    <span>Side</span>
                    <span>Instrument</span>
                    <span className="text-right">Notional</span>
                  </div>
                  {recentTradeTape.map((trade) => {
                    const decisionId = `trade:${trade.id}`;
                    const isSelected = selectedDecision?.id === decisionId;
                    const instrumentLabel = getTradeMarketLabel(trade);

                    return (
                      <button
                        key={trade.id}
                        type="button"
                        className={`grid w-full grid-cols-[58px_60px_minmax(0,1fr)_82px] items-center gap-2 border-b border-arena-elements-dividerColor/40 px-3 py-2.5 text-left transition-colors last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                          isSelected
                            ? 'bg-violet-500/10 shadow-[inset_3px_0_0_rgba(139,92,246,0.72)]'
                            : 'hover:bg-arena-elements-item-backgroundHover'
                        }`}
                        aria-pressed={isSelected}
                        onClick={() => setSelectedDecisionId(decisionId)}
                      >
                        <div className="font-data text-xs leading-tight text-arena-elements-textTertiary">
                          {formatTradeTime(trade.timestamp)}
                        </div>
                        <div className={`font-data text-xs font-bold ${getTradeActionToneClass(trade.action)}`}>
                          {formatTradeActionLabel(trade.action)}
                        </div>
                        <div className="flex min-w-0 items-center gap-2" title={instrumentLabel}>
                          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 font-data text-[9px] font-bold text-sky-700 ring-1 ring-black/5 dark:bg-sky-500/20 dark:text-sky-200 dark:ring-white/10">
                            {getTradeInstrumentBadgeText(trade)}
                          </span>
                          <span className="truncate font-display text-[13px] font-semibold text-arena-elements-textPrimary">
                            {instrumentLabel}
                          </span>
                        </div>
                        <div className="min-w-0 text-right">
                          <div className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                            {formatTradeUsd(trade.notionalUsd)}
                          </div>
                          <div className="truncate font-data text-[10px] uppercase tracking-wide text-arena-elements-textTertiary">
                            {formatTradeMicrostructure(trade)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {canUseCopilot && (
            <div className="flex h-[260px] shrink-0 overflow-hidden">
              <Suspense
                fallback={
                  <div className="glass-card flex min-h-0 flex-1 flex-col justify-center rounded-xl p-4 text-center text-sm text-arena-elements-textTertiary">
                    Loading copilot…
                  </div>
                }
              >
                <PerformanceCopilotPanel
                  botId={bot.id}
                  botName={bot.name}
                  operatorApiUrl={bot.operatorApiUrl}
                  operatorKind={bot.operatorKind}
                  token={operatorAuth.token as string}
                />
              </Suspense>
            </div>
          )}

        </aside>
      </section>
    </div>
  );
}
