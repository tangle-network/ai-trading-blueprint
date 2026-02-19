import type { Address } from 'viem';
import { getAddresses } from '@tangle/blueprint-ui';
import type { ArenaAddresses } from './chains';

// Reactive addresses — reads from the selected chain's network config via blueprint-ui.
export const addresses = new Proxy({} as ArenaAddresses, {
  get(_target, prop: string) {
    return getAddresses<ArenaAddresses>()[prop as keyof ArenaAddresses];
  },
});

// Well-known token addresses (mainnet)
export const tokens = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
} as const;
