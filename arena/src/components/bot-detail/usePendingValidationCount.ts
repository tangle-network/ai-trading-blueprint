import { useBotRecentValidations } from '~/lib/hooks/useBotApi';
import type { BotOperatorKind } from '~/lib/types/bot';

/**
 * Returns the count of pending validations for a bot.
 * Used by the parent page to show a badge on the Validation tab.
 */
export function usePendingValidationCount(
  botId: string,
  botName: string = '',
  enabled: boolean = true,
  chainId?: number,
  operatorApiUrl?: string | null,
  operatorKind?: BotOperatorKind,
): number {
  const { data } = useBotRecentValidations(botId, botName, {
    chainId,
    operatorApiUrl,
    operatorKind,
    enabled,
    refetchInterval: enabled ? 5_000 : false,
  });
  return (data ?? []).filter((trade) => trade.status === 'pending').length;
}
