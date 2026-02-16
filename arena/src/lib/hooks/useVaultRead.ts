import { useReadContract, useReadContracts, useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';

/** Read all vault on-chain state in a single multicall. */
export function useVaultRead(vaultAddress: Address | undefined) {
  const { address: userAddress } = useAccount();

  const vaultContract = { address: vaultAddress!, abi: tradingVaultAbi } as const;

  // Batch vault reads into one multicall
  const { data, isLoading, error, refetch } = useReadContracts({
    contracts: [
      { ...vaultContract, functionName: 'totalAssets' },
      { ...vaultContract, functionName: 'asset' },
      { ...vaultContract, functionName: 'share' },
      { ...vaultContract, functionName: 'paused' },
      // convertToShares(1e18) gives us share price (assets per share = 1/this)
      { ...vaultContract, functionName: 'convertToShares', args: [BigInt(1e18)] },
    ],
    query: { enabled: !!vaultAddress },
  });

  const totalAssets = data?.[0]?.result as bigint | undefined;
  const assetToken = data?.[1]?.result as Address | undefined;
  const shareToken = data?.[2]?.result as Address | undefined;
  const paused = data?.[3]?.result as boolean | undefined;
  const sharesPerAsset = data?.[4]?.result as bigint | undefined;

  // Read asset token info
  const { data: tokenData } = useReadContracts({
    contracts: [
      { address: assetToken!, abi: erc20Abi, functionName: 'symbol' },
      { address: assetToken!, abi: erc20Abi, functionName: 'decimals' },
    ],
    query: { enabled: !!assetToken },
  });

  const assetSymbol = tokenData?.[0]?.result as string | undefined;
  const assetDecimals = tokenData?.[1]?.result as number | undefined;

  // Read share token supply
  const { data: shareSupply } = useReadContract({
    address: shareToken,
    abi: erc20Abi,
    functionName: 'totalSupply',
    query: { enabled: !!shareToken },
  });

  // Read user's share balance (if connected)
  const { data: userShares } = useReadContract({
    address: shareToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress!],
    query: { enabled: !!shareToken && !!userAddress },
  });

  // Read user's asset token balance
  const { data: userAssetBalance } = useReadContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress!],
    query: { enabled: !!assetToken && !!userAddress },
  });

  // Read user's allowance for the vault
  const { data: userAllowance } = useReadContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress!, vaultAddress!],
    query: { enabled: !!assetToken && !!userAddress && !!vaultAddress },
  });

  // Derive computed values
  const decimals = assetDecimals ?? 18;
  const tvl = totalAssets != null ? Number(formatUnits(totalAssets, decimals)) : undefined;
  const sharePrice = sharesPerAsset != null && sharesPerAsset > 0n
    ? Number(formatUnits(BigInt(1e18) * BigInt(10 ** decimals) / sharesPerAsset, decimals))
    : undefined;

  return {
    tvl,
    totalAssets,
    assetToken,
    shareToken,
    assetSymbol: assetSymbol ?? '???',
    assetDecimals: decimals,
    sharePrice,
    totalShares: shareSupply != null ? Number(formatUnits(shareSupply as bigint, 18)) : undefined,
    paused: paused ?? false,
    userShares: userShares != null ? (userShares as bigint) : undefined,
    userSharesFormatted: userShares != null ? Number(formatUnits(userShares as bigint, 18)) : undefined,
    userAssetBalance: userAssetBalance != null ? (userAssetBalance as bigint) : undefined,
    userAssetBalanceFormatted: userAssetBalance != null ? Number(formatUnits(userAssetBalance as bigint, decimals)) : undefined,
    userAllowance: userAllowance != null ? (userAllowance as bigint) : undefined,
    isLoading,
    error,
    refetch,
  };
}
