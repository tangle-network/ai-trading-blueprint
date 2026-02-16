import { useCallback } from 'react';
import { useReadContract, useReadContracts, useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';
import { tangleLocal } from '~/lib/contracts/chains';

const chainId = tangleLocal.id;

/** Read all vault on-chain state in a single multicall. */
export function useVaultRead(vaultAddress: Address | undefined) {
  const { address: userAddress } = useAccount();

  const vaultContract = { address: vaultAddress!, abi: tradingVaultAbi, chainId } as const;

  // Batch vault reads into one multicall
  const { data, isLoading, error, refetch: refetchVault } = useReadContracts({
    contracts: [
      { ...vaultContract, functionName: 'totalAssets' },
      { ...vaultContract, functionName: 'asset' },
      { ...vaultContract, functionName: 'share' },
      { ...vaultContract, functionName: 'paused' },
    ],
    query: { enabled: !!vaultAddress },
  });

  const totalAssets = data?.[0]?.result as bigint | undefined;
  const assetToken = data?.[1]?.result as Address | undefined;
  const shareToken = data?.[2]?.result as Address | undefined;
  const paused = data?.[3]?.result as boolean | undefined;

  // Read asset + share token info (symbol, decimals)
  const { data: tokenData } = useReadContracts({
    contracts: [
      { address: assetToken!, abi: erc20Abi, functionName: 'symbol', chainId },
      { address: assetToken!, abi: erc20Abi, functionName: 'decimals', chainId },
      { address: shareToken!, abi: erc20Abi, functionName: 'decimals', chainId },
    ],
    query: { enabled: !!assetToken && !!shareToken },
  });

  const assetSymbol = tokenData?.[0]?.result as string | undefined;
  const assetDecimals = tokenData?.[1]?.result as number | undefined;
  const shareDecimals = tokenData?.[2]?.result as number | undefined;

  // Use asset decimals for convertToShares (not hardcoded 1e18)
  const decimals = assetDecimals ?? 18;
  const shareDec = shareDecimals ?? 18;
  const oneAsset = BigInt(10 ** decimals);

  const { data: sharesPerAsset, refetch: refetchConversion } = useReadContract({
    ...vaultContract,
    functionName: 'convertToShares',
    args: [oneAsset],
    query: { enabled: !!vaultAddress && decimals > 0 },
  });

  // Read share token supply
  const { data: shareSupply, refetch: refetchSupply } = useReadContract({
    address: shareToken,
    abi: erc20Abi,
    functionName: 'totalSupply',
    chainId,
    query: { enabled: !!shareToken },
  });

  // Read user's share balance (if connected)
  const { data: userShares, refetch: refetchUserShares } = useReadContract({
    address: shareToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress!],
    chainId,
    query: { enabled: !!shareToken && !!userAddress },
  });

  // Read user's asset token balance
  const { data: userAssetBalance, refetch: refetchUserBalance } = useReadContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress!],
    chainId,
    query: { enabled: !!assetToken && !!userAddress },
  });

  // Read user's allowance for the vault
  const { data: userAllowance, refetch: refetchAllowance } = useReadContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress!, vaultAddress!],
    chainId,
    query: { enabled: !!assetToken && !!userAddress && !!vaultAddress },
  });

  // Combined refetch — refreshes ALL on-chain data after deposit/withdraw
  const refetch = useCallback(() => {
    refetchVault();
    refetchConversion();
    refetchSupply();
    refetchUserShares();
    refetchUserBalance();
    refetchAllowance();
  }, [refetchVault, refetchConversion, refetchSupply, refetchUserShares, refetchUserBalance, refetchAllowance]);

  // Derive effective share decimals from conversion rate.
  // convertToShares(10^assetDec) tells us raw shares per 1 human asset.
  // Effective share decimals = log10(sharesPerAsset).
  // e.g. USDC vault with 1:1 raw conversion: convertToShares(1e6) = 1e6 → effectiveDec = 6
  // e.g. properly scaled vault: convertToShares(1e6) = 1e18 → effectiveDec = 18
  const effectiveShareDec = sharesPerAsset != null && (sharesPerAsset as bigint) > 0n
    ? Math.round(Math.log10(Number(sharesPerAsset as bigint)))
    : shareDec;

  // Derive computed values
  const tvl = totalAssets != null ? Number(formatUnits(totalAssets, decimals)) : undefined;

  // Share price = assets per share = assetDecimals-unit / effectiveShareDec-unit
  // convertToShares(oneAsset) = sharesPerAsset → sharePrice = oneAsset / sharesPerAsset (scaled)
  const sharePrice = sharesPerAsset != null && (sharesPerAsset as bigint) > 0n
    ? Number(oneAsset) / Number(sharesPerAsset as bigint)
    : undefined;

  return {
    tvl,
    totalAssets,
    assetToken,
    shareToken,
    assetSymbol: assetSymbol ?? '???',
    assetDecimals: decimals,
    shareDecimals: effectiveShareDec,
    sharePrice,
    totalShares: shareSupply != null ? Number(formatUnits(shareSupply as bigint, effectiveShareDec)) : undefined,
    paused: paused ?? false,
    userShares: userShares != null ? (userShares as bigint) : undefined,
    userSharesFormatted: userShares != null ? Number(formatUnits(userShares as bigint, effectiveShareDec)) : undefined,
    userAssetBalance: userAssetBalance != null ? (userAssetBalance as bigint) : undefined,
    userAssetBalanceFormatted: userAssetBalance != null ? Number(formatUnits(userAssetBalance as bigint, decimals)) : undefined,
    userAllowance: userAllowance != null ? (userAllowance as bigint) : undefined,
    isLoading,
    error,
    refetch,
  };
}
