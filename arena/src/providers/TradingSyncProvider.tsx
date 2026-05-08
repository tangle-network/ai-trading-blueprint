import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { isAddress, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { publicClient } from '@tangle-network/blueprint-ui';
import {
  erc20Abi,
  tangleServicesAbi,
  tradingBlueprintAbi,
  tradingVaultAbi,
  vaultFactoryAbi,
} from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { getBotMeta } from '~/lib/config/botRegistry';
import { ALL_BLUEPRINT_IDS } from '~/lib/blueprints';
import {
  getProvisionStructuralFingerprint,
  provisionsStore,
  type TrackedProvision,
} from '~/lib/stores/provisions';
import { hydratedBotsStore, setHydratedBotsState, type OperatorDataState } from '~/lib/stores/hydratedBots';
import {
  isOperatorSourceInScope,
  operatorSyncScopeStore,
  type OperatorSyncScope,
} from '~/lib/stores/operatorSyncScope';
import type { Bot, BotLifecycleStatus, BotOperatorKind, BotStatus, StrategyType } from '~/lib/types/bot';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { useOperatorMeta } from '~/lib/operator/meta';
import {
  CLOUD_OPERATOR_API_URL,
  INSTANCE_OPERATOR_API_URL,
  TEE_OPERATOR_API_URL,
} from '~/lib/operator/meta';
import { operatorJsonWithAuth } from '~/lib/operator/fetch';
import { subscribeBotsRefresh } from '~/lib/events/bots';
import { resolveBotDisplayName } from '~/lib/utils/botNames';

const REFRESH_INTERVAL_MS = 15_000;

function isUniqueCallId(callId: number | null | undefined): callId is number {
  return typeof callId === 'number' && Number.isFinite(callId) && callId > 0;
}

type VaultEntry = {
  serviceId: number;
  vaultAddress: Address;
  vaultIndex: number;
  operators: Address[];
  isActive: boolean;
  isProvisioned: boolean;
  tvl: number;
  paused: boolean;
};

type OperatorBotRecord = {
  id: string;
  name?: string | null;
  operator_address: string;
  submitter_address?: string | null;
  vault_address: string;
  strategy_type: string;
  strategy_config?: Record<string, unknown>;
  chain_id: number;
  trading_active: boolean;
  paper_trade: boolean;
  created_at: number;
  sandbox_id: string;
  sandbox_exists: boolean;
  sandbox_state?: string | null;
  lifecycle_status: BotLifecycleStatus;
  archived?: boolean;
  control_available?: boolean;
  secrets_configured?: boolean;
  call_id: number;
  service_id: number;
};

type OperatorSource = {
  kind: Exclude<BotOperatorKind, null>;
  apiUrl: string;
  deploymentKind: 'fleet' | 'instance';
  token: string | null;
  isAuthenticating: boolean;
  getCachedToken: () => string | null;
  getToken: (forceRefresh?: boolean) => Promise<string | null>;
};

type OperatorBotResponse = OperatorBotRecord & {
  operatorApiUrl: string;
  operatorKind: Exclude<BotOperatorKind, null>;
};

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

function mapOperatorLifecycleToStatus(
  lifecycleStatus: BotLifecycleStatus,
  paused: boolean,
): BotStatus {
  switch (lifecycleStatus) {
    case 'awaiting_secrets':
      return 'needs_config';
    case 'active':
      return paused ? 'paused' : 'active';
    case 'winding_down':
      return 'winding_down';
    case 'archived':
      return 'archived';
    case 'stopped':
      return 'stopped';
    case 'unknown':
    default:
      return 'unknown';
  }
}

function getOperatorDataState(sources: OperatorSource[]): OperatorDataState {
  if (sources.length === 0) return 'disabled';
  const readyCount = sources.filter((source) => !!source.token).length;
  if (readyCount === 0) {
    return sources.some((source) => source.isAuthenticating) ? 'authenticating' : 'locked';
  }
  return readyCount === sources.length ? 'ready' : 'partial';
}

function filterOperatorSources(
  sources: OperatorSource[],
  syncScope: OperatorSyncScope,
): OperatorSource[] {
  return sources.filter((source) => isOperatorSourceInScope(source.apiUrl, syncScope));
}

function isExplicitVaultPlaceholder(vaultAddress: string | null | undefined): boolean {
  return vaultAddress?.trim().toLowerCase().startsWith('factory:') ?? false;
}

function usableVaultAddress(vaultAddress: string | null | undefined): Address | null {
  if (!vaultAddress || isExplicitVaultPlaceholder(vaultAddress)) return null;
  const trimmed = vaultAddress.trim();
  if (!isAddress(trimmed) || trimmed.toLowerCase() === zeroAddress) return null;
  return trimmed as Address;
}

async function fetchOperatorBots(source: OperatorSource): Promise<OperatorBotResponse[]> {
  const path = source.deploymentKind === 'instance' ? '/api/bot' : '/api/bots?limit=200';
  const data = await operatorJsonWithAuth<any>(
    source.apiUrl,
    path,
    {
      getCachedToken: source.getCachedToken,
      getToken: source.getToken,
    },
    {
      refreshOnUnauthorized: false,
    },
  );

  const bots: OperatorBotRecord[] = source.deploymentKind === 'instance'
    ? [{
        id: data.id,
        name: data.name,
        operator_address: data.operator_address,
        submitter_address: data.submitter_address,
        vault_address: data.vault_address,
        strategy_type: data.strategy_type,
        strategy_config: data.strategy_config,
        chain_id: data.chain_id,
        trading_active: data.trading_active,
        paper_trade: data.paper_trade,
        created_at: data.created_at,
        sandbox_id: data.sandbox_id,
        sandbox_exists: data.sandbox_exists,
        sandbox_state: data.sandbox_state,
        lifecycle_status: data.lifecycle_status,
        archived: data.archived,
        control_available: data.control_available,
        secrets_configured: data.secrets_configured,
        call_id: data.call_id ?? 0,
        service_id: data.service_id ?? 0,
      }]
    : data.bots ?? [];

  return bots.map((bot) => ({
    ...bot,
    operatorApiUrl: source.apiUrl,
    operatorKind: source.kind,
  }));
}

function makeBaseBot(partial: Partial<Bot>, authoritative: boolean): Bot {
  return {
    id: partial.id ?? '',
    serviceId: partial.serviceId ?? 0,
    name: partial.name ?? 'Agent',
    operatorAddress: partial.operatorAddress ?? zeroAddress,
    vaultAddress: partial.vaultAddress ?? zeroAddress,
    strategyType: (partial.strategyType ?? 'momentum') as StrategyType,
    status: partial.status ?? 'unknown',
    createdAt: partial.createdAt ?? Date.now(),
    chainId: partial.chainId,
    pnlPercent: partial.pnlPercent ?? 0,
    pnlAbsolute: partial.pnlAbsolute ?? 0,
    sharpeRatio: partial.sharpeRatio ?? 0,
    maxDrawdown: partial.maxDrawdown ?? 0,
    winRate: partial.winRate ?? 0,
    totalTrades: partial.totalTrades ?? 0,
    tvl: partial.tvl ?? 0,
    avgValidatorScore: partial.avgValidatorScore ?? 0,
    sparklineData: partial.sparklineData ?? [],
    source: partial.source,
    sandboxId: partial.sandboxId,
    sandboxState: partial.sandboxState,
    lifecycleStatus: partial.lifecycleStatus,
    archived: partial.archived ?? false,
    controlAvailable: partial.controlAvailable ?? false,
    tradingActive: partial.tradingActive ?? false,
    workflowId: partial.workflowId,
    maxLifetimeDays: partial.maxLifetimeDays,
    windDownStartedAt: partial.windDownStartedAt,
    secretsConfigured: partial.secretsConfigured ?? false,
    submitterAddress: partial.submitterAddress,
    strategyConfig: partial.strategyConfig,
    riskParams: partial.riskParams,
    paperTrade: partial.paperTrade,
    callId: partial.callId,
    verificationState: authoritative ? 'authoritative' : 'unverified',
    operatorKind: partial.operatorKind ?? null,
    operatorApiUrl: partial.operatorApiUrl ?? null,
    lastVerifiedAt: authoritative ? (partial.lastVerifiedAt ?? Date.now()) : null,
    isUnverified: !authoritative,
  };
}

export function TradingSyncProvider({ children }: { children: ReactNode }) {
  const syncScope = useStore(operatorSyncScopeStore);
  const cloudMeta = useOperatorMeta(CLOUD_OPERATOR_API_URL);
  const instanceMeta = useOperatorMeta(INSTANCE_OPERATOR_API_URL);
  const teeMeta = useOperatorMeta(TEE_OPERATOR_API_URL);
  const cloudAuth = useOperatorAuth(CLOUD_OPERATOR_API_URL);
  const instanceAuth = useOperatorAuth(INSTANCE_OPERATOR_API_URL);
  const teeAuth = useOperatorAuth(TEE_OPERATOR_API_URL);
  const controllerRef = useRef<AbortController | null>(null);
  const refreshSeqRef = useRef(0);

  const operatorSources = useMemo<OperatorSource[]>(() => {
    const sources: OperatorSource[] = [];
    if (CLOUD_OPERATOR_API_URL && cloudMeta.data) {
      sources.push({
        kind: 'cloud',
        apiUrl: CLOUD_OPERATOR_API_URL,
        deploymentKind: cloudMeta.data.deployment_kind,
        token: cloudAuth.getCachedToken(),
        isAuthenticating: cloudAuth.isAuthenticating,
        getCachedToken: cloudAuth.getCachedToken,
        getToken: cloudAuth.getToken,
      });
    }
    if (INSTANCE_OPERATOR_API_URL && instanceMeta.data) {
      sources.push({
        kind: 'instance',
        apiUrl: INSTANCE_OPERATOR_API_URL,
        deploymentKind: instanceMeta.data.deployment_kind,
        token: instanceAuth.getCachedToken(),
        isAuthenticating: instanceAuth.isAuthenticating,
        getCachedToken: instanceAuth.getCachedToken,
        getToken: instanceAuth.getToken,
      });
    }
    if (TEE_OPERATOR_API_URL && teeMeta.data) {
      sources.push({
        kind: 'tee',
        apiUrl: TEE_OPERATOR_API_URL,
        deploymentKind: teeMeta.data.deployment_kind,
        token: teeAuth.getCachedToken(),
        isAuthenticating: teeAuth.isAuthenticating,
        getCachedToken: teeAuth.getCachedToken,
        getToken: teeAuth.getToken,
      });
    }
    return sources;
  }, [
    cloudAuth.getCachedToken,
    cloudAuth.getToken,
    cloudAuth.isAuthenticating,
    cloudMeta.data?.deployment_kind,
    instanceAuth.getCachedToken,
    instanceAuth.getToken,
    instanceAuth.isAuthenticating,
    instanceMeta.data?.deployment_kind,
    teeAuth.getCachedToken,
    teeAuth.getToken,
    teeAuth.isAuthenticating,
    teeMeta.data?.deployment_kind,
  ]);

  const activeOperatorSources = useMemo(
    () => filterOperatorSources(operatorSources, syncScope),
    [operatorSources, syncScope],
  );

  const refresh = useCallback(async () => {
    const refreshSeq = refreshSeqRef.current + 1;
    refreshSeqRef.current = refreshSeq;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;

    setHydratedBotsState((current) => ({
      ...current,
      isLoading: true,
      operatorDataState: getOperatorDataState(activeOperatorSources),
    }));

    try {
      const storedProvisions = provisionsStore.get();

      const operatorFetches = activeOperatorSources
        .filter((source) => source.apiUrl && source.token)
        .map(async (source) => {
          try {
            return await fetchOperatorBots(source);
          } catch (err) {
            console.warn(`[TradingSyncProvider] Operator bot fetch failed for ${source.apiUrl}:`, err);
            return [];
          }
        });
      const operatorBotGroups = await Promise.all(operatorFetches);
      if (signal.aborted || refreshSeqRef.current !== refreshSeq) return;
      const operatorBots = operatorBotGroups.flat();

      let allLogs: unknown[][] = [];
      try {
        allLogs = await Promise.all(
          ALL_BLUEPRINT_IDS.map((bpId) =>
            publicClient.getLogs({
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
              args: { blueprintId: bpId },
              fromBlock: 0n,
              toBlock: 'latest',
            }),
          ),
        );
      } catch (err) {
        console.warn('[TradingSyncProvider] Service event discovery failed; falling back to configured service IDs:', err);
      }
      if (signal.aborted || refreshSeqRef.current !== refreshSeq) return;

      type ActivatedLog = { args: { serviceId?: bigint } };
      const logs = allLogs.flat() as ActivatedLog[];
      let serviceIds: number[] = [...new Set(
        logs.map((log) => Number(log.args.serviceId)).filter((id) => !Number.isNaN(id)),
      )];

      if (serviceIds.length === 0) {
        const envIds = import.meta.env.VITE_SERVICE_IDS;
        if (envIds) {
          serviceIds = envIds.split(',').map(Number).filter((n: number) => !Number.isNaN(n));
        }
      }

      for (const provision of storedProvisions) {
        if (provision.serviceId != null && !serviceIds.includes(provision.serviceId)) {
          serviceIds.push(provision.serviceId);
        }
      }

      let serviceResults: any[] = [];
      let blueprintResults: any[] | null = null;
      let vaultFactoryResults: any[] | null = null;
      const hasBlueprint = addresses.tradingBlueprint !== zeroAddress;
      const hasVaultFactory = addresses.vaultFactory !== zeroAddress;

      if (serviceIds.length > 0) {
        try {
          serviceResults = await publicClient.multicall({
            contracts: serviceIds.flatMap((id) => [
              { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'getServiceOperators' as const, args: [BigInt(id)] },
              { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'isServiceActive' as const, args: [BigInt(id)] },
            ]),
          });
        } catch (err) {
          console.warn('[TradingSyncProvider] Service metadata lookup failed; continuing with operator data:', err);
          serviceResults = [];
        }

        if (hasBlueprint) {
          try {
            blueprintResults = await publicClient.multicall({
              contracts: serviceIds.map((id) => ({
                address: addresses.tradingBlueprint,
                abi: tradingBlueprintAbi,
                functionName: 'instanceProvisioned' as const,
                args: [BigInt(id)],
              })),
            });
          } catch {
            blueprintResults = null;
          }
        }

        if (hasVaultFactory) {
          try {
            vaultFactoryResults = await publicClient.multicall({
              contracts: serviceIds.map((id) => ({
                address: addresses.vaultFactory,
                abi: vaultFactoryAbi,
                functionName: 'getServiceVaults' as const,
                args: [BigInt(id)],
              })),
            });
          } catch {
            vaultFactoryResults = null;
          }
        }
      }
      if (signal.aborted || refreshSeqRef.current !== refreshSeq) return;

      const vaultEntries: VaultEntry[] = [];
      for (let i = 0; i < serviceIds.length; i += 1) {
        const id = serviceIds[i];
        const operators = (serviceResults[i * 2]?.result as Address[] | undefined) ?? [];
        const isActive = (serviceResults[i * 2 + 1]?.result as boolean | undefined) ?? false;
        const vaultAddrs: Address[] = [];
        let isProvisioned = false;

        if (blueprintResults) {
          isProvisioned = (blueprintResults[i]?.result as boolean | undefined) ?? false;
        }

        if (vaultFactoryResults) {
          const factoryVaults = vaultFactoryResults[i]?.result as Address[] | undefined;
          if (factoryVaults) {
            for (const addr of factoryVaults) {
              if (addr !== zeroAddress) vaultAddrs.push(addr);
            }
            if (vaultAddrs.length > 0) isProvisioned = true;
          }
        }

        if (vaultAddrs.length === 0) {
          const envVaults = SERVICE_VAULTS[String(id)] ?? [];
          for (const addr of envVaults) {
            if (addr !== zeroAddress && !vaultAddrs.some((existing) => existing.toLowerCase() === addr.toLowerCase())) {
              vaultAddrs.push(addr);
            }
          }
          if (vaultAddrs.length > 0) isProvisioned = true;
        }

        for (const provision of storedProvisions) {
          if (provision.serviceId === id && provision.vaultAddress) {
            const nextAddress = provision.vaultAddress as Address;
            if (nextAddress !== zeroAddress && !vaultAddrs.some((existing) => existing.toLowerCase() === nextAddress.toLowerCase())) {
              vaultAddrs.push(nextAddress);
            }
          }
        }

        vaultAddrs.forEach((vaultAddress, vaultIndex) => {
          vaultEntries.push({
            serviceId: id,
            vaultAddress,
            vaultIndex,
            operators,
            isActive,
            isProvisioned,
            tvl: 0,
            paused: false,
          });
        });
      }

      let vaultResults: any[] | null = null;
      if (vaultEntries.length > 0) {
        try {
          vaultResults = await publicClient.multicall({
            contracts: vaultEntries.flatMap((entry) => [
              { address: entry.vaultAddress, abi: tradingVaultAbi, functionName: 'totalAssets' as const },
              { address: entry.vaultAddress, abi: tradingVaultAbi, functionName: 'paused' as const },
              { address: entry.vaultAddress, abi: tradingVaultAbi, functionName: 'asset' as const },
            ]),
          });
        } catch {
          vaultResults = null;
        }
      }

      let assetResults: any[] | null = null;
      if (vaultResults) {
        const assetTokens: Address[] = [];
        for (let i = 0; i < vaultEntries.length; i += 1) {
          const assetAddress = vaultResults[i * 3 + 2]?.result as Address | undefined;
          if (assetAddress && assetAddress !== zeroAddress) {
            assetTokens.push(assetAddress);
          }
        }

        if (assetTokens.length > 0) {
          try {
            assetResults = await publicClient.multicall({
              contracts: assetTokens.flatMap((addr) => [
                { address: addr, abi: erc20Abi, functionName: 'symbol' as const },
                { address: addr, abi: erc20Abi, functionName: 'decimals' as const },
              ]),
            });
          } catch {
            assetResults = null;
          }
        }
      }
      if (signal.aborted || refreshSeqRef.current !== refreshSeq) return;

      const vaultsPerService = new Map<number, number>();
      for (const entry of vaultEntries) {
        vaultsPerService.set(entry.serviceId, (vaultsPerService.get(entry.serviceId) ?? 0) + 1);
      }

      const builtBots: Bot[] = [];
      let assetIdx = 0;
      for (let i = 0; i < vaultEntries.length; i += 1) {
        const entry = vaultEntries[i];
        const meta = getBotMeta(entry.serviceId);
        const numVaults = vaultsPerService.get(entry.serviceId) ?? 1;
        let assetSymbol = '???';
        let assetDecimals = 18;
        let paused = false;
        let tvlRaw = 0;

        if (vaultResults) {
          const totalAssets = vaultResults[i * 3]?.result as bigint | undefined;
          paused = (vaultResults[i * 3 + 1]?.result as boolean | undefined) ?? false;
          const assetAddr = vaultResults[i * 3 + 2]?.result as Address | undefined;

          if (assetAddr && assetAddr !== zeroAddress && assetResults) {
            assetSymbol = (assetResults[assetIdx * 2]?.result as string) ?? '???';
            assetDecimals = (assetResults[assetIdx * 2 + 1]?.result as number) ?? 18;
            assetIdx += 1;
          }

          tvlRaw = totalAssets ? Number(totalAssets) / (10 ** assetDecimals) : 0;
        }

        entry.tvl = tvlRaw;
        entry.paused = paused;

        const botStatus: BotStatus = !entry.isProvisioned ? 'stopped'
          : !entry.isActive ? 'stopped'
          : paused ? 'paused'
          : 'unknown';

        let name = meta?.name ?? `Bot #${entry.serviceId}`;
        if (numVaults > 1 && assetSymbol !== '???') {
          name = `${name} (${assetSymbol})`;
        }

        builtBots.push(makeBaseBot({
          id: entry.vaultAddress.toLowerCase(),
          serviceId: entry.serviceId,
          name,
          operatorAddress: entry.operators[0] ?? zeroAddress,
          vaultAddress: entry.vaultAddress,
          strategyType: (meta?.strategyType ?? 'momentum') as StrategyType,
          status: botStatus,
          createdAt: meta?.createdAt ?? Date.now(),
          tvl: tvlRaw,
          lifecycleStatus: 'unknown',
          source: 'on_chain',
        }, false));
      }

      const operatorBackedBots: Bot[] = [];
      const needsVaultResolution = operatorBots.filter((bot) => {
        const vault = bot.vault_address?.toLowerCase() ?? '';
        return (
          (!vault || vault === zeroAddress || isExplicitVaultPlaceholder(vault))
          && isUniqueCallId(bot.call_id)
          && bot.service_id > 0
        );
      });

      const resolvedVaults: Record<string, Address> = {};
      if (needsVaultResolution.length > 0 && addresses.tradingBlueprint !== zeroAddress) {
        try {
          const vaultResolution = await publicClient.multicall({
            contracts: needsVaultResolution.map((bot) => ({
              address: addresses.tradingBlueprint,
              abi: tradingBlueprintAbi,
              functionName: 'botVaults' as const,
              args: [BigInt(bot.service_id), BigInt(bot.call_id)],
            })),
          });
          for (let i = 0; i < needsVaultResolution.length; i += 1) {
            const addr = vaultResolution[i]?.result as Address | undefined;
            if (addr && addr !== zeroAddress) {
              resolvedVaults[needsVaultResolution[i].id] = addr;
            }
          }
        } catch {
          // Keep operator data without resolved vaults.
        }
      }

      const allOperatorVaults = new Set<string>();
      for (const operatorBot of operatorBots) {
        const vault = usableVaultAddress(operatorBot.vault_address);
        if (vault) allOperatorVaults.add(vault.toLowerCase());
        const resolved = resolvedVaults[operatorBot.id]?.toLowerCase();
        if (resolved) allOperatorVaults.add(resolved);
      }
      const keptBots = builtBots.filter((bot) => !allOperatorVaults.has(bot.vaultAddress.toLowerCase()));
      builtBots.length = 0;
      builtBots.push(...keptBots);

      const vaultEntriesByAddress = new Map(
        vaultEntries.map((entry) => [entry.vaultAddress.toLowerCase(), entry] as const),
      );
      const seenBotIds = new Set(builtBots.map((bot) => bot.id));
      const lastVerifiedAt = Date.now();

      for (const operatorBot of operatorBots) {
        const matchingProvision = storedProvisions.find(
          (provision) =>
            (provision.sandboxId && operatorBot.sandbox_id && provision.sandboxId === operatorBot.sandbox_id)
            || (
              isUniqueCallId(provision.callId)
              && isUniqueCallId(operatorBot.call_id)
              && provision.callId === operatorBot.call_id
              && provision.serviceId != null
              && operatorBot.service_id > 0
              && provision.serviceId === operatorBot.service_id
            ),
        );

        const vaultAddress = usableVaultAddress(operatorBot.vault_address)
          ?? resolvedVaults[operatorBot.id]
          ?? zeroAddress;

        const vaultLower = vaultAddress.toLowerCase();

        const hasOperatorLifecycleState = operatorBot.lifecycle_status !== 'unknown'
          || operatorBot.secrets_configured === true
          || matchingProvision?.phase === 'awaiting_secrets';
        if (vaultLower === zeroAddress && !hasOperatorLifecycleState) continue;

        const botId = operatorBot.id;
        if (seenBotIds.has(botId)) continue;
        seenBotIds.add(botId);

        const vaultEntry = vaultEntriesByAddress.get(vaultLower);
        const botStatus = mapOperatorLifecycleToStatus(operatorBot.lifecycle_status, vaultEntry?.paused ?? false);

        const authoritativeBot = makeBaseBot({
          id: botId,
          serviceId: operatorBot.service_id || matchingProvision?.serviceId || vaultEntry?.serviceId || 0,
          name: resolveBotDisplayName({
            primaryName: operatorBot.name || matchingProvision?.name,
            strategyType: operatorBot.strategy_type,
          }),
          operatorAddress: operatorBot.operator_address || (vaultEntry?.operators[0] ?? zeroAddress),
          submitterAddress: operatorBot.submitter_address ?? matchingProvision?.owner,
          vaultAddress,
          strategyType: (operatorBot.strategy_type || 'momentum') as StrategyType,
          strategyConfig: operatorBot.strategy_config,
          status: botStatus,
          createdAt: operatorBot.created_at * 1000,
          chainId: operatorBot.chain_id,
          tvl: vaultEntry?.tvl ?? 0,
          sandboxId: operatorBot.sandbox_id,
          sandboxState: operatorBot.sandbox_state ?? null,
          lifecycleStatus: operatorBot.lifecycle_status,
          archived: operatorBot.archived ?? operatorBot.lifecycle_status === 'archived',
          controlAvailable: operatorBot.control_available ?? false,
          tradingActive: operatorBot.trading_active,
          secretsConfigured: operatorBot.secrets_configured,
          paperTrade: operatorBot.paper_trade,
          callId: operatorBot.call_id ?? matchingProvision?.callId,
          source: 'operator',
          operatorKind: operatorBot.operatorKind,
          operatorApiUrl: operatorBot.operatorApiUrl,
          lastVerifiedAt,
        }, true);

        builtBots.push(authoritativeBot);
        operatorBackedBots.push(authoritativeBot);
      }

      const nextState = {
        bots: builtBots,
        isLoading: false,
        isOnChain: builtBots.length > 0,
        operatorDataState: getOperatorDataState(activeOperatorSources),
        lastSyncedAt: Date.now(),
      };

      if (!signal.aborted && refreshSeqRef.current === refreshSeq) {
        hydratedBotsStore.set(nextState);
      }
    } catch {
      if (!signal.aborted && refreshSeqRef.current === refreshSeq) {
        setHydratedBotsState((current) => ({
          ...current,
          isLoading: false,
          operatorDataState: getOperatorDataState(activeOperatorSources),
        }));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [activeOperatorSources]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    }, REFRESH_INTERVAL_MS);
    const unsubscribeRefresh = subscribeBotsRefresh(() => {
      void refresh();
    });
    let provisionFingerprint = getProvisionStructuralFingerprint(provisionsStore.get());
    const unsubscribeProvisions = provisionsStore.subscribe(() => {
      const nextFingerprint = getProvisionStructuralFingerprint(provisionsStore.get());
      if (nextFingerprint === provisionFingerprint) return;
      provisionFingerprint = nextFingerprint;
      void refresh();
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribeProvisions();
      unsubscribeRefresh();
      window.clearInterval(intervalId);
      controllerRef.current?.abort();
    };
  }, [refresh]);

  return <>{children}</>;
}
