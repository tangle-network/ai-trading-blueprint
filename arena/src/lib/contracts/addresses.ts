import type { Address } from 'viem';

// Contract addresses — configurable via env vars, defaults to Anvil devnet deterministic deploys.
export const addresses = {
  tangle: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
  vaultFactory: (import.meta.env.VITE_VAULT_FACTORY ?? '0x0000000000000000000000000000000000000000') as Address,
  tradingBlueprint: (import.meta.env.VITE_TRADING_BLUEPRINT ?? '0x0000000000000000000000000000000000000000') as Address,
} as const;

// Well-known token addresses (mainnet)
export const tokens = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
} as const;
