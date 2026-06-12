import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  discoverOperatorsWithClient,
  getAddresses,
  publicClient,
  resolveOperatorRpc,
  type DiscoveredOperator,
} from '@tangle-network/blueprint-ui';
import { ALL_BLUEPRINT_IDS } from '~/lib/blueprints';
import { ALL_TRADING_OPERATOR_API_URLS } from './meta';

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Dynamic operator discovery for the arena.
 *
 * Operator API base URLs are discovered from on-chain blueprint registrations
 * (OperatorRegistered events + registration/preference reads, via the shared
 * blueprint-ui discovery path) and merged with the env-configured seed URLs.
 * Env URLs are a guaranteed fallback: discovery failing or returning nothing
 * can never remove an endpoint the deployment was configured with.
 */

export const DISCOVERY_TTL_MS = 5 * 60_000;
const DISCOVERY_CACHE_KEY = 'arena.operator-discovery.v1';

export interface ChainOperatorEntry {
  address: string;
  rpcAddress: string;
  /** Browser-resolved API base URL ('' when the operator registered no RPC). */
  apiUrl: string;
  blueprintIds: number[];
}

export type OperatorEndpointSource = 'env' | 'chain';

export interface OperatorEndpoint {
  apiUrl: string;
  sources: OperatorEndpointSource[];
  address?: string;
  rpcAddress?: string;
  blueprintIds: number[];
  /** False when the page cannot fetch this endpoint (e.g. http API on an https page). */
  browserReachable: boolean;
  unreachableReason?: 'mixed-content';
}

export interface OperatorDirectory {
  endpoints: OperatorEndpoint[];
  /** Browser-reachable operator API base URLs: env seed merged with discovery, env-first. */
  apiUrls: string[];
}

export function getPageProtocol(): string {
  return typeof window !== 'undefined' ? window.location.protocol : 'https:';
}

/**
 * An https page cannot fetch an http endpoint (mixed content is blocked by the
 * browser before the request leaves). Relative URLs inherit the page origin
 * and are always reachable.
 */
export function isMixedContentBlocked(apiUrl: string, pageProtocol: string = getPageProtocol()): boolean {
  if (pageProtocol !== 'https:') return false;
  const trimmed = apiUrl.trim();
  if (!trimmed || !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  try {
    return new URL(trimmed).protocol === 'http:';
  } catch {
    return false;
  }
}

export function buildOperatorDirectory({
  chainOperators,
  envUrls = ALL_TRADING_OPERATOR_API_URLS,
  pageProtocol = getPageProtocol(),
}: {
  chainOperators: ChainOperatorEntry[];
  envUrls?: string[];
  pageProtocol?: string;
}): OperatorDirectory {
  const byUrl = new Map<string, OperatorEndpoint>();

  // Guarded: test suites partially mock the meta module.
  for (const envUrl of envUrls ?? []) {
    const apiUrl = normalizeUrl(envUrl);
    if (!apiUrl || byUrl.has(apiUrl)) continue;
    const blocked = isMixedContentBlocked(apiUrl, pageProtocol);
    byUrl.set(apiUrl, {
      apiUrl,
      sources: ['env'],
      blueprintIds: [],
      browserReachable: !blocked,
      ...(blocked ? { unreachableReason: 'mixed-content' as const } : {}),
    });
  }

  for (const entry of chainOperators) {
    const apiUrl = normalizeUrl(entry.apiUrl);
    if (!apiUrl) continue;
    const existing = byUrl.get(apiUrl);
    if (existing) {
      if (!existing.sources.includes('chain')) existing.sources.push('chain');
      existing.address = existing.address ?? entry.address;
      existing.rpcAddress = existing.rpcAddress ?? entry.rpcAddress;
      existing.blueprintIds = [...new Set([...existing.blueprintIds, ...entry.blueprintIds])];
      continue;
    }
    const blocked = isMixedContentBlocked(apiUrl, pageProtocol);
    byUrl.set(apiUrl, {
      apiUrl,
      sources: ['chain'],
      address: entry.address,
      rpcAddress: entry.rpcAddress,
      blueprintIds: [...entry.blueprintIds],
      browserReachable: !blocked,
      ...(blocked ? { unreachableReason: 'mixed-content' as const } : {}),
    });
  }

  const endpoints = Array.from(byUrl.values());
  return {
    endpoints,
    apiUrls: endpoints.filter((endpoint) => endpoint.browserReachable).map((endpoint) => endpoint.apiUrl),
  };
}

interface DiscoveryCacheRecord {
  key: string;
  ts: number;
  entries: ChainOperatorEntry[];
}

type DiscoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): DiscoveryStorage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function readCache(storage: DiscoveryStorage | null, key: string, now: number): ChainOperatorEntry[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DISCOVERY_CACHE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as DiscoveryCacheRecord;
    if (record.key !== key || !Array.isArray(record.entries)) return null;
    if (now - record.ts > DISCOVERY_TTL_MS) return null;
    return record.entries;
  } catch {
    return null;
  }
}

function writeCache(storage: DiscoveryStorage | null, key: string, now: number, entries: ChainOperatorEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(DISCOVERY_CACHE_KEY, JSON.stringify({ key, ts: now, entries } satisfies DiscoveryCacheRecord));
  } catch {
    // Quota/serialization failures only cost us the cross-navigation cache.
  }
}

export interface ChainDiscoveryDeps {
  blueprintIds?: bigint[];
  discover?: (blueprintId: bigint) => Promise<{ operators: DiscoveredOperator[] }>;
  resolveRpc?: (raw: string) => string;
  now?: () => number;
  storage?: DiscoveryStorage | null;
}

function defaultDiscover(blueprintId: bigint): Promise<{ operators: DiscoveredOperator[] }> {
  return discoverOperatorsWithClient(publicClient, getAddresses().services, blueprintId);
}

function cacheKeyFor(blueprintIds: bigint[]): string {
  let services = 'unknown';
  try {
    services = getAddresses().services;
  } catch {
    // Keep a stable key when chain config is unavailable (tests, SSR).
  }
  return `${services}:${blueprintIds.map(String).join(',')}`;
}

/**
 * Walk on-chain operator registrations for the trading blueprints and resolve
 * each operator's advertised RPC endpoint into an API base URL.
 *
 * Per-blueprint failures are tolerated (a dead RPC or unregistered blueprint
 * must not take down discovery for the others); a fully failed walk resolves
 * to [] so callers fall back to the env seed. Results are cached in
 * sessionStorage for DISCOVERY_TTL_MS so navigation does not re-walk the chain.
 */
export async function fetchChainOperators(deps: ChainDiscoveryDeps = {}): Promise<ChainOperatorEntry[]> {
  const blueprintIds = deps.blueprintIds ?? ALL_BLUEPRINT_IDS ?? [];
  const discover = deps.discover ?? defaultDiscover;
  const resolveRpc = deps.resolveRpc ?? resolveOperatorRpc;
  const now = deps.now ?? Date.now;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const key = cacheKeyFor(blueprintIds);

  const cached = readCache(storage, key, now());
  if (cached) return cached;

  const settled = await Promise.allSettled(blueprintIds.map((id) => discover(id)));

  const byAddress = new Map<string, ChainOperatorEntry>();
  settled.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    const blueprintId = Number(blueprintIds[index]);
    for (const operator of result.value.operators) {
      const addressKey = operator.address.toLowerCase();
      const existing = byAddress.get(addressKey);
      if (existing) {
        if (!existing.blueprintIds.includes(blueprintId)) existing.blueprintIds.push(blueprintId);
        if (!existing.rpcAddress && operator.rpcAddress) {
          existing.rpcAddress = operator.rpcAddress;
          existing.apiUrl = normalizeUrl(resolveRpc(operator.rpcAddress));
        }
        continue;
      }
      byAddress.set(addressKey, {
        address: operator.address,
        rpcAddress: operator.rpcAddress,
        apiUrl: operator.rpcAddress ? normalizeUrl(resolveRpc(operator.rpcAddress)) : '',
        blueprintIds: [blueprintId],
      });
    }
  });

  const entries = Array.from(byAddress.values());
  const anySucceeded = settled.some((result) => result.status === 'fulfilled');
  if (anySucceeded) {
    writeCache(storage, key, now(), entries);
  }
  return entries;
}

const operatorFailures = new Map<string, { at: number; message: string }>();

/** Remember a failed operator fetch so surfaces can flag flaky endpoints without re-probing. */
export function recordOperatorFailure(apiUrl: string, error: unknown): void {
  const normalized = normalizeUrl(apiUrl);
  if (!normalized) return;
  operatorFailures.set(normalized, {
    at: Date.now(),
    message: error instanceof Error ? error.message : String(error),
  });
}

export function clearOperatorFailure(apiUrl: string): void {
  operatorFailures.delete(normalizeUrl(apiUrl));
}

export function getOperatorFailure(apiUrl: string): { at: number; message: string } | undefined {
  return operatorFailures.get(normalizeUrl(apiUrl));
}

export const OPERATOR_DISCOVERY_QUERY_KEY = ['operator-chain-discovery'] as const;

export interface UseOperatorDirectoryResult extends OperatorDirectory {
  isDiscovering: boolean;
  discoveryError: Error | null;
}

/**
 * Operator API directory: on-chain discovery merged over the env seed.
 * While discovery is loading (or when it fails) the directory is exactly the
 * env-configured list, so existing deployments never regress.
 */
export function useOperatorDirectory(): UseOperatorDirectoryResult {
  const query = useQuery({
    queryKey: OPERATOR_DISCOVERY_QUERY_KEY,
    queryFn: () => fetchChainOperators(),
    staleTime: DISCOVERY_TTL_MS,
    gcTime: DISCOVERY_TTL_MS * 2,
    retry: 1,
  });

  const chainOperators = query.data;
  const isDiscovering = query.isLoading;
  const discoveryError = query.error instanceof Error ? query.error : null;

  return useMemo(() => ({
    ...buildOperatorDirectory({ chainOperators: chainOperators ?? [] }),
    isDiscovering,
    discoveryError,
  }), [chainOperators, isDiscovering, discoveryError]);
}
