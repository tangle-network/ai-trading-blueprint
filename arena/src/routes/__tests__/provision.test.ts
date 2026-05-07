import { describe, expect, it, vi } from 'vitest';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import type { TrackedProvision } from '~/lib/stores/provisions';

const setSearchParams = vi.fn();

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useSearchParams: () => [new URLSearchParams(), setSearchParams],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: undefined,
    isConnected: false,
    chainId: undefined,
  }),
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

vi.mock('@tangle-network/blueprint-ui', () => ({
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
      executionMode: 'single-chain',
      supportedChainIds: [84532, 31339],
      cron: '* * * * *',
      maxTurns: 1,
      timeoutMs: 1000,
      expertKnowledge: '',
    },
    {
      id: 'yield',
      name: 'Yield',
      description: 'Yield strategy',
      providers: ['Aave', 'Morpho'],
      executionMode: 'single-chain',
      supportedChainIds: [1, 8453],
      cron: '* * * * *',
      maxTurns: 1,
      timeoutMs: 1000,
      expertKnowledge: '',
    },
    {
      id: 'prediction',
      name: 'Prediction',
      description: 'Prediction strategy',
      providers: ['Polymarket'],
      executionMode: 'single-chain',
      supportedChainIds: [137],
      cron: '* * * * *',
      maxTurns: 1,
      timeoutMs: 1000,
      expertKnowledge: '',
    },
    {
      id: 'perp',
      name: 'Perp',
      description: 'Perp strategy',
      providers: ['GMX'],
      executionMode: 'single-chain',
      supportedChainIds: [42161],
      cron: '* * * * *',
      maxTurns: 1,
      timeoutMs: 1000,
      expertKnowledge: '',
    },
    {
      id: 'volatility',
      name: 'Volatility',
      description: 'Volatility strategy',
      providers: ['Polymarket', 'GMX'],
      executionMode: 'paper-only',
      supportedChainIds: [],
      cron: '* * * * *',
      maxTurns: 1,
      timeoutMs: 1000,
      expertKnowledge: '',
    },
    {
      id: 'multi',
      name: 'Cross-Strategy',
      description: 'Multi strategy',
      providers: ['All protocols'],
      executionMode: 'none',
      supportedChainIds: [],
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
  ConfigureStep: () => null,
}));
vi.mock('~/components/provision/DeployStep', () => ({
  DeployStep: () => null,
}));
vi.mock('~/components/provision/SecretsStep', () => ({
  SecretsStep: () => null,
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

describe('provision runtime backend helpers', () => {
  it('falls back unsupported firecracker runtime to docker', async () => {
    const { resolveRuntimeBackendForProvision, FIRECRACKER_RUNTIME_SUPPORTED } =
      await import('../provision');
    expect(FIRECRACKER_RUNTIME_SUPPORTED).toBe(false);
    expect(resolveRuntimeBackendForProvision('firecracker', false)).toBe(
      'docker',
    );
  });

  it('pins tee blueprints to tee runtime', async () => {
    const { resolveRuntimeBackendForProvision } = await import('../provision');
    expect(resolveRuntimeBackendForProvision('docker', true)).toBe('tee');
  });

  it('keeps firecracker when explicitly marked as supported', async () => {
    const { resolveRuntimeBackendForProvision } = await import('../provision');
    expect(resolveRuntimeBackendForProvision('firecracker', false, true)).toBe(
      'firecracker',
    );
  });

  it('falls back to the first configured network when the selected chain is unsupported', async () => {
    const { resolveSelectedProvisionNetwork } = await import('../provision');
    expect(resolveSelectedProvisionNetwork(31339)?.chain.id).toBe(0);
  });

  it('propagates normalized runtime and overrides into strategy config payload', async () => {
    const { buildStrategyConfigForProvision } = await import('../provision');
    expect(
      buildStrategyConfigForProvision({
        runtimeBackend: 'firecracker',
        isTeeBlueprint: false,
        customExpertKnowledge: 'expert notes',
        customInstructions: 'custom prompt',
        paperTrade: false,
        protocolChainId: 1,
        availableProtocols: ['gmx_v2', 'vertex'],
      }),
    ).toEqual({
      runtime_backend: 'docker',
      paper_trade: false,
      protocol_chain_id: 1,
      available_protocols: ['gmx_v2', 'vertex'],
      expert_knowledge_override: 'expert notes',
      custom_instructions: 'custom prompt',
    });
  });

  it('parses positive validator service IDs consistently', async () => {
    const { parsePositiveServiceIds, resolveValidatorServiceIds } = await import(
      '../provision'
    );

    expect(parsePositiveServiceIds(' 1, 2 ,3 ', 'Validators')).toEqual({
      ok: true,
      ids: [1n, 2n, 3n],
    });
    expect(parsePositiveServiceIds('', 'Validators')).toEqual({
      ok: true,
      ids: [],
    });
    expect(parsePositiveServiceIds('0', 'Validators')).toMatchObject({
      ok: false,
    });
    expect(parsePositiveServiceIds('1,nope', 'Validators')).toMatchObject({
      ok: false,
    });
    expect(
      resolveValidatorServiceIds({
        validatorMode: 'default',
        customValidatorIds: '',
        defaultValidatorServiceId: 'not-a-number',
      }),
    ).toEqual({ ok: true, ids: [] });
  });

  it('blocks invalid custom validator IDs instead of silently dropping them', async () => {
    const { resolveValidatorServiceIds } = await import('../provision');

    expect(
      resolveValidatorServiceIds({
        validatorMode: 'custom',
        customValidatorIds: '7, invalid',
        defaultValidatorServiceId: '9',
      }),
    ).toMatchObject({ ok: false });
  });

  it('shares normalized strategy runtime and schedules across provision payload builders', async () => {
    const {
      buildProvisionStrategyConfig,
      buildOperatorProvisionBody,
      buildInstanceServiceConfig,
    } = await import('../provision');
    const strategyOptions = {
      strategyType: 'dex',
      runtimeBackend: 'tee' as const,
      isTeeBlueprint: false,
      customExpertKnowledge: 'notes',
      customInstructions: 'instructions',
      conversationCron: '0 */2 * * * *',
      researchCron: '0 0 * * * *',
      conversationEnabled: false,
      researchEnabled: true,
    };

    const directConfig = buildProvisionStrategyConfig({
      ...strategyOptions,
      includeExecutionTarget: false,
    });
    const operatorBody = buildOperatorProvisionBody({
      ...strategyOptions,
      name: 'Bot',
      fallbackName: 'Fallback Bot',
      effectiveCron: '* * * * *',
      validatorServiceIds: [11n],
      includeExecutionTarget: false,
    });
    const serviceConfig = buildInstanceServiceConfig({
      ...strategyOptions,
      isInstance: true,
      name: 'Bot',
      includeExecutionTarget: false,
      effectiveCron: '* * * * *',
      validatorServiceIds: [11n],
      vaultSigners: [],
      collateralBps: 2500n,
      targetChainId: 31337,
      assetAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      blueprintDefaults: {
        cpuCores: 1n,
        memoryMb: 512n,
        maxLifetimeDays: 7n,
      },
    });
    const [decoded] = decodeAbiParameters(
      parseAbiParameters(
        '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[], uint256)',
      ),
      serviceConfig,
    );
    const instanceStrategyConfig = JSON.parse(decoded[2]);

    expect(JSON.parse(operatorBody.strategy_config_json)).toEqual(directConfig);
    expect(instanceStrategyConfig).toEqual(directConfig);
    expect(directConfig).toMatchObject({
      runtime_backend: 'docker',
      workflow_schedules: {
        conversation_cron: '0 */2 * * * *',
        research_cron: '0 0 * * * *',
        conversation_enabled: false,
        research_enabled: true,
      },
    });
  });

  it('converts Uniswap envelope ETH amount inputs to wei risk limits', async () => {
    const {
      buildOperatorProvisionBody,
      buildInstanceServiceConfig,
      buildProvisionRiskParams,
      envelopeEthAmountToWei,
    } = await import('../provision');
    const strategyOptions = {
      strategyType: 'dex',
      runtimeBackend: 'docker' as const,
      isTeeBlueprint: false,
      uniswapEnvelopeEnabled: true,
      uniswapEnvelopeMaxDurationSecs: 3600,
      uniswapEnvelopeMaxSingleAmountIn: '0.01',
      uniswapEnvelopeMaxTotalAmountIn: '1.5',
      uniswapEnvelopeMaxSlippageBps: 100,
    };

    expect(envelopeEthAmountToWei('0.01')).toBe('10000000000000000');
    expect(buildProvisionRiskParams(strategyOptions)).toMatchObject({
      uniswap_envelope: {
        enabled: true,
        max_single_amount_in: '10000000000000000',
        max_total_amount_in: '1500000000000000000',
      },
    });

    const operatorBody = buildOperatorProvisionBody({
      ...strategyOptions,
      name: 'Bot',
      fallbackName: 'Fallback Bot',
      effectiveCron: '* * * * *',
      validatorServiceIds: [11n],
      includeExecutionTarget: false,
    });
    expect(JSON.parse(operatorBody.risk_params_json)).toMatchObject({
      uniswap_envelope: {
        enabled: true,
        max_single_amount_in: '10000000000000000',
        max_total_amount_in: '1500000000000000000',
      },
    });

    const serviceConfig = buildInstanceServiceConfig({
      ...strategyOptions,
      isInstance: true,
      name: 'Bot',
      includeExecutionTarget: false,
      effectiveCron: '* * * * *',
      validatorServiceIds: [11n],
      vaultSigners: [],
      collateralBps: 2500n,
      targetChainId: 31337,
      assetAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      blueprintDefaults: {
        cpuCores: 1n,
        memoryMb: 512n,
        maxLifetimeDays: 7n,
      },
    });
    const [decoded] = decodeAbiParameters(
      parseAbiParameters(
        '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[], uint256)',
      ),
      serviceConfig,
    );
    expect(JSON.parse(decoded[3])).toMatchObject({
      uniswap_envelope: {
        enabled: true,
        max_single_amount_in: '10000000000000000',
        max_total_amount_in: '1500000000000000000',
      },
    });
  });

  it('requires positive Uniswap envelope limits for live envelope mode', async () => {
    const { validateUniswapEnvelopeLimitInputs } = await import('../provision');

    expect(
      validateUniswapEnvelopeLimitInputs({
        strategyType: 'dex',
        paperTrade: false,
        uniswapEnvelopeEnabled: true,
        uniswapEnvelopeMaxSingleAmountIn: '',
        uniswapEnvelopeMaxTotalAmountIn: '1',
      }),
    ).toEqual({
      ok: false,
      message: 'Enter positive Max single and Max total ETH amounts for Uniswap envelope mode',
    });

    expect(
      validateUniswapEnvelopeLimitInputs({
        strategyType: 'dex',
        paperTrade: false,
        uniswapEnvelopeEnabled: true,
        uniswapEnvelopeMaxSingleAmountIn: '2',
        uniswapEnvelopeMaxTotalAmountIn: '1',
      }),
    ).toEqual({
      ok: false,
      message: 'Max single ETH amount must be less than or equal to Max total ETH amount',
    });

    expect(
      validateUniswapEnvelopeLimitInputs({
        strategyType: 'dex',
        paperTrade: false,
        uniswapEnvelopeEnabled: true,
        uniswapEnvelopeMaxSingleAmountIn: '0.25',
        uniswapEnvelopeMaxTotalAmountIn: '1',
      }),
    ).toEqual({ ok: true });
  });

  it('does not require Uniswap envelope limits outside live envelope mode', async () => {
    const { validateUniswapEnvelopeLimitInputs } = await import('../provision');

    expect(
      validateUniswapEnvelopeLimitInputs({
        strategyType: 'dex',
        paperTrade: true,
        uniswapEnvelopeEnabled: true,
        uniswapEnvelopeMaxSingleAmountIn: '',
        uniswapEnvelopeMaxTotalAmountIn: '',
      }),
    ).toEqual({ ok: true });

    expect(
      validateUniswapEnvelopeLimitInputs({
        strategyType: 'dex',
        paperTrade: false,
        uniswapEnvelopeEnabled: false,
        uniswapEnvelopeMaxSingleAmountIn: '',
        uniswapEnvelopeMaxTotalAmountIn: '',
      }),
    ).toEqual({ ok: true });
  });

  it('forces Uniswap envelope risk params off for paper trading', async () => {
    const { buildProvisionRiskParams } = await import('../provision');

    expect(
      buildProvisionRiskParams({
        strategyType: 'dex',
        runtimeBackend: 'docker',
        isTeeBlueprint: false,
        paperTrade: true,
        uniswapEnvelopeEnabled: true,
        uniswapEnvelopeMaxSingleAmountIn: '0.01',
        uniswapEnvelopeMaxTotalAmountIn: '1',
      }),
    ).toMatchObject({
      uniswap_envelope: {
        enabled: false,
        max_single_amount_in: '10000000000000000',
        max_total_amount_in: '1000000000000000000',
      },
    });
  });

  it('builds WETH-scoped Uniswap envelope limits for Ethereum live targets', async () => {
    const {
      buildInstanceServiceConfig,
      buildOperatorProvisionBody,
      resolveExecutionTargetProvisionConfig,
    } = await import('../provision');
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const target = {
      id: 'ethereum' as const,
      label: 'Ethereum Fork',
      description: 'Local fork',
      enabled: true,
      chainId: 31339,
      protocolChainId: 1,
      rpcUrl: 'http://127.0.0.1:42545',
      vaultFactoryAddress: '0x710e9fbed43da7da297c46e868de78d16e309afb',
      assetToken: weth,
      paperTrade: false,
    };
    const executionConfig = resolveExecutionTargetProvisionConfig(target);

    const operatorBody = buildOperatorProvisionBody({
      strategyType: 'dex',
      runtimeBackend: 'docker',
      isTeeBlueprint: false,
      uniswapEnvelopeEnabled: true,
      uniswapEnvelopeMaxSingleAmountIn: '0.5',
      uniswapEnvelopeMaxTotalAmountIn: '2',
      name: 'Bot',
      fallbackName: 'Fallback Bot',
      effectiveCron: '* * * * *',
      validatorServiceIds: [11n],
      selectedExecutionTarget: target,
      includeExecutionTarget: true,
      executionConfig,
    });
    const riskParams = JSON.parse(operatorBody.risk_params_json);

    expect(riskParams.uniswap_envelope.allowed_pairs).toEqual([
      { token_in: weth, token_out: usdc },
    ]);
    expect(riskParams.uniswap_envelope.max_single_amount_in_by_token).toEqual({
      [weth]: '500000000000000000',
    });
    expect(riskParams.uniswap_envelope.max_total_amount_in_by_token).toEqual({
      [weth]: '2000000000000000000',
    });

    const serviceConfig = buildInstanceServiceConfig({
      strategyType: 'dex',
      runtimeBackend: 'docker',
      isTeeBlueprint: false,
      paperTrade: false,
      uniswapEnvelopeEnabled: true,
      uniswapEnvelopeMaxSingleAmountIn: '0.5',
      uniswapEnvelopeMaxTotalAmountIn: '2',
      isInstance: true,
      name: 'Bot',
      includeExecutionTarget: true,
      selectedExecutionTarget: target,
      executionConfig,
      effectiveCron: '* * * * *',
      validatorServiceIds: [11n],
      vaultSigners: [],
      collateralBps: 2500n,
      targetChainId: 31339,
      assetAddress: weth,
      blueprintDefaults: {
        cpuCores: 1n,
        memoryMb: 512n,
        maxLifetimeDays: 7n,
      },
    });
    const [decoded] = decodeAbiParameters(
      parseAbiParameters(
        '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[], uint256)',
      ),
      serviceConfig,
    );
    const instanceStrategyConfig = JSON.parse(decoded[2]);
    const instanceRiskParams = JSON.parse(decoded[3]);

    expect(instanceStrategyConfig).toMatchObject({
      protocol_chain_id: 1,
      available_protocols: ['uniswap_v3'],
    });
    expect(instanceRiskParams.uniswap_envelope).toMatchObject({
      enabled: true,
      allowed_pairs: [{ token_in: weth, token_out: usdc }],
      max_single_amount_in_by_token: {
        [weth]: '500000000000000000',
      },
      max_total_amount_in_by_token: {
        [weth]: '2000000000000000000',
      },
    });
  });

  it('keeps Uniswap envelope disabled for paper-trading instances', async () => {
    const { buildInstanceServiceConfig, resolveExecutionTargetProvisionConfig } =
      await import('../provision');
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const target = {
      id: 'ethereum' as const,
      label: 'Ethereum Fork',
      description: 'Local fork',
      enabled: true,
      chainId: 31339,
      protocolChainId: 1,
      rpcUrl: 'http://127.0.0.1:42545',
      vaultFactoryAddress: '0x710e9fbed43da7da297c46e868de78d16e309afb',
      assetToken: weth,
      paperTrade: true,
    };
    const executionConfig = resolveExecutionTargetProvisionConfig(target);

    const serviceConfig = buildInstanceServiceConfig({
      strategyType: 'dex',
      runtimeBackend: 'docker',
      isTeeBlueprint: false,
      paperTrade: true,
      uniswapEnvelopeEnabled: true,
      uniswapEnvelopeMaxSingleAmountIn: '0.5',
      uniswapEnvelopeMaxTotalAmountIn: '2',
      isInstance: true,
      name: 'Bot',
      includeExecutionTarget: true,
      selectedExecutionTarget: target,
      executionConfig,
      effectiveCron: '* * * * *',
      validatorServiceIds: [11n],
      vaultSigners: [],
      collateralBps: 2500n,
      targetChainId: 31339,
      assetAddress: weth,
      blueprintDefaults: {
        cpuCores: 1n,
        memoryMb: 512n,
        maxLifetimeDays: 7n,
      },
    });
    const [decoded] = decodeAbiParameters(
      parseAbiParameters(
        '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[], uint256)',
      ),
      serviceConfig,
    );
    const instanceRiskParams = JSON.parse(decoded[3]);

    expect(instanceRiskParams.uniswap_envelope.enabled).toBe(false);
  });

  it('resolves a complete execution target into provision-safe values', async () => {
    const { resolveExecutionTargetProvisionConfig } =
      await import('../provision');
    expect(
      resolveExecutionTargetProvisionConfig({
        id: 'ethereum',
        label: 'Ethereum Fork (Local QA)',
        description: 'Local fork',
        enabled: true,
        chainId: 31339,
        rpcUrl: 'http://127.0.0.1:42545',
        vaultAddress: '0x19ba547192222d3480665d4af454270b3fbe6749',
        assetToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        paperTrade: false,
        protocolChainId: 1,
      }),
    ).toEqual({
      chainId: 31339n,
      rpcUrl: 'http://127.0.0.1:42545',
      vaultBinding: 'direct',
      provisionVaultAddress: '0x19ba547192222d3480665d4af454270b3fbe6749',
      vaultFactoryAddress: undefined,
      vaultAddress: '0x19ba547192222d3480665d4af454270b3fbe6749',
      assetAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      paperTrade: false,
      protocolChainId: 1,
    });
  });

  it('keeps cloud factory and direct vault execution addresses separate', async () => {
    const { resolveExecutionTargetProvisionConfig } =
      await import('../provision');
    expect(
      resolveExecutionTargetProvisionConfig({
        id: 'ethereum',
        label: 'Ethereum Fork (Local QA)',
        description: 'Local fork',
        enabled: true,
        chainId: 31339,
        rpcUrl: 'http://127.0.0.1:42545',
        vaultFactoryAddress: '0x00000000000000000000000000000000000000fa',
        vaultAddress: '0x00000000000000000000000000000000000000bb',
        assetToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        paperTrade: false,
        protocolChainId: 1,
      }),
    ).toMatchObject({
      vaultBinding: 'factory',
      provisionVaultAddress: '0x00000000000000000000000000000000000000fa',
      vaultFactoryAddress: '0x00000000000000000000000000000000000000fa',
      vaultAddress: '0x00000000000000000000000000000000000000bb',
    });
  });

  it('defaults enabled execution targets to live mode when paper mode is omitted', async () => {
    const { resolveExecutionTargetProvisionConfig } =
      await import('../provision');
    const config = resolveExecutionTargetProvisionConfig({
      id: 'ethereum',
      label: 'Ethereum Fork (Local Live)',
      description: 'Local fork',
      enabled: true,
      chainId: 31339,
      rpcUrl: 'http://127.0.0.1:42545',
      vaultAddress: '0x19ba547192222d3480665d4af454270b3fbe6749',
      assetToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    });

    expect(config).toMatchObject({
      paperTrade: false,
    });
  });

  it('uses execution target config when the target is compatible with the strategy', async () => {
    const { strategyUsesExecutionTarget } = await import('../provision');
    const ethereumTarget = {
      id: 'ethereum',
      label: 'Ethereum Fork (Local Live)',
      description: 'Local fork',
      enabled: true,
      chainId: 31339,
      protocolChainId: 1,
    } as const;
    const arbitrumForkTarget = {
      id: 'arbitrum-fork',
      label: 'Arbitrum Fork',
      description: 'Local Arbitrum fork',
      enabled: true,
      chainId: 31340,
      protocolChainId: 42161,
    } as const;
    const baseTarget = {
      id: 'base',
      label: 'Base Sepolia',
      description: 'Base',
      enabled: true,
      chainId: 84532,
    } as const;

    expect(strategyUsesExecutionTarget('dex', baseTarget)).toBe(true);
    expect(strategyUsesExecutionTarget('dex', ethereumTarget)).toBe(false);
    expect(strategyUsesExecutionTarget('perp', arbitrumForkTarget)).toBe(true);
    expect(strategyUsesExecutionTarget('perp', ethereumTarget)).toBe(false);
    expect(strategyUsesExecutionTarget('yield', baseTarget)).toBe(false);
    expect(strategyUsesExecutionTarget('prediction', baseTarget)).toBe(false);
    expect(strategyUsesExecutionTarget('prediction', baseTarget, false)).toBe(
      false,
    );
  });

  it('rejects incomplete execution targets', async () => {
    const { resolveExecutionTargetProvisionConfig } =
      await import('../provision');
    expect(
      resolveExecutionTargetProvisionConfig({
        id: 'ethereum',
        label: 'Ethereum Fork (Local QA)',
        description: 'Local fork',
        enabled: true,
        chainId: 31339,
      }),
    ).toBeNull();
  });

  it('prefers the current service when selecting the latest instance provision', async () => {
    const { selectLatestInstanceProvision } = await import('../provision');
    const owner = '0x0000000000000000000000000000000000000001' as const;
    expect(
      selectLatestInstanceProvision(
        [
          {
            id: 'instance-11',
            owner,
            name: 'Older',
            strategyType: 'dex',
            operators: [],
            blueprintId: '1',
            serviceId: 11,
            phase: 'awaiting_secrets',
            createdAt: 10,
            updatedAt: 10,
            chainId: 31337,
          },
          {
            id: 'instance-12',
            owner,
            name: 'Newest',
            strategyType: 'dex',
            operators: [],
            blueprintId: '1',
            serviceId: 12,
            phase: 'awaiting_secrets',
            createdAt: 20,
            updatedAt: 20,
            chainId: 31337,
          },
        ],
        '11',
      )?.id,
    ).toBe('instance-11');
  });

  it('resumes the explicitly targeted instance draft by bot or sandbox identity', async () => {
    const { selectLatestInstanceProvision } = await import('../provision');
    const owner = '0x0000000000000000000000000000000000000001' as const;
    const provisions: TrackedProvision[] = [
      {
        id: 'instance-11',
        owner,
        name: 'Older',
        strategyType: 'dex',
        operators: [],
        blueprintId: '1',
        serviceId: 11,
        botId: 'bot-11',
        sandboxId: 'sandbox-11',
        phase: 'awaiting_secrets',
        createdAt: 10,
        updatedAt: 10,
        chainId: 31337,
      },
      {
        id: 'instance-12',
        owner,
        name: 'Newest',
        strategyType: 'dex',
        operators: [],
        blueprintId: '1',
        serviceId: 12,
        botId: 'bot-12',
        sandboxId: 'sandbox-12',
        phase: 'awaiting_secrets',
        createdAt: 20,
        updatedAt: 20,
        chainId: 31337,
      },
    ];

    expect(
      selectLatestInstanceProvision(provisions, undefined, { botId: 'bot-11' })
        ?.id,
    ).toBe('instance-11');
    expect(
      selectLatestInstanceProvision(provisions, undefined, {
        sandboxId: 'sandbox-12',
      })?.id,
    ).toBe('instance-12');
  });

  it('does not guess when multiple instance drafts exist without a route target', async () => {
    const { selectLatestInstanceProvision } = await import('../provision');
    const owner = '0x0000000000000000000000000000000000000001' as const;

    expect(
      selectLatestInstanceProvision([
        {
          id: 'instance-11',
          owner,
          name: 'Older',
          strategyType: 'dex',
          operators: [],
          blueprintId: '1',
          serviceId: 11,
          phase: 'awaiting_secrets',
          createdAt: 10,
          updatedAt: 10,
          chainId: 31337,
        },
        {
          id: 'instance-12',
          owner,
          name: 'Newest',
          strategyType: 'dex',
          operators: [],
          blueprintId: '1',
          serviceId: 12,
          phase: 'awaiting_secrets',
          createdAt: 20,
          updatedAt: 20,
          chainId: 31337,
        },
      ]),
    ).toBeUndefined();
  });

  it('still auto-resumes when there is exactly one instance draft', async () => {
    const { selectLatestInstanceProvision } = await import('../provision');
    const owner = '0x0000000000000000000000000000000000000001' as const;

    expect(
      selectLatestInstanceProvision([
        {
          id: 'instance-11',
          owner,
          name: 'Only Draft',
          strategyType: 'dex',
          operators: [],
          blueprintId: '1',
          serviceId: 11,
          phase: 'awaiting_secrets',
          createdAt: 10,
          updatedAt: 10,
          chainId: 31337,
        },
      ])?.id,
    ).toBe('instance-11');
  });

  it('filters execution targets by selected strategy chain support', async () => {
    const { executionTargetsForStrategy } = await import('../provision');
    const targets = [
      {
        id: 'base',
        label: 'Base Sepolia',
        description: 'Base test',
        enabled: true,
        chainId: 84532,
      },
      {
        id: 'polygon',
        label: 'Polygon',
        description: 'Polygon',
        enabled: true,
        chainId: 137,
      },
      {
        id: 'arbitrum-fork',
        label: 'Arbitrum Fork',
        description: 'Arbitrum fork',
        enabled: true,
        chainId: 31340,
        protocolChainId: 42161,
      },
      {
        id: 'arbitrum-one',
        label: 'Arbitrum One',
        description: 'Arbitrum',
        enabled: true,
        chainId: 42161,
      },
    ] as const;

    expect(
      executionTargetsForStrategy('dex', [...targets]).map(
        (target) => target.id,
      ),
    ).toEqual(['base']);
    expect(
      executionTargetsForStrategy('prediction', [...targets]).map(
        (target) => target.id,
      ),
    ).toEqual(['polygon']);
    expect(
      executionTargetsForStrategy('perp', [...targets]).map(
        (target) => target.id,
      ),
    ).toEqual(['arbitrum-fork', 'arbitrum-one']);
    expect(executionTargetsForStrategy('volatility', [...targets])).toEqual([]);
  });

  it('returns GMX and Vertex as the Arbitrum perp protocols', async () => {
    const { availableProtocolsForStrategyTarget } =
      await import('../provision');
    expect(
      availableProtocolsForStrategyTarget('perp', {
        id: 'arbitrum-fork',
        label: 'Arbitrum Fork',
        description: 'Local Arbitrum fork',
        enabled: true,
        chainId: 31340,
        protocolChainId: 42161,
      }),
    ).toEqual(['gmx_v2', 'vertex']);
    expect(
      availableProtocolsForStrategyTarget('perp', {
        id: 'ethereum',
        label: 'Ethereum Fork',
        description: 'Local Ethereum fork',
        enabled: true,
        chainId: 31339,
        protocolChainId: 1,
      }),
    ).toBeUndefined();
  });

  it('defaults Uniswap envelope mode for live Uniswap execution targets only', async () => {
    const { shouldDefaultUniswapEnvelopeMode } = await import('../provision');
    const liveDexTarget = {
      id: 'ethereum',
      label: 'Ethereum Fork',
      description: 'Local Ethereum fork',
      enabled: true,
      chainId: 31339,
    } as const;

    expect(shouldDefaultUniswapEnvelopeMode('dex', liveDexTarget, false)).toBe(true);
    expect(shouldDefaultUniswapEnvelopeMode('dex', liveDexTarget, true)).toBe(false);
    expect(
      shouldDefaultUniswapEnvelopeMode(
        'dex',
        { ...liveDexTarget, enabled: false },
        false,
      ),
    ).toBe(false);
    expect(shouldDefaultUniswapEnvelopeMode('perp', liveDexTarget, false)).toBe(false);
  });

  it('validates paper-only and unsupported single-chain strategies', async () => {
    const { validateStrategyExecutionSelection } = await import('../provision');
    const target = {
      id: 'base',
      label: 'Base Sepolia',
      description: 'Base test',
      enabled: true,
      chainId: 84532,
    } as const;

    expect(
      validateStrategyExecutionSelection('volatility', target, true),
    ).toEqual({ ok: true });
    expect(
      validateStrategyExecutionSelection('volatility', target, false),
    ).toMatchObject({ ok: false });
    expect(
      validateStrategyExecutionSelection('multi', target, true),
    ).toMatchObject({ ok: false });
    expect(
      validateStrategyExecutionSelection('prediction', target, true),
    ).toMatchObject({ ok: false });
  });
});
