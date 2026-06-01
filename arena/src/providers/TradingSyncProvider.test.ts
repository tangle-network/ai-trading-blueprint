import { describe, expect, it } from 'vitest';
import { getOperatorDataStateForSources } from './TradingSyncProvider';

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
