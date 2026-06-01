import { beforeEach, describe, expect, it, vi } from 'vitest';

const blueprintUiState = vi.hoisted(() => ({
  networks: {} as Record<number, unknown>,
  selectedChainId: 31337,
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  tangleLocal: {
    id: 31337,
    name: 'Tangle Local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  },
  tangleTestnet: {
    id: 3799,
    name: 'Tangle Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://testnet-rpc.tangle.tools'] } },
  },
  tangleMainnet: {
    id: 5845,
    name: 'Tangle Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.tangle.tools'] } },
  },
  rpcUrl: 'http://127.0.0.1:8545',
  allTangleChains: [],
  mainnet: {},
  resolveRpcUrl: vi.fn(),
  selectedChainIdStore: {
    get: vi.fn(() => blueprintUiState.selectedChainId),
    set: vi.fn((chainId: number) => {
      blueprintUiState.selectedChainId = chainId;
    }),
  },
  configureNetworks: vi.fn((networks: Record<number, unknown>) => {
    blueprintUiState.networks = networks;
  }),
  getNetworks: vi.fn(() => blueprintUiState.networks),
}));

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ASSET_TOKEN = '0x00000000000000000000000000000000000000a0';
const VAULT_FACTORY = '0x00000000000000000000000000000000000000f0';
const VAULT = '0x00000000000000000000000000000000000000b0';

async function importChains() {
  vi.resetModules();
  return import('../chains');
}

describe('HyperEVM chain configuration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    blueprintUiState.networks = {};
    blueprintUiState.selectedChainId = 31337;
  });

  it('does not configure HyperEVM testnet with only enabled, chain id, RPC, and asset token', async () => {
    vi.stubEnv('VITE_HYPEREVM_TESTNET_ENABLED', 'true');
    vi.stubEnv('VITE_HYPEREVM_TESTNET_CHAIN_ID', '998');
    vi.stubEnv(
      'VITE_HYPEREVM_TESTNET_RPC_URL',
      'https://rpc.hyperliquid-testnet.xyz/evm',
    );
    vi.stubEnv('VITE_HYPEREVM_TESTNET_USDC_ASSET_TOKEN', ASSET_TOKEN);
    vi.stubEnv('VITE_HYPEREVM_TESTNET_VAULT_FACTORY_ADDRESS', ZERO_ADDRESS);
    vi.stubEnv('VITE_HYPEREVM_TESTNET_VAULT_ADDRESS', ZERO_ADDRESS);

    const { hyperEvmTestnetConfigured, networks } = await importChains();

    expect(hyperEvmTestnetConfigured).toBe(false);
    expect(networks[998]).toBeUndefined();
  });

  it('does not configure HyperEVM mainnet when factory and vault addresses are zero', async () => {
    vi.stubEnv('VITE_HYPEREVM_MAINNET_ENABLED', 'true');
    vi.stubEnv('VITE_HYPEREVM_MAINNET_CHAIN_ID', '999');
    vi.stubEnv(
      'VITE_HYPEREVM_MAINNET_RPC_URL',
      'https://rpc.hyperliquid.xyz/evm',
    );
    vi.stubEnv('VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN', ASSET_TOKEN);
    vi.stubEnv('VITE_HYPEREVM_MAINNET_VAULT_FACTORY_ADDRESS', ZERO_ADDRESS);
    vi.stubEnv('VITE_HYPEREVM_MAINNET_VAULT_ADDRESS', ZERO_ADDRESS);

    const { hyperEvmMainnetConfigured, networks } = await importChains();

    expect(hyperEvmMainnetConfigured).toBe(false);
    expect(networks[999]).toBeUndefined();
  });

  it('configures HyperEVM for factory-provisioned vaults without a direct vault address', async () => {
    vi.stubEnv('VITE_HYPEREVM_TESTNET_ENABLED', 'true');
    vi.stubEnv('VITE_HYPEREVM_TESTNET_CHAIN_ID', '998');
    vi.stubEnv(
      'VITE_HYPEREVM_TESTNET_RPC_URL',
      'https://rpc.hyperliquid-testnet.xyz/evm',
    );
    vi.stubEnv('VITE_HYPEREVM_TESTNET_USDC_ASSET_TOKEN', ASSET_TOKEN);
    vi.stubEnv('VITE_HYPEREVM_TESTNET_VAULT_FACTORY_ADDRESS', VAULT_FACTORY);
    vi.stubEnv('VITE_HYPEREVM_TESTNET_VAULT_ADDRESS', ZERO_ADDRESS);

    const { hyperEvmTestnetConfigured, networks } = await importChains();
    const network = networks[998];

    expect(hyperEvmTestnetConfigured).toBe(true);
    expect(network).toMatchObject({
      rpcUrl: 'https://rpc.hyperliquid-testnet.xyz/evm',
      addresses: {
        vaultFactory: VAULT_FACTORY,
        tradingVault: ZERO_ADDRESS,
      },
    });
  });

  it('configures HyperEVM for direct vault reads without a factory address', async () => {
    vi.stubEnv('VITE_HYPEREVM_TESTNET_ENABLED', 'true');
    vi.stubEnv('VITE_HYPEREVM_TESTNET_CHAIN_ID', '998');
    vi.stubEnv(
      'VITE_HYPEREVM_TESTNET_RPC_URL',
      'https://rpc.hyperliquid-testnet.xyz/evm',
    );
    vi.stubEnv('VITE_HYPEREVM_TESTNET_USDC_ASSET_TOKEN', ASSET_TOKEN);
    vi.stubEnv('VITE_HYPEREVM_TESTNET_VAULT_FACTORY_ADDRESS', ZERO_ADDRESS);
    vi.stubEnv('VITE_HYPEREVM_TESTNET_VAULT_ADDRESS', VAULT);

    const { hyperEvmTestnetConfigured, networks } = await importChains();
    const network = networks[998];

    expect(hyperEvmTestnetConfigured).toBe(true);
    expect(network).toMatchObject({
      rpcUrl: 'https://rpc.hyperliquid-testnet.xyz/evm',
      addresses: {
        vaultFactory: ZERO_ADDRESS,
        tradingVault: VAULT,
      },
    });
  });

  it('does not expose the local chain when local chain mode is disabled', async () => {
    vi.stubEnv('VITE_USE_LOCAL_CHAIN', 'false');
    vi.stubEnv('VITE_CHAIN_ID', '8453');

    const { networks } = await importChains();

    expect(networks[31337]).toBeUndefined();
    expect(networks[8453]).toBeDefined();
    expect(blueprintUiState.selectedChainId).toBe(8453);
  });
});
