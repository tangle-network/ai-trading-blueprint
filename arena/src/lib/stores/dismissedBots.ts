import { persistedAtom } from '@tangle-network/blueprint-ui';
import {
  buildArenaDeploymentFingerprint,
  buildScopedStorageKey,
  migrateLegacyScopedKey,
  pruneScopedStorageKeys,
} from '~/lib/config/deploymentFingerprint';

/** Bot IDs that the user has dismissed from their dashboard view. */
const DISMISSED_BOTS_STORE_KEY_PREFIX = 'arena_dismissed_bots';
const dismissedBotsDeploymentFingerprint = buildArenaDeploymentFingerprint();
const dismissedBotsStoreKey = buildScopedStorageKey(
  DISMISSED_BOTS_STORE_KEY_PREFIX,
  dismissedBotsDeploymentFingerprint,
);

if (typeof window !== 'undefined' && window.localStorage) {
  migrateLegacyScopedKey(window.localStorage, DISMISSED_BOTS_STORE_KEY_PREFIX, dismissedBotsStoreKey);
  pruneScopedStorageKeys(window.localStorage, DISMISSED_BOTS_STORE_KEY_PREFIX, dismissedBotsStoreKey);
}

export const dismissedBotsStore = persistedAtom<string[]>({
  key: dismissedBotsStoreKey,
  initial: [],
});

const MAX_DISMISSED = 100;

export function dismissBot(botId: string) {
  const current = dismissedBotsStore.get();
  if (!current.includes(botId)) {
    // Cap at MAX_DISMISSED — drop oldest entries first
    const next = [...current, botId];
    dismissedBotsStore.set(next.length > MAX_DISMISSED ? next.slice(-MAX_DISMISSED) : next);
  }
}

export function undismissBot(botId: string) {
  dismissedBotsStore.set(
    dismissedBotsStore.get().filter((id: string) => id !== botId),
  );
}
