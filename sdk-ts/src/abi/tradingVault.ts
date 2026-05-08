import abiJson from './_tradingVault.json' with { type: 'json' };

/**
 * Subset of the on-chain TradingVault ABI containing only the 13 envelope-mode
 * execute functions. Generated from `contracts/out/TradingVault.sol/TradingVault.json`
 * (forge build output).
 *
 * Cast to `as const` so viem can derive precise call argument types via
 * its `Abi` inference.
 */
export const TRADING_VAULT_ABI = abiJson;
