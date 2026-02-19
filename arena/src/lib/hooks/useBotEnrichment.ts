import { useMemo, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Bot } from '~/lib/types/bot';
import { getBotApiUrl } from '~/lib/config/botRegistry';

/**
 * Per-bot metrics response from the HTTP API.
 * GET /metrics/history?from=...&to=...&limit=100
 */
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

/**
 * Enriches a list of on-chain bots with performance data from their HTTP APIs.
 * Fetches /metrics/history from each bot's API in parallel.
 * Returns the same bot list with performance fields filled in where data is available.
 *
 * PERF: Stabilizes output reference — only returns a new array when enrichment
 * data actually changes, preventing downstream useMemo invalidation cascades.
 */
export function useBotEnrichment(bots: Bot[]): Bot[] {
  // Stable list of enrichable bots (only recompute when bot IDs change)
  const botIds = bots.map((b) => b.id).join(',');
  const enrichable = useMemo(() => {
    const indices: number[] = [];
    const entries: Array<{ botId: string; serviceId: number; apiUrl: string }> = [];
    for (let i = 0; i < bots.length; i++) {
      const apiUrl = getBotApiUrl(bots[i].serviceId);
      if (apiUrl) {
        indices.push(i);
        entries.push({ botId: bots[i].id, serviceId: bots[i].serviceId, apiUrl });
      }
    }
    return { indices, entries };
  }, [botIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useQueries({
    queries: enrichable.entries.map(({ botId, apiUrl }) => ({
      queryKey: ['bot-enrichment', botId] as const,
      queryFn: async (): Promise<MetricsSnapshot[]> => {
        const from = new Date(Date.now() - 30 * 86400000).toISOString();
        const to = new Date().toISOString();
        const res = await fetch(`${apiUrl}/metrics/history?from=${from}&to=${to}&limit=100`, {
          headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) throw new Error(`API ${res.status}`);
        return res.json();
      },
      staleTime: 60_000,
      refetchInterval: 60_000,
      retry: 1,
    })),
  });

  const prevRef = useRef<Bot[]>(bots);

  // Build fingerprint of enrichment results to avoid new array on every render
  const dataFingerprint = results.map((r) =>
    r.data ? `${r.data.length}:${r.data[r.data.length - 1]?.trade_count}` : 'x',
  ).join(',');

  // useMemo must always be called (Rules of Hooks) — handle empty case inside
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
  }, [botIds, dataFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps
}
