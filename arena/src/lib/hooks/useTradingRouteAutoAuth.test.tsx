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
  const metaByUrl = new Map<string, { data?: { deployment_kind: 'fleet' | 'instance' } }>();
  const operatorApiConfig = {
    cloud: '',
    instance: '',
    tee: '',
  };

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
    metaByUrl,
    operatorApiConfig,
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => mocks.accountState,
}));

vi.mock('./useOperatorAuth', () => ({
  useOperatorAuth: (apiUrl: string) => mocks.getAuthState(apiUrl),
}));

vi.mock('~/lib/operator/meta', () => ({
  CLOUD_OPERATOR_API_URL: mocks.operatorApiConfig.cloud,
  INSTANCE_OPERATOR_API_URL: mocks.operatorApiConfig.instance,
  TEE_OPERATOR_API_URL: mocks.operatorApiConfig.tee,
  useOperatorMeta: (apiUrl: string) => mocks.metaByUrl.get(apiUrl) ?? { data: undefined },
}));

describe('useTradingRouteAutoAuth', () => {
  beforeEach(() => {
    mocks.accountState.address = '0x1234';
    mocks.accountState.isConnected = true;
    mocks.authStateByUrl.clear();
    mocks.metaByUrl.clear();
    mocks.operatorApiConfig.cloud = '';
    mocks.operatorApiConfig.instance = '';
    mocks.operatorApiConfig.tee = '';
    vi.resetModules();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('attempts auth for each configured trading operator URL', async () => {
    mocks.operatorApiConfig.cloud = '/cloud';
    mocks.operatorApiConfig.instance = '/instance';
    mocks.operatorApiConfig.tee = '/tee';
    mocks.metaByUrl.set('/cloud', { data: { deployment_kind: 'fleet' } });
    mocks.metaByUrl.set('/instance', { data: { deployment_kind: 'instance' } });
    mocks.metaByUrl.set('/tee', { data: { deployment_kind: 'instance' } });

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'dashboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/cloud').authenticate).toHaveBeenCalledTimes(1);
      expect(mocks.getAuthState('/instance').authenticate).toHaveBeenCalledTimes(1);
      expect(mocks.getAuthState('/tee').authenticate).toHaveBeenCalledTimes(1);
    });
  });

  it('still authenticates in instance-only deployments', async () => {
    mocks.operatorApiConfig.instance = '/instance';
    mocks.metaByUrl.set('/instance', { data: { deployment_kind: 'instance' } });

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'leaderboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/instance').authenticate).toHaveBeenCalledTimes(1);
    });
  });

  it('still authenticates in TEE-only deployments', async () => {
    mocks.operatorApiConfig.tee = '/tee';
    mocks.metaByUrl.set('/tee', { data: { deployment_kind: 'instance' } });

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'leaderboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/tee').authenticate).toHaveBeenCalledTimes(1);
    });
  });

  it('skips operators whose metadata is unavailable', async () => {
    mocks.operatorApiConfig.cloud = '/cloud';
    mocks.operatorApiConfig.instance = '/instance';
    mocks.operatorApiConfig.tee = '/tee';
    mocks.metaByUrl.set('/cloud', { data: { deployment_kind: 'fleet' } });

    const { useTradingRouteAutoAuth } = await import('./useTradingRouteAutoAuth');
    renderHook(() => useTradingRouteAutoAuth({ enabled: true, routeKey: 'dashboard' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/cloud').authenticate).toHaveBeenCalledTimes(1);
    });
    expect(mocks.getAuthState('/instance').authenticate).not.toHaveBeenCalled();
    expect(mocks.getAuthState('/tee').authenticate).not.toHaveBeenCalled();
  });
});
