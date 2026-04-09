import { useEffect, useMemo } from 'react';
import { selectedChainIdStore } from '@tangle-network/blueprint-ui';
import { useBotMetrics, useBotPortfolio, useBotTrades } from './useBotApi';
import type { BotOperatorKind } from '~/lib/types/bot';
import { syncTradesIntoTxStore } from '~/lib/utils/txHistorySync';

interface MetricsSnapshot {
  account_value_usd: number;
  unrealized_pnl: number;
  realized_pnl: number;
  drawdown_pct: number;
}

interface BotLiveSummaryOptions {
  botId: string;
  botName?: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  enabled?: boolean;
}

export interface BotLiveSummary {
  pnlPercent: number | null;
  pnlAbsolute: number | null;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  portfolioValue: number | null;
  avgValidatorScore: number | null;
  isLoading: boolean;
}

export type PortfolioValueState = 'missing' | 'priced' | 'unpriced';

function roundTo(value: number, decimals: number) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function computeSharpeRatio(snapshots: MetricsSnapshot[]): number | null {
  if (snapshots.length < 4) return null;

  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i += 1) {
    const previous = snapshots[i - 1]?.account_value_usd ?? 0;
    const current = snapshots[i]?.account_value_usd ?? 0;
    if (previous <= 0 || !Number.isFinite(previous) || !Number.isFinite(current)) continue;
    returns.push((current - previous) / previous);
  }

  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
  if (variance <= Number.EPSILON) return null;

  const standardDeviation = Math.sqrt(variance);
  return roundTo((mean / standardDeviation) * Math.sqrt(returns.length), 2);
}

export function summarizeBotLiveData(
  snapshots: MetricsSnapshot[] | undefined,
  portfolioValue: number | null | undefined,
  validatorScores: Array<number | undefined>,
  portfolioValueState: PortfolioValueState = 'missing',
): Omit<BotLiveSummary, 'isLoading'> {
  const validSnapshots = snapshots ?? [];
  const first = validSnapshots[0];
  const latest = validSnapshots[validSnapshots.length - 1];

  const pnlAbsolute = latest
    ? roundTo(latest.realized_pnl + latest.unrealized_pnl, 2)
    : null;

  const pnlPercent = first && latest && first.account_value_usd > 0
    ? roundTo(((latest.account_value_usd - first.account_value_usd) / first.account_value_usd) * 100, 1)
    : null;

  const maxDrawdown = validSnapshots.length > 0
    ? roundTo(Math.max(...validSnapshots.map((snapshot) => snapshot.drawdown_pct)), 1)
    : null;

  const scores = validatorScores.filter((score): score is number => typeof score === 'number');
  const avgValidatorScore = scores.length > 0
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : null;

  const hasResolvedPortfolioValue = typeof portfolioValue === 'number' && Number.isFinite(portfolioValue);
  const derivedPortfolioValue = portfolioValueState === 'priced'
    ? (hasResolvedPortfolioValue ? portfolioValue : null)
    : portfolioValueState === 'missing'
      ? latest?.account_value_usd ?? null
      : null;

  return {
    pnlPercent,
    pnlAbsolute,
    sharpeRatio: computeSharpeRatio(validSnapshots),
    maxDrawdown,
    winRate: null,
    portfolioValue: typeof derivedPortfolioValue === 'number' && Number.isFinite(derivedPortfolioValue)
      ? roundTo(derivedPortfolioValue, 2)
      : null,
    avgValidatorScore,
  };
}

export function useBotLiveSummary({
  botId,
  botName = '',
  operatorApiUrl,
  operatorKind,
  enabled = true,
}: BotLiveSummaryOptions): BotLiveSummary {
  const metricsQuery = useBotMetrics(botId, 30, {
    operatorApiUrl,
    operatorKind,
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
  const portfolioQuery = useBotPortfolio(botId, {
    operatorApiUrl,
    operatorKind,
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  });
  const tradesQuery = useBotTrades(botId, botName, 100, {
    operatorApiUrl,
    operatorKind,
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });

  useEffect(() => {
    const trades = tradesQuery.data ?? [];
    if (trades.length === 0) return;
    const fallbackChainId = selectedChainIdStore.get() || 31337;
    syncTradesIntoTxStore(trades, fallbackChainId);
  }, [tradesQuery.data]);

  return useMemo(() => {
    const portfolioValueState: PortfolioValueState = !portfolioQuery.data
      ? 'missing'
      : portfolioQuery.data.hasUnpricedPositions || portfolioQuery.data.displayTotalValueUsd == null
        ? 'unpriced'
        : 'priced';

    const summary = summarizeBotLiveData(
      metricsQuery.data,
      portfolioQuery.data?.displayTotalValueUsd ?? null,
      (tradesQuery.data ?? []).map((trade) => trade.validatorScore),
      portfolioValueState,
    );

    return {
      ...summary,
      isLoading: metricsQuery.isLoading || portfolioQuery.isLoading || tradesQuery.isLoading,
    };
  }, [
    metricsQuery.data,
    metricsQuery.isLoading,
    portfolioQuery.data,
    portfolioQuery.isLoading,
    tradesQuery.data,
    tradesQuery.isLoading,
  ]);
}
