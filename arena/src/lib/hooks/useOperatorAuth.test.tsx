import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOperatorAuth } from './useOperatorAuth';

const accountState = {
  address: undefined as string | undefined,
};

vi.mock('wagmi', () => ({
  useAccount: () => accountState,
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
}));

describe('useOperatorAuth', () => {
  beforeEach(() => {
    accountState.address = undefined;
    window.sessionStorage.clear();
  });

  it('uses a sessionStorage auth address for lab browser sessions without a wallet extension', () => {
    const address = '0x5aF64c5AA925B3871Ba58e38950aa2A3Dd5FE0ED';
    const apiUrl = '/operator-api';
    const cacheKey = `${address.toLowerCase()}::${apiUrl}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    window.sessionStorage.setItem('arena.operator_auth.address', address);
    window.sessionStorage.setItem(
      `arena.operator_auth.${cacheKey}`,
      JSON.stringify({ token: 'lab-token', expiresAt }),
    );

    const { result } = renderHook(() => useOperatorAuth(apiUrl));

    expect(result.current.accountAddress).toBe(address);
    expect(result.current.authCacheKey).toBe(cacheKey);
    expect(result.current.token).toBe('lab-token');
    expect(result.current.isAuthenticated).toBe(true);
  });
});
