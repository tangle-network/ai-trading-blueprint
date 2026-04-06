import { describe, expect, it } from 'vitest';
import type { TrackedProvision } from './provisions';
import {
  getProvisionStructuralFingerprint,
  isPersistableDraftProvision,
  isProvisionServiceHint,
  sanitizePersistedProvisionList,
  serializeProvisionForPersistence,
  shouldRenderProvisionFallbackBot,
} from './provisions';

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
    updatedAt: 2,
    chainId: 31337,
    ...overrides,
  };
}

describe('provision storage helpers', () => {
  it('persists only draft-safe fields', () => {
    const serialized = serializeProvisionForPersistence(makeProvision({
      serviceId: 7,
      callId: 9,
      vaultAddress: '0x00000000000000000000000000000000000000aa',
      botId: 'bot-1',
      sandboxId: 'sandbox-1',
      workflowId: 42,
      progressPhase: 'ready',
      progressDetail: 'done',
    }));

    expect(serialized).toEqual({
      id: 'prov-1',
      owner: '0x0000000000000000000000000000000000000001',
      name: 'bot1',
      strategyType: 'dex',
      operators: [],
      blueprintId: '1',
      phase: 'awaiting_secrets',
      createdAt: 1,
      updatedAt: 2,
      chainId: 31337,
      serviceId: 7,
      callId: 9,
      vaultAddress: '0x00000000000000000000000000000000000000aa',
      botId: 'bot-1',
      sandboxId: 'sandbox-1',
      workflowId: 42,
    });
  });

  it('drops active verified provisions during persistence sanitization', () => {
    expect(isPersistableDraftProvision(makeProvision({ phase: 'active', botId: 'bot-1' }))).toBe(false);

    expect(sanitizePersistedProvisionList([
      makeProvision({ phase: 'active', botId: 'bot-1', sandboxId: 'sandbox-1' }),
    ])).toEqual([]);
  });

  it('keeps awaiting-secrets drafts with stable operator identity fields on reload', () => {
    expect(sanitizePersistedProvisionList([
      makeProvision({
        botId: 'bot-1',
        sandboxId: 'sandbox-1',
        workflowId: 12,
        progressPhase: 'ready',
        progressDetail: 'done',
      }),
    ])).toEqual([
      makeProvision({
        botId: 'bot-1',
        sandboxId: 'sandbox-1',
        workflowId: 12,
      }),
    ]);
  });

  it('treats operator identity as structural and blocks fallback rendering once known', () => {
    const before = makeProvision({ botId: undefined });
    const after = makeProvision({ botId: 'bot-1', sandboxId: 'sandbox-1', workflowId: 4 });

    expect(getProvisionStructuralFingerprint([before])).not.toBe(getProvisionStructuralFingerprint([after]));
    expect(shouldRenderProvisionFallbackBot(before)).toBe(true);
    expect(shouldRenderProvisionFallbackBot(after)).toBe(false);
    expect(isProvisionServiceHint(after)).toBe(true);
  });
});
