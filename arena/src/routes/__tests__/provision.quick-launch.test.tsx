import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const DRAFT_STORAGE_KEY = 'arena:create-strategy-draft:v1';

const shared = vi.hoisted(() => ({
  setSearchParams: vi.fn(),
  operators: [] as Array<{ address: string; rpcAddress: string }>,
  operatorsLoading: false,
  quotes: [] as any[],
  quoteErrors: new Map<string, { kind: string; detail: string }>(),
  totalCost: 0n,
  writeContractCalls: 0,
  newServiceWriteContract: vi.fn(),
  submitJobWriteContract: vi.fn(),
}));

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useSearchParams: () => [
    new URLSearchParams('draft=create'),
    shared.setSearchParams,
  ],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x0000000000000000000000000000000000000001',
    isConnected: true,
    chainId: 0,
  }),
  useWriteContract: () => {
    shared.writeContractCalls += 1;
    if (shared.writeContractCalls % 2 === 1) {
      return {
        writeContract: shared.submitJobWriteContract,
        data: undefined,
        isPending: false,
        reset: vi.fn(),
      };
    }
    return {
      writeContract: shared.newServiceWriteContract,
      isPending: false,
    };
  },
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
}));

vi.mock('@nanostores/react', () => ({
  useStore: (store: any) => {
    if (store && typeof store.get === 'function') return store.get();
    return 0;
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
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
  isKnownExternalHyperEvmChainId: (chainId: number) =>
    chainId === 998 || chainId === 999,
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  publicClient: {
    getBlockNumber: vi.fn(async () => 1000n),
    getLogs: vi.fn(async () => []),
    readContract: vi.fn(async () => {
      throw new Error('no service configured');
    }),
    watchContractEvent: vi.fn(() => vi.fn()),
    waitForTransactionReceipt: vi.fn(() => new Promise(() => {})),
  },
  selectedChainIdStore: {},
  useOperators: () => ({
    operators: shared.operators,
    operatorCount: BigInt(shared.operators.length),
    isLoading: shared.operatorsLoading,
    error: null,
  }),
  addTx: vi.fn(),
}));

vi.mock('~/lib/hooks/useQuotes', () => ({
  useQuotes: () => ({
    quotes: shared.quotes,
    isLoading: false,
    errors: shared.quoteErrors,
    totalCost: shared.totalCost,
    refetch: vi.fn(),
  }),
}));

vi.mock('~/lib/stores/provisions', () => ({
  provisionsForOwner: () => ({ subscribe: vi.fn(), get: vi.fn(() => []) }),
  addProvision: vi.fn(),
  upsertInstanceProvision: vi.fn(),
  removeProvision: vi.fn(),
  removeMatchingInstanceProvision: vi.fn(),
  removeInstanceProvisions: vi.fn(),
  updateProvision: vi.fn(),
  findMatchingInstanceProvision: vi.fn(),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    token: null,
    authenticate: vi.fn(),
    clearCachedToken: vi.fn(),
    getCachedToken: vi.fn(),
    getToken: vi.fn(),
  }),
}));

vi.mock('~/lib/operator/meta', () => ({
  useOperatorMeta: () => ({
    data: { deployment_kind: 'fleet', features: { chat: false, terminal: false } },
  }),
  buildBotScopedPath: vi.fn(),
  getOperatorApiUrlForBlueprint: vi.fn(() => '/operator-api'),
  getExpectedDeploymentKindForBlueprint: vi.fn(() => 'fleet'),
}));

vi.mock('~/lib/hooks/useRouteOperatorAutoAuth', () => ({
  useRouteOperatorAutoAuth: vi.fn(),
}));

vi.mock('~/lib/events/bots', () => ({
  dispatchBotsRefresh: vi.fn(),
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
      id: 'trading-cloud',
      name: 'Trading Cloud',
      blueprintId: '1',
      isFleet: true,
      isTee: false,
      defaults: { cpuCores: 1n, memoryMb: 512n, maxLifetimeDays: 7n },
      encodeProvision: vi.fn(() => '0x'),
    },
    {
      id: 'trading-instance',
      name: 'Trading Instance',
      blueprintId: '2',
      isFleet: false,
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
      executionMode: 'single-chain',
      supportedChainIds: [84532, 31339],
      cron: '* * * * *',
      maxTurns: 1,
      timeoutMs: 1000,
      expertKnowledge: '',
    },
  ],
  buildFullInstructions: vi.fn(() => ''),
}));

vi.mock('~/components/provision/BlueprintSelector', () => ({
  BlueprintSelector: () => null,
}));
vi.mock('~/components/provision/ConfigureStep', () => ({
  ConfigureStep: ({ name }: { name: string }) => (
    <div data-testid="configure-step">{name}</div>
  ),
}));
vi.mock('~/components/provision/DeployStep', () => ({
  DeployStep: () => <div data-testid="deploy-step" />,
}));
vi.mock('~/components/provision/SecretsStep', () => ({
  SecretsStep: () => <div data-testid="secrets-step" />,
}));
vi.mock('~/components/provision/InfrastructureDialog', () => ({
  InfrastructureDialog: () => null,
}));
vi.mock('~/components/provision/AdvancedSettingsDialog', () => ({
  AdvancedSettingsDialog: () => null,
}));

vi.mock('~/lib/utils/resolveBotId', () => ({
  resolveBotId: vi.fn(async () => ({ botId: 'bot-1' })),
}));

const OPERATOR = '0x00000000000000000000000000000000000000aa';

function seedDraft() {
  window.localStorage.setItem(
    DRAFT_STORAGE_KEY,
    JSON.stringify({
      name: 'Momentum Scout',
      strategyType: 'dex',
      provisionStrategyType: 'dex',
      market: 'ETH / USDC',
      venue: 'Uniswap v3 on Base',
      sizing: '2% per position',
      drawdown: '10% max drawdown',
      mode: 'Paper start',
      prompt: 'Trade ETH momentum with tight risk control',
      updatedAt: Date.now(),
    }),
  );
}

function seedQuotedOperator() {
  shared.operators = [{ address: OPERATOR, rpcAddress: 'http://op' }];
  shared.operatorsLoading = false;
  shared.quotes = [
    {
      operator: OPERATOR,
      signature: '0xsig',
      totalCost: 5_000_000_000n,
      costRate: 5,
      details: {
        requester: '0x0000000000000000000000000000000000000001',
        blueprintId: 1n,
        ttlBlocks: 216000n,
        totalCost: 5_000_000_000n,
        timestamp: 1n,
        expiry: 2n,
        confidentiality: 0,
        securityCommitments: [],
        resourceCommitments: [{ kind: 0, count: 1n }],
      },
    },
  ];
  shared.totalCost = 5_000_000_000n;
}

describe('provision quick launch (draft=create)', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    shared.setSearchParams.mockClear();
    shared.newServiceWriteContract.mockClear();
    shared.submitJobWriteContract.mockClear();
    shared.writeContractCalls = 0;
    shared.operators = [];
    shared.operatorsLoading = false;
    shared.quotes = [];
    shared.quoteErrors = new Map();
    shared.totalCost = 0n;
  });

  it('renders the quick-launch contract instead of the wizard for a draft arrival', async () => {
    seedDraft();
    seedQuotedOperator();
    const { default: ProvisionPage } = await import('../provision');
    render(<ProvisionPage />);

    expect(screen.getByText('Momentum Scout')).toBeInTheDocument();
    expect(screen.getByText('ETH / USDC')).toBeInTheDocument();
    expect(screen.getByText('Uniswap v3 on Base')).toBeInTheDocument();
    expect(screen.getByText('10% max drawdown')).toBeInTheDocument();
    expect(screen.getByText('Paper start')).toBeInTheDocument();

    // The 4-step wizard chrome must not render on the quick path.
    expect(screen.queryByRole('button', { name: /Blueprint/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('configure-step')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deploy-step')).not.toBeInTheDocument();

    // Auto-resolution converges on the cheapest quote and prices the button.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Launch · $5.00' }),
      ).toBeEnabled();
    });
  });

  it('launches through createServiceFromQuotes with the auto-picked operator', async () => {
    seedDraft();
    seedQuotedOperator();
    const { default: ProvisionPage } = await import('../provision');
    const user = userEvent.setup();
    render(<ProvisionPage />);

    const launch = await screen.findByRole('button', { name: 'Launch · $5.00' });
    await waitFor(() => expect(launch).toBeEnabled());
    await user.click(launch);

    await waitFor(() => {
      expect(shared.newServiceWriteContract).toHaveBeenCalledTimes(1);
    });
    const [writeConfig] = shared.newServiceWriteContract.mock.calls[0];
    expect(writeConfig.functionName).toBe('createServiceFromQuotes');
    expect(writeConfig.args[1]).toHaveLength(1);
    expect(writeConfig.args[1][0].operator).toBe(OPERATOR);
  });

  it('keeps the wizard reachable through the Advanced setup escape hatch with the draft applied', async () => {
    seedDraft();
    seedQuotedOperator();
    const { default: ProvisionPage } = await import('../provision');
    const user = userEvent.setup();
    render(<ProvisionPage />);

    await user.click(screen.getByRole('button', { name: 'Advanced setup' }));

    await waitFor(() => {
      expect(screen.getByTestId('configure-step')).toHaveTextContent(
        'Momentum Scout',
      );
    });
    // Wizard chrome is back.
    expect(screen.getByRole('button', { name: /Blueprint/ })).toBeInTheDocument();
  });

  it('falls back to the deploy step with a visible notice when no operators are discoverable', async () => {
    seedDraft();
    shared.operators = [];
    shared.operatorsLoading = false;
    const { default: ProvisionPage } = await import('../provision');
    render(<ProvisionPage />);

    await waitFor(() => {
      expect(screen.getByTestId('deploy-step')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/No operators are discoverable for this runtime/),
    ).toBeInTheDocument();
  });

  it('keeps the plain wizard for draft arrivals when no stored draft exists', async () => {
    const { default: ProvisionPage } = await import('../provision');
    render(<ProvisionPage />);

    // Wizard chrome (stage bar) renders from the first step.
    expect(
      await screen.findByRole('button', { name: /Blueprint/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Advanced setup' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Launch contract')).not.toBeInTheDocument();
  });
});
