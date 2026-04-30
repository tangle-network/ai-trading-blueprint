import { describe, expect, it } from 'vitest';
import { getProvisionBotRouteId } from './provisionBotRoute';

describe('provision bot route helpers', () => {
  it('prefers the canonical bot id over sandbox and vault ids', () => {
    expect(getProvisionBotRouteId({
      botId: 'trading-123',
      sandboxId: 'sandbox-123',
      vaultAddress: '0x00000000000000000000000000000000000000bb',
    })).toBe('trading-123');
  });

  it('does not route to non-address vault placeholders', () => {
    expect(getProvisionBotRouteId({
      sandboxId: 'sandbox-123',
      vaultAddress: 'factory:0x00000000000000000000000000000000000000bb',
    })).toBe('sandbox-123');
  });
});
