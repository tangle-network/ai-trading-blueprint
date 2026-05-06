import { describe, expect, it } from 'vitest';
import type { TrackedProvision } from '~/lib/stores/provisions';
import { shouldPollOperatorProgress } from './useProvisionWatcher';

function provision(overrides: Partial<TrackedProvision>): TrackedProvision {
  return {
    id: 'prov-1',
    owner: '0x0000000000000000000000000000000000000001',
    name: 'dex',
    strategyType: 'dex',
    operators: [],
    blueprintId: 'blueprint',
    phase: 'job_submitted',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chainId: 31338,
    ...overrides,
  };
}

describe('shouldPollOperatorProgress', () => {
  it('polls the operator for the current zero-call provision while it is still processing', () => {
    expect(shouldPollOperatorProgress(provision({
      callId: 0,
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      phase: 'job_submitted',
    }))).toBe(true);

    expect(shouldPollOperatorProgress(provision({
      callId: 0,
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      phase: 'job_processing',
    }))).toBe(true);
  });

  it('does not resume stale zero-call provisions after processing has finished', () => {
    expect(shouldPollOperatorProgress(provision({
      callId: 0,
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      phase: 'awaiting_secrets',
      botId: undefined,
    }))).toBe(false);

    expect(shouldPollOperatorProgress(provision({
      callId: 0,
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      phase: 'active',
      botId: undefined,
    }))).toBe(false);
  });

  it('keeps positive call ids pollable for repair and recovery', () => {
    expect(shouldPollOperatorProgress(provision({
      callId: 7,
      phase: 'awaiting_secrets',
      botId: undefined,
    }))).toBe(true);

    expect(shouldPollOperatorProgress(provision({
      callId: 7,
      phase: 'failed',
      botId: undefined,
    }))).toBe(true);
  });
});
