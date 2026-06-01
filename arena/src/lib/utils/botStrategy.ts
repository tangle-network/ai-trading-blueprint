import type { Bot } from '~/lib/types/bot';

export function readStrategyNumber(value: unknown): number | null {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : null;
  return numberValue != null && Number.isFinite(numberValue) ? numberValue : null;
}

export function getBotStrategyChainId(bot: Pick<Bot, 'chainId' | 'strategyConfig'>): number | undefined {
  return readStrategyNumber(bot.strategyConfig?.protocol_chain_id ?? bot.strategyConfig?.chain_id)
    ?? bot.chainId;
}
