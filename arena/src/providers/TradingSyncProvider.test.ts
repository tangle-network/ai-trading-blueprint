import { describe, expect, it } from 'vitest';
import {
  dedupeBotsByOperatorScopedKey,
  getOperatorDataStateForSources,
  operatorScopedBotKey,
} from './TradingSyncProvider';

describe('getOperatorDataStateForSources', () => {
  it('treats public fleet sources as readable without a wallet token', () => {
    expect(getOperatorDataStateForSources([
      { deploymentKind: 'fleet', token: null, isAuthenticating: false },
    ])).toBe('ready');
  });

  it('keeps private instance sources locked until authenticated', () => {
    expect(getOperatorDataStateForSources([
      { deploymentKind: 'instance', token: null, isAuthenticating: false },
    ])).toBe('locked');
    expect(getOperatorDataStateForSources([
      { deploymentKind: 'instance', token: null, isAuthenticating: true },
    ])).toBe('authenticating');
    expect(getOperatorDataStateForSources([
      { deploymentKind: 'instance', token: 'session-token', isAuthenticating: false },
    ])).toBe('ready');
  });

  it('reports partial state when public fleet data is available but a private source is locked', () => {
    expect(getOperatorDataStateForSources([
      { deploymentKind: 'fleet', token: null, isAuthenticating: false },
      { deploymentKind: 'instance', token: null, isAuthenticating: false },
    ])).toBe('partial');
  });
});

describe('operator-scoped roster merge', () => {
  it('keys operator bots by (operator, bot id) and on-chain bots by id', () => {
    expect(operatorScopedBotKey({ id: 'bot-1', operatorApiUrl: 'https://op-a.example' }))
      .not.toBe(operatorScopedBotKey({ id: 'bot-1', operatorApiUrl: 'https://op-b.example' }));
    expect(operatorScopedBotKey({ id: '0xvault', operatorApiUrl: null })).toBe('0xvault');
  });

  it('merges two operators\' bot lists without collapsing same-id bots across operators', () => {
    const merged = dedupeBotsByOperatorScopedKey([
      { id: 'bot-1', operatorApiUrl: 'https://op-a.example' },
      { id: 'bot-1', operatorApiUrl: 'https://op-b.example' },
      { id: 'bot-2', operatorApiUrl: 'https://op-b.example' },
    ]);
    expect(merged).toHaveLength(3);
  });

  it('drops duplicate entries from the same operator', () => {
    const merged = dedupeBotsByOperatorScopedKey([
      { id: 'bot-1', operatorApiUrl: 'https://op-a.example' },
      { id: 'bot-1', operatorApiUrl: 'https://op-a.example' },
    ]);
    expect(merged).toHaveLength(1);
  });
});
