import { useStore } from '@nanostores/react';
import { hydratedBotsStore } from '~/lib/stores/hydratedBots';
import { dispatchBotsRefresh } from '~/lib/events/bots';

export function useBots() {
  const state = useStore(hydratedBotsStore);

  return {
    bots: state.bots,
    isLoading: state.isLoading,
    isOnChain: state.isOnChain,
    operatorDataState: state.operatorDataState,
    refetch: dispatchBotsRefresh,
  };
}
