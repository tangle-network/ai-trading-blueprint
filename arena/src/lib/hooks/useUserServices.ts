import { useEffect, useState, useCallback, useMemo } from 'react';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import { useBlockNumber } from 'wagmi';
import { tangleServicesAbi, vaultFactoryAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { publicClient } from '@tangle-network/blueprint-ui';
import {
  provisionsStore,
  getProvisionStructuralFingerprint,
} from '~/lib/stores/provisions';
import { ALL_BLUEPRINT_IDS } from '~/lib/blueprints';
import { computeServiceRemainingSeconds } from '~/lib/serviceTtl';

export interface UserService {
  serviceId: number;
  blueprintId: number;
  owner: string;
  createdAt: number;
  ttl: number;
  terminatedAt: number;
  status: number; // 0=pending, 1=active, 2=terminated
  operators: Address[];
  vaultAddresses: Address[];
  isActive: boolean;
  remainingSeconds: number | null;
}

/**
 * Discovers Tangle services the connected user owns or operates.
 * Queries on-chain events + multicall for service metadata.
 */
export function useUserServices(userAddress: Address | undefined) {
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const [services, setServices] = useState<UserService[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const discover = useCallback(async () => {
    if (!userAddress) {
      setServices([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      // Discover service IDs from ServiceActivated events across all configured blueprints
      const allLogs = await Promise.all(
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
      type ActivatedLog = { args: { serviceId?: bigint; requestId?: bigint; blueprintId?: bigint } };
      const logs = allLogs.flat() as ActivatedLog[];

      let serviceIds: number[] = [...new Set(
        logs.map((log: ActivatedLog) => Number(log.args.serviceId)).filter((id: number) => !isNaN(id)),
      )];

      // Fallback: use VITE_SERVICE_IDS env var
      if (serviceIds.length === 0) {
        const envIds = import.meta.env.VITE_SERVICE_IDS;
        if (envIds) {
          serviceIds = envIds.split(',').map(Number).filter((n: number) => !isNaN(n));
        }
      }

      if (serviceIds.length === 0) {
        setServices([]);
        setIsLoading(false);
        return;
      }

      // Multicall: getService + isServiceActive + getServiceOperators per service
      const serviceResults: any[] = await publicClient.multicall({
        contracts: serviceIds.flatMap((id) => [
          { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'getService' as const, args: [BigInt(id)] },
          { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'isServiceActive' as const, args: [BigInt(id)] },
          { address: addresses.tangle, abi: tangleServicesAbi, functionName: 'getServiceOperators' as const, args: [BigInt(id)] },
        ]),
      });

      // Vault factory queries
      const hasVaultFactory = addresses.vaultFactory !== zeroAddress;
      let vaultResults: any[] | null = null;
      if (hasVaultFactory) {
        try {
          vaultResults = await publicClient.multicall({
            contracts: serviceIds.map((id) => ({
              address: addresses.vaultFactory,
              abi: vaultFactoryAbi,
              functionName: 'getServiceVaults' as const,
              args: [BigInt(id)],
            })),
          });
        } catch {
          // VaultFactory not available
        }
      }

      // Build service objects
      const built: UserService[] = [];
      const userLower = userAddress.toLowerCase();

      for (let i = 0; i < serviceIds.length; i++) {
        const serviceData = serviceResults[i * 3]?.result as any;
        const isActive = (serviceResults[i * 3 + 1]?.result as boolean | undefined) ?? false;
        const operators = (serviceResults[i * 3 + 2]?.result as Address[] | undefined) ?? [];

        if (!serviceData) continue;

        const owner = serviceData.owner as string;
        const createdAt = Number(serviceData.createdAt);
        const ttl = Number(serviceData.ttl);
        const terminatedAt = Number(serviceData.terminatedAt);
        const status = Number(serviceData.status);

        // Filter: show services user owns or operates. Local provision drafts
        // can trigger a refresh, but they should not grant visibility.
        const isOwner = owner.toLowerCase() === userLower;
        const isOperator = operators.some((op) => op.toLowerCase() === userLower);
        if (!isOwner && !isOperator) continue;

        // Vault addresses
        const vaultAddresses: Address[] = [];
        if (vaultResults) {
          const factoryVaults = vaultResults[i]?.result as Address[] | undefined;
          if (factoryVaults) {
            for (const addr of factoryVaults) {
              if (addr !== zeroAddress) vaultAddresses.push(addr);
            }
          }
        }
        // TTL
        built.push({
          serviceId: serviceIds[i],
          blueprintId: Number(serviceData.blueprintId),
          owner,
          createdAt,
          ttl,
          terminatedAt,
          status,
          operators,
          vaultAddresses,
          isActive,
          remainingSeconds: computeServiceRemainingSeconds(createdAt, ttl),
        });
      }

      setServices(built);
    } catch (err) {
      console.warn('[useUserServices] Discovery failed:', err);
      setServices([]);
    } finally {
      setIsLoading(false);
    }
  }, [userAddress]);

  useEffect(() => {
    discover();
    let provisionFingerprint = getProvisionStructuralFingerprint(provisionsStore.get());
    const unsubscribe = provisionsStore.subscribe(() => {
      const nextFingerprint = getProvisionStructuralFingerprint(provisionsStore.get());
      if (nextFingerprint === provisionFingerprint) return;
      provisionFingerprint = nextFingerprint;
      void discover();
    });

    return () => {
      unsubscribe();
    };
  }, [discover]);

  const liveServices = useMemo(() => {
    void currentBlock;
    const nowSeconds = Math.floor(Date.now() / 1000);

    return services.map((service) => {
      return {
        ...service,
        remainingSeconds: computeServiceRemainingSeconds(service.createdAt, service.ttl, nowSeconds),
      };
    });
  }, [currentBlock, services]);

  return { services: liveServices, isLoading, refetch: discover };
}
