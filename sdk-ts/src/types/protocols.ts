/**
 * Protocol identifiers used by the high-level vault API. The SDK fans-out to
 * each candidate adapter for a given high-level intent and picks the best
 * quote. The strings here are *not* on-chain identifiers — they are SDK-level
 * tags used by adapters to declare which on-chain envelope variant they
 * produce.
 */
export const SWAP_PROTOCOLS = [
  'uniswap_v3',
  'uniswap_v4',
  'aerodrome',
  'pancakeswap_v3',
  'curve',
] as const;

export type SwapProtocol = (typeof SWAP_PROTOCOLS)[number];

export const LENDING_PROTOCOLS = ['aave', 'morpho'] as const;
export type LendingProtocol = (typeof LENDING_PROTOCOLS)[number];

/** Aave V3 interest-rate mode: 1 = stable, 2 = variable. */
export type InterestRateMode = 1n | 2n;
