import { useReadContract, useBlockNumber } from 'wagmi';
import { tangleServicesAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';

export interface ServiceInfo {
  blueprintId: number;
  owner: string;
  createdAt: number;
  ttl: number;
  terminatedAt: number;
  status: number;
}

const BLOCK_TIME_SECONDS = 12;

export function useServiceInfo(serviceId: number | undefined) {
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const { data: serviceData, isLoading } = useReadContract({
    address: addresses.tangle,
    abi: tangleServicesAbi,
    functionName: 'getService',
    args: serviceId != null ? [BigInt(serviceId)] : undefined,
    query: { enabled: serviceId != null },
  });

  if (!serviceData || serviceId == null) {
    return { service: null, isLoading, remainingSeconds: null };
  }

  const service: ServiceInfo = {
    blueprintId: Number(serviceData.blueprintId),
    owner: serviceData.owner,
    createdAt: Number(serviceData.createdAt),
    ttl: Number(serviceData.ttl),
    terminatedAt: Number(serviceData.terminatedAt),
    status: serviceData.status,
  };

  const currentBlock = blockNumber ? Number(blockNumber) : 0;
  const expiryBlock = service.createdAt + service.ttl;
  const remainingBlocks = Math.max(0, expiryBlock - currentBlock);
  const remainingSeconds = remainingBlocks * BLOCK_TIME_SECONDS;

  return { service, isLoading, remainingSeconds };
}
