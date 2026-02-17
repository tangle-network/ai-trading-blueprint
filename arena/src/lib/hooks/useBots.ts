import { useEffect, useState, useCallback } from 'react';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import type { Bot, BotStatus, StrategyType } from '~/lib/types/bot';
import { tradingVaultAbi, erc20Abi, tangleServicesAbi, vaultFactoryAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { getBotMeta } from '~/lib/config/botRegistry';
import { publicClient } from '~/lib/contracts/publicClient';

// Direct vault address mapping (fallback when VaultFactory not deployed):
// VITE_SERVICE_VAULTS={"0":"0x...","1":"0x..."}
const SERVICE_VAULTS: Record<string, Address> = (() => {
  try {
    const raw = import.meta.env.VITE_SERVICE_VAULTS;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
})();

const BLUEPRINT_ID = BigInt(import.meta.env.VITE_BLUEPRINT_ID ?? '0');

/**
 * Hook that discovers bots by reading ServiceActivated events from the Tangle contract.
 * Uses a standalone viem client — works regardless of wallet chain.
 */
export function useBots(): { bots: Bot[]; isLoading: boolean; isOnChain: boolean; refetch: () => void } {
  const [bots, setBots] = useState<Bot[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const discover = useCallback(async () => {
    setIsLoading(true);
    try {
      // Phase 0: Discover service IDs from ServiceActivated events
      const logs = await publicClient.getLogs({
        address: addresses.tangle,
        event: {
          type: 'event',
          name: 'ServiceActivated',
          inputs: [
            { name: 'serviceId', type: 'uint64', indexed: true },
            { name: 'requestId', type: 'uint64', indexed: true },
            { name: 'blueprintId', type: 'uint64', indexed: true },
          ],
        },
        args: { blueprintId: BLUEPRINT_ID },
        fromBlock: 0n,
        toBlock: 'latest',
      });

      const serviceIds = [...new Set(
        logs.map((log) => Number(log.args.serviceId)).filter((id) => !isNaN(id)),
      )];

      if (serviceIds.length === 0) {
        setBots([]);
        setIsLoading(false);
        return;
      }

      // Phase 1: Service-level queries (operators, active status)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serviceResults: any[] = await publicClient.multicall({
        contracts: serviceIds.flatMap((id) => [
          { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'getServiceOperators' as const, args: [BigInt(id)] },
          { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'isServiceActive' as const, args: [BigInt(id)] },
        ]),
      });

      // Phase 1b: Vault factory queries (if factory is deployed)
      const hasVaultFactory = addresses.vaultFactory !== zeroAddress;
      let vaultFactoryResults: any[] | null = null;
      if (hasVaultFactory) {
        try {
          vaultFactoryResults = await publicClient.multicall({
            contracts: serviceIds.map((id) => ({
              address: addresses.vaultFactory, abi: vaultFactoryAbi, functionName: 'getServiceVaults' as const, args: [BigInt(id)],
            })),
          });
        } catch {
          // VaultFactory not deployed or call failed — fall back to env mapping
        }
      }

      // Build vault entries
      type VaultEntry = { serviceId: number; address: Address; operators: Address[]; isActive: boolean };
      const vaultEntries: VaultEntry[] = serviceIds.map((id, i) => {
        const operators = (serviceResults[i * 2]?.result as Address[] | undefined) ?? [];
        const isActive = (serviceResults[i * 2 + 1]?.result as boolean | undefined) ?? false;

        let vaultAddr: Address | undefined;

        // Try VaultFactory first
        if (vaultFactoryResults) {
          const vaults = vaultFactoryResults[i]?.result as Address[] | undefined;
          if (vaults && vaults.length > 0 && vaults[0] !== zeroAddress) {
            vaultAddr = vaults[0];
          }
        }

        // Fallback to env mapping
        if (!vaultAddr) {
          vaultAddr = SERVICE_VAULTS[String(id)];
        }

        return { serviceId: id, address: vaultAddr ?? zeroAddress, operators, isActive };
      });

      // Phase 2: Vault-level queries (only for non-zero vault addresses)
      const vaultsWithAddr = vaultEntries.filter((v) => v.address !== zeroAddress);
      let vaultResults: any[] | null = null;
      if (vaultsWithAddr.length > 0) {
        try {
          vaultResults = await publicClient.multicall({
            contracts: vaultsWithAddr.flatMap((v) => [
              { address: v.address, abi: tradingVaultAbi, functionName: 'totalAssets' as const },
              { address: v.address, abi: tradingVaultAbi, functionName: 'paused' as const },
              { address: v.address, abi: tradingVaultAbi, functionName: 'asset' as const },
            ]),
          });
        } catch {
          // Vault contracts not reachable
        }
      }

      // Phase 3: Asset token symbol/decimals queries
      const assetTokens: Address[] = [];
      if (vaultResults) {
        for (let i = 0; i < vaultsWithAddr.length; i++) {
          const assetAddr = vaultResults[i * 3 + 2]?.result as Address | undefined;
          if (assetAddr && assetAddr !== zeroAddress) {
            assetTokens.push(assetAddr);
          }
        }
      }

      let assetResults: any[] | null = null;
      if (assetTokens.length > 0) {
        try {
          assetResults = await publicClient.multicall({
            contracts: assetTokens.flatMap((addr) => [
              { address: addr, abi: erc20Abi, functionName: 'symbol' as const },
              { address: addr, abi: erc20Abi, functionName: 'decimals' as const },
            ]),
          });
        } catch {
          // Token contracts not reachable
        }
      }

      // Build bot objects
      const vaultAddrIndex = new Map<number, number>();
      vaultsWithAddr.forEach((v, i) => vaultAddrIndex.set(v.serviceId, i));

      let assetIdx = 0;
      const builtBots: Bot[] = vaultEntries.map((entry) => {
        const meta = getBotMeta(entry.serviceId);

        let tvlRaw = 0;
        let assetSymbol = '???';
        let assetDecimals = 18;
        let paused = false;

        const vi = vaultAddrIndex.get(entry.serviceId);
        if (vi != null && vaultResults) {
          const totalAssets = vaultResults[vi * 3]?.result as bigint | undefined;
          paused = (vaultResults[vi * 3 + 1]?.result as boolean | undefined) ?? false;
          const assetAddr = vaultResults[vi * 3 + 2]?.result as Address | undefined;

          if (assetAddr && assetAddr !== zeroAddress && assetResults) {
            const symbolResult = assetResults[assetIdx * 2];
            const decimalsResult = assetResults[assetIdx * 2 + 1];
            assetSymbol = (symbolResult?.result as string) ?? '???';
            assetDecimals = (decimalsResult?.result as number) ?? 18;
            assetIdx++;
          }

          tvlRaw = totalAssets ? Number(totalAssets) / (10 ** assetDecimals) : 0;
        }

        const botStatus: BotStatus = !entry.isActive ? 'stopped' : paused ? 'paused' : 'active';

        return {
          id: `service-${entry.serviceId}`,
          name: meta?.name ?? `Bot #${entry.serviceId}`,
          operatorAddress: entry.operators[0] ?? zeroAddress,
          vaultAddress: entry.address !== zeroAddress ? entry.address : zeroAddress,
          strategyType: (meta?.strategyType ?? 'momentum') as StrategyType,
          status: botStatus,
          createdAt: meta?.createdAt ?? Date.now(),
          pnlPercent: 0,
          pnlAbsolute: 0,
          sharpeRatio: 0,
          maxDrawdown: 0,
          winRate: 0,
          totalTrades: 0,
          tvl: tvlRaw,
          avgValidatorScore: 0,
          sparklineData: [],
        };
      });

      setBots(builtBots);
    } catch (err) {
      console.warn('[useBots] Discovery failed:', err);
      setBots([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    discover();
  }, [discover]);

  return {
    bots,
    isLoading,
    isOnChain: bots.length > 0,
    refetch: discover,
  };
}
