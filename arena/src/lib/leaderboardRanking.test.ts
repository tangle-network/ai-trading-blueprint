import { describe, expect, it } from 'vitest';
import { rankLeaderboardBots } from './leaderboardRanking';
import type { Bot } from './types/bot';

function makeBot(overrides: Partial<Bot>): Bot {
  return {
    id: overrides.id ?? 'bot',
    serviceId: 1,
    name: overrides.name ?? 'Agent',
    operatorAddress: '0x1234567890abcdef1234567890abcdef12345678',
    vaultAddress: '0x0000000000000000000000000000000000000000',
    strategyType: 'dex',
    status: 'active',
    createdAt: 0,
    pnlPercent: 0,
    pnlAbsolute: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    tvl: 0,
    avgValidatorScore: 0,
    sparklineData: [],
    verificationState: 'authoritative',
    operatorKind: 'cloud',
    operatorApiUrl: null,
    ...overrides,
  };
}

describe('rankLeaderboardBots', () => {
  it('ranks by return before active status', () => {
    const ranked = rankLeaderboardBots([
      makeBot({ id: 'active-low', name: 'Active Low', status: 'active', pnlPercent: 2 }),
      makeBot({ id: 'paused-high', name: 'Paused High', status: 'paused', pnlPercent: 18 }),
    ]);

    expect(ranked.map((bot) => bot.id)).toEqual(['paused-high', 'active-low']);
  });

  it('uses active status only as a tie-breaker after return and sharpe', () => {
    const ranked = rankLeaderboardBots([
      makeBot({ id: 'paused', name: 'Paused', status: 'paused', pnlPercent: 5, sharpeRatio: 1.1 }),
      makeBot({ id: 'active', name: 'Active', status: 'active', pnlPercent: 5, sharpeRatio: 1.1 }),
    ]);

    expect(ranked.map((bot) => bot.id)).toEqual(['active', 'paused']);
  });
});
