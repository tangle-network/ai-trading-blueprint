import { networks } from '~/lib/contracts/chains';

export interface ExplorerLink {
  label: string;
  url: string;
}

const EVM_TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

const FALLBACK_EVM_EXPLORERS: Record<number, ExplorerLink> = {
  1: { label: 'Etherscan', url: 'https://etherscan.io' },
  10: { label: 'Optimistic Etherscan', url: 'https://optimistic.etherscan.io' },
  137: { label: 'Polygonscan', url: 'https://polygonscan.com' },
  42161: { label: 'Arbiscan', url: 'https://arbiscan.io' },
  421614: { label: 'Arbiscan Sepolia', url: 'https://sepolia.arbiscan.io' },
  8453: { label: 'BaseScan', url: 'https://basescan.org' },
  84532: { label: 'BaseScan Sepolia', url: 'https://sepolia.basescan.org' },
  11155111: { label: 'Sepolia Etherscan', url: 'https://sepolia.etherscan.io' },
};

function cleanExplorerUrl(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export function isEvmTransactionHash(value: string | undefined | null): boolean {
  return EVM_TX_HASH_PATTERN.test(value ?? '');
}

export function getExplorerTxLink(
  chainId: number | undefined | null,
  txHash: string | undefined | null,
): ExplorerLink | null {
  if (!chainId || !isEvmTransactionHash(txHash)) return null;

  const configuredExplorer = networks[chainId]?.chain.blockExplorers?.default;
  const fallbackExplorer = FALLBACK_EVM_EXPLORERS[chainId];
  const baseUrl = cleanExplorerUrl(configuredExplorer?.url) ?? cleanExplorerUrl(fallbackExplorer?.url);
  const label = configuredExplorer?.name || fallbackExplorer?.label;

  if (!baseUrl || !label) return null;

  return {
    label,
    url: `${baseUrl}/tx/${txHash}`,
  };
}
