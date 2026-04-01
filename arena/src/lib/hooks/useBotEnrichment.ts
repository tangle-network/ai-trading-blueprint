import { useMemo, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Bot } from '~/lib/types/bot';
import { buildBotScopedPath, OPERATOR_API_URL, useOperatorMeta } from '~/lib/operator/meta';
import { useOperatorAuth } from './useOperatorAuth';

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

function normalizeSnapshots(data: MetricsSnapshot[] | MetricsHistoryResponse): MetricsSnapshot[] {
  return Array.isArray(data) ? data : data.snapshots;
}

export function useBotEnrichment(bots: Bot[]): Bot[] {
  const botIds = bots.map((b) => b.id).join(',');
  const { data: meta } = useOperatorMeta();
  const auth = useOperatorAuth(OPERATOR_API_URL);

  const enrichable = useMemo(() => {
    const indices: number[] = [];
    const entries: Array<{ botId: string }> = [];
    if (!meta || !auth.token) {
      return { indices, entries };
    }
    for (let i = 0; i < bots.length; i++) {
      indices.push(i);
      entries.push({ botId: bots[i].id });
    }
    return { indices, entries };
  }, [auth.token, botIds, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useQueries({
    queries: enrichable.entries.map(({ botId }) => ({
      queryKey: ['bot-enrichment', botId, meta?.deployment_kind, auth.token] as const,
      queryFn: async (): Promise<MetricsSnapshot[]> => {
        const from = new Date(Date.now() - 30 * 86400000).toISOString();
        const to = new Date().toISOString();
        const path = `${buildBotScopedPath(meta, botId, '/metrics/history')}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`;
        const res = await fetch(`${OPERATOR_API_URL}${path}`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${auth.token}`,
          },
        });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const data = await res.json() as MetricsSnapshot[] | MetricsHistoryResponse;
        return normalizeSnapshots(data);
      },
      staleTime: 60_000,
      refetchInterval: 60_000,
      retry: 1,
      enabled: !!meta && !!auth.token,
    })),
  });

  const prevRef = useRef<Bot[]>(bots);
  const dataFingerprint = results.map((r) =>
    r.data ? `${r.data.length}:${r.data[r.data.length - 1]?.trade_count}` : 'x',
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
        totalTrades: latest.trade_count,
        sparklineData,
      };
    }
    prevRef.current = enrichedBots;
    return enrichedBots;
  }, [botIds, bots, dataFingerprint, enrichable.entries.length, enrichable.indices, results]); // eslint-disable-line react-hooks/exhaustive-deps
}
