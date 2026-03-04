import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let latestInfrastructureProps: any;

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chainId: undefined }),
  useWriteContract: () => ({
    writeContract: vi.fn(),
    data: undefined,
    isPending: false,
    reset: vi.fn(),
  }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
}));

vi.mock('@nanostores/react', () => ({
  useStore: (store: any) => {
    if (store && typeof store.get === 'function') return store.get();
    return 0;
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('~/lib/contracts/abis', () => ({
  tangleJobsAbi: [],
  tangleServicesAbi: [],
  tradingBlueprintAbi: [],
}));

vi.mock('~/lib/contracts/addresses', () => ({
  addresses: { tangle: '0x0000000000000000000000000000000000000000' },
}));

vi.mock('~/lib/contracts/chains', () => ({
  networks: {
    0: { chain: { id: 0, name: 'Testnet' } },
  },
}));

vi.mock('@tangle/blueprint-ui/components', () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Input: (props: any) => <input {...props} />,
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  DialogDescription: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  Tabs: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  TabsList: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  TabsTrigger: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  TabsContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

vi.mock('@tangle/blueprint-ui', () => ({
  publicClient: {},
  selectedChainIdStore: {},
  useOperators: () => ({ operators: [], operatorCount: 0 }),
  addTx: vi.fn(),
}));

vi.mock('~/lib/hooks/useQuotes', () => ({
  useQuotes: () => ({
    quotes: [],
    isLoading: false,
    errors: [],
    totalCost: 0n,
    refetch: vi.fn(),
  }),
}));

vi.mock('~/lib/stores/provisions', () => ({
  provisionsForOwner: () => ({ subscribe: vi.fn(), get: vi.fn(() => []) }),
  addProvision: vi.fn(),
  updateProvision: vi.fn(),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    token: null,
    authenticate: vi.fn(),
    clearCachedToken: vi.fn(),
  }),
}));

vi.mock('~/lib/config/aiProviders', () => ({
  AI_PROVIDERS: [],
  buildEnvForProvider: vi.fn(() => ({})),
  ACTIVATION_LABELS: {},
  DEFAULT_AI_PROVIDER: 'anthropic',
  DEFAULT_AI_API_KEY: '',
}));

vi.mock('~/lib/blueprints', () => ({
  TRADING_BLUEPRINTS: [
    {
      id: 'default',
      name: 'Default',
      blueprintId: '1',
      isFleet: true,
      isTee: false,
      defaults: { cpuCores: 1n, memoryMb: 512n, maxLifetimeDays: 7n },
      encodeProvision: vi.fn(() => '0x'),
    },
  ],
  getBlueprint: vi.fn(),
  strategyPacks: [
    {
      id: 'dex',
      name: 'DEX',
      description: 'DEX strategy',
      providers: ['Uniswap'],
      cron: '* * * * *',
      maxTurns: 1,
      timeoutMs: 1000,
      expertKnowledge: '',
    },
  ],
  buildFullInstructions: vi.fn(() => ''),
}));

vi.mock('~/components/provision/BlueprintSelector', () => ({ BlueprintSelector: () => null }));
vi.mock('~/components/provision/DeployStep', () => ({ DeployStep: () => null }));
vi.mock('~/components/provision/SecretsStep', () => ({ SecretsStep: () => null }));
vi.mock('~/components/provision/InfrastructureDialog', () => ({
  InfrastructureDialog: (props: any) => {
    latestInfrastructureProps = props;
    return <div data-testid="infra-open-state">{String(props.open)}</div>;
  },
}));

vi.mock('~/lib/utils/resolveBotId', () => ({
  resolveBotId: vi.fn(async () => ({ botId: 'bot-1' })),
}));

describe('provision route dialog wiring', () => {
  it('opens infrastructure dialog from advanced callback', async () => {
    const { default: ProvisionPage } = await import('../provision');
    const user = userEvent.setup();
    render(<ProvisionPage />);

    expect(screen.getByTestId('infra-open-state')).toHaveTextContent('false');
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Infrastructure Settings' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Open Infrastructure Settings' }));

    await waitFor(() => {
      expect(screen.getByTestId('infra-open-state')).toHaveTextContent('true');
      expect(latestInfrastructureProps.open).toBe(true);
      expect(screen.queryByRole('button', { name: 'Open Infrastructure Settings' })).not.toBeInTheDocument();
    });
  });
});
