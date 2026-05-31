import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorAccessCard, OperatorSessionBanner } from './OperatorAccessCard';

const mocks = vi.hoisted(() => {
  const authStateByUrl = new Map<string, {
    token: string | null;
    isAuthenticated: boolean;
    isAuthenticating: boolean;
    error: string | null;
    authenticate: ReturnType<typeof vi.fn>;
  }>();
  const metaByUrl = new Map<string, { data?: { deployment_kind: 'fleet' | 'instance' } }>();
  const syncState = {
    operatorDataState: 'locked',
  };

  const getAuthState = (apiUrl: string) => {
    let state = authStateByUrl.get(apiUrl);
    if (!state) {
      state = {
        token: null,
        isAuthenticated: false,
        isAuthenticating: false,
        error: null,
        authenticate: vi.fn(async () => null),
      };
      authStateByUrl.set(apiUrl, state);
    }
    return state;
  };

  return {
    authStateByUrl,
    getAuthState,
    metaByUrl,
    syncState,
  };
});

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@nanostores/react', () => ({
  useStore: () => mocks.syncState,
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: (apiUrl: string) => mocks.getAuthState(apiUrl),
}));

vi.mock('~/lib/stores/hydratedBots', () => ({
  hydratedBotsStore: {},
}));

vi.mock('~/lib/operator/meta', () => ({
  CLOUD_OPERATOR_API_URL: '',
  INSTANCE_OPERATOR_API_URL: '/instance-operator-api',
  TEE_OPERATOR_API_URL: '/tee-operator-api',
  OPERATOR_API_URL: '',
  HAS_TRADING_OPERATOR_API: true,
  useOperatorMeta: (apiUrl: string) => mocks.metaByUrl.get(apiUrl) ?? { data: undefined },
}));

describe('OperatorAccessCard', () => {
  beforeEach(() => {
    mocks.authStateByUrl.clear();
    mocks.metaByUrl.clear();
    mocks.syncState.operatorDataState = 'locked';
  });

  it('authenticates every configured trading target when apiUrls are provided', async () => {
    mocks.metaByUrl.set('/instance-operator-api', { data: { deployment_kind: 'instance' } });
    mocks.metaByUrl.set('/tee-operator-api', { data: { deployment_kind: 'instance' } });

    render(
      <OperatorAccessCard
        apiUrls={['/instance-operator-api', '/tee-operator-api']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/instance-operator-api').authenticate).toHaveBeenCalledTimes(1);
      expect(mocks.getAuthState('/tee-operator-api').authenticate).toHaveBeenCalledTimes(1);
    });
  });

  it('skips unavailable operators when authenticating', async () => {
    mocks.metaByUrl.set('/instance-operator-api', { data: { deployment_kind: 'instance' } });

    render(
      <OperatorSessionBanner />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));

    await waitFor(() => {
      expect(mocks.getAuthState('/instance-operator-api').authenticate).toHaveBeenCalledTimes(1);
    });
    expect(mocks.getAuthState('/tee-operator-api').authenticate).not.toHaveBeenCalled();
  });

  it('renders the session banner when any trading operator exists, even without a cloud operator URL', () => {
    render(<OperatorSessionBanner />);
    expect(screen.getByText('Sign once to load operator-managed data')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authenticate' })).toBeInTheDocument();
  });
});
