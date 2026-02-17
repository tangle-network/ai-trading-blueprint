import { defineChain } from 'viem';
import { mainnet } from 'viem/chains';
import type { Address, Chain } from 'viem';

/**
 * Resolve the RPC URL so it's reachable from the user's browser.
 * If the configured URL points to localhost/127.0.0.1 but the user accesses
 * the site from a different hostname (e.g. Tailscale IP), swap the RPC host
 * to match the page hostname so the browser can reach Anvil.
 */
function resolveRpcUrl(): string {
  const configured = import.meta.env.VITE_RPC_URL ?? 'http://localhost:8545';

  if (typeof window === 'undefined') return configured;

  try {
    const rpc = new URL(configured);
    const isLocalRpc = rpc.hostname === '127.0.0.1' || rpc.hostname === 'localhost';
    const pageHost = window.location.hostname;
    const isLocalPage = pageHost === '127.0.0.1' || pageHost === 'localhost';

    // If RPC is local but page is accessed remotely, swap hostname
    if (isLocalRpc && !isLocalPage) {
      rpc.hostname = pageHost;
      return rpc.toString().replace(/\/$/, '');
    }
  } catch {
    // malformed URL — return as-is
  }

  return configured;
}

export const rpcUrl = resolveRpcUrl();

// ── Chain definitions ─────────────────────────────────────────────────

export const tangleLocal = defineChain({
  id: Number(import.meta.env.VITE_CHAIN_ID ?? 31337),
  name: 'Tangle Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [rpcUrl],
    },
  },
  blockExplorers: {
    default: { name: 'Explorer', url: '' },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
});

export const tangleTestnet = defineChain({
  id: 3799,
  name: 'Tangle Testnet',
  nativeCurrency: { name: 'Tangle', symbol: 'tTNT', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://testnet-rpc.tangle.tools'],
      webSocket: ['wss://testnet-rpc.tangle.tools'],
    },
  },
  blockExplorers: {
    default: { name: 'Tangle Explorer', url: 'https://testnet-explorer.tangle.tools' },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
});

export const tangleMainnet = defineChain({
  id: 5845,
  name: 'Tangle',
  nativeCurrency: { name: 'Tangle', symbol: 'TNT', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.tangle.tools'],
      webSocket: ['wss://rpc.tangle.tools'],
    },
  },
  blockExplorers: {
    default: { name: 'Tangle Explorer', url: 'https://explorer.tangle.tools' },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
});

// ── Network config: chain + addresses + RPC per network ───────────────

export interface NetworkConfig {
  chain: Chain;
  rpcUrl: string;
  label: string;
  shortLabel: string;
  addresses: {
    tangle: Address;
    vaultFactory: Address;
    tradingBlueprint: Address;
  };
}

export const networks: Record<number, NetworkConfig> = {
  [tangleLocal.id]: {
    chain: tangleLocal,
    rpcUrl,
    label: 'Tangle Local',
    shortLabel: 'Local',
    addresses: {
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
      // Testnet contract addresses — update when deployed
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
      // Mainnet contract addresses — update when deployed
      tangle: '0x0000000000000000000000000000000000000000' as Address,
      vaultFactory: '0x0000000000000000000000000000000000000000' as Address,
      tradingBlueprint: '0x0000000000000000000000000000000000000000' as Address,
    },
  },
};

// Re-export mainnet for wagmi config
export { mainnet };

/** All Tangle chains for wagmi registration */
export const allTangleChains = [tangleLocal, tangleTestnet, tangleMainnet] as const;
