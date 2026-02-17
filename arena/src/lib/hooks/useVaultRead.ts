import { useEffect, useState, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';
import { publicClient } from '~/lib/contracts/publicClient';

interface VaultReadState {
  tvl?: number;
  totalAssets?: bigint;
  assetToken?: Address;
  shareToken?: Address;
  assetSymbol: string;
  assetDecimals: number;
  shareDecimals: number;
  sharePrice?: number;
  totalShares?: number;
  paused: boolean;
  userShares?: bigint;
  userSharesFormatted?: number;
  userAssetBalance?: bigint;
  userAssetBalanceFormatted?: number;
  userAllowance?: bigint;
  isLoading: boolean;
  error?: Error;
}

/** Read all vault on-chain state using a standalone viem client. */
export function useVaultRead(vaultAddress: Address | undefined) {
  const { address: userAddress } = useAccount();
  const [state, setState] = useState<VaultReadState>({
    assetSymbol: '???',
    assetDecimals: 18,
    shareDecimals: 18,
    paused: false,
    isLoading: true,
  });

  const fetchAll = useCallback(async () => {
    if (!vaultAddress) {
      setState((s) => ({ ...s, isLoading: false }));
      return;
    }

    setState((s) => ({ ...s, isLoading: true, error: undefined }));

    try {
      // Phase 1: Vault basics
      const vaultBasics = await publicClient.multicall({
        contracts: [
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'totalAssets' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'asset' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'share' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'paused' },
        ],
      });

      const totalAssets = vaultBasics[0]?.result as bigint | undefined;
      const assetToken = vaultBasics[1]?.result as Address | undefined;
      const shareToken = vaultBasics[2]?.result as Address | undefined;
      const paused = (vaultBasics[3]?.result as boolean | undefined) ?? false;

      if (!assetToken || !shareToken) {
        setState((s) => ({
          ...s,
          totalAssets,
          assetToken,
          shareToken,
          paused,
          isLoading: false,
        }));
        return;
      }

      // Phase 2: Token info (symbol, decimals for asset + share)
      const tokenInfo = await publicClient.multicall({
        contracts: [
          { address: assetToken, abi: erc20Abi, functionName: 'symbol' },
          { address: assetToken, abi: erc20Abi, functionName: 'decimals' },
          { address: shareToken, abi: erc20Abi, functionName: 'decimals' },
          { address: shareToken, abi: erc20Abi, functionName: 'totalSupply' },
        ],
      });

      const assetSymbol = (tokenInfo[0]?.result as string) ?? '???';
      const assetDecimals = (tokenInfo[1]?.result as number) ?? 18;
      const shareDec = (tokenInfo[2]?.result as number) ?? 18;
      const shareSupply = tokenInfo[3]?.result as bigint | undefined;

      // Phase 3: Conversion rate
      const oneAsset = BigInt(10 ** assetDecimals);
      let sharesPerAsset: bigint | undefined;
      try {
        sharesPerAsset = await publicClient.readContract({
          address: vaultAddress,
          abi: tradingVaultAbi,
          functionName: 'convertToShares',
          args: [oneAsset],
        }) as bigint;
      } catch {
        // convertToShares might revert if vault is empty
      }

      // Phase 4: User balances (if connected)
      let userShares: bigint | undefined;
      let userAssetBalance: bigint | undefined;
      let userAllowance: bigint | undefined;

      if (userAddress) {
        try {
          const userResults = await publicClient.multicall({
            contracts: [
              { address: shareToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] },
              { address: assetToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] },
              { address: assetToken, abi: erc20Abi, functionName: 'allowance', args: [userAddress, vaultAddress] },
            ],
          });
          userShares = userResults[0]?.result as bigint | undefined;
          userAssetBalance = userResults[1]?.result as bigint | undefined;
          userAllowance = userResults[2]?.result as bigint | undefined;
        } catch {
          // User queries failed — non-critical
        }
      }

      // Derive computed values
      const effectiveShareDec = sharesPerAsset != null && sharesPerAsset > 0n
        ? Math.round(Math.log10(Number(sharesPerAsset)))
        : shareDec;

      const tvl = totalAssets != null ? Number(formatUnits(totalAssets, assetDecimals)) : undefined;

      const sharePrice = sharesPerAsset != null && sharesPerAsset > 0n
        ? Number(oneAsset) / Number(sharesPerAsset)
        : undefined;

      setState({
        tvl,
        totalAssets,
        assetToken,
        shareToken,
        assetSymbol,
        assetDecimals,
        shareDecimals: effectiveShareDec,
        sharePrice,
        totalShares: shareSupply != null ? Number(formatUnits(shareSupply, effectiveShareDec)) : undefined,
        paused,
        userShares,
        userSharesFormatted: userShares != null ? Number(formatUnits(userShares, effectiveShareDec)) : undefined,
        userAssetBalance,
        userAssetBalanceFormatted: userAssetBalance != null ? Number(formatUnits(userAssetBalance, assetDecimals)) : undefined,
        userAllowance,
        isLoading: false,
      });
    } catch (err) {
      console.warn('[useVaultRead] Failed:', err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err : new Error(String(err)),
      }));
    }
  }, [vaultAddress, userAddress]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return {
    ...state,
    refetch: fetchAll,
  };
}
