import { createPublicClient, http } from 'viem';
import type { PublicClient } from 'viem';
import { atom } from 'nanostores';
import { networks, tangleLocal } from './chains';
import { persistedAtom } from '~/lib/stores/persistedAtom';

// ── Selected chain store (persisted) ──────────────────────────────────

const defaultChainId = Number(import.meta.env.VITE_CHAIN_ID ?? tangleLocal.id);

export const selectedChainIdStore = persistedAtom<number>({
  key: 'arena_selected_chain',
  initial: defaultChainId,
});

// ── Reactive public client ────────────────────────────────────────────

const clientCache = new Map<number, PublicClient>();

function getOrCreateClient(chainId: number): PublicClient {
  const cached = clientCache.get(chainId);
  if (cached) return cached;

  const net = networks[chainId];
  if (!net) {
    // Fallback to default
    const fallback = networks[defaultChainId]!;
    const client = createPublicClient({ chain: fallback.chain, transport: http(fallback.rpcUrl) });
    return client;
  }

  const client = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl) });
  clientCache.set(chainId, client);
  return client;
}

/** Reactive atom — updates when selectedChainIdStore changes */
export const publicClientStore = atom<PublicClient>(getOrCreateClient(selectedChainIdStore.get()));

selectedChainIdStore.subscribe((chainId) => {
  publicClientStore.set(getOrCreateClient(chainId));
});

/**
 * Current public client singleton. For use in non-reactive contexts (module scope, callbacks).
 * In React components/hooks, prefer `useStore(publicClientStore)` for reactivity.
 */
export function getPublicClient(): PublicClient {
  return publicClientStore.get();
}

/** Shorthand — current public client. Hooks call methods through this proxy. */
export const publicClient = new Proxy({} as PublicClient, {
  get(_target, prop) {
    const client = getOrCreateClient(selectedChainIdStore.get());
    const value = (client as any)[prop];
    // Bind functions so `this` context is correct
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

// ── Reactive addresses ────────────────────────────────────────────────

export function getAddresses() {
  const net = networks[selectedChainIdStore.get()];
  return net?.addresses ?? networks[defaultChainId]!.addresses;
}
