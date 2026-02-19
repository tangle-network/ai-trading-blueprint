import type { Address } from 'viem';
import {
  tangleLocal, tangleTestnet, tangleMainnet, rpcUrl,
  configureNetworks, getNetworks,
  type CoreAddresses,
} from '@tangle/blueprint-ui';

export {
  tangleLocal, tangleTestnet, tangleMainnet, rpcUrl,
  allTangleChains, mainnet, resolveRpcUrl,
  configureNetworks, getNetworks,
} from '@tangle/blueprint-ui';
export type { CoreAddresses, NetworkConfig } from '@tangle/blueprint-ui';

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
    rpcUrl,
    label: 'Tangle Local',
    shortLabel: 'Local',
    addresses: {
      jobs: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      services: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      tangle: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      vaultFactory: (import.meta.env.VITE_VAULT_FACTORY ?? '0x0000000000000000000000000000000000000000') as Address,
      tradingBlueprint: (import.meta.env.VITE_TRADING_BLUEPRINT ?? '0x0000000000000000000000000000000000000000') as Address,
    },
  },
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
