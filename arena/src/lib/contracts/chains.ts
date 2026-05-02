import type { Address } from 'viem';
import { defineChain } from 'viem';
import {
  tangleLocal as sharedTangleLocal, tangleTestnet, tangleMainnet, rpcUrl,
  configureNetworks, getNetworks,
  type CoreAddresses,
} from '@tangle-network/blueprint-ui';

const forkMode = import.meta.env.VITE_FORK_MODE === 'true';
const executionForkChainId = Number(import.meta.env.VITE_DEX_ETHEREUM_CHAIN_ID ?? sharedTangleLocal.id);
const executionForkRpcUrl = import.meta.env.VITE_DEX_ETHEREUM_RPC_URL ?? rpcUrl;

function isLocalRpcUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

const includeLocalExecutionFork =
  import.meta.env.VITE_USE_LOCAL_CHAIN === 'true' &&
  import.meta.env.VITE_DEX_ETHEREUM_ENABLED !== 'false' &&
  executionForkChainId !== sharedTangleLocal.id &&
  isLocalRpcUrl(executionForkRpcUrl);

export const executionForkChain = defineChain({
  id: executionForkChainId,
  name: 'Ethereum Local Fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [executionForkRpcUrl] } },
  blockExplorers: { default: { name: 'Explorer', url: '' } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const tangleLocal = forkMode ? executionForkChain : sharedTangleLocal;

export {
  tangleTestnet, tangleMainnet, rpcUrl,
  allTangleChains, mainnet, resolveRpcUrl,
  configureNetworks, getNetworks,
} from '@tangle-network/blueprint-ui';
export type { CoreAddresses, NetworkConfig } from '@tangle-network/blueprint-ui';

/** Arena-specific contract addresses. */
export interface ArenaAddresses extends CoreAddresses {
  tangle: Address;
  vaultFactory: Address;
  tradingBlueprint: Address;
}

// Configure arena networks at module load time.
configureNetworks<ArenaAddresses>({
  [tangleLocal.id]: {
    chain: tangleLocal,
    rpcUrl: tangleLocal.rpcUrls.default.http[0] ?? rpcUrl,
    label: forkMode ? 'Ethereum Local Fork' : 'Tangle Local',
    shortLabel: 'Local',
    addresses: {
      jobs: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      services: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      tangle: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      vaultFactory: (import.meta.env.VITE_VAULT_FACTORY ?? '0x0000000000000000000000000000000000000000') as Address,
      tradingBlueprint: (import.meta.env.VITE_TRADING_BLUEPRINT ?? '0x0000000000000000000000000000000000000000') as Address,
    },
  },
  ...(includeLocalExecutionFork
    ? {
        [executionForkChain.id]: {
          chain: executionForkChain,
          rpcUrl: executionForkChain.rpcUrls.default.http[0] ?? rpcUrl,
          label: 'Ethereum Fork',
          shortLabel: 'Fork',
          addresses: {
            jobs: '0x0000000000000000000000000000000000000000' as Address,
            services: '0x0000000000000000000000000000000000000000' as Address,
            tangle: '0x0000000000000000000000000000000000000000' as Address,
            vaultFactory: (import.meta.env.VITE_DEX_ETHEREUM_VAULT_FACTORY_ADDRESS ??
              '0x0000000000000000000000000000000000000000') as Address,
            tradingBlueprint: '0x0000000000000000000000000000000000000000' as Address,
          },
        },
      }
    : {}),
  [tangleTestnet.id]: {
    chain: tangleTestnet,
    rpcUrl: 'https://testnet-rpc.tangle.tools',
    label: 'Tangle Testnet',
    shortLabel: 'Testnet',
    addresses: {
      jobs: '0x0000000000000000000000000000000000000000' as Address,
      services: '0x0000000000000000000000000000000000000000' as Address,
      tangle: '0x0000000000000000000000000000000000000000' as Address,
      vaultFactory: '0x0000000000000000000000000000000000000000' as Address,
      tradingBlueprint: '0x0000000000000000000000000000000000000000' as Address,
    },
  },
  [tangleMainnet.id]: {
    chain: tangleMainnet,
    rpcUrl: 'https://rpc.tangle.tools',
    label: 'Tangle Mainnet',
    shortLabel: 'Mainnet',
    addresses: {
      jobs: '0x0000000000000000000000000000000000000000' as Address,
      services: '0x0000000000000000000000000000000000000000' as Address,
      tangle: '0x0000000000000000000000000000000000000000' as Address,
      vaultFactory: '0x0000000000000000000000000000000000000000' as Address,
      tradingBlueprint: '0x0000000000000000000000000000000000000000' as Address,
    },
  },
});

/** Backwards-compatible accessor. */
export const networks = getNetworks<ArenaAddresses>();
