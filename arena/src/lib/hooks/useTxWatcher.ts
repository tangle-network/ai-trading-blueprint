import { useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { txListStore, updateTx } from '@tangle-network/blueprint-ui';
import { getChainPublicClient } from '~/lib/contracts/chainClients';

/**
 * Watches all pending transactions and updates their status when confirmed or failed.
 * Uses standalone viem client — works regardless of wallet chain.
 * Mount once near the app root (e.g. in Header).
 */
export function useTxWatcher() {
  const txs = useStore(txListStore);
  const watching = useRef(new Set<string>());

  useEffect(() => {
    for (const tx of txs) {
      if (tx.status !== 'pending') continue;
      if (watching.current.has(tx.hash)) continue;
      watching.current.add(tx.hash);

      const client = getChainPublicClient(tx.chainId);
      client
        .waitForTransactionReceipt({ hash: tx.hash })
        .then((receipt: { status: string; blockNumber: bigint; gasUsed: bigint }) => {
          updateTx(tx.hash, {
            status: receipt.status === 'success' ? 'confirmed' : 'failed',
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
          });
        })
        .catch(() => {
          updateTx(tx.hash, { status: 'failed' });
        })
        .finally(() => {
          watching.current.delete(tx.hash);
        });
    }
  }, [txs]);
}
