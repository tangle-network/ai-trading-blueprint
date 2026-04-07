import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const accountState = {
    address: '0x1234',
    isConnected: true,
  };
  const authStateByUrl = new Map<string, {
    token: string | null;
    isAuthenticating: boolean;
    isAuthenticated: boolean;
    error: string | null;
    authenticate: ReturnType<typeof vi.fn>;
  }>();

  const getAuthState = (apiUrl: string) => {
    let state = authStateByUrl.get(apiUrl);
    if (!state) {
      state = {
        token: null,
        isAuthenticating: false,
        isAuthenticated: false,
        error: null,
        authenticate: vi.fn(async () => null),
      };
      authStateByUrl.set(apiUrl, state);
    }
    return state;
  };

  return {
    accountState,
    authStateByUrl,
    getAuthState,
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => mocks.accountState,
}));

vi.mock('./useOperatorAuth', () => ({
  useOperatorAuth: (apiUrl: string) => mocks.getAuthState(apiUrl),
}));

describe('useTradingRouteAutoAuth', () => {
  beforeEach(() => {
    mocks.accountState.address = '0x1234';
    mocks.accountState.isConnected = true;
    mocks.authStateByUrl.clear();
    vi.resetModules();
    vi.unstubAllEnvs();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('attempts auth for each configured trading operator URL', async () => {
    vi.stubEnv('VITE_OPERATOR_API_URL', '/cloud');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '/cloud');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '/instance');
    vi.stubEnv('VITE_TEE_OPERATOR_API_URL', '/tee');

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'dashboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/cloud').authenticate).toHaveBeenCalledTimes(1);
      expect(mocks.getAuthState('/instance').authenticate).toHaveBeenCalledTimes(1);
      expect(mocks.getAuthState('/tee').authenticate).toHaveBeenCalledTimes(1);
    });
  });

  it('still authenticates in instance-only deployments', async () => {
    vi.stubEnv('VITE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '/instance');
    vi.stubEnv('VITE_TEE_OPERATOR_API_URL', '');

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'leaderboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/instance').authenticate).toHaveBeenCalledTimes(1);
    });
    expect(mocks.authStateByUrl.has('/cloud')).toBe(false);
  });

  it('still authenticates in TEE-only deployments', async () => {
    vi.stubEnv('VITE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_TEE_OPERATOR_API_URL', '/tee');

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'leaderboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/tee').authenticate).toHaveBeenCalledTimes(1);
    });
    expect(mocks.authStateByUrl.has('/instance')).toBe(false);
  });

  it('deduplicates duplicate operator URLs', async () => {
    vi.stubEnv('VITE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '/shared');
    vi.stubEnv('VITE_TEE_OPERATOR_API_URL', '/shared');

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'dashboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/shared').authenticate).toHaveBeenCalledTimes(1);
    });
  });
});
