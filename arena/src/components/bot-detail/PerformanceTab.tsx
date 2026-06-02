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
  getTradeActionToneClass,
  getTradeMarketLabel,
  isBuySideTradeAction,
  isSellSideTradeAction,
} from '~/lib/tradeDisplay';
import { TradingPerformanceChart, type TradeChartMarker } from './TradingPerformanceChart';
import { UnverifiedDataNotice } from './shared/DataAccessNotices';
import { PERFORMANCE_SECTION_COPY } from './metricCopy';
import { buildDecisionItemsFromTrades } from '~/lib/decisionFeed';
import { DecisionInspector } from './shared/DecisionInspector';
import { TradeInstrumentDisplay } from './shared/AssetDisplay';

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

  if (loadedTrades > 0) {
    return {
      value: loadedTrades,
      source: 'loaded-trades',
      loaded: loadedTrades,
      total: null,
    };
  }

  const bestMetricCount = Math.max(metricCount ?? 0, summaryCount ?? 0, rosterCount ?? 0);
  if (bestMetricCount > 0) {
    return {
      value: bestMetricCount,
      source: 'metric-total',
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

function executionCountSubvalue({ source, loaded, total }: { source: ExecutionCountSource; loaded: number; total: number | null }): string | null {
  if (total != null && loaded > 0 && loaded < total) return `${loaded.toLocaleString()} loaded`;
  if (source === 'metric-total' && loaded > 0) return `${loaded.toLocaleString()} ledger rows`;
  return null;
}

function terminalStatValueClass(tone: string): string {
  if (tone === 'text-arena-elements-icon-success' || tone === 'text-arena-elements-icon-error') {
    return tone;
  }
  return 'text-[#f6fefd]';
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

function formatExecutionMode(trade: Trade): string {
  if (trade.paperTrade || trade.status === 'paper') return 'Paper';
  return trade.execution?.status ? formatTradeStatus(trade.execution.status) : formatTradeStatus(trade.status);
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
  const selectedTrade = selectedDecision?.source === 'trade'
    ? recentTradeTape.find((trade) => `trade:${trade.id}` === selectedDecision.id) ?? recentTradeTape[0] ?? null
    : recentTradeTape[0] ?? null;
  const buyTapeCount = recentTradeTape.filter((trade) => isBuySideTradeAction(trade.action)).length;
  const sellTapeCount = recentTradeTape.filter((trade) => isSellSideTradeAction(trade.action)).length;
  const otherTapeCount = Math.max(0, recentTradeTape.length - buyTapeCount - sellTapeCount);

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
          shortLabel: 'Price',
          value: formatChartCurrency(latestMarketCandle?.close ?? null),
          tone: marketMoveTone,
          subvalue: formatSignedChartPercent(marketMovePercent),
          subvaluePrefix: selectedRange.label,
        },
        {
          label: `${selectedRange.label} High / Low`,
          shortLabel: 'H / L',
          value: formatChartCurrency(marketHighValue),
          tone: 'text-arena-elements-textPrimary',
          subvalue: formatChartCurrency(marketLowValue),
          subvaluePrefix: 'Low',
        },
        {
          label: 'Volume',
          shortLabel: 'Vol',
          value: formatChartNumber(marketVolumeValue),
          tone: 'text-arena-elements-textPrimary',
        },
        {
          label: 'Range PnL',
          shortLabel: 'PnL',
          value: accountPnlForDisplay == null ? '—' : formatChartCurrency(accountPnlForDisplay),
          tone: accountPnlTone,
        },
        {
          label: 'Fills',
          shortLabel: 'Fills',
          value: totalTradesValue > 0 ? totalTradesValue.toLocaleString() : '—',
          tone: 'text-arena-elements-textPrimary',
          subvalue: executionStatSubvalue,
          subvaluePrefix: '',
        },
      ] as const
    : [
        {
          label: 'Account Value',
          shortLabel: 'Equity',
          value: formatChartCurrency(accountValueForDisplay),
          tone: 'text-arena-elements-textPrimary',
        },
        {
          label: 'Range PnL',
          shortLabel: 'PnL',
          value: accountPnlForDisplay == null ? '—' : formatChartCurrency(accountPnlForDisplay),
          tone: accountPnlTone,
        },
        {
          label: `${selectedRange.label} Return`,
          shortLabel: 'Return',
          value: formatSignedChartPercent(accountReturnForDisplay),
          tone: accountReturnTone,
        },
        {
          label: 'Fills',
          shortLabel: 'Fills',
          value: totalTradesValue > 0 ? totalTradesValue.toLocaleString() : '—',
          tone: 'text-arena-elements-textPrimary',
          subvalue: executionStatSubvalue,
          subvaluePrefix: '',
        },
        {
          label: 'Account High / Low',
          shortLabel: 'H / L',
          value: formatChartCurrency(chartHighValue),
          tone: 'text-arena-elements-textPrimary',
          subvalue: formatChartCurrency(chartLowValue),
          subvaluePrefix: 'Low',
        },
      ] as const;
  const chartHeading = effectiveChartMode === 'market'
    ? `${isHyperliquidPerpBot && marketCandleToken ? `${marketCandleToken}-PERP` : marketCandleToken ?? 'Market'}`
    : 'Account';

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

      <section className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(190px,25dvh)] gap-2 overflow-hidden min-[1280px]:grid-cols-[minmax(0,1fr)_332px] min-[1280px]:grid-rows-none min-[1440px]:grid-cols-[minmax(0,1fr)_346px]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] shadow-[0_22px_80px_rgba(0,0,0,0.28)]">
          <div className="flex shrink-0 flex-col border-b border-[#273035] bg-[#0f1a1e] min-[1180px]:h-[72px] min-[1180px]:flex-row min-[1180px]:items-stretch">
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-[#273035] px-3 py-2 min-[1180px]:w-[178px] min-[1180px]:border-b-0 min-[1180px]:border-r">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#123f3a] text-[#50d2c1]">
                <span className="i-ph:chart-line-up text-base" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate font-display text-lg font-semibold leading-tight text-[#f6fefd]">
                  {chartHeading}
                </h2>
                {(lastCheckpointLabel || liveNavLabel) && (
                  <div className="mt-0.5 truncate font-data text-[11px] text-[#949e9c]">
                    {lastCheckpointLabel ?? 'checkpoint unavailable'}
                    {liveNavLabel ? ` · live ${liveNavLabel}` : ''}
                  </div>
                )}
              </div>
            </div>

            <div className="grid min-w-0 flex-1 grid-cols-5 divide-x divide-[#273035] overflow-hidden">
              {chartStats.map((stat) => (
                <div key={stat.label} className="min-w-0 px-2.5 py-2 min-[1440px]:px-3">
                  <div className="truncate font-data text-[11px] text-[#949e9c]">
                    {stat.shortLabel}
                  </div>
                  <div className={`mt-1 truncate font-data text-[15px] font-semibold leading-none tabular-nums ${terminalStatValueClass(stat.tone)}`}>
                    {stat.value}
                  </div>
                  {'subvalue' in stat && stat.subvalue && (
                    <div className="mt-1 hidden truncate font-data text-[11px] text-[#949e9c] min-[1440px]:block">
                      {stat.subvaluePrefix ? `${stat.subvaluePrefix} ` : ''}{stat.subvalue}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex shrink-0 items-center gap-1 border-t border-[#273035] px-2 py-2 min-[1180px]:border-l min-[1180px]:border-t-0">
              <div
                className="inline-flex rounded-[5px] bg-[#273035] p-0.5"
                role="group"
                aria-label="Chart mode"
              >
                {(['market', 'nav'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`h-7 rounded-[4px] px-2.5 font-data text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 disabled:cursor-not-allowed disabled:opacity-45 ${
                      effectiveChartMode === mode
                        ? 'bg-[#50d2c1] text-[#04060c]'
                        : 'text-[#d2dad7] hover:bg-[#344148] hover:text-[#f6fefd]'
                    }`}
                    aria-pressed={effectiveChartMode === mode}
                    disabled={mode === 'market' && !hasMarketCandles}
                    onClick={() => setChartMode(mode)}
                  >
                    {mode === 'market' ? 'Market' : 'NAV'}
                  </button>
                ))}
              </div>
              <div
                className="inline-flex rounded-[5px] bg-[#273035] p-0.5"
                role="group"
                aria-label="Performance date range"
              >
                {PERFORMANCE_RANGES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`h-7 rounded-[4px] px-2 font-data text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
                      range === item.value
                        ? 'bg-[#d2dad7] text-[#04060c]'
                        : 'text-[#949e9c] hover:bg-[#344148] hover:text-[#f6fefd]'
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

          <div className="min-h-0 flex-1 bg-[#0f1a1f]">
            {chartIsRenderable ? (
              <div className="h-full min-h-[260px] min-[1280px]:min-h-[420px]">
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
              <div className="grid h-full min-h-[260px] place-items-center gap-4 p-3 min-[1280px]:min-h-[420px]">
                <div className="w-full max-w-3xl rounded-md border border-[#273035] bg-[#0b1418] p-5 text-left">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-data text-[11px] text-[#949e9c]">
                        Awaiting checkpoint
                      </div>
                      <h3 className="mt-2 font-display text-2xl font-semibold text-[#f6fefd]">
                        No performance snapshots available yet.
                      </h3>
                    </div>
                    <span className="rounded-[4px] border border-[#273035] px-3 py-1 font-data text-xs text-[#949e9c]">
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
                        className="min-w-0 rounded-[5px] border border-[#273035] bg-[#0f1a1f] px-3 py-2"
                      >
                        <div className="truncate font-data text-[10px] text-[#949e9c]">
                          {item.label}
                        </div>
                        <div className="mt-1 truncate font-data text-base font-semibold text-[#f6fefd]">
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

        <aside className="flex min-h-0 flex-col overflow-hidden min-[1280px]:gap-2">
          {tradePageIsPending ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-2">
              <div className="mb-2 flex shrink-0 items-center justify-between gap-3 border-b border-[#273035] px-1 pb-2">
                <h3 className="font-display text-sm font-semibold text-[#f6fefd]">
                  Fills
                </h3>
                <span className="font-data text-xs text-[#949e9c]">
                  Loading
                </span>
              </div>
              <div className="space-y-2">
                {Array.from({ length: 6 }, (_, index) => (
                  <div
                    key={index}
                    className="rounded-[5px] border border-[#273035] bg-[#0b1418] px-3 py-3"
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-2">
              <div className="mb-2 flex shrink-0 items-center justify-between gap-3 border-b border-[#273035] px-1 pb-2">
                <div>
                  <h3 className="font-display text-sm font-semibold text-[#f6fefd]">
                    Fills
                  </h3>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-data text-[11px] text-[#949e9c]">
                    <span>{buyTapeCount} buy</span>
                    <span className="text-[#575e62]">/</span>
                    <span>{sellTapeCount} sell</span>
                    {otherTapeCount > 0 && (
                      <>
                        <span className="text-[#575e62]">/</span>
                        <span>{otherTapeCount} other</span>
                      </>
                    )}
                  </div>
                </div>
                <span className="font-data text-xs text-[#949e9c]">
                  {Math.min(recentTradeTape.length, 6)}
                  {tradePage?.total != null
                    ? ` / ${tradePage.total.toLocaleString()}`
                    : trades && trades.length > recentTradeTape.length
                      ? ` / ${trades.length.toLocaleString()}`
                      : ''}
                </span>
              </div>
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,0.88fr)_minmax(210px,1fr)] gap-2">
                <DecisionInspector
                  item={selectedDecision}
                  variant="terminal"
                  instrumentSlot={selectedTrade ? (
                    <TradeInstrumentDisplay
                      trade={selectedTrade}
                      size="md"
                      showVenue
                      labelClassName="text-base !text-[#f6fefd]"
                    />
                  ) : undefined}
                  className="rounded-[5px] border border-[#273035] bg-[#0b1418]"
                />
                <div
                  className="min-h-0 overflow-y-auto rounded-[5px] border border-[#273035] bg-[#0b1418] p-1.5"
                  aria-label="Recent fills"
                  tabIndex={0}
                >
                  {recentTradeTape.map((trade) => {
                    const decisionId = `trade:${trade.id}`;
                    const isSelected = selectedDecision?.id === decisionId;

                    return (
                      <button
                        key={trade.id}
                        type="button"
                        className={`mb-1.5 grid w-full grid-cols-[72px_minmax(0,1fr)_86px] items-center gap-2 rounded-[5px] border px-2.5 py-2.5 text-left transition-colors last:mb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
                          isSelected
                            ? 'border-[#50d2c1]/45 bg-[#143c38] shadow-[inset_3px_0_0_rgba(80,210,193,0.82)]'
                            : 'border-[#273035] bg-[#0f1a1f] hover:bg-[#16242a]'
                        }`}
                        aria-pressed={isSelected}
                        onClick={() => setSelectedDecisionId(decisionId)}
                      >
                        <div className="min-w-0">
                          <div className={`inline-flex rounded-[3px] border border-current/20 px-1.5 py-0.5 font-data text-[10px] font-semibold uppercase ${getTradeActionToneClass(trade.action)}`}>
                            {formatTradeActionLabel(trade.action)}
                          </div>
                          <div className="mt-1 truncate font-data text-[11px] text-[#949e9c]">
                            {formatTradeTime(trade.timestamp)}
                          </div>
                        </div>
                        <TradeInstrumentDisplay
                          trade={trade}
                          size="sm"
                          showVenue={false}
                          labelClassName="max-w-[150px] text-[14px] !text-[#f6fefd]"
                        />
                        <div className="min-w-0 text-right">
                          <div className="font-data text-sm font-semibold tabular-nums text-[#f6fefd]">
                            {formatTradeUsd(trade.notionalUsd)}
                          </div>
                          <div className="truncate font-data text-[10px] text-[#949e9c]" title={formatTradeMicrostructure(trade)}>
                            {formatExecutionMode(trade)}
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
