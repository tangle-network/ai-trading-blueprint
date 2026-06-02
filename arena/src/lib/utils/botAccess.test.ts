import { describe, expect, it } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import { isBotCallableByWallet, isBotCommandableByWallet, isBotOwnedByWallet } from './botAccess';

function makeBot(overrides: Partial<Bot>): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'Agent One',
    operatorAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    vaultAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    strategyType: 'momentum',
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
    ...overrides,
  };
}

describe('botAccess', () => {
  it('treats submitter match as callable', () => {
    const bot = makeBot({
      submitterAddress: '0x1111111111111111111111111111111111111111',
    });

    expect(isBotCallableByWallet(bot, '0x1111111111111111111111111111111111111111')).toBe(true);
    expect(isBotCallableByWallet(bot, '0x2222222222222222222222222222222222222222')).toBe(false);
  });

  it('does not mark missing submitter bots callable', () => {
    expect(isBotCallableByWallet(makeBot({ submitterAddress: undefined }), '0x1111111111111111111111111111111111111111')).toBe(false);
  });

  it('keeps broader ownership separate from call permission', () => {
    const bot = makeBot({
      serviceId: 7,
      submitterAddress: '0x2222222222222222222222222222222222222222',
    });

    expect(isBotCallableByWallet(bot, '0x1111111111111111111111111111111111111111')).toBe(false);
    expect(isBotOwnedByWallet(bot, {
      walletAddress: '0x1111111111111111111111111111111111111111',
      services: [{
        serviceId: 7,
        vaultAddresses: [],
      }],
    })).toBe(true);
  });

  it('requires authoritative operator data before exposing command surfaces', () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const bot = makeBot({
      submitterAddress: wallet,
      source: 'operator',
      verificationState: 'authoritative',
    });

    expect(isBotCommandableByWallet(bot, wallet)).toBe(true);
    expect(isBotCommandableByWallet({ ...bot, source: 'on_chain' }, wallet)).toBe(false);
    expect(isBotCommandableByWallet({ ...bot, verificationState: 'unverified' }, wallet)).toBe(false);
    expect(isBotCommandableByWallet({ ...bot, submitterAddress: '0x2222222222222222222222222222222222222222' }, wallet)).toBe(false);
  });
});
