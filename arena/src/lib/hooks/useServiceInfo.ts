import { useReadContract, useBlockNumber } from 'wagmi';
import { tangleServicesAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { computeServiceRemainingSeconds } from '~/lib/serviceTtl';

export interface ServiceInfo {
  blueprintId: number;
  owner: string;
  createdAt: number;
  ttl: number;
  terminatedAt: number;
  status: number;
}

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

  void blockNumber;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const remainingSeconds = computeServiceRemainingSeconds(service.createdAt, service.ttl, nowSeconds);

  return { service, isLoading, remainingSeconds };
}
