import { useEffect, useState, useCallback } from 'react';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import type { Bot, BotStatus, StrategyType } from '~/lib/types/bot';
import { tradingVaultAbi, erc20Abi, tangleServicesAbi, vaultFactoryAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { getBotMeta } from '~/lib/config/botRegistry';
import { publicClient } from '~/lib/contracts/publicClient';
import { provisionsStore } from '~/lib/stores/provisions';

// Direct vault address mapping (fallback when VaultFactory not deployed):
// VITE_SERVICE_VAULTS={"0":["0x..."],"1":["0x...","0x..."]}
// Also supports legacy single-address format: {"0":"0x..."}
const SERVICE_VAULTS: Record<string, Address[]> = (() => {
  try {
    const raw = import.meta.env.VITE_SERVICE_VAULTS;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const result: Record<string, Address[]> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (Array.isArray(val)) {
        result[key] = val as Address[];
      } else if (typeof val === 'string') {
        result[key] = [val as Address];
      }
    }
    return result;
  } catch {
    return {};
  }
})();

const BLUEPRINT_ID = BigInt(import.meta.env.VITE_BLUEPRINT_ID ?? '0');
const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

/** Intermediate: one entry per vault discovered on-chain */
type VaultEntry = {
  serviceId: number;
  vaultAddress: Address;
  vaultIndex: number;
  operators: Address[];
  isActive: boolean;
};

/**
 * Discovers bots from on-chain data.
 *
 * Model: Service (Tangle) → N vaults (VaultFactory) → N bots on the leaderboard.
 * Each vault is a separate trading bot that shares operators with its service siblings.
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

      let serviceIds = [...new Set(
        logs.map((log) => Number(log.args.serviceId)).filter((id) => !isNaN(id)),
      )];

      // Fallback: use VITE_SERVICE_IDS if event discovery found nothing
      if (serviceIds.length === 0) {
        const envIds = import.meta.env.VITE_SERVICE_IDS;
        if (envIds) {
          serviceIds = envIds.split(',').map(Number).filter((n: number) => !isNaN(n));
        }
      }

      // Also include service IDs from tracked provisions (catches newly created services)
      for (const prov of provisionsStore.get()) {
        if (prov.serviceId != null && !serviceIds.includes(prov.serviceId)) {
          serviceIds.push(prov.serviceId);
        }
      }

      // Phase 1: Service-level queries (operators, active status)
      let serviceResults: any[] = [];
      let vaultFactoryResults: any[] | null = null;

      if (serviceIds.length > 0) {
        serviceResults = await publicClient.multicall({
          contracts: serviceIds.flatMap((id) => [
            { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'getServiceOperators' as const, args: [BigInt(id)] },
            { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'isServiceActive' as const, args: [BigInt(id)] },
          ]),
        });

        // Phase 1b: Vault factory queries — get ALL vaults per service
        const hasVaultFactory = addresses.vaultFactory !== zeroAddress;
        if (hasVaultFactory) {
          try {
            vaultFactoryResults = await publicClient.multicall({
              contracts: serviceIds.map((id) => ({
                address: addresses.vaultFactory, abi: vaultFactoryAbi, functionName: 'getServiceVaults' as const, args: [BigInt(id)],
              })),
            });
          } catch (err) {
            console.warn('[useBots] VaultFactory multicall failed:', err);
          }
        }
      }

      // Expand services into per-vault entries
      const vaultEntries: VaultEntry[] = [];

      for (let i = 0; i < serviceIds.length; i++) {
        const id = serviceIds[i];
        const operators = (serviceResults[i * 2]?.result as Address[] | undefined) ?? [];
        const isActive = (serviceResults[i * 2 + 1]?.result as boolean | undefined) ?? false;

        // Collect all vault addresses for this service
        const vaultAddrs: Address[] = [];

        // From VaultFactory
        if (vaultFactoryResults) {
          const factoryVaults = vaultFactoryResults[i]?.result as Address[] | undefined;
          if (factoryVaults) {
            for (const addr of factoryVaults) {
              if (addr !== zeroAddress) vaultAddrs.push(addr);
            }
          }
        }

        // From env fallback (merge, dedupe)
        const envVaults = SERVICE_VAULTS[String(id)] ?? [];
        for (const addr of envVaults) {
          if (addr !== zeroAddress && !vaultAddrs.some((a) => a.toLowerCase() === addr.toLowerCase())) {
            vaultAddrs.push(addr);
          }
        }

        // From provisions store (catches vaults deployed by recent provisions)
        for (const prov of provisionsStore.get()) {
          if (prov.serviceId === id && prov.vaultAddress) {
            const va = prov.vaultAddress as Address;
            if (va !== zeroAddress && !vaultAddrs.some((a) => a.toLowerCase() === va.toLowerCase())) {
              vaultAddrs.push(va);
            }
          }
        }

        // One entry per vault
        vaultAddrs.forEach((addr, vi) => {
          vaultEntries.push({ serviceId: id, vaultAddress: addr, vaultIndex: vi, operators, isActive });
        });
      }

      // Phase 2-3: Vault-level queries (only if we have vaults to query)
      const builtBots: Bot[] = [];

      if (vaultEntries.length > 0) {
        let vaultResults: any[] | null = null;
        try {
          vaultResults = await publicClient.multicall({
            contracts: vaultEntries.flatMap((v) => [
              { address: v.vaultAddress, abi: tradingVaultAbi, functionName: 'totalAssets' as const },
              { address: v.vaultAddress, abi: tradingVaultAbi, functionName: 'paused' as const },
              { address: v.vaultAddress, abi: tradingVaultAbi, functionName: 'asset' as const },
            ]),
          });
        } catch {
          // Vault contracts not reachable
        }

        // Phase 3: Asset token symbol/decimals
        const assetTokens: Address[] = [];
        if (vaultResults) {
          for (let i = 0; i < vaultEntries.length; i++) {
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

        // Count vaults per service (for naming)
        const vaultsPerService = new Map<number, number>();
        for (const entry of vaultEntries) {
          vaultsPerService.set(entry.serviceId, (vaultsPerService.get(entry.serviceId) ?? 0) + 1);
        }

        // Build bot objects — one per vault
        let assetIdx = 0;
        for (let i = 0; i < vaultEntries.length; i++) {
          const entry = vaultEntries[i];
          const meta = getBotMeta(entry.serviceId);
          const numVaults = vaultsPerService.get(entry.serviceId) ?? 1;

          let tvlRaw = 0;
          let assetSymbol = '???';
          let assetDecimals = 18;
          let paused = false;

          if (vaultResults) {
            const totalAssets = vaultResults[i * 3]?.result as bigint | undefined;
            paused = (vaultResults[i * 3 + 1]?.result as boolean | undefined) ?? false;
            const assetAddr = vaultResults[i * 3 + 2]?.result as Address | undefined;

            if (assetAddr && assetAddr !== zeroAddress && assetResults) {
              assetSymbol = (assetResults[assetIdx * 2]?.result as string) ?? '???';
              assetDecimals = (assetResults[assetIdx * 2 + 1]?.result as number) ?? 18;
              assetIdx++;
            }

            tvlRaw = totalAssets ? Number(totalAssets) / (10 ** assetDecimals) : 0;
          }

          const botStatus: BotStatus = !entry.isActive ? 'stopped' : paused ? 'paused' : 'active';

          let name = meta?.name ?? `Bot #${entry.serviceId}`;
          if (numVaults > 1 && assetSymbol !== '???') {
            name = `${name} (${assetSymbol})`;
          }

          builtBots.push({
            id: entry.vaultAddress.toLowerCase(),
            serviceId: entry.serviceId,
            name,
            operatorAddress: entry.operators[0] ?? zeroAddress,
            vaultAddress: entry.vaultAddress,
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
          });
        }
      }

      // Phase 4: Merge bots from operator API (catches newly provisioned bots not yet on-chain)
      if (OPERATOR_API_URL) {
        try {
          const res = await fetch(`${OPERATOR_API_URL}/api/bots?limit=200`);
          if (res.ok) {
            const data = await res.json();
            const operatorBots: Array<{
              id: string;
              operator_address: string;
              vault_address: string;
              strategy_type: string;
              chain_id: number;
              trading_active: boolean;
              paper_trade: boolean;
              created_at: number;
              sandbox_id: string;
              secrets_configured?: boolean;
            }> = data.bots ?? [];

            // Merge operator API data into existing on-chain bots (by vault address)
            const existingVaults = new Map(builtBots.map((b) => [b.vaultAddress.toLowerCase(), b]));

            for (const ob of operatorBots) {
              const existing = existingVaults.get(ob.vault_address.toLowerCase());
              if (existing) {
                // Enrich existing bot with operator API fields
                existing.sandboxId = ob.sandbox_id;
                existing.tradingActive = ob.trading_active;
                existing.secretsConfigured = ob.secrets_configured;
                existing.paperTrade = ob.paper_trade;
                // Update status from operator API if more specific
                if (!ob.trading_active && existing.status === 'active') {
                  existing.status = 'stopped';
                }
                continue;
              }
              // Try to find the correct service ID from provisions
              // Match by vault address first, then sandbox_id as fallback
              const matchingProv = provisionsStore.get().find(
                (p) => {
                  if (p.vaultAddress && ob.vault_address &&
                      ob.vault_address.toLowerCase() !== zeroAddress &&
                      p.vaultAddress.toLowerCase() === ob.vault_address.toLowerCase()) {
                    return true;
                  }
                  if (p.sandboxId && ob.sandbox_id && p.sandboxId === ob.sandbox_id) {
                    return true;
                  }
                  return false;
                },
              );

              builtBots.push({
                id: ob.vault_address?.toLowerCase() || ob.id,
                serviceId: matchingProv?.serviceId ?? 0,
                name: matchingProv?.name ?? `${ob.strategy_type} Agent`,
                operatorAddress: ob.operator_address || zeroAddress,
                vaultAddress: ob.vault_address as Address,
                strategyType: (ob.strategy_type || 'momentum') as StrategyType,
                status: ob.trading_active ? 'active' : 'stopped',
                createdAt: ob.created_at * 1000,
                pnlPercent: 0,
                pnlAbsolute: 0,
                sharpeRatio: 0,
                maxDrawdown: 0,
                winRate: 0,
                totalTrades: 0,
                tvl: 0,
                avgValidatorScore: 0,
                sparklineData: [],
                sandboxId: ob.sandbox_id,
                tradingActive: ob.trading_active,
                secretsConfigured: ob.secrets_configured,
                paperTrade: ob.paper_trade,
              });
            }
          }
        } catch {
          // Operator API unreachable — continue with on-chain bots only
        }
      }

      // Phase 5: Build bots directly from provisions — the guaranteed fallback.
      // On-chain discovery is fragile (wrong service ID, VaultFactory not deployed,
      // operator API down). The provisions store always has the ground truth for
      // user-deployed bots. Includes in-progress provisions (no vault yet) so they
      // appear under the correct service card.
      for (const prov of provisionsStore.get()) {
        // Skip failed provisions — they're shown in ProvisionsBanner
        if (prov.phase === 'failed') continue;

        const hasVault = prov.vaultAddress && prov.vaultAddress.toLowerCase() !== zeroAddress;
        const botId = hasVault ? prov.vaultAddress!.toLowerCase() : `provision:${prov.id}`;

        // Skip if already represented by ID
        if (builtBots.some((b) => b.id === botId)) continue;
        // Skip if vault already exists from an earlier phase
        if (hasVault && builtBots.some((b) => b.vaultAddress.toLowerCase() === prov.vaultAddress!.toLowerCase())) continue;

        builtBots.push({
          id: botId,
          serviceId: prov.serviceId ?? 0,
          name: prov.name || 'Agent',
          operatorAddress: prov.operators?.[0] ?? zeroAddress,
          vaultAddress: (hasVault ? prov.vaultAddress! : zeroAddress) as Address,
          strategyType: (prov.strategyType || 'momentum') as StrategyType,
          status: prov.phase === 'active' ? 'active' : prov.phase === 'awaiting_secrets' ? 'needs_config' : 'stopped',
          createdAt: prov.createdAt,
          pnlPercent: 0,
          pnlAbsolute: 0,
          sharpeRatio: 0,
          maxDrawdown: 0,
          winRate: 0,
          totalTrades: 0,
          tvl: 0,
          avgValidatorScore: 0,
          sparklineData: [],
          sandboxId: prov.sandboxId,
          secretsConfigured: prov.phase === 'active',
          tradingActive: prov.phase === 'active',
        });
      }

      setBots(builtBots);
    } catch (err) {
      console.warn('[useBots] Discovery failed:', err);
      // Even if on-chain discovery completely fails, still show provision-derived bots
      const fallbackBots: Bot[] = [];
      for (const prov of provisionsStore.get()) {
        if (prov.phase === 'failed') continue;

        const hasVault = prov.vaultAddress && prov.vaultAddress.toLowerCase() !== zeroAddress;
        const botId = hasVault ? prov.vaultAddress!.toLowerCase() : `provision:${prov.id}`;

        fallbackBots.push({
          id: botId,
          serviceId: prov.serviceId ?? 0,
          name: prov.name || 'Agent',
          operatorAddress: prov.operators?.[0] ?? zeroAddress,
          vaultAddress: (hasVault ? prov.vaultAddress! : zeroAddress) as Address,
          strategyType: (prov.strategyType || 'momentum') as StrategyType,
          status: prov.phase === 'active' ? 'active' : prov.phase === 'awaiting_secrets' ? 'needs_config' : 'stopped',
          createdAt: prov.createdAt,
          pnlPercent: 0,
          pnlAbsolute: 0,
          sharpeRatio: 0,
          maxDrawdown: 0,
          winRate: 0,
          totalTrades: 0,
          tvl: 0,
          avgValidatorScore: 0,
          sparklineData: [],
          sandboxId: prov.sandboxId,
        });
      }
      setBots(fallbackBots);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    discover();
    // Refresh every 60s instead of on every store change
    const interval = setInterval(discover, 60_000);
    return () => clearInterval(interval);
  }, [discover]);

  return {
    bots,
    isLoading,
    isOnChain: bots.length > 0,
    refetch: discover,
  };
}
