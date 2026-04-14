import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRouteOperatorAutoAuth } from './useRouteOperatorAutoAuth';

const accountState = {
  address: '0x1234',
  isConnected: true,
};

const authState = {
  token: null as string | null,
  isAuthenticating: false,
  authenticate: vi.fn(async () => null),
};

vi.mock('wagmi', () => ({
  useAccount: () => accountState,
}));

vi.mock('./useOperatorAuth', () => ({
  useOperatorAuth: () => authState,
}));

describe('useRouteOperatorAutoAuth', () => {
  beforeEach(() => {
    accountState.address = '0x1234';
    accountState.isConnected = true;
    authState.token = null;
    authState.isAuthenticating = false;
    authState.authenticate.mockClear();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('triggers one interactive auth attempt when the route requires operator access', async () => {
    const { rerender } = renderHook(() =>
      useRouteOperatorAutoAuth({
        enabled: true,
        routeKey: 'provision',
        apiUrl: '/operator-api',
      }),
    );

    await waitFor(() => expect(authState.authenticate).toHaveBeenCalledTimes(1));

    rerender();
    await waitFor(() => expect(authState.authenticate).toHaveBeenCalledTimes(1));
  });

  it('waits until the document becomes visible before prompting', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    renderHook(() =>
      useRouteOperatorAutoAuth({
        enabled: true,
        routeKey: 'bot-detail:bot-1',
        apiUrl: '/operator-api',
      }),
    );

    expect(authState.authenticate).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(authState.authenticate).toHaveBeenCalledTimes(1));
  });
});
