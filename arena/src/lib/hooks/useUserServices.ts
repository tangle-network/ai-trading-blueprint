import { useEffect, useState, useCallback } from 'react';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import { tangleServicesAbi, vaultFactoryAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { publicClient } from '~/lib/contracts/publicClient';
import { provisionsStore } from '~/lib/stores/provisions';

const BLUEPRINT_ID = BigInt(import.meta.env.VITE_BLUEPRINT_ID ?? '0');
const BLOCK_TIME_SECONDS = 12;

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
      // Discover service IDs from ServiceActivated events
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

      // Fallback: use VITE_SERVICE_IDS env var
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

      // Get current block for TTL computation
      const currentBlock = Number(await publicClient.getBlockNumber());

      // Build service objects
      const built: UserService[] = [];
      const userLower = userAddress.toLowerCase();

      // Service IDs from user's provisions (user should always see services they provisioned)
      const provisionServiceIds = new Set(
        provisionsStore.get()
          .filter((p) => p.owner.toLowerCase() === userLower && p.serviceId != null)
          .map((p) => p.serviceId!),
      );

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

        // Filter: show services user owns, operates, or provisioned
        const isOwner = owner.toLowerCase() === userLower;
        const isOperator = operators.some((op) => op.toLowerCase() === userLower);
        const hasProvision = provisionServiceIds.has(serviceIds[i]);
        if (!isOwner && !isOperator && !hasProvision) continue;

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
        // Also pull vault addresses from provisions
        for (const prov of provisionsStore.get()) {
          if (prov.serviceId === serviceIds[i] && prov.vaultAddress) {
            const va = prov.vaultAddress as Address;
            if (va !== zeroAddress && !vaultAddresses.some((a) => a.toLowerCase() === va.toLowerCase())) {
              vaultAddresses.push(va);
            }
          }
        }

        // TTL
        const expiryBlock = createdAt + ttl;
        const remainingBlocks = Math.max(0, expiryBlock - currentBlock);
        const remainingSeconds = ttl > 0 ? remainingBlocks * BLOCK_TIME_SECONDS : null;

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
          remainingSeconds,
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
  }, [discover]);

  return { services, isLoading, refetch: discover };
}
