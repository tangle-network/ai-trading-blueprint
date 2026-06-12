import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  selectedChainId: 84532,
  operatorMetaData: {
    features: {
      chat: true,
      terminal: true,
    },
  } as { features: { chat: boolean; terminal: boolean } } | undefined,
}));

vi.mock('@nanostores/react', () => ({
  useStore: () => [],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1234567890abcdef1234567890abcdef12345678',
    isConnected: true,
  }),
}));

vi.mock('@radix-ui/react-tooltip', () => ({
  Provider: ({ children }: any) => <>{children}</>,
  Root: ({ children }: any) => <>{children}</>,
  Trigger: ({ children }: any) => <>{children}</>,
  Portal: ({ children }: any) => <>{children}</>,
  Content: ({ children }: any) => <div>{children}</div>,
  Arrow: () => null,
}));

vi.mock('@tangle-network/blueprint-ui', async () => {
  const actual = await vi.importActual<typeof import('@tangle-network/blueprint-ui')>(
    '@tangle-network/blueprint-ui',
  );

  return {
    ...actual,
    selectedChainIdStore: {
      get: () => hoisted.selectedChainId,
      set: (value: number) => {
        hoisted.selectedChainId = value;
      },
    },
  };
});

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  AnimatedPage: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Badge: ({ children }: any) => <span>{children}</span>,
  Button: ({ children }: any) => <button>{children}</button>,
  Identicon: ({ address }: any) => <span>{address?.slice(0, 6)}</span>,
}));

vi.mock('~/lib/hooks/useBots', () => ({
  useBots: () => ({
    bots: [{
      id: 'bot-1',
      serviceId: 1,
      name: 'Route Bot',
      operatorAddress: '0x1234567890abcdef1234567890abcdef12345678',
      submitterAddress: '0x1234567890abcdef1234567890abcdef12345678',
      vaultAddress: '0x0000000000000000000000000000000000000000',
      strategyType: 'hyperliquid_perp',
      status: 'active',
      createdAt: Date.parse('2026-06-01T00:00:00Z'),
      pnlPercent: 3.2,
      pnlAbsolute: 32,
      sharpeRatio: 1.4,
      maxDrawdown: 2.1,
      winRate: 50,
      totalTrades: 12,
      tvl: 1000,
      avgValidatorScore: 90,
      sparklineData: [100, 103],
      verificationState: 'authoritative',
      source: 'operator',
      operatorKind: 'cloud',
      operatorApiUrl: 'http://operator.test',
      chainId: 84532,
      sandboxId: 'sandbox-1',
      paperTrade: true,
      strategyConfig: { asset: 'ETH', initial_capital_usd: '1000' },
      riskParams: { max_drawdown_pct: '5' },
    }],
    isLoading: false,
  }),
}));

vi.mock('~/lib/hooks/useBotDetail', () => ({
  useBotDetail: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
  }),
}));

vi.mock('~/lib/hooks/useBotLiveSummary', () => ({
  useBotLiveSummary: () => ({
    pnlPercent: 3.2,
    sharpeRatio: 1.4,
    maxDrawdown: 2.1,
    tradeCount: 1,
    portfolioValue: 1032,
  }),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    accountAddress: '0x1234567890abcdef1234567890abcdef12345678',
    isAuthenticating: false,
  }),
}));

vi.mock('~/lib/hooks/useRouteOperatorAutoAuth', () => ({
  useRouteOperatorAutoAuth: vi.fn(),
}));

vi.mock('~/lib/hooks/useOperatorSyncScope', () => ({
  useOperatorSyncScope: vi.fn(),
}));

vi.mock('~/lib/operator/meta', async () => {
  const actual = await vi.importActual<typeof import('~/lib/operator/meta')>('~/lib/operator/meta');
  return {
    ...actual,
    OPERATOR_API_URL: 'http://operator.test',
    INSTANCE_OPERATOR_API_URL: 'http://instance.test',
    useOperatorMeta: () => ({
      data: hoisted.operatorMetaData,
    }),
  };
});

vi.mock('~/lib/stores/provisions', () => ({
  provisionsForOwner: () => ({}),
}));

vi.mock('~/components/bot-detail/PerformanceTab', () => ({
  PerformanceTab: ({ canCommand }: any) => (
    <div data-testid="workspace-performance">
      Performance workspace {canCommand ? 'commandable' : 'public'}
    </div>
  ),
}));

vi.mock('~/components/bot-detail/PortfolioWorkspace', () => ({
  PortfolioWorkspace: () => <div data-testid="workspace-portfolio">Portfolio workspace</div>,
}));

vi.mock('~/components/bot-detail/RunsTab', () => ({
  RunsTab: () => <div data-testid="workspace-runs">Runs workspace</div>,
}));

vi.mock('~/components/bot-detail/ChatTab', () => ({
  ChatTab: () => <div data-testid="workspace-chat">Chat workspace</div>,
}));

vi.mock('~/components/bot-detail/OperationsWorkspace', () => ({
  OperationsWorkspace: ({ initialPanel, onPanelChange }: any) => (
    <div data-testid="workspace-operations">
      Operations workspace {initialPanel}
      <button type="button" onClick={() => onPanelChange?.('validation')}>
        Open Validation
      </button>
    </div>
  ),
}));

vi.mock('~/components/bot-detail/usePendingValidationCount', () => ({
  usePendingValidationCount: () => 0,
}));

vi.mock('~/components/home/SecretsModal', () => ({
  SecretsModal: () => null,
}));

vi.mock('~/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>,
}));

vi.mock('~/components/bot-detail/EnvelopeNeededBanner', () => ({
  EnvelopeNeededBanner: () => null,
}));

function renderBotWorkspace(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  const route = {
    path: '/arena/bot/:id/:section?',
    HydrateFallback: () => null,
    async lazy() {
      const module = await import('../arena.bot.$id');
      return { Component: module.default };
    },
  };
  const router = createMemoryRouter([route], { initialEntries });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return router;
}

function findWorkspace(testId: string) {
  return screen.findByTestId(testId, {}, { timeout: 10_000 });
}

function clickFirstWorkspaceLink(name: RegExp) {
  fireEvent.click(screen.getAllByRole('link', { name })[0]);
}

describe('bot workspace routing', () => {
  beforeEach(() => {
    hoisted.selectedChainId = 84532;
    hoisted.operatorMetaData = {
      features: {
        chat: true,
        terminal: true,
      },
    };
  });

  it('canonicalizes bare agent routes to performance', async () => {
    const router = renderBotWorkspace(['/arena/bot/bot-1']);

    expect(await findWorkspace('workspace-performance')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe('/arena/bot/bot-1/performance'));
    expect(router.state.location.search).toBe('');
  });

  it('uses the operator auth account as the command identity fallback', async () => {
    renderBotWorkspace(['/arena/bot/bot-1/performance']);

    expect(await findWorkspace('workspace-performance')).toHaveTextContent('commandable');
  });

  it('preserves browser back navigation between route-native agent sections', async () => {
    const router = renderBotWorkspace(['/arena/bot/bot-1/performance']);

    expect(await findWorkspace('workspace-performance')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    clickFirstWorkspaceLink(/chat/i);

    expect(await findWorkspace('workspace-chat')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/chat');

    await act(async () => {
      await router.navigate(-1);
    });

    expect(await findWorkspace('workspace-performance')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/performance');
  });

  it('switches from chat dense mode to performance through the agent rail', async () => {
    const router = renderBotWorkspace(['/arena/bot/bot-1/chat']);

    expect(await findWorkspace('workspace-chat')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^back to agent$/i })).not.toBeInTheDocument();
    clickFirstWorkspaceLink(/performance/i);

    expect(await findWorkspace('workspace-performance')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/performance');
  });

  it('keeps chat dense mode route-native instead of using a fullscreen return link', async () => {
    const router = renderBotWorkspace(['/arena/bot/bot-1/portfolio']);

    expect(await findWorkspace('workspace-portfolio')).toBeInTheDocument();
    clickFirstWorkspaceLink(/chat/i);

    expect(await findWorkspace('workspace-chat')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/chat');

    expect(screen.queryByRole('link', { name: /^back to agent$/i })).not.toBeInTheDocument();
    clickFirstWorkspaceLink(/portfolio/i);

    expect(await findWorkspace('workspace-portfolio')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/portfolio');

    await act(async () => {
      await router.navigate(-1);
    });

    expect(await findWorkspace('workspace-chat')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/chat');
  });

  it('preserves alias route tokens when moving out of chat dense mode', async () => {
    const router = renderBotWorkspace(['/arena/bot/sandbox-1/portfolio']);

    expect(await findWorkspace('workspace-portfolio')).toBeInTheDocument();
    clickFirstWorkspaceLink(/chat/i);

    expect(await findWorkspace('workspace-chat')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/sandbox-1/chat');

    expect(screen.queryByRole('link', { name: /^back to agent$/i })).not.toBeInTheDocument();
    clickFirstWorkspaceLink(/portfolio/i);

    expect(await findWorkspace('workspace-portfolio')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/sandbox-1/portfolio');
  });

  it('keeps runs dense mode route-native instead of using a fullscreen return link', async () => {
    const router = renderBotWorkspace(['/arena/bot/bot-1/portfolio']);

    expect(await findWorkspace('workspace-portfolio')).toBeInTheDocument();
    clickFirstWorkspaceLink(/runs/i);

    expect(await findWorkspace('workspace-runs')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/runs');

    expect(screen.queryByRole('link', { name: /^back to agent$/i })).not.toBeInTheDocument();
    clickFirstWorkspaceLink(/portfolio/i);

    expect(await findWorkspace('workspace-portfolio')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/portfolio');
  });

  it('redirects legacy query tabs into route-native sections without leaving stale tab state', async () => {
    const router = renderBotWorkspace(['/arena/bot/bot-1?tab=terminal']);

    await waitFor(() => expect(router.state.location.pathname).toBe('/arena/bot/bot-1/operations'));
    expect(router.state.location.search).toBe('?panel=terminal');
    expect(await findWorkspace('workspace-operations')).toHaveTextContent('terminal');
  });

  it('keeps direct chat routes available while operator metadata is still loading', async () => {
    hoisted.operatorMetaData = undefined;
    const router = renderBotWorkspace(['/arena/bot/bot-1/chat']);

    expect(await findWorkspace('workspace-chat')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/arena/bot/bot-1/chat');
    expect(screen.getByText('Chat')).toBeInTheDocument();
  });

  it('persists operations panel changes in the route query string', async () => {
    const router = renderBotWorkspace(['/arena/bot/bot-1/operations']);

    expect(await findWorkspace('workspace-operations')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open validation/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/arena/bot/bot-1/operations'));
    expect(router.state.location.search).toBe('?panel=validation');
  });
});
