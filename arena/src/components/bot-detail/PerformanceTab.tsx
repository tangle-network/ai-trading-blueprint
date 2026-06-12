import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Bot } from '~/lib/types/bot';
import type { Portfolio, Position } from '~/lib/types/portfolio';
import { useChartTheme } from '~/lib/hooks/useChartTheme';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import {
  useBotChartStudies,
  useBotMarketCandles,
  useBotMetrics,
  useBotMetricsSummary,
  useBotPerformanceSummary,
  useBotPortfolio,
  useBotTradePage,
  type BotPerformanceSummary,
} from '~/lib/hooks/useBotApi';
import { Skeleton } from '~/components/ui/Skeleton';
import { formatNumber } from '~/lib/format';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { readStrategyNumber } from '~/lib/utils/botStrategy';
import { isExplicitPaperValidationBypass } from '~/lib/tradeValidation';
import { buildPerformanceChartPoints } from './performanceChart';
import type { Trade } from '~/lib/types/trade';
import {
  formatTradeActionLabel,
  formatTradeModeLabel,
  formatTradeUsd,
  getHyperliquidSizeLabel,
  getTradeActionToneClass,
  getTradeMarketLabel,
  isBuySideTradeAction,
  isSellSideTradeAction,
} from '~/lib/tradeDisplay';
import {
  TradingPerformanceChart,
  type MarketDataCoverage,
  type TradeChartMarker,
} from './TradingPerformanceChart';
import { UnverifiedDataNotice } from './shared/DataAccessNotices';
import { buildDecisionItemsFromTrades } from '~/lib/decisionFeed';
import { TradeInstrumentDisplay } from './shared/AssetDisplay';
import {
  fillCountEvidenceSubvalue,
  resolveFillCountEvidence,
} from '~/lib/tradeEvidence';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePanePercent,
  shouldCollapsePaneSize,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';
import { PerformanceCopilotPanel } from './PerformanceCopilotPanel';

const LIVE_NAV_APPEND_THRESHOLD_MS = 60_000;
const TRADE_MARKER_PAGE_SIZE = 200;

type PerformanceRange = '1d' | '7d' | '30d' | '6m' | '1y';
type PerformanceChartMode = 'market' | 'nav';

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
const fillTapeTimeFormatter = new Intl.DateTimeFormat('en-US', {
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

function readStrategyChainId(strategyConfig: Record<string, unknown> | undefined): number | undefined {
  if (!strategyConfig) return undefined;
  for (const key of ['protocol_chain_id', 'chain_id']) {
    const raw = strategyConfig[key];
    const parsed = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw)
        : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function isAddressToken(value: string | null | undefined): boolean {
  return /^0x[a-f0-9]{32,}$/i.test(value?.trim() ?? '');
}

function resolveCandleTokenCandidate(
  value: string | null | undefined,
  chainId: number | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!isAddressToken(trimmed)) return trimmed;

  const resolved = resolveAssetDisplay(trimmed, chainId);
  return resolved.isKnown ? resolved.symbol : trimmed;
}

function normalizeCandleToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (isAddressToken(trimmed)) return trimmed;
  const normalized = trimmed
    .replace(/-PERP$/i, '')
    .replace(/\/USD[CT]?$/i, '')
    .replace(/-USD[CT]?$/i, '')
    .toUpperCase();
  if (normalized === 'WETH') return 'ETH';
  if (normalized === 'WBTC') return 'BTC';
  return normalized;
}

function isStableCandleToken(value: string | null | undefined): boolean {
  const token = normalizeCandleToken(value);
  return token === 'USDC' || token === 'USDT' || token === 'DAI' || token === 'USD';
}

function firstRiskCandleToken(...values: Array<string | null | undefined>): string | null {
  const normalized = values.map(normalizeCandleToken).filter((value): value is string => value != null);
  const chartable = normalized.filter((value) => !isAddressToken(value));
  return chartable.find((value) => !isStableCandleToken(value)) ?? chartable[0] ?? null;
}

function inferMarketCandleToken(bot: Bot, trades: Trade[] | undefined): string | null {
  const latestTrade = trades?.find((trade) => Number.isFinite(trade.timestamp));
  const strategyChainId = readStrategyChainId(bot.strategyConfig) ?? latestTrade?.chainId ?? bot.chainId;
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
  return firstRiskCandleToken(
    resolveCandleTokenCandidate(latestTrade?.assetIn.symbol, strategyChainId),
    resolveCandleTokenCandidate(latestTrade?.assetOut.symbol, strategyChainId),
    resolveCandleTokenCandidate(latestTrade?.tokenIn, strategyChainId),
    resolveCandleTokenCandidate(latestTrade?.tokenOut, strategyChainId),
    resolveCandleTokenCandidate(latestTrade?.rawTokenIn, strategyChainId),
    resolveCandleTokenCandidate(latestTrade?.rawTokenOut, strategyChainId),
    resolveCandleTokenCandidate(readStrategyString(bot.strategyConfig, [
      'asset',
      'symbol',
      'token',
      'base_asset',
      'asset_token',
      'cash_token',
    ]), strategyChainId),
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

function formatFillTapeTime(timestamp: number): string {
  return fillTapeTimeFormatter.format(new Date(timestamp));
}

function formatChartNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const maximumFractionDigits = value >= 1000 ? 0 : 2;
  return formatNumber(value, {
    maximumFractionDigits,
    minimumFractionDigits: value >= 1000 || Number.isInteger(value) ? 0 : Math.min(2, maximumFractionDigits),
  });
}

function formatCompactChartNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute >= 1_000_000_000) {
    return `${sign}${formatNumber(absolute / 1_000_000_000, { maximumFractionDigits: 1 })}B`;
  }
  if (absolute >= 1_000_000) {
    return `${sign}${formatNumber(absolute / 1_000_000, { maximumFractionDigits: 1 })}M`;
  }
  if (absolute >= 100_000) {
    return `${sign}${formatNumber(absolute / 1_000, { maximumFractionDigits: 0 })}K`;
  }
  return formatChartNumber(value);
}

function formatChartPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${formatNumber(value, {
    maximumFractionDigits: Math.abs(value) >= 10 ? 1 : 2,
    minimumFractionDigits: Math.abs(value) >= 10 ? 1 : 2,
  })}%`;
}

function formatLeverageValue(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return `${formatNumber(value, {
    maximumFractionDigits: value >= 10 ? 1 : 2,
    minimumFractionDigits: value >= 10 ? 1 : 2,
  })}x`;
}

function marketCandleLimitForRange(range: PerformanceRange): number {
  if (range === '1d') return 10_080;
  if (range === '7d') return 8_640;
  if (range === '30d') return 8_640;
  if (range === '6m') return 8_800;
  return 4_400;
}

function marketCandleFetchDaysForRange(range: PerformanceRange): number {
  if (range === '1d') return 7;
  if (range === '7d') return 30;
  if (range === '30d') return 30;
  if (range === '6m') return 365;
  return 365;
}

function marketCandleIntervalForRange(range: PerformanceRange): string {
  if (range === '1d') return '1m';
  if (range === '7d') return '5m';
  if (range === '30d') return '15m';
  if (range === '6m') return '1h';
  return '4h';
}

function inferMarketCandleSource(bot: Bot, token: string | null | undefined): string | null {
  if (!token || isAddressToken(token) || isStableCandleToken(token)) return null;
  const strategyType = bot.strategyType.toLowerCase();
  if (strategyType.includes('hyperliquid')) return 'hyperliquid';
  if (strategyType.includes('drift')) return 'drift';
  if (strategyType.includes('polymarket')) return 'polymarket';
  return 'binance';
}

function formatMarketSourceLabel(source: string | null | undefined, interval: string | null | undefined): string {
  const key = source?.trim().toLowerCase();
  const sourceLabel = key === 'hyperliquid'
    ? 'Hyperliquid'
    : key === 'binance'
      ? 'Binance'
      : key === 'coinbase'
        ? 'Coinbase'
        : key === 'drift'
          ? 'Drift'
          : key === 'polymarket'
            ? 'Polymarket'
            : key === 'geckoterminal'
              ? 'GeckoTerminal'
              : 'bot store';
  return interval ? `${sourceLabel} ${interval}` : sourceLabel;
}

function tradeMarkerPagesForRange(range: PerformanceRange): number {
  switch (range) {
    case '1d':
      return 3;
    case '7d':
      return 8;
    case '30d':
      return 20;
    case '6m':
      return 40;
    case '1y':
      return 60;
    default:
      return 20;
  }
}

function filterCandlesToWindow<T extends { timestamp: number }>(candles: T[], fromMs: number, toMs: number): T[] {
  return candles.filter((candle) => candle.timestamp >= fromMs && candle.timestamp <= toMs);
}

function terminalStatValueClass(tone: string): string {
  if (tone === 'text-arena-elements-icon-success') {
    return 'text-[var(--arena-terminal-success)]';
  }
  if (tone === 'text-arena-elements-icon-error') {
    return 'text-[var(--arena-terminal-danger)]';
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
  const market = getTradeMarketLabel(trade);
  const notional = trade.notionalUsd != null && trade.notionalUsd > 0
    ? ` · ${formatTradeUsd(trade.notionalUsd)}`
    : '';
  return `${formatTradeActionLabel(trade.action)} ${market}${notional}`;
}

function formatTradeVenueLabel(trade: Trade): string {
  const protocol = trade.targetProtocol?.trim().toLowerCase();
  if (protocol === 'hyperliquid') return 'Hyperliquid';
  if (protocol === 'polymarket') return 'Polymarket';
  if (protocol === 'drift') return 'Drift';
  if (protocol === 'geckoterminal') return 'GeckoTerminal';
  if (protocol) {
    return protocol
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return trade.venue === 'perp' ? 'Perp venue' : 'DEX venue';
}

function formatTradeMarkerPrice(trade: Trade): string {
  const price = trade.execution?.filledPriceUsd
    ?? trade.execution?.requestedPriceUsd
    ?? trade.priceUsd;
  return formatTradeUsd(price);
}

function formatTradeMarkerSize(trade: Trade): string | null {
  return getHyperliquidSizeLabel(trade);
}

function formatTradeMarkerDetail(trade: Trade): string {
  return [
    formatTradeVenueLabel(trade),
    getTradeMarketLabel(trade),
    formatTradeModeLabel(trade),
    formatTradeMarkerSize(trade),
    `${formatTradeMarkerPrice(trade)} fill`,
    trade.notionalUsd != null && trade.notionalUsd > 0 ? `${formatTradeUsd(trade.notionalUsd)} notional` : null,
    formatTradeMicrostructure(trade),
  ]
    .filter((item): item is string => Boolean(item))
    .join(' · ');
}

function formatTradeStatus(value: string | null | undefined): string {
  if (!value) return 'Pending';
  return value.replace(/_/g, ' ').toUpperCase();
}

function isHyperliquidPerpPosition(position: Position): boolean {
  const positionType = position.positionType?.toLowerCase() ?? '';
  return positionType === 'long_perp'
    || positionType === 'short_perp'
    || positionType.includes('perp')
    || position.notionalUsd != null
    || position.leverage != null
    || position.liquidationPrice != null;
}

function marginUsedUsd(position: Position): number | null {
  if (position.marginUsedUsd != null) return position.marginUsedUsd;
  if (position.notionalUsd != null && position.leverage != null && position.leverage > 0) {
    return position.notionalUsd / position.leverage;
  }
  if (position.valueUsd != null && (position.notionalUsd == null || position.valueUsd <= position.notionalUsd)) {
    return position.valueUsd;
  }
  return null;
}

function liquidationDistancePercent(position: Position): number | null {
  if (
    position.currentPrice == null
    || position.currentPrice <= 0
    || position.liquidationPrice == null
    || position.liquidationPrice <= 0
  ) {
    return null;
  }
  return Math.abs(position.currentPrice - position.liquidationPrice) / position.currentPrice * 100;
}

interface HyperliquidRiskSnapshot {
  positions: Position[];
  totalNotionalUsd: number;
  totalMarginUsd: number;
  totalUnrealizedPnlUsd: number | null;
  maxLeverage: number | null;
  nearestLiquidation: {
    price: number;
    distancePercent: number;
  } | null;
  marginUsagePercent: number | null;
}

function buildHyperliquidRiskSnapshot(portfolio: Portfolio | null | undefined): HyperliquidRiskSnapshot | null {
  if (!portfolio) return null;

  const portfolioPositions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const positions = portfolioPositions.filter(isHyperliquidPerpPosition);
  if (positions.length === 0) {
    return {
      positions,
      totalNotionalUsd: 0,
      totalMarginUsd: 0,
      totalUnrealizedPnlUsd: null,
      maxLeverage: null,
      nearestLiquidation: null,
      marginUsagePercent: null,
    };
  }

  const totalNotionalUsd = positions.reduce((sum, position) => sum + (position.notionalUsd ?? 0), 0);
  const totalMarginUsd = positions.reduce((sum, position) => sum + (marginUsedUsd(position) ?? 0), 0);
  const pnlValues = positions
    .map((position) => position.unrealizedPnlUsd)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const leverageValues = positions
    .map((position) => position.leverage)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const nearestLiquidation = positions
    .map((position) => {
      const distancePercent = liquidationDistancePercent(position);
      return position.liquidationPrice != null && distancePercent != null
        ? { price: position.liquidationPrice, distancePercent }
        : null;
    })
    .filter((item): item is { price: number; distancePercent: number } => item != null)
    .sort((left, right) => left.distancePercent - right.distancePercent)[0] ?? null;
  const equity = portfolio.displayTotalValueUsd ?? portfolio.totalValueUsd;

  return {
    positions,
    totalNotionalUsd,
    totalMarginUsd,
    totalUnrealizedPnlUsd: pnlValues.length > 0
      ? pnlValues.reduce((sum, value) => sum + value, 0)
      : null,
    maxLeverage: leverageValues.length > 0 ? Math.max(...leverageValues) : null,
    nearestLiquidation,
    marginUsagePercent: equity != null && equity > 0 && totalMarginUsd > 0
      ? (totalMarginUsd / equity) * 100
      : null,
  };
}

function riskToneClass(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'text-[#d2dad7]';
  return value > 0 ? 'text-[var(--arena-terminal-success)]' : 'text-[#ff5d6c]';
}

function formatTradeMicrostructure(trade: Trade): string {
  if (trade.execution?.slippageBps != null) {
    return `${formatNumber(trade.execution.slippageBps, { maximumFractionDigits: 1 })} bps slip`;
  }
  if (trade.gasUsed) return `Gas ${trade.gasUsed}`;
  if (
    trade.validatorScore != null
    && !isExplicitPaperValidationBypass(trade.validation, trade.paperTrade)
  ) {
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
      executionPriceUsd: trade.execution?.filledPriceUsd
        ?? trade.execution?.requestedPriceUsd
        ?? trade.priceUsd,
      tooltip: formatTradeMarkerTooltip(trade),
      venueLabel: formatTradeVenueLabel(trade),
      marketLabel: getTradeMarketLabel(trade),
      modeLabel: formatTradeModeLabel(trade),
      notionalLabel: trade.notionalUsd != null && trade.notionalUsd > 0
        ? formatTradeUsd(trade.notionalUsd)
        : null,
      priceLabel: formatTradeMarkerPrice(trade),
      sizeLabel: formatTradeMarkerSize(trade),
      statusLabel: formatTradeMicrostructure(trade),
      timeLabel: formatTradeTime(trade.timestamp),
      detail: formatTradeMarkerDetail(trade),
      color: tradeMarkerColor(trade, chartTheme),
      shape: tradeMarkerShape(trade),
      position: tradeMarkerPosition(trade),
      text: formatTradeMarkerText(trade),
    }))
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function hasBenchmarkData(summary: BotPerformanceSummary | null | undefined): summary is BotPerformanceSummary {
  return Boolean(
    summary
    && (
      summary.returnPct != null
      || summary.alphaPct != null
      || summary.benchmarkBuyHoldReturnPct != null
      || summary.maxDrawdownPct != null
    ),
  );
}

function signedPercentTone(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'text-[#d2dad7]';
  return value > 0
    ? 'text-[var(--arena-terminal-success)]'
    : 'text-[var(--arena-terminal-danger)]';
}

function BenchmarkStrip({ summary }: { summary: BotPerformanceSummary }) {
  const windowLabel = summary.windowFromMs != null && summary.windowToMs != null
    ? `${freshnessTimestampFormatter.format(new Date(summary.windowFromMs))} – ${freshnessTimestampFormatter.format(new Date(summary.windowToMs))}`
    : null;
  const capitalLabel = summary.initialCapitalUsd != null && summary.navLatestUsd != null
    ? `${formatChartCurrency(summary.initialCapitalUsd)} → ${formatChartCurrency(summary.navLatestUsd)}`
    : null;
  const maxDrawdownValue = summary.maxDrawdownPct == null
    ? '—'
    : summary.maxDrawdownPct === 0
      ? formatChartPercent(0)
      : `-${formatChartPercent(Math.abs(summary.maxDrawdownPct))}`;
  const cells = [
    {
      label: 'Return',
      value: formatSignedChartPercent(summary.returnPct),
      tone: signedPercentTone(summary.returnPct),
      subvalue: capitalLabel ?? windowLabel,
    },
    {
      label: 'vs Buy & Hold',
      value: formatSignedChartPercent(summary.alphaPct),
      tone: signedPercentTone(summary.alphaPct),
      subvalue: summary.benchmarkBuyHoldReturnPct != null
        ? `B&H ${formatSignedChartPercent(summary.benchmarkBuyHoldReturnPct)}`
        : null,
    },
    {
      label: 'Max DD',
      value: maxDrawdownValue,
      tone: summary.maxDrawdownPct != null && summary.maxDrawdownPct !== 0
        ? 'text-[var(--arena-terminal-danger)]'
        : 'text-[#d2dad7]',
      subvalue: windowLabel,
    },
  ];

  return (
    <section
      aria-label="Performance vs benchmark"
      className="grid shrink-0 grid-cols-3 gap-px border-b border-[#273035] bg-[#273035]"
    >
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0 bg-[#0f1a1f] px-3 py-2">
          <div className="truncate font-data text-[11px] uppercase tracking-[0.12em] text-[#697371] min-[1440px]:text-xs">
            {cell.label}
          </div>
          <div className={`mt-1 truncate font-data text-base font-semibold tabular-nums min-[1440px]:text-lg ${cell.tone}`}>
            {cell.value}
          </div>
          {/* Always render the subvalue row so cell height is identical before
              and after window/capital labels resolve (no vertical reflow). */}
          <div
            className="mt-0.5 truncate font-data text-[11px] text-[#949e9c] min-[1440px]:text-xs"
            title={cell.subvalue ?? undefined}
          >
            {cell.subvalue ?? ' '}
          </div>
        </div>
      ))}
    </section>
  );
}

interface PerformanceTabProps {
  bot: Bot;
  isLive: boolean;
  canCommand?: boolean;
}

interface PerformanceWorkspaceLayout {
  chartPercent: number;
  fillsWidth: number;
  fillsCollapsed: boolean;
}

const PERFORMANCE_WORKSPACE_LAYOUT_KEY = 'arena:performance-workspace-layout';
const DEFAULT_PERFORMANCE_WORKSPACE_LAYOUT: PerformanceWorkspaceLayout = {
  chartPercent: 64,
  fillsWidth: 340,
  fillsCollapsed: false,
};

function normalizePerformanceWorkspaceLayout(value: Partial<PerformanceWorkspaceLayout>): PerformanceWorkspaceLayout {
  return {
    chartPercent: clampNumber(
      Number(value.chartPercent) || DEFAULT_PERFORMANCE_WORKSPACE_LAYOUT.chartPercent,
      48,
      78,
    ),
    fillsWidth: clampNumber(
      Number(value.fillsWidth) || DEFAULT_PERFORMANCE_WORKSPACE_LAYOUT.fillsWidth,
      300,
      520,
    ),
    fillsCollapsed: value.fillsCollapsed === true,
  };
}

export function PerformanceTab({ bot, isLive, canCommand = false }: PerformanceTabProps) {
  const chartTheme = useChartTheme();
  const operatorAuth = useOperatorAuth(bot.operatorApiUrl ?? '');
  const isHyperliquidPerpBot = bot.strategyType === 'hyperliquid_perp';
  const [range, setRange] = useState<PerformanceRange>('30d');
  const [chartMode, setChartMode] = useState<PerformanceChartMode>('market');
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const [usesFillsRail, setUsesFillsRail] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? false
      : window.matchMedia('(min-width: 1600px)').matches,
  );
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    PERFORMANCE_WORKSPACE_LAYOUT_KEY,
    DEFAULT_PERFORMANCE_WORKSPACE_LAYOUT,
    normalizePerformanceWorkspaceLayout,
  );
  const selectedRange = PERFORMANCE_RANGES.find((item) => item.value === range) ?? PERFORMANCE_RANGES[1];
  const selectedRangeEndMs = useMemo(
    () => Date.now(),
    [selectedRange.days],
  );
  const selectedRangeStartMs = selectedRangeEndMs - selectedRange.days * 24 * 60 * 60 * 1000;
  const marketCandleFetchDays = marketCandleFetchDaysForRange(selectedRange.value);
  const marketCandleFetchStartMs = selectedRangeEndMs - marketCandleFetchDays * 24 * 60 * 60 * 1000;
  const tradeMarkerFetchPages = tradeMarkerPagesForRange(selectedRange.value);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(min-width: 1600px)');
    const syncLayout = () => setUsesFillsRail(mediaQuery.matches);
    syncLayout();
    mediaQuery.addEventListener('change', syncLayout);
    return () => mediaQuery.removeEventListener('change', syncLayout);
  }, []);

  const {
    data: apiMetrics,
    isError: hasMetricsError,
    isLoading,
    isPlaceholderData: metricsArePlaceholder,
  } = useBotMetrics(bot.id, selectedRange.days, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 30_000 : false,
  });
  const { data: latestTradePage } = useBotTradePage(bot.id, bot.name, 24, {
    chainId: bot.chainId,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    pages: 1,
    refetchInterval: isLive ? 30_000 : false,
  });
  const { data: markerTradePage } = useBotTradePage(bot.id, bot.name, TRADE_MARKER_PAGE_SIZE, {
    chainId: bot.chainId,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    pages: tradeMarkerFetchPages,
    stopAtTimestampMs: marketCandleFetchStartMs,
    refetchInterval: isLive ? 30_000 : false,
  });
  const tradePage = markerTradePage ?? latestTradePage;
  const tradePageIsPending = latestTradePage == null && markerTradePage == null;
  const trades = markerTradePage?.trades ?? latestTradePage?.trades;
  const latestTrades = latestTradePage?.trades ?? markerTradePage?.trades;
  const marketCandleToken = useMemo(
    () => inferMarketCandleToken(bot, trades),
    [bot, trades],
  );
  const marketCandleSource = useMemo(
    () => inferMarketCandleSource(bot, marketCandleToken),
    [bot, marketCandleToken],
  );
  const marketCandleInterval = marketCandleIntervalForRange(selectedRange.value);
  const { data: marketCandles = [] } = useBotMarketCandles(bot.id, marketCandleToken, marketCandleFetchDays, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 60_000 : false,
    source: marketCandleSource,
    interval: marketCandleInterval,
    backfill: marketCandleSource != null,
    limit: marketCandleLimitForRange(selectedRange.value),
  });
  const { data: chartStudies = [] } = useBotChartStudies(
    bot.id,
    marketCandleToken,
    { fromMs: selectedRangeStartMs, toMs: selectedRangeEndMs },
    {
      operatorApiUrl: bot.operatorApiUrl,
      operatorKind: bot.operatorKind,
      refetchInterval: isLive ? 60_000 : false,
      limit: 12,
      enabled: isLive && marketCandleToken != null,
    },
  );
  const { data: metricsSummary } = useBotMetricsSummary(bot.id, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 30_000 : false,
  });
  const { data: performanceSummary, isLoading: performanceSummaryLoading } = useBotPerformanceSummary(bot.id, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 60_000 : false,
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
  const firstMarketCandle = marketCandles[0] ?? null;
  const latestMarketCandle = marketCandles[marketCandles.length - 1] ?? null;
  const visibleMarketRangeEndMs = latestMarketCandle?.timestamp ?? selectedRangeEndMs;
  const visibleMarketRangeStartMs = visibleMarketRangeEndMs - selectedRange.days * 24 * 60 * 60 * 1000;
  const visibleMarketRange = useMemo(
    () => ({ fromMs: visibleMarketRangeStartMs, toMs: visibleMarketRangeEndMs }),
    [visibleMarketRangeEndMs, visibleMarketRangeStartMs],
  );
  const visibleMarketCandles = useMemo(
    () => filterCandlesToWindow(marketCandles, visibleMarketRangeStartMs, visibleMarketRangeEndMs),
    [marketCandles, visibleMarketRangeEndMs, visibleMarketRangeStartMs],
  );
  const marketStatCandles = visibleMarketCandles.length > 1 ? visibleMarketCandles : marketCandles;
  const firstVisibleMarketCandle = marketStatCandles[0] ?? null;
  const latestVisibleMarketCandle = marketStatCandles[marketStatCandles.length - 1] ?? null;
  const marketDataCoverage = useMemo<MarketDataCoverage | null>(() => (
    hasMarketCandles
      ? {
          sourceLabel: formatMarketSourceLabel(
            latestMarketCandle?.source ?? firstMarketCandle?.source ?? marketCandleSource,
            latestMarketCandle?.interval ?? firstMarketCandle?.interval ?? marketCandleInterval,
          ),
          requestedRangeLabel: selectedRange.label,
          requestedFromMs: visibleMarketRangeStartMs,
          requestedToMs: visibleMarketRangeEndMs,
          loadedFromMs: firstMarketCandle?.timestamp ?? null,
          loadedToMs: latestMarketCandle?.timestamp ?? null,
          botCreatedAtMs: Number.isFinite(bot.createdAt) ? bot.createdAt : null,
        }
      : null
  ), [
    bot.createdAt,
    firstMarketCandle?.interval,
    firstMarketCandle?.source,
    firstMarketCandle?.timestamp,
    hasMarketCandles,
    latestMarketCandle?.interval,
    latestMarketCandle?.source,
    latestMarketCandle?.timestamp,
    marketCandleInterval,
    marketCandleSource,
    selectedRange.label,
    visibleMarketRangeEndMs,
    visibleMarketRangeStartMs,
  ]);
  const effectiveChartMode = chartMode === 'market' && hasMarketCandles ? 'market' : 'nav';
  const chartIsRenderable = chartPoints.length > 0 || hasMarketCandles;

  const fillCountEvidence = resolveFillCountEvidence({
    backendEvidence: markerTradePage?.evidence ?? latestTradePage?.evidence,
    metricTradeCount: latestRenderableMetric?.trade_count,
    summaryTradeCount: metricsSummary?.trade_count,
    rosterTradeCount: bot.totalTrades,
    visibleTradeCount: markerTradePage?.loaded ?? latestTradePage?.loaded ?? trades?.length ?? 0,
    tradePageTotal: markerTradePage?.total ?? latestTradePage?.total,
  });
  const totalTradesValue = fillCountEvidence.value;
  const executionStatSubvalue = fillCountEvidenceSubvalue(fillCountEvidence);
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
  const marketMove = firstVisibleMarketCandle && latestVisibleMarketCandle
    ? latestVisibleMarketCandle.close - firstVisibleMarketCandle.open
    : null;
  const marketMovePercent = marketMove != null && firstVisibleMarketCandle && firstVisibleMarketCandle.open > 0
    ? (marketMove / firstVisibleMarketCandle.open) * 100
    : null;
  const marketHighValue = marketStatCandles.length > 0
    ? Math.max(...marketStatCandles.map((candle) => candle.high))
    : null;
  const marketLowValue = marketStatCandles.length > 0
    ? Math.min(...marketStatCandles.map((candle) => candle.low))
    : null;
  const marketVolumeValue = marketStatCandles.length > 0
    ? marketStatCandles.reduce((sum, candle) => sum + candle.volume, 0)
    : null;
  const recentTradeTape = useMemo(() => (latestTrades ?? []).slice(0, 12), [latestTrades]);
  const tradeDecisionItems = useMemo(
    () => buildDecisionItemsFromTrades(recentTradeTape),
    [recentTradeTape],
  );
  const selectedDecision = tradeDecisionItems.find((item) => item.id === selectedDecisionId)
    ?? tradeDecisionItems[0]
    ?? null;

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
          value: formatCompactChartNumber(marketVolumeValue),
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
          value: totalTradesValue > 0 ? formatNumber(totalTradesValue, { maximumFractionDigits: 0 }) : '—',
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
          value: totalTradesValue > 0 ? formatNumber(totalTradesValue, { maximumFractionDigits: 0 }) : '—',
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
  const hyperliquidRiskSnapshot = isHyperliquidPerpBot
    ? buildHyperliquidRiskSnapshot(livePortfolio ?? null)
    : null;
  const resetLayout = () => setLayout(DEFAULT_PERFORMANCE_WORKSPACE_LAYOUT);
  const toggleFills = () => setLayout((current) => ({
    ...current,
    fillsCollapsed: !current.fillsCollapsed,
  }));
  const startFillsResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setLayout((current) => ({ ...current, fillsCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: usesFillsRail ? 'col-resize' : 'row-resize',
      onMove: (moveEvent) => {
        if (usesFillsRail) {
          const maxWidth = Math.min(520, Math.max(340, rect.width * 0.42));
          const rawWidth = rect.right - moveEvent.clientX;
          if (shouldCollapsePaneSize(rawWidth)) {
            setLayout((current) => ({
              ...current,
              fillsCollapsed: true,
            }));
            return;
          }
          const nextWidth = clampNumber(rawWidth, 300, maxWidth);
          setLayout((current) => ({
            ...current,
            fillsWidth: nextWidth,
            fillsCollapsed: false,
          }));
          return;
        }

        const rawPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
        if (shouldCollapsePanePercent(100 - rawPercent)) {
          setLayout((current) => ({
            ...current,
            fillsCollapsed: true,
          }));
          return;
        }
        const nextPercent = clampNumber(rawPercent, 48, 78);
        setLayout((current) => ({
          ...current,
          chartPercent: nextPercent,
          fillsCollapsed: false,
        }));
      },
    });
  };
  const workspaceStyle = {
    '--performance-chart-fr': `${layout.chartPercent}fr`,
    '--performance-fills-fr': `${100 - layout.chartPercent}fr`,
    '--performance-fills-width': `${layout.fillsWidth}px`,
  } as CSSProperties;
  const workspaceGridClass = layout.fillsCollapsed
    ? 'grid-rows-[minmax(0,1fr)_8px_44px] min-[1600px]:grid-cols-[minmax(0,1fr)_8px_44px] min-[1600px]:grid-rows-none'
    : 'grid-rows-[minmax(0,var(--performance-chart-fr))_8px_minmax(220px,var(--performance-fills-fr))] min-[1600px]:grid-cols-[minmax(0,1fr)_8px_minmax(300px,var(--performance-fills-width))] min-[1600px]:grid-rows-none';

  if (isLoading) {
    return (
      <div className="arena-trace-terminal flex h-full min-h-0 flex-col overflow-hidden">
        <section
          className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_8px_minmax(220px,34fr)] gap-0 overflow-hidden"
          aria-label="Loading performance workspace"
        >
          <div className="col-start-1 row-start-1 flex min-h-0 flex-col overflow-hidden border border-[#273035] bg-[#0f1a1f] shadow-[0_22px_80px_rgba(0,0,0,0.28)]">
            <div className="flex shrink-0 flex-col border-b border-[#273035] bg-[#0f1a1e] min-[1120px]:h-[78px] min-[1120px]:flex-row min-[1120px]:items-stretch">
              <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-[#273035] px-3 py-2 min-[1120px]:w-[178px] min-[1120px]:border-b-0 min-[1120px]:border-r">
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--arena-terminal-success-soft)] text-[var(--arena-terminal-success)]">
                  <span className="i-ph:chart-line-up text-base" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-semibold leading-tight text-[#f6fefd]">
                    Account
                  </h2>
                  <div className="mt-0.5 truncate font-data text-[11px] text-[#949e9c]">
                    Loading performance
                  </div>
                </div>
              </div>

              <div className="grid min-w-0 flex-1 grid-cols-5 divide-x divide-[#273035] overflow-hidden">
                {['Equity', 'PnL', 'Return', 'Fills', 'H / L'].map((label) => (
                  <div key={label} className="min-w-0 px-2.5 py-2 min-[1440px]:px-3">
                    <div className="truncate font-data text-[11px] text-[#949e9c]">
                      {label}
                    </div>
                    <Skeleton className="mt-2 h-4 w-20" />
                    <Skeleton className="mt-2 hidden h-3 w-16 min-[1440px]:block" />
                  </div>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 p-3">
              <Skeleton className="h-full min-h-[260px] w-full" />
            </div>
          </div>

          <div
            className="col-start-1 row-start-2 hidden shrink-0 items-center justify-center bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text-subtle)] lg:flex"
            aria-hidden="true"
          >
            <span className="h-px w-12 bg-current" />
          </div>

          <aside className="col-start-1 row-start-3 flex min-h-0 flex-col overflow-hidden border border-[#273035] bg-[#0f1a1f] p-2">
            <div className="mb-2 flex shrink-0 items-center justify-between gap-3 border-b border-[#273035] px-1 pb-2">
              <h3 className="font-display text-sm font-semibold text-[#f6fefd]">
                Fills
              </h3>
              <span className="font-data text-xs text-[#949e9c]">
                Loading
              </span>
            </div>
            <div className="grid min-h-0 flex-1 grid-rows-4 gap-2 overflow-hidden">
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  className="border border-[#273035] bg-[#0b1418] px-3 py-2"
                >
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="mt-2 h-3 w-40" />
                </div>
              ))}
            </div>
          </aside>
        </section>
      </div>
    );
  }

  if (hasMetricsError) {
    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] py-16 text-center text-arena-elements-textSecondary">
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
    <div className="arena-trace-terminal flex h-full min-h-0 flex-col overflow-hidden">
      {bot.verificationState === 'unverified' && (
        <UnverifiedDataNotice subject="performance snapshots" />
      )}

      <section
        ref={workspaceRef}
        className={`grid min-h-0 flex-1 gap-0 overflow-hidden ${workspaceGridClass}`}
        style={workspaceStyle}
      >
        <div className="col-start-1 row-start-1 flex min-h-0 flex-col overflow-hidden border border-[#273035] bg-[#0f1a1f] shadow-[0_22px_80px_rgba(0,0,0,0.28)]">
          <div className="flex shrink-0 flex-col border-b border-[#273035] bg-[#0f1a1e] min-[1120px]:h-[78px] min-[1120px]:flex-row min-[1120px]:items-stretch">
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-[#273035] px-3 py-2 min-[1120px]:w-[178px] min-[1120px]:border-b-0 min-[1120px]:border-r">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--arena-terminal-success-soft)] text-[var(--arena-terminal-success)]">
                <span className="i-ph:chart-line-up text-base" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate font-display text-lg font-semibold leading-tight text-[#f6fefd] min-[1440px]:text-xl">
                  {chartHeading}
                </h2>
                {(lastCheckpointLabel || liveNavLabel) && (
                  <div className="mt-0.5 truncate font-data text-[11px] text-[#949e9c] min-[1440px]:text-xs">
                    {lastCheckpointLabel ?? 'checkpoint unavailable'}
                    {liveNavLabel ? ` · live ${liveNavLabel}` : ''}
                  </div>
                )}
              </div>
            </div>

            <div className="grid min-w-0 flex-1 grid-cols-5 divide-x divide-[#273035] overflow-hidden">
              {chartStats.map((stat) => (
                <div key={stat.label} className="min-w-0 px-2.5 py-2 min-[1440px]:px-3">
                  <div className="truncate font-data text-[11px] text-[#949e9c] min-[1440px]:text-xs">
                    {stat.shortLabel}
                  </div>
                  <div className={`mt-1 truncate font-data text-lg font-semibold leading-none tabular-nums min-[1440px]:text-xl ${terminalStatValueClass(stat.tone)}`}>
                    {stat.value}
                  </div>
                  {'subvalue' in stat && stat.subvalue && (
                    <div className="mt-1 hidden truncate font-data text-xs text-[#949e9c] min-[1440px]:block">
                      {stat.subvaluePrefix ? `${stat.subvaluePrefix} ` : ''}{stat.subvalue}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex shrink-0 items-center gap-1 border-t border-[#273035] px-2 py-2 min-[1120px]:border-l min-[1120px]:border-t-0">
              <WorkspaceControlButton
                label={layout.fillsCollapsed ? 'Restore fills' : 'Minimize fills'}
                icon={layout.fillsCollapsed ? 'i-ph:sidebar-simple' : 'i-ph:minus-bold'}
                onClick={toggleFills}
              />
              <WorkspaceControlButton
                label="Reset workspace"
                icon="i-ph:arrow-counter-clockwise"
                onClick={resetLayout}
              />
              <div
                className="inline-flex rounded-[5px] bg-[#273035] p-0.5"
                role="group"
                aria-label="Chart mode"
              >
                {(['market', 'nav'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`h-8 rounded-[4px] px-3 font-data text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] disabled:cursor-not-allowed disabled:opacity-45 min-[1440px]:text-sm ${
                      effectiveChartMode === mode
                        ? 'bg-[var(--arena-terminal-accent)] text-[var(--arena-terminal-accent-text)]'
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
                    className={`h-8 rounded-[4px] px-2.5 font-data text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] min-[1440px]:text-sm ${
                      range === item.value
                        ? 'bg-[var(--arena-terminal-text)] text-[var(--arena-terminal-bg)]'
                        : 'text-[#949e9c] hover:bg-[#344148] hover:text-[#f6fefd]'
                    }`}
                    aria-pressed={range === item.value}
                    onClick={() => setRange(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {metricsArePlaceholder && (
                <span
                  role="status"
                  aria-label="Updating range"
                  title="Updating range"
                  className="inline-flex h-8 items-center px-1 font-data text-[11px] text-[#949e9c]"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[var(--arena-terminal-accent)] animate-pulse motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                </span>
              )}
            </div>
          </div>

          {isHyperliquidPerpBot && (
            <section
              aria-label="Hyperliquid exposure"
              className="grid shrink-0 gap-px border-b border-[#273035] bg-[#273035] min-[900px]:grid-cols-[minmax(0,1.08fr)_repeat(5,minmax(0,1fr))]"
            >
              <div className="min-w-0 bg-[#0b1418] px-3 py-2">
                <div className="font-data text-[11px] uppercase tracking-[0.12em] text-[#697371] min-[1440px]:text-xs">
                  Perp Risk
                </div>
                <div className="mt-1 truncate font-display text-base font-semibold text-[#f6fefd] min-[1440px]:text-lg">
                  {hyperliquidRiskSnapshot == null
                    ? 'Risk feed pending'
                    : hyperliquidRiskSnapshot.positions.length === 0
                      ? 'No open perps'
                      : `${formatNumber(hyperliquidRiskSnapshot.positions.length, { maximumFractionDigits: 0 })} open ${hyperliquidRiskSnapshot.positions.length === 1 ? 'position' : 'positions'}`}
                </div>
              </div>
              {[
                {
                  label: 'Notional',
                  value: hyperliquidRiskSnapshot == null
                    ? '—'
                    : formatChartCurrency(hyperliquidRiskSnapshot.totalNotionalUsd > 0 ? hyperliquidRiskSnapshot.totalNotionalUsd : null),
                  subvalue: hyperliquidRiskSnapshot == null
                    ? 'portfolio sync'
                    : `${formatChartCurrency(hyperliquidRiskSnapshot.totalMarginUsd > 0 ? hyperliquidRiskSnapshot.totalMarginUsd : null)} margin`,
                  tone: 'text-[#f6fefd]',
                },
                {
                  label: 'Margin Use',
                  value: formatChartPercent(hyperliquidRiskSnapshot?.marginUsagePercent ?? null),
                  subvalue: 'equity basis',
                  tone: 'text-[#f6fefd]',
                },
                {
                  label: 'Max Lev',
                  value: formatLeverageValue(hyperliquidRiskSnapshot?.maxLeverage ?? null),
                  subvalue: 'open book',
                  tone: 'text-[#f6fefd]',
                },
                {
                  label: 'Nearest Liq',
                  value: hyperliquidRiskSnapshot?.nearestLiquidation
                    ? formatChartCurrency(hyperliquidRiskSnapshot.nearestLiquidation.price)
                    : '—',
                  subvalue: hyperliquidRiskSnapshot?.nearestLiquidation
                    ? `${formatChartPercent(hyperliquidRiskSnapshot.nearestLiquidation.distancePercent)} away`
                    : 'no liquidation price',
                  tone: hyperliquidRiskSnapshot?.nearestLiquidation?.distancePercent != null && hyperliquidRiskSnapshot.nearestLiquidation.distancePercent < 5
                    ? 'text-[#ff5d6c]'
                    : 'text-[#f6fefd]',
                },
                {
                  label: 'uPnL',
                  value: hyperliquidRiskSnapshot?.totalUnrealizedPnlUsd == null
                    ? '—'
                    : formatChartCurrency(hyperliquidRiskSnapshot.totalUnrealizedPnlUsd),
                  subvalue: hyperliquidRiskSnapshot == null
                    ? 'portfolio sync'
                    : livePortfolio?.stale ? 'stale' : 'live account',
                  tone: riskToneClass(hyperliquidRiskSnapshot?.totalUnrealizedPnlUsd ?? null),
                },
              ].map((item) => (
                <div key={item.label} className="min-w-0 bg-[#0f1a1f] px-3 py-2">
                  <div className="truncate font-data text-[11px] uppercase tracking-[0.12em] text-[#697371] min-[1440px]:text-xs">
                    {item.label}
                  </div>
                  <div className={`mt-1 truncate font-data text-base font-semibold tabular-nums min-[1440px]:text-lg ${item.tone}`}>
                    {item.value}
                  </div>
                  <div className="mt-0.5 truncate font-data text-[11px] text-[#949e9c] min-[1440px]:text-xs">
                    {item.subvalue}
                  </div>
                </div>
              ))}
            </section>
          )}

          {hasBenchmarkData(performanceSummary) ? (
            <BenchmarkStrip summary={performanceSummary} />
          ) : performanceSummaryLoading ? (
            // Reserve the strip's footprint while the summary loads so the
            // chart doesn't get pushed down when benchmark data pops in.
            <section
              aria-label="Performance vs benchmark"
              aria-busy="true"
              className="grid shrink-0 grid-cols-3 gap-px border-b border-[#273035] bg-[#273035]"
            >
              {['Return', 'vs Buy & Hold', 'Max DD'].map((label) => (
                <div key={label} className="min-w-0 bg-[#0f1a1f] px-3 py-2">
                  <div className="truncate font-data text-[11px] uppercase tracking-[0.12em] text-[#697371] min-[1440px]:text-xs">
                    {label}
                  </div>
                  <Skeleton className="mt-1.5 h-5 w-16 min-[1440px]:h-6" />
                  <Skeleton className="mt-1.5 h-3.5 w-28 min-[1440px]:h-4" />
                </div>
              ))}
            </section>
          ) : null}

          <div className="min-h-0 flex-1 bg-[#0f1a1f]" aria-busy={metricsArePlaceholder}>
            {chartIsRenderable ? (
              <div className="h-full min-h-[260px] min-[1280px]:min-h-[420px]">
                <TradingPerformanceChart
                  points={chartPoints}
                  tradeMarkers={tradeMarkers}
                  chartTheme={chartTheme}
                  mode={effectiveChartMode}
                  marketCandles={marketCandles}
                  marketLabel={marketCandleToken}
                  marketDataCoverage={marketDataCoverage}
                  visibleRange={visibleMarketRange}
                  chartStudies={chartStudies}
                  fillCountEvidence={fillCountEvidence}
                />
              </div>
            ) : (
              <div className="grid h-full min-h-[260px] place-items-center gap-4 p-3 min-[1280px]:min-h-[420px]">
                <div className="w-full max-w-3xl border border-[#273035] bg-[#0b1418] p-5 text-left">
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
                      { label: 'Agent Trades', value: totalTradesValue > 0 ? formatNumber(totalTradesValue, { maximumFractionDigits: 0 }) : '0' },
                      { label: 'Strategy', value: bot.strategyType },
                      { label: 'Market Feed', value: hasMarketCandles ? `${marketCandles.length}` : 'Account pending' },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="min-w-0 border border-[#273035] bg-[#0f1a1f] px-3 py-2"
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

        <WorkspaceResizeHandle
          orientation={usesFillsRail ? 'vertical' : 'horizontal'}
          className="col-start-1 row-start-2 min-[1600px]:col-start-2 min-[1600px]:row-start-1"
          ariaLabel="Resize performance fills"
          title="Drag to resize chart and fills"
          onPointerDown={startFillsResize}
        />

        {layout.fillsCollapsed ? (
          <WorkspaceCollapsedPane
            label="Fills"
            icon="i-ph:list-bullets"
            orientation={usesFillsRail ? 'vertical' : 'horizontal'}
            className="col-start-1 row-start-3 min-[1600px]:col-start-3 min-[1600px]:row-start-1"
            onClick={() => setLayout((current) => ({ ...current, fillsCollapsed: false }))}
          />
        ) : (
        <aside className="col-start-1 row-start-3 flex min-h-0 flex-col overflow-hidden min-[1600px]:col-start-3 min-[1600px]:row-start-1">
          {tradePageIsPending ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[#273035] bg-[#0f1a1f] p-2">
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
                    className="border border-[#273035] bg-[#0b1418] px-3 py-3"
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[#273035] bg-[#0f1a1f] p-2">
              <div className="mb-1.5 flex h-8 shrink-0 items-center justify-between gap-3 border-b border-[#273035] px-1 pb-1.5">
                <h3 className="font-display text-sm font-semibold text-[#f6fefd]">
                  Fills
                </h3>
                <span className="font-data text-xs text-[#949e9c]">
                  {formatNumber(recentTradeTape.length, { maximumFractionDigits: 0 })}
                  {' / '}
                  {formatNumber(tradePage?.total ?? trades?.length ?? recentTradeTape.length, { maximumFractionDigits: 0 })}
                </span>
              </div>
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_48px] overflow-hidden border border-[#273035] bg-[#0b1418]">
                <div
                  className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
                  aria-label="Recent fills"
                  tabIndex={0}
                >
                  <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_128px] border-b border-[#273035] bg-[#0b1418]/95 px-2 py-1 font-data text-xs uppercase text-[#697371] backdrop-blur min-[1440px]:grid-cols-[minmax(0,1fr)_144px]">
                    <span>Fill</span>
                    <span className="text-right">Notional</span>
                  </div>
                  <div className="divide-y divide-[#273035]">
                    {recentTradeTape.map((trade) => {
                      const decisionId = `trade:${trade.id}`;
                      const selected = selectedDecision?.id === decisionId;
                      const fillDetail = formatTradeMicrostructure(trade);
                      const showFillDetail = fillDetail !== 'Paper fill' ? fillDetail : null;

                      return (
                        <button
                          key={trade.id}
                          type="button"
                          className={`grid min-h-[54px] w-full grid-cols-[minmax(0,1fr)_128px] items-center gap-2 px-2 py-1 text-left transition-colors min-[1440px]:grid-cols-[minmax(0,1fr)_144px] ${
                            selected
                              ? 'bg-[#132329] shadow-[inset_3px_0_0_rgba(80,210,193,0.82)]'
                              : 'hover:bg-[#101f25]'
                          }`}
                          aria-pressed={selected}
                          onClick={() => setSelectedDecisionId(decisionId)}
                          title={`${formatTradeActionLabel(trade.action)} ${getTradeMarketLabel(trade)} · ${formatTradeMicrostructure(trade)}`}
                        >
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={`min-w-0 truncate font-data text-sm font-bold uppercase leading-4 ${getTradeActionToneClass(trade.action)}`}>
                                {formatTradeActionLabel(trade.action)}
                              </span>
                              <span className="shrink-0 font-data text-xs leading-3 text-[#697371]">
                                {formatFillTapeTime(trade.timestamp)}
                              </span>
                            </div>
                            <TradeInstrumentDisplay
                              trade={trade}
                              className="mt-1 w-full overflow-hidden"
                              size="sm"
                              showVenue={false}
                              showSecondary={false}
                              labelClassName="max-w-full !truncate text-[15px] !leading-4 !text-[var(--arena-terminal-text)]"
                            />
                          </div>
                          <div className="min-w-0 text-right">
                            <div className="font-data text-base font-semibold tabular-nums leading-5 text-[#f6fefd] min-[1440px]:text-[17px]">
                              {formatTradeUsd(trade.notionalUsd)}
                            </div>
                            {showFillDetail && (
                              <div className="truncate font-data text-xs leading-3 text-[#697371]">
                                {showFillDetail}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <aside
                  className="min-h-0 border-t border-[#273035] bg-[#0f1a1f] px-2.5 py-1.5"
                  aria-label="Decision inspector"
                >
                  {selectedDecision ? (
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <div className="truncate font-data text-sm font-semibold uppercase text-[var(--arena-terminal-accent)]">
                          {selectedDecision.actionLabel}
                        </div>
                        <div className="shrink-0 font-data text-xs text-[#949e9c]">
                          {selectedDecision.statusLabel}
                        </div>
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-sm leading-5 text-[#d2dad7]">
                        {selectedDecision.reason}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-[#949e9c]">No decisions captured yet.</p>
                  )}
                </aside>
              </div>
            </div>
          )}

          {canUseCopilot && (
            <div className="hidden h-[260px] shrink-0 overflow-hidden min-[1600px]:flex">
              <PerformanceCopilotPanel
                botId={bot.id}
                botName={bot.name}
                operatorApiUrl={bot.operatorApiUrl}
                operatorKind={bot.operatorKind}
                token={operatorAuth.token as string}
              />
            </div>
          )}

        </aside>
        )}
      </section>
    </div>
  );
}
