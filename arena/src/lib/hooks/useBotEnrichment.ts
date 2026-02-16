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
 */
export function useBotEnrichment(bots: Bot[]): Bot[] {
  // Build queries for each bot that has an API configured
  const enrichableIndices: number[] = [];
  const enrichableBots = bots.reduce<Array<{ botId: string; serviceId: number; apiUrl: string }>>((acc, bot, i) => {
    const match = bot.id.match(/^service-(\d+)$/);
    if (!match) return acc;
    const serviceId = Number(match[1]);
    const apiUrl = getBotApiUrl(serviceId);
    if (apiUrl) {
      enrichableIndices.push(i);
      acc.push({ botId: bot.id, serviceId, apiUrl });
    }
    return acc;
  }, []);

  const results = useQueries({
    queries: enrichableBots.map(({ botId, apiUrl }) => ({
      queryKey: ['bot-enrichment', botId],
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
      retry: 1,
    })),
  });

  // No enrichable bots? Return as-is
  if (enrichableBots.length === 0) return bots;

  // Merge results back
  const enrichedBots = [...bots];
  for (let qi = 0; qi < results.length; qi++) {
    const result = results[qi];
    const botIndex = enrichableIndices[qi];
    if (!result.data || result.data.length === 0) continue;

    const snapshots = result.data;
    const latest = snapshots[snapshots.length - 1];
    const first = snapshots[0];

    // Compute performance metrics from snapshots
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

  return enrichedBots;
}
