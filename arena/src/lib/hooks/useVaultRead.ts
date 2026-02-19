import { useEffect, useState, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';
import { publicClient } from '@tangle/blueprint-ui';

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
      // Phase 1: Vault basics — try multicall first, fall back to individual calls
      let totalAssets: bigint | undefined;
      let assetToken: Address | undefined;
      let shareToken: Address | undefined;
      let paused = false;

      try {
        const vaultBasics: any[] = await publicClient.multicall({
          contracts: [
            { address: vaultAddress, abi: tradingVaultAbi, functionName: 'totalAssets' },
            { address: vaultAddress, abi: tradingVaultAbi, functionName: 'asset' },
            { address: vaultAddress, abi: tradingVaultAbi, functionName: 'share' },
            { address: vaultAddress, abi: tradingVaultAbi, functionName: 'paused' },
          ],
        });
        totalAssets = vaultBasics[0]?.status === 'success' ? vaultBasics[0].result as bigint : undefined;
        assetToken = vaultBasics[1]?.status === 'success' ? vaultBasics[1].result as Address : undefined;
        shareToken = vaultBasics[2]?.status === 'success' ? vaultBasics[2].result as Address : undefined;
        paused = vaultBasics[3]?.status === 'success' ? (vaultBasics[3].result as boolean) : false;

        // Log individual failures for debugging
        for (let i = 0; i < vaultBasics.length; i++) {
          if (vaultBasics[i]?.status === 'failure') {
            const names = ['totalAssets', 'asset', 'share', 'paused'];
            console.warn(`[useVaultRead] ${names[i]}() failed:`, vaultBasics[i].error?.message ?? 'unknown');
          }
        }
      } catch (mcErr) {
        // Multicall failed entirely (e.g. multicall3 not deployed) — try individual calls
        console.warn('[useVaultRead] multicall failed, trying individual calls:', mcErr);
        try { totalAssets = await publicClient.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'totalAssets' }) as bigint; } catch {}
        try { assetToken = await publicClient.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'asset' }) as Address; } catch {}
        try { shareToken = await publicClient.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'share' }) as Address; } catch {}
        try { paused = (await publicClient.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'paused' }) as boolean) ?? false; } catch {}
      }

      if (!assetToken || !shareToken) {
        console.warn('[useVaultRead] Could not read asset/share tokens from vault', vaultAddress, { assetToken, shareToken });
        setState((s) => ({
          ...s,
          totalAssets,
          assetToken,
          shareToken,
          paused,
          isLoading: false,
          error: new Error(`Could not read vault contract at ${vaultAddress}. Is the vault deployed on this chain?`),
        }));
        return;
      }

      // Phase 2: Token info (symbol, decimals for asset + share)
      let assetSymbol = '???';
      let assetDecimals = 18;
      let shareDec = 18;
      let shareSupply: bigint | undefined;

      try {
        const tokenInfo: any[] = await publicClient.multicall({
          contracts: [
            { address: assetToken, abi: erc20Abi, functionName: 'symbol' },
            { address: assetToken, abi: erc20Abi, functionName: 'decimals' },
            { address: shareToken, abi: erc20Abi, functionName: 'decimals' },
            { address: shareToken, abi: erc20Abi, functionName: 'totalSupply' },
          ],
        });
        assetSymbol = tokenInfo[0]?.status === 'success' ? (tokenInfo[0].result as string) : '???';
        assetDecimals = tokenInfo[1]?.status === 'success' ? (tokenInfo[1].result as number) : 18;
        shareDec = tokenInfo[2]?.status === 'success' ? (tokenInfo[2].result as number) : 18;
        shareSupply = tokenInfo[3]?.status === 'success' ? (tokenInfo[3].result as bigint) : undefined;
      } catch (mcErr) {
        console.warn('[useVaultRead] token info multicall failed, trying individual calls:', mcErr);
        try { assetSymbol = (await publicClient.readContract({ address: assetToken, abi: erc20Abi, functionName: 'symbol' }) as string) ?? '???'; } catch {}
        try { assetDecimals = (await publicClient.readContract({ address: assetToken, abi: erc20Abi, functionName: 'decimals' }) as number) ?? 18; } catch {}
        try { shareDec = (await publicClient.readContract({ address: shareToken, abi: erc20Abi, functionName: 'decimals' }) as number) ?? 18; } catch {}
        try { shareSupply = await publicClient.readContract({ address: shareToken, abi: erc20Abi, functionName: 'totalSupply' }) as bigint; } catch {}
      }

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
          const userResults: any[] = await publicClient.multicall({
            contracts: [
              { address: shareToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] },
              { address: assetToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] },
              { address: assetToken, abi: erc20Abi, functionName: 'allowance', args: [userAddress, vaultAddress] },
            ],
          });
          userShares = userResults[0]?.status === 'success' ? userResults[0].result as bigint : undefined;
          userAssetBalance = userResults[1]?.status === 'success' ? userResults[1].result as bigint : undefined;
          userAllowance = userResults[2]?.status === 'success' ? userResults[2].result as bigint : undefined;
        } catch (mcErr) {
          console.warn('[useVaultRead] user balance multicall failed, trying individual calls:', mcErr);
          try { userShares = await publicClient.readContract({ address: shareToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] }) as bigint; } catch {}
          try { userAssetBalance = await publicClient.readContract({ address: assetToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] }) as bigint; } catch {}
          try { userAllowance = await publicClient.readContract({ address: assetToken, abi: erc20Abi, functionName: 'allowance', args: [userAddress, vaultAddress] }) as bigint; } catch {}
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
