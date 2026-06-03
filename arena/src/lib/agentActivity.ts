import type { LatestAgentTrade } from '~/lib/hooks/useBotApi';
import { getTradeMarketLabel } from '~/lib/tradeDisplay';
import type { TradeAction } from '~/lib/types/trade';

export const AGENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AgentActivityStats {
  botId: string;
  recentFills: number;
  recentNotionalUsd: number;
  totalVisibleFills: number;
  totalVisibleNotionalUsd: number;
  firstRecentTradeAt: number | null;
  lastTradeAt: number | null;
  lastAction: TradeAction | null;
  lastMarket: string | null;
  tradesPerHour: number;
}

function emptyStats(botId: string): AgentActivityStats {
  return {
    botId,
    recentFills: 0,
    recentNotionalUsd: 0,
    totalVisibleFills: 0,
    totalVisibleNotionalUsd: 0,
    firstRecentTradeAt: null,
    lastTradeAt: null,
    lastAction: null,
    lastMarket: null,
    tradesPerHour: 0,
  };
}

function positiveUsd(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildAgentActivityStats(
  trades: LatestAgentTrade[],
  {
    now = Date.now(),
    windowMs = AGENT_ACTIVITY_WINDOW_MS,
  }: {
    now?: number;
    windowMs?: number;
  } = {},
): Map<string, AgentActivityStats> {
  const byBotId = new Map<string, AgentActivityStats>();
  const windowStart = now - windowMs;
  const maxFutureSkew = now + 5 * 60 * 1000;

  for (const item of trades) {
    const botId = item.botId || item.trade.botId;
    if (!botId) continue;

    const stats = byBotId.get(botId) ?? emptyStats(botId);
    byBotId.set(botId, stats);

    const notionalUsd = positiveUsd(item.trade.notionalUsd);
    stats.totalVisibleFills += 1;
    stats.totalVisibleNotionalUsd += notionalUsd;

    if (stats.lastTradeAt == null || item.trade.timestamp > stats.lastTradeAt) {
      stats.lastTradeAt = item.trade.timestamp;
      stats.lastAction = item.trade.action;
      stats.lastMarket = getTradeMarketLabel(item.trade);
    }

    const inWindow = item.trade.timestamp >= windowStart && item.trade.timestamp <= maxFutureSkew;
    if (!inWindow) continue;

    stats.recentFills += 1;
    stats.recentNotionalUsd += notionalUsd;
    stats.firstRecentTradeAt = stats.firstRecentTradeAt == null
      ? item.trade.timestamp
      : Math.min(stats.firstRecentTradeAt, item.trade.timestamp);
  }

  for (const stats of byBotId.values()) {
    if (stats.recentFills === 0 || stats.firstRecentTradeAt == null || stats.lastTradeAt == null) {
      stats.tradesPerHour = 0;
      continue;
    }

    const activeWindowHours = Math.max(
      1,
      (stats.lastTradeAt - stats.firstRecentTradeAt) / (60 * 60 * 1000),
    );
    stats.tradesPerHour = stats.recentFills / activeWindowHours;
  }

  return byBotId;
}
