import { useEffect, useState, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';
import { getChainPublicClient } from '~/lib/contracts/chainClients';

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
  maxDeposit?: bigint;
  heldTokens: Address[];
  hasNonDepositAssets: boolean;
  isNavSafe?: boolean;
  loadedVaultAddress?: Address;
  loadedTargetChainId?: number;
  // Collateral
  totalOutstandingCollateral?: bigint;
  maxCollateralBps?: number;
  availableCollateral?: bigint;
  isAdmin?: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  error?: Error;
}

const HYPEREVM_TESTNET_CHAIN_ID = Number(import.meta.env.VITE_HYPEREVM_TESTNET_CHAIN_ID ?? 998);

function usesAssetUnitShares(targetChainId: number): boolean {
  return targetChainId === HYPEREVM_TESTNET_CHAIN_ID;
}

/** Read all vault on-chain state using a standalone viem client. */
export function useVaultRead(vaultAddress: Address | undefined, targetChainId: number) {
  const { address: userAddress } = useAccount();
  const [state, setState] = useState<VaultReadState>({
    assetSymbol: '???',
    assetDecimals: 18,
    shareDecimals: 18,
    paused: false,
    heldTokens: [],
    hasNonDepositAssets: false,
    isLoading: true,
    isRefreshing: false,
  });

  const fetchAll = useCallback(async () => {
    if (!vaultAddress) {
      setState((s) => ({ ...s, isLoading: false, isRefreshing: false }));
      return;
    }

    setState((s) => {
      const hasLoadedVault =
        s.assetToken != null &&
        s.shareToken != null &&
        s.loadedVaultAddress?.toLowerCase() === vaultAddress.toLowerCase() &&
        s.loadedTargetChainId === targetChainId;
      return {
        ...s,
        isLoading: !hasLoadedVault,
        isRefreshing: hasLoadedVault,
        error: undefined,
      };
    });

    try {
      const client = getChainPublicClient(targetChainId);
      const assetUnitShares = usesAssetUnitShares(targetChainId);
      // Phase 1: Vault basics — try multicall first, fall back to individual calls
      let totalAssets: bigint | undefined;
      let assetToken: Address | undefined;
      let shareToken: Address | undefined;
      let paused = false;

      if (assetUnitShares) {
        try { totalAssets = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'totalAssets' }) as bigint; } catch {}
        try { assetToken = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'asset' }) as Address; } catch {}
        try { shareToken = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'share' }) as Address; } catch {}
        try { paused = (await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'paused' }) as boolean) ?? false; } catch {}
      } else {
        try {
          const vaultBasics: any[] = await client.multicall({
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
          try { totalAssets = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'totalAssets' }) as bigint; } catch {}
          try { assetToken = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'asset' }) as Address; } catch {}
          try { shareToken = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'share' }) as Address; } catch {}
          try { paused = (await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'paused' }) as boolean) ?? false; } catch {}
        }
      }

      if (!assetToken || !shareToken) {
        console.warn('[useVaultRead] Could not read asset/share tokens from vault', vaultAddress, { assetToken, shareToken });
        setState((s) => ({
          ...s,
          totalAssets,
          assetToken,
          shareToken,
          paused,
          loadedVaultAddress: vaultAddress,
          loadedTargetChainId: targetChainId,
          isLoading: false,
          isRefreshing: false,
          error: new Error(`Could not read vault contract at ${vaultAddress}. Is the vault deployed on this chain?`),
        }));
        return;
      }

      // Phase 2: Token info (symbol, decimals for asset + share)
      let assetSymbol = '???';
      let assetDecimals = 18;
      let shareDec = 18;
      let shareSupply: bigint | undefined;

      if (assetUnitShares) {
        try { assetSymbol = (await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'symbol' }) as string) ?? '???'; } catch {}
        try { assetDecimals = (await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'decimals' }) as number) ?? 18; } catch {}
        try { shareDec = (await client.readContract({ address: shareToken, abi: erc20Abi, functionName: 'decimals' }) as number) ?? 18; } catch {}
        try { shareSupply = await client.readContract({ address: shareToken, abi: erc20Abi, functionName: 'totalSupply' }) as bigint; } catch {}
      } else {
        try {
          const tokenInfo: any[] = await client.multicall({
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
          try { assetSymbol = (await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'symbol' }) as string) ?? '???'; } catch {}
          try { assetDecimals = (await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'decimals' }) as number) ?? 18; } catch {}
          try { shareDec = (await client.readContract({ address: shareToken, abi: erc20Abi, functionName: 'decimals' }) as number) ?? 18; } catch {}
          try { shareSupply = await client.readContract({ address: shareToken, abi: erc20Abi, functionName: 'totalSupply' }) as bigint; } catch {}
        }
      }
      const displayShareDecimals = usesAssetUnitShares(targetChainId) ? assetDecimals : shareDec;

      // Phase 3: Conversion rate
      const oneShare = 10n ** BigInt(displayShareDecimals);
      let assetsPerShare: bigint | undefined;
      try {
        assetsPerShare = await client.readContract({
          address: vaultAddress,
          abi: tradingVaultAbi,
          functionName: 'convertToAssets',
          args: [oneShare],
        }) as bigint;
      } catch {
        // convertToAssets might revert if vault is still initializing
      }

      // Phase 4: User balances (if connected)
      let userShares: bigint | undefined;
      let userAssetBalance: bigint | undefined;
      let userAllowance: bigint | undefined;
      let maxDeposit: bigint | undefined;
      let heldTokens: Address[] = [];
      let isNavSafe: boolean | undefined;

      if (userAddress) {
        if (assetUnitShares) {
          try { userShares = await client.readContract({ address: shareToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] }) as bigint; } catch {}
          try { userAssetBalance = await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] }) as bigint; } catch {}
          try { userAllowance = await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'allowance', args: [userAddress, vaultAddress] }) as bigint; } catch {}
          try { maxDeposit = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'maxDeposit', args: [userAddress] }) as bigint; } catch {}
        } else {
          try {
            const userResults: any[] = await client.multicall({
              contracts: [
                { address: shareToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] },
                { address: assetToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] },
                { address: assetToken, abi: erc20Abi, functionName: 'allowance', args: [userAddress, vaultAddress] },
                { address: vaultAddress, abi: tradingVaultAbi, functionName: 'maxDeposit', args: [userAddress] },
              ],
            });
            userShares = userResults[0]?.status === 'success' ? userResults[0].result as bigint : undefined;
            userAssetBalance = userResults[1]?.status === 'success' ? userResults[1].result as bigint : undefined;
            userAllowance = userResults[2]?.status === 'success' ? userResults[2].result as bigint : undefined;
            maxDeposit = userResults[3]?.status === 'success' ? userResults[3].result as bigint : undefined;
          } catch (mcErr) {
            console.warn('[useVaultRead] user balance multicall failed, trying individual calls:', mcErr);
            try { userShares = await client.readContract({ address: shareToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] }) as bigint; } catch {}
            try { userAssetBalance = await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress] }) as bigint; } catch {}
            try { userAllowance = await client.readContract({ address: assetToken, abi: erc20Abi, functionName: 'allowance', args: [userAddress, vaultAddress] }) as bigint; } catch {}
            try { maxDeposit = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'maxDeposit', args: [userAddress] }) as bigint; } catch {}
          }
        }
      } else {
        try { maxDeposit = await client.readContract({ address: vaultAddress, abi: tradingVaultAbi, functionName: 'maxDeposit', args: [zeroAddress] }) as bigint; } catch {}
      }

      if (!assetUnitShares) {
        try {
          heldTokens = await client.readContract({
            address: vaultAddress,
            abi: tradingVaultAbi,
            functionName: 'getHeldTokens',
          }) as Address[];
        } catch {
          heldTokens = [];
        }
        try {
          isNavSafe = await client.readContract({
            address: vaultAddress,
            abi: tradingVaultAbi,
            functionName: 'isNavSafe',
          }) as boolean;
        } catch {
          isNavSafe = undefined;
        }
      }

      // Phase 5: Collateral state
      let totalOutstandingCollateral: bigint | undefined;
      let maxCollateralBps: number | undefined;
      let availableCollateral: bigint | undefined;
      let isAdmin = false;

      if (!assetUnitShares) {
        try {
          const collateralCalls: any[] = [
            { address: vaultAddress, abi: tradingVaultAbi, functionName: 'totalOutstandingCollateral' },
            { address: vaultAddress, abi: tradingVaultAbi, functionName: 'maxCollateralBps' },
            { address: vaultAddress, abi: tradingVaultAbi, functionName: 'availableCollateral' },
          ];
          // Check admin role if connected
          if (userAddress) {
            collateralCalls.push(
              { address: vaultAddress, abi: tradingVaultAbi, functionName: 'DEFAULT_ADMIN_ROLE' },
            );
          }
          const collateralResults: any[] = await client.multicall({ contracts: collateralCalls });
          totalOutstandingCollateral = collateralResults[0]?.status === 'success' ? collateralResults[0].result as bigint : undefined;
          maxCollateralBps = collateralResults[1]?.status === 'success' ? Number(collateralResults[1].result) : undefined;
          availableCollateral = collateralResults[2]?.status === 'success' ? collateralResults[2].result as bigint : undefined;

          // If we got the admin role hash, check if user has it
          if (userAddress && collateralResults[3]?.status === 'success') {
            const adminRole = collateralResults[3].result as `0x${string}`;
            try {
              isAdmin = await client.readContract({
                address: vaultAddress,
                abi: tradingVaultAbi,
                functionName: 'hasRole',
                args: [adminRole, userAddress],
              }) as boolean;
            } catch {}
          }
        } catch {
          // Collateral reads are non-critical — older vaults may not have these functions
        }
      }

      // Derive computed values
      const tvl = totalAssets != null ? Number(formatUnits(totalAssets, assetDecimals)) : undefined;
      const hasNonDepositAssets = heldTokens.some((token) => token.toLowerCase() !== assetToken.toLowerCase());

      const sharePrice = assetsPerShare != null
        ? Number(formatUnits(assetsPerShare, assetDecimals))
        : undefined;

      setState({
        tvl,
        totalAssets,
        assetToken,
        shareToken,
        assetSymbol,
        assetDecimals,
        shareDecimals: displayShareDecimals,
        sharePrice,
        totalShares: shareSupply != null ? Number(formatUnits(shareSupply, displayShareDecimals)) : undefined,
        paused,
        userShares,
        userSharesFormatted: userShares != null ? Number(formatUnits(userShares, displayShareDecimals)) : undefined,
        userAssetBalance,
        userAssetBalanceFormatted: userAssetBalance != null ? Number(formatUnits(userAssetBalance, assetDecimals)) : undefined,
        userAllowance,
        maxDeposit,
        heldTokens,
        hasNonDepositAssets,
        isNavSafe,
        loadedVaultAddress: vaultAddress,
        loadedTargetChainId: targetChainId,
        totalOutstandingCollateral,
        maxCollateralBps,
        availableCollateral,
        isAdmin,
        isLoading: false,
        isRefreshing: false,
      });
    } catch (err) {
      console.warn('[useVaultRead] Failed:', err);
      setState((s) => ({
        ...s,
        isLoading: false,
        isRefreshing: false,
        error: err instanceof Error ? err : new Error(String(err)),
      }));
    }
  }, [vaultAddress, userAddress, targetChainId]);

  useEffect(() => {
    fetchAll();
    const interval = window.setInterval(() => {
      void fetchAll();
    }, 15_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [fetchAll]);

  return {
    ...state,
    refetch: fetchAll,
  };
}
