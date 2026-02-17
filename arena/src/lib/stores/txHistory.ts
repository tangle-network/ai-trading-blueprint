import { computed } from 'nanostores';
import { persistedAtom, serializeWithBigInt, deserializeWithBigInt } from './persistedAtom';

export interface TrackedTx {
  hash: `0x${string}`;
  label: string;
  status: 'pending' | 'confirmed' | 'failed';
  timestamp: number;
  chainId: number;
  blockNumber?: bigint;
  gasUsed?: bigint;
}

const MAX_TXS = 50;

export const txListStore = persistedAtom<TrackedTx[]>({
  key: 'arena_tx_history',
  initial: [],
  serialize: serializeWithBigInt,
  deserialize: deserializeWithBigInt,
});

export const pendingCount = computed(txListStore, (txs) =>
  txs.filter((tx) => tx.status === 'pending').length,
);

export function addTx(hash: `0x${string}`, label: string, chainId: number) {
  const existing = txListStore.get();
  if (existing.some((tx) => tx.hash === hash)) return;
  const newTx: TrackedTx = { hash, label, status: 'pending', timestamp: Date.now(), chainId };
  txListStore.set([newTx, ...existing].slice(0, MAX_TXS));
}

export function updateTx(
  hash: `0x${string}`,
  update: Partial<Pick<TrackedTx, 'status' | 'blockNumber' | 'gasUsed'>>,
) {
  txListStore.set(
    txListStore.get().map((tx) =>
      tx.hash === hash ? { ...tx, ...update } : tx,
    ),
  );
}

export function clearTxs() {
  txListStore.set([]);
}
