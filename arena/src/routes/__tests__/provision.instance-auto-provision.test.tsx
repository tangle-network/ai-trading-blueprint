import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => {
  const state: any = {
    addProvision: vi.fn(),
    addTx: vi.fn(),
    authenticate: vi.fn(async () => 'test-token'),
    clearCachedToken: vi.fn(),
    decodeEventLog: vi.fn(({ data }: { data: string }) => {
      if (data !== '0x01') throw new Error('unrelated log');
      return {
        eventName: 'ServiceActivated',
        args: {
          blueprintId: 2n,
          serviceId: 77n,
        },
      };
    }),
    fetchMock: vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/bot/provision')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bot_id: 'bot-77',
            sandbox_id: 'sandbox-77',
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'bot-77',
          sandbox_id: 'sandbox-77',
          sandbox_exists: true,
          vault_address: '0x0000000000000000000000000000000000000000',
          strategy_type: 'dex',
          trading_active: false,
          lifecycle_status: 'awaiting_secrets',
          secrets_configured: false,
          call_id: 0,
          service_id: 77,
          workflow_id: null,
        }),
      };
    }),
    instanceBlueprint: {
      id: 'trading-instance',
      name: 'Instance',
      blueprintId: '2',
      isFleet: false,
      isTee: false,
      defaults: { cpuCores: 1n, memoryMb: 512n, maxLifetimeDays: 7n },
      encodeProvision: vi.fn(() => '0x'),
    },
    instanceVaultAddress: '0x0000000000000000000000000000000000000077',
    newServiceWriteContract: vi.fn(),
    provisions: [] as any[],
    removeInstanceProvisions: vi.fn(),
    removeMatchingInstanceProvision: vi.fn(),
    removeProvision: vi.fn(),
    resetTx: vi.fn(),
    resolveReceipt: undefined as ((value: unknown) => void) | undefined,
    setSearchParams: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    updateProvision: vi.fn(),
    upsertInstanceProvision: vi.fn((provision: any) => {
      state.provisions = [provision];
    }),
    useWriteContractCalls: 0,
    waitForTransactionReceipt: vi.fn(
      () =>
        new Promise((resolve) => {
          state.resolveReceipt = resolve;
        }),
    ),
    watchContractEvent: vi.fn(({ onLogs }: { onLogs: (logs: Array<{ args: { blueprintId?: bigint; serviceId?: bigint } }>) => void }) => {
      state.watchLogs = onLogs;
      return vi.fn();
    }),
    watchLogs: undefined as
      | ((logs: Array<{ args: { blueprintId?: bigint; serviceId?: bigint } }>) => void)
      | undefined,
  };

  state.ownerStore = {
    get: () => state.provisions,
    subscribe: vi.fn(() => vi.fn()),
  };

  state.newServiceWriteContract.mockImplementation(
    (_config: unknown, callbacks?: { onSuccess?: (hash: `0x${string}`) => void }) => {
      callbacks?.onSuccess?.(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      );
    },
  );

  return state;
});

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useSearchParams: () => [new URLSearchParams(), shared.setSearchParams],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x0000000000000000000000000000000000000001',
    isConnected: true,
    chainId: 31337,
  }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => {
    shared.useWriteContractCalls += 1;
    if (shared.useWriteContractCalls === 1) {
      return {
        writeContract: vi.fn(),
        data: undefined,
        isPending: false,
        reset: shared.resetTx,
      };
    }

    return {
      writeContract: shared.newServiceWriteContract,
      isPending: false,
    };
  },
}));

vi.mock('@nanostores/react', () => ({
  useStore: (store: any) => {
    if (store && typeof store.get === 'function') return store.get();
    return 0;
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: shared.toastError,
    success: shared.toastSuccess,
  },
}));

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    decodeEventLog: shared.decodeEventLog,
  };
});

vi.mock('~/lib/contracts/abis', () => ({
  tangleJobsAbi: [],
  tangleServicesAbi: [],
  tradingBlueprintAbi: [],
}));

vi.mock('~/lib/contracts/addresses', () => ({
  addresses: {
    tangle: '0x0000000000000000000000000000000000000000',
  },
}));

vi.mock('~/lib/contracts/chains', () => ({
  networks: {
    0: {
      chain: {
        id: 31337,
        name: 'Tangle Local',
      },
    },
  },
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  addTx: shared.addTx,
  publicClient: {
    getBlockNumber: vi.fn(async () => 1000n),
    getLogs: vi.fn(async () => []),
    multicall: vi.fn(async () => []),
    readContract: vi.fn(async ({ functionName }: { functionName?: string }) =>
      functionName === 'instanceVault' ? shared.instanceVaultAddress : [],
    ),
    waitForTransactionReceipt: shared.waitForTransactionReceipt,
    watchContractEvent: shared.watchContractEvent,
  },
  selectedChainIdStore: {
    get: () => 0,
    subscribe: vi.fn(() => vi.fn()),
  },
  useOperators: () => ({ operators: [], operatorCount: 0 }),
}));

vi.mock('~/lib/hooks/useQuotes', () => ({
  useQuotes: () => ({
    quotes: [
      {
        operator: '0x0000000000000000000000000000000000000002',
        signature: '0xsig',
        totalCost: 1n,
        details: {
          blueprintId: 2n,
          ttlBlocks: 1n,
          totalCost: 1n,
          timestamp: 1n,
          expiry: 2n,
          confidentiality: 0,
          securityCommitments: [],
          resourceCommitments: [{ kind: 0, count: 1n }],
        },
      },
    ],
    isLoading: false,
    errors: [],
    totalCost: 1n,
    refetch: vi.fn(),
  }),
}));

vi.mock('~/lib/stores/provisions', () => ({
  provisionsForOwner: () => shared.ownerStore,
  addProvision: shared.addProvision,
  upsertInstanceProvision: shared.upsertInstanceProvision,
  removeProvision: shared.removeProvision,
  removeMatchingInstanceProvision: shared.removeMatchingInstanceProvision,
  removeInstanceProvisions: shared.removeInstanceProvisions,
  updateProvision: shared.updateProvision,
  findMatchingInstanceProvision: vi.fn(),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    token: 'test-token',
    authenticate: shared.authenticate,
    clearCachedToken: shared.clearCachedToken,
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
  TRADING_BLUEPRINTS: [shared.instanceBlueprint],
  getBlueprint: vi.fn(() => shared.instanceBlueprint),
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

vi.mock('~/components/provision/BlueprintSelector', () => ({ BlueprintSelector: () => null }));
vi.mock('~/components/provision/ConfigureStep', () => ({
  ConfigureStep: ({ setName, goNext }: { setName: (value: string) => void; goNext: () => void }) => (
    <button
      onClick={() => {
        setName('Instance Bot');
        goNext();
      }}
    >
      Continue
    </button>
  ),
}));
vi.mock('~/components/provision/DeployStep', () => ({
  DeployStep: ({ handleDeployNewService }: { handleDeployNewService: () => void }) => (
    <button onClick={handleDeployNewService}>Create Instance Service</button>
  ),
}));
vi.mock('~/components/provision/SecretsStep', () => ({
  SecretsStep: () => <div data-testid="secrets-step">Secrets</div>,
}));
vi.mock('~/components/provision/InfrastructureDialog', () => ({
  InfrastructureDialog: () => null,
}));
vi.mock('~/components/provision/AdvancedSettingsDialog', () => ({
  AdvancedSettingsDialog: () => null,
}));

vi.mock('~/lib/utils/resolveBotId', () => ({
  resolveBotId: vi.fn(async () => ({ botId: 'bot-77' })),
}));

vi.mock('~/lib/operator/meta', () => ({
  buildBotScopedPath: vi.fn(),
  getExpectedDeploymentKindForBlueprint: vi.fn(() => 'instance'),
  getOperatorApiUrlForBlueprint: vi.fn(() => '/instance-operator-api'),
  useOperatorMeta: () => ({
    data: {
      deployment_kind: 'instance',
      features: { chat: false, terminal: false },
    },
  }),
}));

vi.mock('~/lib/hooks/useRouteOperatorAutoAuth', () => ({
  useRouteOperatorAutoAuth: vi.fn(),
}));

vi.mock('~/lib/events/bots', () => ({
  dispatchBotsRefresh: vi.fn(),
}));

vi.mock('~/lib/operator/errors', () => ({
  isStaleStateError: vi.fn(() => false),
  readOperatorError: vi.fn(async () => new Error('operator error')),
}));

describe('instance service activation auto-provision', () => {
  const getProvisionRequestCalls = () =>
    shared.fetchMock.mock.calls.filter(([url]: [unknown]) =>
      String(url).includes('/api/bot/provision'),
    );

  beforeEach(() => {
    shared.addProvision.mockClear();
    shared.addTx.mockClear();
    shared.authenticate.mockClear();
    shared.clearCachedToken.mockClear();
    shared.fetchMock.mockClear();
    shared.newServiceWriteContract.mockClear();
    shared.provisions = [];
    shared.removeInstanceProvisions.mockClear();
    shared.removeMatchingInstanceProvision.mockClear();
    shared.removeProvision.mockClear();
    shared.resetTx.mockClear();
    shared.resolveReceipt = undefined;
    shared.setSearchParams.mockClear();
    shared.toastError.mockClear();
    shared.toastSuccess.mockClear();
    shared.updateProvision.mockClear();
    shared.upsertInstanceProvision.mockClear();
    shared.useWriteContractCalls = 0;
    shared.waitForTransactionReceipt.mockClear();
    shared.watchContractEvent.mockClear();
    shared.watchLogs = undefined;
    vi.stubEnv('VITE_DEX_BASE_ENABLED', 'true');
    vi.stubEnv('VITE_INSTANCE_TRADING_BLUEPRINT', '0x0000000000000000000000000000000000000002');
    vi.stubEnv('VITE_INSTANCE_VAULT_ADDRESS', '0x00000000000000000000000000000000000000aa');
    vi.resetModules();
    vi.stubGlobal('fetch', shared.fetchMock);
  });

  it('dedupes duplicate ServiceActivated delivery across watcher and receipt paths', async () => {
    const { default: ProvisionPage } = await import('../provision');
    const user = userEvent.setup();

    render(<ProvisionPage />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Create Instance Service' }));

    await waitFor(() => {
      expect(shared.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(shared.watchContractEvent).toHaveBeenCalledTimes(1);
      expect(shared.watchLogs).toBeTypeOf('function');
    });

    const [writeConfig] = shared.newServiceWriteContract.mock.calls[0];
    expect(writeConfig.functionName).toBe('createServiceFromQuotes');
    expect(writeConfig.args[0]).toBe(2n);
    expect(writeConfig.args[1]).toEqual([
      {
        details: {
          blueprintId: 2n,
          ttlBlocks: 1n,
          totalCost: 1n,
          timestamp: 1n,
          expiry: 2n,
          confidentiality: 0,
          securityCommitments: [],
          resourceCommitments: [{ kind: 0, count: 1n }],
        },
        signature: '0xsig',
        operator: '0x0000000000000000000000000000000000000002',
      },
    ]);
    expect(writeConfig.args[3]).toEqual(['0x0000000000000000000000000000000000000001']);
    expect(writeConfig.args[4]).toBe(216000n);

    await act(async () => {
      shared.watchLogs?.([
        {
          args: {
            blueprintId: 2n,
            serviceId: 77n,
          },
        },
      ]);
    });

    await waitFor(() => {
      expect(getProvisionRequestCalls()).toHaveLength(1);
      expect(shared.upsertInstanceProvision).toHaveBeenCalled();
    });

    const [, provisionRequest] = getProvisionRequestCalls()[0];
    expect(JSON.parse((provisionRequest as RequestInit).body as string).vault_address).toBe(
      shared.instanceVaultAddress,
    );

    expect(await screen.findByTestId('secrets-step')).toBeInTheDocument();

    await act(async () => {
      shared.resolveReceipt?.({
        status: 'success',
        logs: [
          {
            data: '0x01',
            topics: ['0xdeadbeef'],
          },
        ],
      });
    });

    await waitFor(() => {
      expect(getProvisionRequestCalls()).toHaveLength(1);
    });

    expect(shared.toastError).not.toHaveBeenCalled();
  });
});
