import { describe, expect, it } from 'vitest';
import { fallbackBotDisplayName, resolveBotDisplayName } from './botNames';

describe('botNames', () => {
  it('uses the strategy label when no name is available', () => {
    expect(resolveBotDisplayName({ strategyType: 'dex' })).toBe('DEX Spot Trading');
  });

  it('drops fabricated strategy-agent placeholders from stale frontend state', () => {
    expect(resolveBotDisplayName({
      fallbackName: 'dex Agent',
      strategyType: 'dex',
    })).toBe('DEX Spot Trading');
  });

  it('keeps authoritative names from the backend or provisions', () => {
    expect(resolveBotDisplayName({
      primaryName: 'Base Sepolia Rollout Plan',
      fallbackName: 'dex Agent',
      strategyType: 'dex',
    })).toBe('Base Sepolia Rollout Plan');
  });

  it('falls back to the raw strategy type when there is no mapped label', () => {
    expect(fallbackBotDisplayName('custom-strategy')).toBe('custom-strategy');
  });
});
