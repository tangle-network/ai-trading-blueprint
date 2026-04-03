import { atom, computed } from 'nanostores';
import type { Address } from 'viem';
import { zeroAddress } from 'viem';
import {
  buildArenaDeploymentFingerprint,
  buildScopedStorageKey,
  migrateLegacyScopedKey,
  pruneScopedStorageKeys,
} from '~/lib/config/deploymentFingerprint';

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
  botId?: string;
  sandboxId?: string;
  workflowId?: number;
  errorMessage?: string;
  /** Intermediate progress phase from operator API */
  progressPhase?: string;
  /** Human-readable progress detail */
  progressDetail?: string;
  /** Which blueprint type was used ('trading-cloud' | 'trading-instance' | 'trading-tee-instance') */
  blueprintType?: string;
}

export type PersistedTrackedProvision = Pick<
  TrackedProvision,
  | 'id'
  | 'owner'
  | 'name'
  | 'strategyType'
  | 'operators'
  | 'blueprintId'
  | 'phase'
  | 'createdAt'
  | 'updatedAt'
  | 'chainId'
> & Partial<Pick<
  TrackedProvision,
  | 'txHash'
  | 'serviceId'
  | 'callId'
  | 'jobIndex'
  | 'costWei'
  | 'vaultAddress'
  | 'errorMessage'
  | 'blueprintType'
>>;

function isProvisionPhase(value: unknown): value is ProvisionPhase {
  return value === 'pending_confirmation'
    || value === 'job_submitted'
    || value === 'job_processing'
    || value === 'awaiting_secrets'
    || value === 'active'
    || value === 'failed';
}

function normalizeProvisionAddress(value: unknown): string | undefined {
  return typeof value === 'string' && value && value !== zeroAddress ? value : undefined;
}

export function isPersistableDraftProvision(provision: Pick<TrackedProvision, 'phase' | 'botId'>): boolean {
  if (provision.phase === 'active') return !provision.botId;
  return true;
}

export function isProvisionServiceHint(provision: Pick<TrackedProvision, 'phase' | 'botId'>): boolean {
  if (provision.phase === 'failed') return false;
  return provision.phase !== 'active' || !provision.botId;
}

export function shouldRenderProvisionFallbackBot(
  provision: Pick<TrackedProvision, 'phase' | 'botId'>,
): boolean {
  if (provision.phase === 'failed') return false;
  if (provision.phase === 'active') return false;
  return !provision.botId;
}

export function serializeProvisionForPersistence(
  provision: TrackedProvision,
): PersistedTrackedProvision | null {
  if (!isPersistableDraftProvision(provision)) return null;

  const persisted: PersistedTrackedProvision = {
    id: provision.id,
    owner: provision.owner,
    name: provision.name,
    strategyType: provision.strategyType,
    operators: provision.operators,
    blueprintId: provision.blueprintId,
    phase: provision.phase,
    createdAt: provision.createdAt,
    updatedAt: provision.updatedAt,
    chainId: provision.chainId,
  };

  if (provision.txHash) persisted.txHash = provision.txHash;
  if (provision.serviceId != null) persisted.serviceId = provision.serviceId;
  if (provision.callId != null) persisted.callId = provision.callId;
  if (provision.jobIndex != null) persisted.jobIndex = provision.jobIndex;
  if (provision.costWei) persisted.costWei = provision.costWei;
  if (provision.errorMessage) persisted.errorMessage = provision.errorMessage;
  if (provision.blueprintType) persisted.blueprintType = provision.blueprintType;

  const vaultAddress = normalizeProvisionAddress(provision.vaultAddress);
  if (vaultAddress) persisted.vaultAddress = vaultAddress;

  return persisted;
}

export function sanitizePersistedProvision(record: unknown): TrackedProvision | null {
  if (!record || typeof record !== 'object') return null;

  const raw = record as Partial<TrackedProvision>;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.owner !== 'string' || raw.owner.length === 0) return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
  if (typeof raw.strategyType !== 'string' || raw.strategyType.length === 0) return null;
  if (!Array.isArray(raw.operators) || raw.operators.some((value) => typeof value !== 'string')) return null;
  if (typeof raw.blueprintId !== 'string' || raw.blueprintId.length === 0) return null;
  if (!isProvisionPhase(raw.phase)) return null;
  if (raw.phase === 'active' && typeof raw.botId === 'string' && raw.botId.length > 0) return null;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;
  if (typeof raw.chainId !== 'number' || !Number.isFinite(raw.chainId)) return null;

  const sanitized: TrackedProvision = {
    id: raw.id,
    owner: raw.owner,
    name: raw.name,
    strategyType: raw.strategyType,
    operators: raw.operators as Address[],
    blueprintId: raw.blueprintId,
    phase: raw.phase,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    chainId: raw.chainId,
  };

  if (typeof raw.txHash === 'string' && raw.txHash.startsWith('0x')) sanitized.txHash = raw.txHash;
  if (typeof raw.serviceId === 'number' && Number.isFinite(raw.serviceId)) sanitized.serviceId = raw.serviceId;
  if (typeof raw.callId === 'number' && Number.isFinite(raw.callId)) sanitized.callId = raw.callId;
  if (typeof raw.jobIndex === 'number' && Number.isFinite(raw.jobIndex)) sanitized.jobIndex = raw.jobIndex;
  if (typeof raw.costWei === 'string' && raw.costWei.length > 0) sanitized.costWei = raw.costWei;
  if (typeof raw.errorMessage === 'string' && raw.errorMessage.length > 0) sanitized.errorMessage = raw.errorMessage;
  if (typeof raw.blueprintType === 'string' && raw.blueprintType.length > 0) sanitized.blueprintType = raw.blueprintType;

  const vaultAddress = normalizeProvisionAddress(raw.vaultAddress);
  if (vaultAddress) sanitized.vaultAddress = vaultAddress;

  return serializeProvisionForPersistence(sanitized);
}

export function sanitizePersistedProvisionList(records: unknown): TrackedProvision[] {
  if (!Array.isArray(records)) return [];
  return records
    .map((record) => sanitizePersistedProvision(record))
    .filter((record): record is TrackedProvision => record !== null)
    .slice(0, MAX_PROVISIONS);
}

export function getProvisionStructuralFingerprint(provisions: TrackedProvision[]): string {
  return provisions
    .map((p) => [
      p.id,
      p.phase,
      p.serviceId ?? '',
      p.vaultAddress ?? '',
      p.callId ?? '',
    ].join('|'))
    .join(';');
}

const MAX_PROVISIONS = 20;
const PROVISIONS_STORE_KEY_PREFIX = 'arena_provisions';
const provisionsDeploymentFingerprint = buildArenaDeploymentFingerprint();
const provisionsStoreKey = buildScopedStorageKey(PROVISIONS_STORE_KEY_PREFIX, provisionsDeploymentFingerprint);

if (typeof window !== 'undefined' && window.localStorage) {
  migrateLegacyScopedKey(window.localStorage, PROVISIONS_STORE_KEY_PREFIX, provisionsStoreKey);
  pruneScopedStorageKeys(window.localStorage, PROVISIONS_STORE_KEY_PREFIX, provisionsStoreKey);
}

export const provisionsStore = atom<TrackedProvision[]>([]);

function persistProvisionDrafts(provisions: readonly TrackedProvision[]) {
  if (typeof window === 'undefined' || !window.localStorage) return;

  const sanitized = provisions
    .map((provision) => serializeProvisionForPersistence(provision))
    .filter((provision): provision is PersistedTrackedProvision => provision !== null)
    .slice(0, MAX_PROVISIONS);

  try {
    if (sanitized.length === 0) {
      window.localStorage.removeItem(provisionsStoreKey);
      return;
    }

    const serialized = JSON.stringify(sanitized);
    if (window.localStorage.getItem(provisionsStoreKey) !== serialized) {
      window.localStorage.setItem(provisionsStoreKey, serialized);
    }
  } catch {
    // Best-effort persistence only.
  }
}

if (typeof window !== 'undefined' && window.localStorage) {
  try {
    const raw = window.localStorage.getItem(provisionsStoreKey);
    if (raw) {
      provisionsStore.set(sanitizePersistedProvisionList(JSON.parse(raw)));
    }
  } catch {
    window.localStorage.removeItem(provisionsStoreKey);
  }

  persistProvisionDrafts(provisionsStore.get());
  provisionsStore.listen((provisions) => {
    persistProvisionDrafts(provisions);
  });
}

function setProvisions(next: TrackedProvision[]) {
  provisionsStore.set(next);
}

export function addProvision(provision: TrackedProvision) {
  const existing = provisionsStore.get();
  if (existing.some((p: TrackedProvision) => p.id === provision.id)) return;
  setProvisions([provision, ...existing].slice(0, MAX_PROVISIONS));
}

export function upsertInstanceProvision(provision: TrackedProvision) {
  const current = provisionsStore.get();
  const owner = provision.owner.toLowerCase();
  const existing = current.find(
    (p: TrackedProvision) => p.owner.toLowerCase() === owner && p.id === provision.id,
  );

  const next = current.filter(
    (p: TrackedProvision) =>
      p.owner.toLowerCase() !== owner || !p.id.startsWith('instance-') || p.id === provision.id,
  );

  const normalized: TrackedProvision = {
    ...existing,
    ...provision,
    createdAt: existing?.createdAt ?? provision.createdAt,
    updatedAt: Date.now(),
  };

  setProvisions(
    [normalized, ...next.filter((p: TrackedProvision) => p.id !== provision.id)].slice(0, MAX_PROVISIONS),
  );
}

export function updateProvision(id: string, update: Partial<TrackedProvision>) {
  const current = provisionsStore.get();
  const target = current.find((p: TrackedProvision) => p.id === id);
  if (!target) return;

  // Skip no-op updates to avoid triggering subscriber cascades
  const dominated = Object.keys(update).every(
    (k) => (target as any)[k] === (update as any)[k],
  );
  if (dominated) return;

  setProvisions(
    current.map((p: TrackedProvision) =>
      p.id === id ? { ...p, ...update, updatedAt: Date.now() } : p,
    ),
  );
}

export function removeProvision(id: string) {
  setProvisions(provisionsStore.get().filter((p: TrackedProvision) => p.id !== id));
}

export function removeInstanceProvisions(owner: Address | undefined) {
  if (!owner) return;
  const key = owner.toLowerCase();
  setProvisions(
    provisionsStore.get().filter(
      (p: TrackedProvision) => p.owner.toLowerCase() !== key || !p.id.startsWith('instance-'),
    ),
  );
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
