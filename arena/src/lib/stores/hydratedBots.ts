import { atom } from 'nanostores';
import type { Bot } from '~/lib/types/bot';
import { demoArenaEnabled, demoPaperBot } from '~/lib/demo/demoBots';

export type OperatorDataState = 'disabled' | 'authenticating' | 'locked' | 'ready' | 'partial';

export interface HydratedBotsState {
  bots: Bot[];
  isLoading: boolean;
  isOnChain: boolean;
  operatorDataState: OperatorDataState;
  lastSyncedAt: number | null;
}

const demoBots = demoArenaEnabled() ? [demoPaperBot] : [];

const EMPTY_STATE: HydratedBotsState = {
  bots: demoBots,
  isLoading: demoBots.length === 0,
  isOnChain: false,
  operatorDataState: 'disabled',
  lastSyncedAt: null,
};

export const hydratedBotsStore = atom<HydratedBotsState>(EMPTY_STATE);

export function setHydratedBotsState(
  update: Partial<HydratedBotsState> | ((current: HydratedBotsState) => HydratedBotsState),
) {
  hydratedBotsStore.set(
    typeof update === 'function'
      ? update(hydratedBotsStore.get())
      : { ...hydratedBotsStore.get(), ...update },
  );
}

export function resetHydratedBotsState() {
  hydratedBotsStore.set(EMPTY_STATE);
}
