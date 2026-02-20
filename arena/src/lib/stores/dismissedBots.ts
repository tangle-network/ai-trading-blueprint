import { persistedAtom } from '@tangle/blueprint-ui';

/** Bot IDs that the user has dismissed from their dashboard view. */
export const dismissedBotsStore = persistedAtom<string[]>({
  key: 'arena_dismissed_bots',
  initial: [],
});

export function dismissBot(botId: string) {
  const current = dismissedBotsStore.get();
  if (!current.includes(botId)) {
    dismissedBotsStore.set([...current, botId]);
  }
}

export function undismissBot(botId: string) {
  dismissedBotsStore.set(
    dismissedBotsStore.get().filter((id: string) => id !== botId),
  );
}
