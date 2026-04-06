import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TrackedProvision } from '~/lib/stores/provisions';

const accountAddress = '0x0000000000000000000000000000000000000001' as const;

const accountState = {
  address: accountAddress,
  isConnected: true,
};

const servicesState = {
  services: [
    {
      serviceId: 1,
      blueprintId: 1,
      owner: accountState.address,
      createdAt: 1,
      ttl: 100,
      terminatedAt: 0,
      status: 1,
      operators: [],
      vaultAddresses: [],
      isActive: true,
      remainingSeconds: 120,
    },
  ],
  isLoading: false,
};

const botsState = {
  bots: [] as any[],
  isLoading: false,
  operatorDataState: 'locked' as const,
};

let provisionsState: TrackedProvision[] = [];

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));

vi.mock('wagmi', () => ({
  useAccount: () => accountState,
}));

vi.mock('@nanostores/react', () => ({
  useStore: () => [],
}));

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  publicClient: {},
  persistedAtom: ({ initial }: { initial: unknown }) => ({
    get: () => initial,
    set: vi.fn(),
    subscribe: () => () => {},
  }),
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
  Button: ({ children, asChild: _asChild, ...props }: any) => <button {...props}>{children}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  Skeleton: () => <div>loading</div>,
  StaggerContainer: ({ children }: any) => <div>{children}</div>,
  StaggerItem: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('~/lib/stores/provisions', async () => {
  return {
    getProvisionStructuralFingerprint: (provisions: TrackedProvision[]) => provisions
      .map((p) => [
        p.id,
        p.phase,
        p.serviceId ?? '',
        p.vaultAddress ?? '',
        p.callId ?? '',
        p.progressPhase ?? '',
        p.botId ?? '',
        p.sandboxId ?? '',
        p.workflowId ?? '',
      ].join('|'))
      .join(';'),
    provisionsForOwner: () => ({
      get: () => provisionsState,
      subscribe: () => () => {},
    }),
    removeProvision: vi.fn(),
    updateProvision: vi.fn(),
  };
});

vi.mock('~/lib/hooks/useUserServices', () => ({
  useUserServices: () => servicesState,
}));

vi.mock('~/lib/hooks/useBots', () => ({
  useBots: () => ({
    bots: botsState.bots,
    isLoading: botsState.isLoading,
    isOnChain: false,
    refetch: vi.fn(),
    operatorDataState: botsState.operatorDataState,
  }),
}));

vi.mock('~/lib/hooks/useBotEnrichment', () => ({
  useBotEnrichment: (bots: any[]) => bots,
}));

vi.mock('~/lib/hooks/useTradingRouteAutoAuth', () => ({
  useTradingRouteAutoAuth: vi.fn(),
}));

vi.mock('~/lib/contracts/addresses', () => ({
  addresses: { tangle: '0x0000000000000000000000000000000000000000' },
}));

vi.mock('~/components/home/ServiceCard', () => ({
  ServiceCard: ({ service, lockedBotCount }: any) => (
    <div>
      service-{service.serviceId}-locked-{lockedBotCount}
    </div>
  ),
}));

vi.mock('~/components/home/HomeBotCard', () => ({
  HomeBotCard: ({ bot }: any) => <div>bot-{bot.name}</div>,
}));

vi.mock('~/components/home/ProvisionsBanner', () => ({
  ProvisionsBanner: ({ provisions, failedProvisions }: any) => (
    <div>
      provisioning-{provisions.length}-failed-{failedProvisions.length}
    </div>
  ),
}));

vi.mock('~/components/home/SecretsModal', () => ({
  SecretsModal: () => null,
}));

vi.mock('~/components/operator/OperatorAccessCard', () => ({
  OperatorAccessCard: ({ title, description }: any) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
  OperatorSessionBanner: () => null,
}));

vi.mock('~/components/motion/AnimatedNumber', () => ({
  AnimatedNumber: () => null,
}));

describe('dashboard auth-aware rendering', () => {
  beforeEach(() => {
    botsState.bots = [];
    botsState.isLoading = false;
    botsState.operatorDataState = 'locked';
    provisionsState = [];
  });

  it('shows locked bot access instead of a fake provisioning row when botId is already known', async () => {
    provisionsState = [
      {
        id: 'prov-1',
        owner: accountState.address,
        name: 'bot1',
        strategyType: 'dex',
        operators: [],
        blueprintId: '1',
        phase: 'awaiting_secrets',
        createdAt: 1,
        updatedAt: 1,
        chainId: 31338,
        serviceId: 1,
        callId: 7,
        botId: 'trading-real-bot',
        sandboxId: 'sandbox-1',
      },
    ];

    const { default: HomePage } = await import('../dashboard');
    render(<HomePage />);

    expect(screen.getByText('Operator authentication required')).toBeInTheDocument();
    expect(screen.getByText(/Authenticate to load 1 operator-managed bot/i)).toBeInTheDocument();
    expect(screen.getByText('service-1-locked-1')).toBeInTheDocument();
    expect(screen.queryByText('provisioning-1-failed-0')).not.toBeInTheDocument();
    expect(screen.getByText('Active Bots').parentElement).toHaveTextContent('—');
  });

  it('keeps genuinely unresolved provisions in the provisioning section', async () => {
    provisionsState = [
      {
        id: 'prov-2',
        owner: accountState.address,
        name: 'bot2',
        strategyType: 'dex',
        operators: [],
        blueprintId: '1',
        phase: 'awaiting_secrets',
        createdAt: 1,
        updatedAt: 1,
        chainId: 31338,
        serviceId: 1,
        callId: 8,
      },
    ];

    const { default: HomePage } = await import('../dashboard');
    render(<HomePage />);

    expect(screen.getByText('provisioning-1-failed-0')).toBeInTheDocument();
    expect(screen.queryByText('Operator authentication required')).not.toBeInTheDocument();
    expect(screen.queryByText('bot-bot2')).not.toBeInTheDocument();
  });

  it('hides failed historical provisions when a real bot for the same logical bot already exists', async () => {
    botsState.bots = [
      {
        id: 'bot-real-1',
        serviceId: 1,
        name: 'bot1',
        operatorAddress: accountState.address,
        vaultAddress: '0x00000000000000000000000000000000000000aa',
        strategyType: 'dex',
        status: 'stopped',
        createdAt: 1,
        pnlPercent: 0,
        pnlAbsolute: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
        totalTrades: 0,
        tvl: 0,
        avgValidatorScore: 0,
        sparklineData: [],
        source: 'operator',
      },
    ];
    provisionsState = [
      {
        id: 'prov-failed',
        owner: accountState.address,
        name: 'bot1',
        strategyType: 'dex',
        operators: [],
        blueprintId: '1',
        phase: 'failed',
        createdAt: 1,
        updatedAt: 1,
        chainId: 31338,
        serviceId: 1,
        errorMessage: 'Provision timed out after 30 minutes',
      },
    ];

    const { default: HomePage } = await import('../dashboard');
    render(<HomePage />);

    expect(screen.queryByText('provisioning-0-failed-1')).not.toBeInTheDocument();
    expect(screen.queryByText('provisioning-0-failed-0')).not.toBeInTheDocument();
    expect(screen.getByText('bot-bot1')).toBeInTheDocument();
  });
});
