import { useReadContracts } from 'wagmi';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import type { Bot, BotStatus, StrategyType } from '~/lib/types/bot';
import { tradingVaultAbi, tradingBlueprintAbi, tangleServicesAbi, erc20Abi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { mockBots } from '~/lib/mock/bots';
import { getBotApiUrl, getBotMeta } from '~/lib/config/botRegistry';

// Parse service IDs from env or default to empty
const SERVICE_IDS: number[] = (() => {
  const raw = import.meta.env.VITE_SERVICE_IDS;
  if (!raw) return [];
  return raw.split(',').map(Number).filter((n: number) => !isNaN(n) && n >= 0);
})();

interface OnChainBot {
  serviceId: number;
  vaultAddress: Address;
  operators: Address[];
  isActive: boolean;
  tvl: number;
  paused: boolean;
  assetSymbol: string;
  assetDecimals: number;
}

// Build multicall contract reads for a set of service IDs
function buildServiceQueries(serviceIds: number[]) {
  const calls: Array<{
    address: Address;
    abi: typeof tradingBlueprintAbi | typeof tangleServicesAbi | typeof tradingVaultAbi | typeof erc20Abi;
    functionName: string;
    args: readonly unknown[];
  }> = [];

  // For each service: get vault address, operators, active status
  for (const id of serviceIds) {
    // 3 calls per service in first batch
    calls.push({
      address: addresses.tradingBlueprint,
      abi: tradingBlueprintAbi,
      functionName: 'instanceVault',
      args: [BigInt(id)] as const,
    });
    calls.push({
      address: addresses.tangle,
      abi: tangleServicesAbi,
      functionName: 'getServiceOperators',
      args: [BigInt(id)] as const,
    });
    calls.push({
      address: addresses.tangle,
      abi: tangleServicesAbi,
      functionName: 'isServiceActive',
      args: [BigInt(id)] as const,
    });
  }
  return calls;
}

function buildVaultQueries(vaults: Array<{ serviceId: number; address: Address }>) {
  const calls: Array<{
    address: Address;
    abi: typeof tradingVaultAbi | typeof erc20Abi;
    functionName: string;
    args?: readonly unknown[];
  }> = [];

  for (const v of vaults) {
    // 3 calls per vault
    calls.push({
      address: v.address,
      abi: tradingVaultAbi,
      functionName: 'totalAssets',
    });
    calls.push({
      address: v.address,
      abi: tradingVaultAbi,
      functionName: 'paused',
    });
    calls.push({
      address: v.address,
      abi: tradingVaultAbi,
      functionName: 'asset',
    });
  }
  return calls;
}

/**
 * Hook that discovers bots from on-chain data.
 * When VITE_SERVICE_IDS is set, queries the chain for real bot data.
 * Falls back to mock data when no services are configured.
 */
export function useBots(): { bots: Bot[]; isLoading: boolean; isOnChain: boolean; refetch: () => void } {
  const hasServices = SERVICE_IDS.length > 0 && addresses.tradingBlueprint !== zeroAddress;

  // Phase 1: service-level queries
  const serviceQueries = hasServices ? buildServiceQueries(SERVICE_IDS) : [];
  const { data: serviceResults, isLoading: serviceLoading, refetch: refetchServices } = useReadContracts({
    contracts: serviceQueries as any,
    query: { enabled: hasServices },
  });

  // Parse vault addresses from service results
  const vaultsToQuery: Array<{ serviceId: number; address: Address; operators: Address[]; isActive: boolean }> = [];
  if (serviceResults) {
    for (let i = 0; i < SERVICE_IDS.length; i++) {
      const vaultResult = serviceResults[i * 3];
      const operatorsResult = serviceResults[i * 3 + 1];
      const activeResult = serviceResults[i * 3 + 2];

      const vaultAddr = vaultResult?.result as Address | undefined;
      const operators = (operatorsResult?.result as Address[] | undefined) ?? [];
      const isActive = (activeResult?.result as boolean | undefined) ?? false;

      if (vaultAddr && vaultAddr !== zeroAddress) {
        vaultsToQuery.push({ serviceId: SERVICE_IDS[i], address: vaultAddr, operators, isActive });
      }
    }
  }

  // Phase 2: vault-level queries
  const vaultQueries = vaultsToQuery.length > 0 ? buildVaultQueries(vaultsToQuery) : [];
  const { data: vaultResults, isLoading: vaultLoading, refetch: refetchVaults } = useReadContracts({
    contracts: vaultQueries as any,
    query: { enabled: vaultsToQuery.length > 0 },
  });

  // Phase 3: asset token symbol/decimals queries
  const assetTokens: Address[] = [];
  if (vaultResults) {
    for (let i = 0; i < vaultsToQuery.length; i++) {
      const assetResult = vaultResults[i * 3 + 2];
      const assetAddr = assetResult?.result as Address | undefined;
      if (assetAddr && assetAddr !== zeroAddress) {
        assetTokens.push(assetAddr);
      }
    }
  }

  const assetQueries = assetTokens.length > 0 ? assetTokens.flatMap(addr => [
    { address: addr, abi: erc20Abi, functionName: 'symbol' as const },
    { address: addr, abi: erc20Abi, functionName: 'decimals' as const },
  ]) : [];

  const { data: assetResults, isLoading: assetLoading } = useReadContracts({
    contracts: assetQueries as any,
    query: { enabled: assetTokens.length > 0 },
  });

  // Build bot objects from on-chain data
  const onChainBots: Bot[] = [];
  if (vaultResults && vaultsToQuery.length > 0) {
    let assetIdx = 0;
    for (let i = 0; i < vaultsToQuery.length; i++) {
      const v = vaultsToQuery[i];
      const totalAssetsResult = vaultResults[i * 3];
      const pausedResult = vaultResults[i * 3 + 1];
      const assetResult = vaultResults[i * 3 + 2];

      const totalAssets = totalAssetsResult?.result as bigint | undefined;
      const paused = (pausedResult?.result as boolean | undefined) ?? false;
      const assetAddr = assetResult?.result as Address | undefined;

      let assetSymbol = '???';
      let assetDecimals = 18;
      if (assetAddr && assetAddr !== zeroAddress && assetResults) {
        const symbolResult = assetResults[assetIdx * 2];
        const decimalsResult = assetResults[assetIdx * 2 + 1];
        assetSymbol = (symbolResult?.result as string) ?? '???';
        assetDecimals = (decimalsResult?.result as number) ?? 18;
        assetIdx++;
      }

      const tvlRaw = totalAssets ? Number(totalAssets) / (10 ** assetDecimals) : 0;

      // Get metadata from bot registry (names, strategy, etc.)
      const meta = getBotMeta(v.serviceId);

      const status: BotStatus = !v.isActive ? 'stopped' : paused ? 'paused' : 'active';

      onChainBots.push({
        id: `service-${v.serviceId}`,
        name: meta?.name ?? `Bot #${v.serviceId}`,
        operatorAddress: v.operators[0] ?? zeroAddress,
        vaultAddress: v.address,
        strategyType: (meta?.strategyType ?? 'momentum') as StrategyType,
        status,
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

  const isLoading = hasServices && (serviceLoading || vaultLoading || assetLoading);
  const bots = hasServices && onChainBots.length > 0 ? onChainBots : mockBots;

  return {
    bots,
    isLoading,
    isOnChain: hasServices && onChainBots.length > 0,
    refetch: () => { refetchServices(); refetchVaults(); },
  };
}
