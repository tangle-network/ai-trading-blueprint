import { useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { usePublicClient } from 'wagmi';
import { txListStore, updateTx } from '~/lib/stores/txHistory';

/**
 * Watches all pending transactions and updates their status when confirmed or failed.
 * Mount once near the app root (e.g. in Header).
 */
export function useTxWatcher() {
  const client = usePublicClient();
  const txs = useStore(txListStore);
  const watching = useRef(new Set<string>());

  useEffect(() => {
    if (!client) return;

    for (const tx of txs) {
      if (tx.status !== 'pending') continue;
      if (watching.current.has(tx.hash)) continue;
      watching.current.add(tx.hash);

      client
        .waitForTransactionReceipt({ hash: tx.hash })
        .then((receipt) => {
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
  }, [txs, client]);
}
