import { defineChain } from 'viem';

// Tangle Local (Anvil devnet) — used during development and E2E testing
export const tangleLocal = defineChain({
  id: Number(import.meta.env.VITE_CHAIN_ID ?? 31337),
  name: 'Tangle Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_RPC_URL ?? 'http://localhost:8545'],
    },
  },
  blockExplorers: {
    default: { name: 'Explorer', url: '' },
  },
});
