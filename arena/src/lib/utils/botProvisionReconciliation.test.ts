import { describe, expect, it } from 'vitest';
import type { TrackedProvision } from '~/lib/stores/provisions';
import type { Bot } from '~/lib/types/bot';
import {
  collectMatchedProvisionIds,
  collectLikelyMatchedProvisionIds,
  doesProvisionMatchBot,
  doesProvisionLikelyReferToBot,
  isInstanceProvision,
  partitionProvisionsForBots,
} from './botProvisionReconciliation';

function makeProvision(overrides: Partial<TrackedProvision> = {}): TrackedProvision {
  return {
    id: 'prov-1',
    owner: '0x0000000000000000000000000000000000000001',
    name: 'bot1',
    strategyType: 'dex',
    operators: [],
    blueprintId: '1',
    phase: 'awaiting_secrets',
    createdAt: 1,
    updatedAt: 1,
    chainId: 31337,
    ...overrides,
  };
}

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'bot1',
    operatorAddress: '0x0000000000000000000000000000000000000001',
    vaultAddress: '0x0000000000000000000000000000000000000000',
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
    source: 'operator',
    ...overrides,
  };
}

describe('bot/provision reconciliation', () => {
  it('matches by bot id, sandbox id, call/service pair, or vault address', () => {
    expect(
      doesProvisionMatchBot(
        makeProvision({ botId: 'bot-1' }),
        makeBot({ id: 'bot-1' }),
      ),
    ).toBe(true);

    expect(
      doesProvisionMatchBot(
        makeProvision({ botId: undefined, sandboxId: 'sandbox-1' }),
        makeBot({ id: 'bot-2', sandboxId: 'sandbox-1' }),
      ),
    ).toBe(true);

    expect(
      doesProvisionMatchBot(
        makeProvision({ botId: undefined, sandboxId: undefined, serviceId: 7, callId: 9 }),
        makeBot({ id: 'bot-3', serviceId: 7, callId: 9 }),
      ),
    ).toBe(true);

    expect(
      doesProvisionMatchBot(
        makeProvision({
          botId: undefined,
          sandboxId: undefined,
          serviceId: undefined,
          callId: undefined,
          vaultAddress: '0x00000000000000000000000000000000000000aa',
        }),
        makeBot({
          id: 'bot-4',
          vaultAddress: '0x00000000000000000000000000000000000000aa',
        }),
      ),
    ).toBe(true);
  });

  it('does not match fleet bots by non-unique zero call ids', () => {
    expect(
      doesProvisionMatchBot(
        makeProvision({ botId: undefined, sandboxId: undefined, serviceId: 7, callId: 0 }),
        makeBot({ id: 'bot-3', serviceId: 7, callId: 0 }),
      ),
    ).toBe(false);
  });

  it('partitions matched provisions away from unresolved provisioning work', () => {
    const matchedProvision = makeProvision({
      id: 'prov-matched',
      name: 'bot2',
      sandboxId: 'sandbox-2',
      serviceId: 1,
      callId: 2,
    });
    const unresolvedProvision = makeProvision({
      id: 'prov-unresolved',
      name: 'bot3',
      sandboxId: 'sandbox-3',
      serviceId: 1,
      callId: 3,
    });
    const bot = makeBot({
      id: 'operator-bot-2',
      name: 'bot2',
      sandboxId: 'sandbox-2',
      serviceId: 1,
      callId: 2,
      status: 'active',
    });

    const { matched, unresolved } = partitionProvisionsForBots(
      [matchedProvision, unresolvedProvision],
      [bot],
    );

    expect(matched.map((provision) => provision.id)).toEqual(['prov-matched']);
    expect(unresolved.map((provision) => provision.id)).toEqual(['prov-unresolved']);
    expect(collectMatchedProvisionIds([matchedProvision, unresolvedProvision], [bot])).toEqual(
      new Set(['prov-matched']),
    );
  });

  it('detects instance provisions so only fleet/cloud entries are auto-cleaned', () => {
    expect(isInstanceProvision(makeProvision({ id: 'instance-1' }))).toBe(true);
    expect(
      isInstanceProvision(makeProvision({ id: 'prov-2', blueprintType: 'trading-instance' })),
    ).toBe(true);
    expect(
      isInstanceProvision(makeProvision({ id: 'prov-3', blueprintType: 'trading-tee-instance' })),
    ).toBe(true);
    expect(
      isInstanceProvision(makeProvision({ id: 'prov-4', blueprintType: 'trading-cloud' })),
    ).toBe(false);
  });

  it('treats same-name same-service failed provisions as historical once a real bot exists', () => {
    const failedProvision = makeProvision({
      id: 'prov-failed',
      phase: 'failed',
      serviceId: 11,
      name: 'bot1',
      strategyType: 'dex',
      errorMessage: 'Provision timed out after 30 minutes',
    });
    const bot = makeBot({
      id: 'operator-bot-11',
      serviceId: 11,
      name: 'bot1',
      strategyType: 'dex',
      source: 'operator',
    });

    expect(doesProvisionLikelyReferToBot(failedProvision, bot)).toBe(true);
    expect(collectLikelyMatchedProvisionIds([failedProvision], [bot])).toEqual(
      new Set(['prov-failed']),
    );
  });
});
