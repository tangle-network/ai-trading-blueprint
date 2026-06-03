import { describe, expect, it } from 'vitest';
import { buildAgentActivityStats } from './agentActivity';
import type { LatestAgentTrade } from './hooks/useBotApi';
import type { ResolvedAssetDisplay } from './tradeTokenMetadata';
import type { Trade } from './types/trade';

function makeAsset(symbol: string, name = symbol): ResolvedAssetDisplay {
  return {
    rawToken: symbol,
    symbol,
    name,
    primaryLabel: symbol,
    isKnown: true,
    accentClassName: 'bg-slate-500/20 text-slate-100',
    iconText: symbol.slice(0, 3).toUpperCase(),
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    botId: 'bot-1',
    botName: 'ETH Macro Scalper',
    action: 'open_long',
    assetIn: makeAsset('USD'),
    assetOut: makeAsset('ETH', 'Ethereum'),
    tokenIn: 'USD',
    tokenOut: 'ETH',
    amountIn: 1000,
    amountOut: 0.3,
    priceUsd: 3500,
    notionalUsd: 1000,
    timestamp: Date.parse('2026-06-02T12:00:00Z'),
    status: 'paper',
    paperTrade: true,
    targetProtocol: 'hyperliquid',
    venue: 'paper',
    hyperliquidMetadata: { asset: 'ETH', assetSize: '0.3' },
    ...overrides,
  };
}

function makeItem(trade: Trade): LatestAgentTrade {
  return {
    trade,
    botId: trade.botId,
    botName: trade.botName,
  };
}

describe('buildAgentActivityStats', () => {
  it('derives recent flow stats from visible trades', () => {
    const now = Date.parse('2026-06-02T12:30:00Z');
    const stats = buildAgentActivityStats([
      makeItem(makeTrade({
        id: 'old',
        timestamp: now - 30 * 60 * 60 * 1000,
        notionalUsd: 750,
        action: 'close_long',
      })),
      makeItem(makeTrade({
        id: 'first',
        timestamp: now - 2 * 60 * 60 * 1000,
        notionalUsd: 1000,
      })),
      makeItem(makeTrade({
        id: 'latest',
        timestamp: now - 30 * 60 * 1000,
        notionalUsd: 1500,
        action: 'close_short',
      })),
    ], { now });

    const botStats = stats.get('bot-1');
    expect(botStats).toMatchObject({
      recentFills: 2,
      recentNotionalUsd: 2500,
      totalVisibleFills: 3,
      totalVisibleNotionalUsd: 3250,
      lastAction: 'close_short',
      lastMarket: 'ETH-PERP',
    });
    expect(botStats?.lastTradeAt).toBe(now - 30 * 60 * 1000);
    expect(botStats?.tradesPerHour).toBeCloseTo(1.33, 2);
  });
});
