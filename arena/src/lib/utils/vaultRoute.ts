import type { Address } from 'viem';

export function buildVaultPath(vaultAddress: Address | string, chainId?: number | null): string {
  const basePath = `/vault/${vaultAddress}`;
  if (chainId == null || !Number.isFinite(chainId) || chainId <= 0) return basePath;
  return `${basePath}?chainId=${Math.trunc(chainId)}`;
}
