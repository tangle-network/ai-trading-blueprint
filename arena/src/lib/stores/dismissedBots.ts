import { persistedAtom } from '@tangle/blueprint-ui';

/** Bot IDs that the user has dismissed from their dashboard view. */
export const dismissedBotsStore = persistedAtom<string[]>({
  key: 'arena_dismissed_bots',
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
