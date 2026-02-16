import { defineChain } from 'viem';

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

// Tangle Local (Anvil devnet) — used during development and E2E testing
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
