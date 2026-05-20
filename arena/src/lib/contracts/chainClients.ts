import { createPublicClient, defineChain, http } from 'viem';
import type { PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import {
  executionForkChain,
  isKnownExternalHyperEvmChainId,
  networks,
  rpcUrl,
} from '~/lib/contracts/chains';

const clientCache = new Map<number, PublicClient>();

function fallbackChain(chainId: number) {
  if (chainId === mainnet.id) return mainnet;
  if (chainId === executionForkChain.id) return executionForkChain;

  return defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Explorer', url: '' } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });
}

function fallbackRpcUrl(chainId: number) {
  if (chainId === executionForkChain.id) {
    return executionForkChain.rpcUrls.default.http[0] ?? rpcUrl;
  }
  return undefined;
}

export function getChainPublicClient(chainId: number): PublicClient {
  const cached = clientCache.get(chainId);
  if (cached) return cached;

  const network = networks[chainId];
  if ((!network || !network.rpcUrl) && isKnownExternalHyperEvmChainId(chainId)) {
    throw new Error(`HyperEVM chain ${chainId} is not configured. Set the matching VITE_HYPEREVM_*_RPC_URL before reading this vault.`);
  }
  const chain = network?.chain ?? fallbackChain(chainId);
  const transportUrl = network?.rpcUrl ?? fallbackRpcUrl(chainId);
  const client = createPublicClient({ chain, transport: http(transportUrl) });

  clientCache.set(chainId, client);
  return client;
}
