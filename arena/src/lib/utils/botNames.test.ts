import { describe, expect, it } from 'vitest';
import { fallbackBotDisplayName, resolveBotDisplayName } from './botNames';

describe('botNames', () => {
  it('uses the strategy label when no name is available', () => {
    expect(resolveBotDisplayName({ strategyType: 'dex' })).toBe('DEX Spot');
  });

  it('drops fabricated strategy-agent placeholders from stale frontend state', () => {
    expect(resolveBotDisplayName({
      fallbackName: 'dex Agent',
      strategyType: 'dex',
    })).toBe('DEX Spot');
  });

  it('keeps authoritative names from the backend or provisions', () => {
    expect(resolveBotDisplayName({
      primaryName: 'Base Sepolia Rollout Plan',
      fallbackName: 'dex Agent',
      strategyType: 'dex',
    })).toBe('Base Sepolia Rollout Plan');
  });

  it('drops raw prompt-style backend names', () => {
    expect(resolveBotDisplayName({
      primaryName: 'I want an agent that trades ETH perps on Hyperliquid with strict drawdown limits',
      strategyType: 'hyperliquid_perp',
    })).toBe('Hyperliquid Perps');
  });

  it('uses a clean fallback when the primary name is a prompt', () => {
    expect(resolveBotDisplayName({
      primaryName: 'Build me an agent that maximizes yield across Aave and Morpho lending protocols',
      fallbackName: 'USDC Yield Router',
      strategyType: 'yield',
    })).toBe('USDC Yield Router');
  });

  it('falls back to the raw strategy type when there is no mapped label', () => {
    expect(fallbackBotDisplayName('custom-strategy')).toBe('custom-strategy');
  });
});
