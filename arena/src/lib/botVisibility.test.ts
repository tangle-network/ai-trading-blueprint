import { describe, expect, it } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import {
  isOperatorTradeCandidate,
  isPlatformVolumeCandidate,
  isPublicLeaderboardBot,
  selectLatestTradeFallbackBots,
  shouldFetchOperatorFallback,
} from './botVisibility';

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'Bot',
    operatorAddress: '0x0000000000000000000000000000000000000001',
    vaultAddress: '0x0000000000000000000000000000000000000002',
    strategyType: 'dex',
    status: 'active',
    createdAt: 1,
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
    operatorApiUrl: 'https://operator.example',
    operatorKind: 'cloud',
    ...overrides,
  };
}

describe('bot visibility policy', () => {
  it('keeps active authoritative bots on the public leaderboard', () => {
    expect(isPublicLeaderboardBot(makeBot())).toBe(true);
  });

  it('hides unverified, provisioning, and config-only bots from the public leaderboard', () => {
    expect(isPublicLeaderboardBot(makeBot({ verificationState: 'unverified' }))).toBe(false);
    expect(isPublicLeaderboardBot(makeBot({ id: 'provision:abc' }))).toBe(false);
    expect(isPublicLeaderboardBot(makeBot({ status: 'needs_config' }))).toBe(false);
  });

  it('keeps stopped bots only when they have prior activity evidence', () => {
    expect(isPublicLeaderboardBot(makeBot({ status: 'stopped', totalTrades: 0, tvl: 0 }))).toBe(false);
    expect(isPublicLeaderboardBot(makeBot({ status: 'stopped', totalTrades: 3 }))).toBe(true);
    expect(isPublicLeaderboardBot(makeBot({ status: 'stopped', secretsConfigured: true }))).toBe(true);
  });

  it('uses the same operator activity threshold for latest trades and volume', () => {
    const active = makeBot({ totalTrades: 0, tradingActive: false });
    const dormant = makeBot({ status: 'paused', totalTrades: 0, tradingActive: false });
    const historical = makeBot({ status: 'paused', totalTrades: 4, tradingActive: false });

    expect(isOperatorTradeCandidate(active)).toBe(true);
    expect(isOperatorTradeCandidate(dormant)).toBe(false);
    expect(isOperatorTradeCandidate(historical)).toBe(true);
    expect(isPlatformVolumeCandidate(historical)).toBe(true);
    expect(isPlatformVolumeCandidate(makeBot({ id: 'provision:x', totalTrades: 4 }))).toBe(false);
  });

  it('falls back only for bots whose aggregate operator read failed', () => {
    const healthyOperatorBot = makeBot({
      id: 'healthy-bot',
      operatorApiUrl: 'https://healthy.operator',
      totalTrades: 9,
    });
    const failedOperatorBot = makeBot({
      id: 'failed-bot',
      operatorApiUrl: 'https://failed.operator',
      totalTrades: 7,
    });
    const failedDormantBot = makeBot({
      id: 'failed-dormant',
      operatorApiUrl: 'https://failed.operator',
      status: 'paused',
      totalTrades: 0,
    });
    const failedUrls = new Set(['https://failed.operator']);

    expect(shouldFetchOperatorFallback(healthyOperatorBot, failedUrls, false)).toBe(false);
    expect(shouldFetchOperatorFallback(failedOperatorBot, failedUrls, false)).toBe(true);
    expect(selectLatestTradeFallbackBots(
      [healthyOperatorBot, failedOperatorBot, failedDormantBot],
      failedUrls,
      false,
      10,
    )).toEqual([failedOperatorBot]);
    expect(selectLatestTradeFallbackBots(
      [healthyOperatorBot, failedOperatorBot],
      failedUrls,
      true,
      1,
    )).toEqual([healthyOperatorBot]);
  });
});
