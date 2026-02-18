import { computed } from 'nanostores';
import type { Address } from 'viem';
import { persistedAtom } from './persistedAtom';

export type ProvisionPhase = 'pending_confirmation' | 'job_submitted' | 'job_processing' | 'awaiting_secrets' | 'active' | 'failed';

export interface TrackedProvision {
  /** txHash once available, used as stable ID */
  id: string;
  owner: Address;
  name: string;
  strategyType: string;
  operators: Address[];
  blueprintId: string;
  txHash?: `0x${string}`;
  serviceId?: number;
  callId?: number;
  jobIndex?: number;
  phase: ProvisionPhase;
  createdAt: number;
  updatedAt: number;
  /** Wei cost as string (avoids bigint serialization issues) */
  costWei?: string;
  chainId: number;
  /** Decoded from TradingProvisionOutput */
  vaultAddress?: string;
  sandboxId?: string;
  workflowId?: number;
  errorMessage?: string;
  /** Intermediate progress phase from operator API */
  progressPhase?: string;
  /** Human-readable progress detail */
  progressDetail?: string;
}

const MAX_PROVISIONS = 20;

export const provisionsStore = persistedAtom<TrackedProvision[]>({
  key: 'arena_provisions',
  initial: [],
});

export function addProvision(provision: TrackedProvision) {
  const existing = provisionsStore.get();
  if (existing.some((p) => p.id === provision.id)) return;
  provisionsStore.set([provision, ...existing].slice(0, MAX_PROVISIONS));
}

export function updateProvision(id: string, update: Partial<TrackedProvision>) {
  const current = provisionsStore.get();
  const target = current.find((p) => p.id === id);
  if (!target) return;

  // Skip no-op updates to avoid triggering subscriber cascades
  const dominated = Object.keys(update).every(
    (k) => (target as any)[k] === (update as any)[k],
  );
  if (dominated) return;

  provisionsStore.set(
    current.map((p) =>
      p.id === id ? { ...p, ...update, updatedAt: Date.now() } : p,
    ),
  );
}

export function removeProvision(id: string) {
  provisionsStore.set(provisionsStore.get().filter((p) => p.id !== id));
}

/** Computed store filtered to provisions owned by a specific address. Cached per address. */
const ownerComputedCache = new Map<string, ReturnType<typeof computed>>();

export function provisionsForOwner(address: Address | undefined) {
  if (!address) return computed(provisionsStore, (): TrackedProvision[] => []);
  const key = address.toLowerCase();
  let cached = ownerComputedCache.get(key);
  if (!cached) {
    cached = computed(provisionsStore, (all: TrackedProvision[]): TrackedProvision[] =>
      all.filter((p) => p.owner.toLowerCase() === key),
    );
    ownerComputedCache.set(key, cached);
  }
  return cached;
}
