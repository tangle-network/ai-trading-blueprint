import { useMemo, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Bot } from '~/lib/types/bot';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import { useOperatorAuth } from './useOperatorAuth';
import { operatorJsonWithAuth } from '~/lib/operator/fetch';

interface MetricsSnapshot {
  timestamp: string;
  bot_id: string;
  account_value_usd: number;
  unrealized_pnl: number;
  realized_pnl: number;
  high_water_mark: number;
  drawdown_pct: number;
  positions_count: number;
  trade_count: number;
}

interface MetricsHistoryResponse {
  snapshots: MetricsSnapshot[];
}

interface PortfolioStateResponse {
  total_value_usd?: number | string | null;
  has_unpriced_positions?: boolean;
}

interface TradeCountResponse {
  trades?: unknown[];
  total?: number | string | null;
  count?: number | string | null;
  total_count?: number | string | null;
}

function normalizeSnapshots(data: MetricsSnapshot[] | MetricsHistoryResponse): MetricsSnapshot[] {
  return Array.isArray(data) ? data : data.snapshots;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function portfolioTvlUsd(data: PortfolioStateResponse | null | undefined): number | null {
  if (!data || data.has_unpriced_positions) return null;
  const value = toFiniteNumber(data.total_value_usd);
  return value != null && value >= 0 ? value : null;
}

function toNonNegativeCount(value: number | string | null | undefined): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed < 0) return null;
  return Math.floor(parsed);
}

export function normalizeTradeHistoryCount(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== 'object') return null;

  const response = data as TradeCountResponse;
  const explicitCount = toNonNegativeCount(response.total)
    ?? toNonNegativeCount(response.total_count)
    ?? toNonNegativeCount(response.count);
  const visibleCount = Array.isArray(response.trades) ? response.trades.length : null;

  if (explicitCount != null && visibleCount != null) return Math.max(explicitCount, visibleCount);
  return explicitCount ?? visibleCount;
}

export interface BotEnrichmentOptions {
  enabled?: boolean;
}

export function useBotEnrichment(
  bots: Bot[],
  options: BotEnrichmentOptions = {},
): Bot[] {
  const enabled = options.enabled ?? true;
  const botIds = bots.map((b) => b.id).join(',');

  const enrichable = useMemo(() => {
    if (!enabled) return { indices: [], entries: [] };
    const indices: number[] = [];
    const entries: Array<{ botId: string; operatorApiUrl: string; operatorKind: Bot['operatorKind'] }> = [];
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      if (bot.verificationState !== 'authoritative' || !bot.operatorApiUrl) continue;
      indices.push(i);
      entries.push({
        botId: bot.id,
        operatorApiUrl: bot.operatorApiUrl,
        operatorKind: bot.operatorKind,
      });
    }
    return { indices, entries };
  }, [botIds, bots, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const authByUrl = {
    cloud: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'cloud')?.operatorApiUrl ?? ''),
    instance: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'instance')?.operatorApiUrl ?? ''),
    tee: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'tee')?.operatorApiUrl ?? ''),
  } as const;

  const results = useQueries({
    queries: enrichable.entries.map(({ botId, operatorApiUrl, operatorKind }) => {
      const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
      const auth = authByUrl[operatorKind ?? 'cloud'];
      const needsAuth = deploymentKind !== 'fleet';
      const authKey = needsAuth ? auth.authCacheKey : 'public';

      return {
        queryKey: [
          'bot-enrichment',
          operatorApiUrl,
          botId,
          deploymentKind,
          authKey,
        ] as const,
        queryFn: async (): Promise<MetricsSnapshot[]> => {
          const from = new Date(Date.now() - 30 * 86400000).toISOString();
          const to = new Date().toISOString();
          const path = `${buildBotScopedPathForDeploymentKind(
            deploymentKind,
            botId,
            '/metrics/history',
          )}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`;
          const data = await operatorJsonWithAuth<MetricsSnapshot[] | MetricsHistoryResponse>(
            operatorApiUrl,
            path,
            auth,
            { auth: needsAuth },
          );
          return normalizeSnapshots(data);
        },
        staleTime: 60_000,
        refetchInterval: 60_000,
        retry: 1,
        enabled: enabled && !!operatorApiUrl && (!needsAuth || !!auth.getCachedToken()),
      };
    }),
  });

  const portfolioResults = useQueries({
    queries: enrichable.entries.map(({ botId, operatorApiUrl, operatorKind }) => {
      const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
      const auth = authByUrl[operatorKind ?? 'cloud'];
      const needsAuth = deploymentKind !== 'fleet';
      const authKey = needsAuth ? auth.authCacheKey : 'public';

      return {
        queryKey: [
          'bot-enrichment-portfolio',
          operatorApiUrl,
          botId,
          deploymentKind,
          authKey,
        ] as const,
        queryFn: async (): Promise<PortfolioStateResponse> => {
          const path = buildBotScopedPathForDeploymentKind(
            deploymentKind,
            botId,
            '/portfolio/state',
          );
          return operatorJsonWithAuth<PortfolioStateResponse>(
            operatorApiUrl,
            path,
            auth,
            { auth: needsAuth },
          );
        },
        staleTime: 10_000,
        refetchInterval: 15_000,
        retry: 1,
        enabled: enabled && !!operatorApiUrl && (!needsAuth || !!auth.getCachedToken()),
      };
    }),
  });

  const tradeCountResults = useQueries({
    queries: enrichable.entries.map(({ botId, operatorApiUrl, operatorKind }) => {
      const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
      const auth = authByUrl[operatorKind ?? 'cloud'];
      const needsAuth = deploymentKind !== 'fleet';
      const authKey = needsAuth ? auth.authCacheKey : 'public';

      return {
        queryKey: [
          'bot-enrichment-trade-count',
          operatorApiUrl,
          botId,
          deploymentKind,
          authKey,
        ] as const,
        queryFn: async (): Promise<number | null> => {
          const path = `${buildBotScopedPathForDeploymentKind(
            deploymentKind,
            botId,
            '/trades',
          )}?limit=200`;
          const data = await operatorJsonWithAuth<unknown>(
            operatorApiUrl,
            path,
            auth,
            { auth: needsAuth },
          );
          return normalizeTradeHistoryCount(data);
        },
        staleTime: 30_000,
        refetchInterval: 60_000,
        retry: 1,
        enabled: enabled && !!operatorApiUrl && (!needsAuth || !!auth.getCachedToken()),
      };
    }),
  });

  const prevRef = useRef<Bot[]>(bots);
  const dataFingerprint = results.map((r) =>
    r.data ? `${r.data.length}:${r.data[r.data.length - 1]?.trade_count}` : 'x',
  ).join(',');
  const portfolioFingerprint = portfolioResults.map((r) => {
    const tvl = portfolioTvlUsd(r.data);
    return tvl == null ? 'x' : String(tvl);
  }).join(',');
  const tradeCountFingerprint = tradeCountResults.map((r) =>
    r.data == null ? 'x' : String(r.data),
  ).join(',');

  return useMemo(() => {
    if (enrichable.entries.length === 0) return bots;

    const enrichedBots = [...bots];
    for (let qi = 0; qi < results.length; qi++) {
      const result = results[qi];
      const botIndex = enrichable.indices[qi];
      if (!result.data || result.data.length === 0) continue;

      const snapshots = result.data;
      const latest = snapshots[snapshots.length - 1];
      const first = snapshots[0];

      const pnlAbsolute = latest.realized_pnl + latest.unrealized_pnl;
      const pnlPercent = first.account_value_usd > 0
        ? ((latest.account_value_usd - first.account_value_usd) / first.account_value_usd) * 100
        : 0;
      const maxDrawdown = Math.min(...snapshots.map(s => s.drawdown_pct));
      const sparklineData = snapshots.map(s => s.account_value_usd);

      enrichedBots[botIndex] = {
        ...enrichedBots[botIndex],
        pnlPercent: Math.round(pnlPercent * 10) / 10,
        pnlAbsolute: Math.round(pnlAbsolute),
        maxDrawdown: Math.round(maxDrawdown * 10) / 10,
        totalTrades: Math.max(latest.trade_count, tradeCountResults[qi]?.data ?? 0),
        sparklineData,
      };
    }
    for (let qi = 0; qi < tradeCountResults.length; qi++) {
      const tradeCount = tradeCountResults[qi].data;
      if (tradeCount == null) continue;

      const botIndex = enrichable.indices[qi];
      enrichedBots[botIndex] = {
        ...enrichedBots[botIndex],
        totalTrades: Math.max(enrichedBots[botIndex].totalTrades, tradeCount),
      };
    }
    for (let qi = 0; qi < portfolioResults.length; qi++) {
      const tvl = portfolioTvlUsd(portfolioResults[qi].data);
      if (tvl == null) continue;

      const botIndex = enrichable.indices[qi];
      enrichedBots[botIndex] = {
        ...enrichedBots[botIndex],
        tvl,
      };
    }
    prevRef.current = enrichedBots;
    return enrichedBots;
  }, [botIds, bots, dataFingerprint, portfolioFingerprint, tradeCountFingerprint, enrichable.entries.length, enrichable.indices, results, portfolioResults, tradeCountResults]); // eslint-disable-line react-hooks/exhaustive-deps
}
