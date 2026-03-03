import { describe, expect, it, vi } from 'vitest';

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
  useStore: () => 0,
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
vi.mock('~/components/provision/ConfigureStep', () => ({ ConfigureStep: () => null }));
vi.mock('~/components/provision/DeployStep', () => ({ DeployStep: () => null }));
vi.mock('~/components/provision/SecretsStep', () => ({ SecretsStep: () => null }));
vi.mock('~/components/provision/InfrastructureDialog', () => ({ InfrastructureDialog: () => null }));
vi.mock('~/components/provision/AdvancedSettingsDialog', () => ({ AdvancedSettingsDialog: () => null }));

vi.mock('~/lib/utils/resolveBotId', () => ({
  resolveBotId: vi.fn(async () => ({ botId: 'bot-1' })),
}));

describe('provision runtime backend helpers', () => {
  it('falls back unsupported firecracker runtime to docker', async () => {
    const { resolveRuntimeBackendForProvision, FIRECRACKER_RUNTIME_SUPPORTED } = await import('../provision');
    expect(FIRECRACKER_RUNTIME_SUPPORTED).toBe(false);
    expect(resolveRuntimeBackendForProvision('firecracker', false)).toBe('docker');
  });

  it('pins tee blueprints to tee runtime', async () => {
    const { resolveRuntimeBackendForProvision } = await import('../provision');
    expect(resolveRuntimeBackendForProvision('docker', true)).toBe('tee');
  });

  it('propagates normalized runtime and overrides into strategy config payload', async () => {
    const { buildStrategyConfigForProvision } = await import('../provision');
    expect(
      buildStrategyConfigForProvision({
        runtimeBackend: 'firecracker',
        isTeeBlueprint: false,
        customExpertKnowledge: 'expert notes',
        customInstructions: 'custom prompt',
      }),
    ).toEqual({
      runtime_backend: 'docker',
      expert_knowledge_override: 'expert notes',
      custom_instructions: 'custom prompt',
    });
  });
});
