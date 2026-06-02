import type { Bot } from '~/lib/types/bot';

export function isPublicLeaderboardBot(bot: Bot): boolean {
  if (bot.verificationState === 'unverified') return false;
  if (bot.id.startsWith('provision:')) return false;
  if (bot.status === 'archived' || bot.status === 'unknown' || bot.status === 'needs_config') return false;
  if (bot.status === 'active') return true;
  if (bot.status === 'paused' || bot.status === 'winding_down') return true;
  if (bot.status === 'stopped') {
    return bot.secretsConfigured === true || bot.totalTrades > 0 || bot.tvl > 0;
  }
  return false;
}

export function isOperatorTradeCandidate(bot: Bot): boolean {
  return bot.verificationState === 'authoritative'
    && Boolean(bot.operatorApiUrl)
    && bot.status !== 'archived'
    && bot.status !== 'unknown'
    && (bot.totalTrades > 0 || bot.status === 'active' || bot.tradingActive === true);
}

export function isPlatformVolumeCandidate(bot: Bot): boolean {
  return isOperatorTradeCandidate(bot) && !bot.id.startsWith('provision:');
}

export function shouldFetchOperatorFallback(
  bot: Bot,
  failedAggregateUrls: ReadonlySet<string>,
  fallbackAllOperators: boolean,
): boolean {
  return fallbackAllOperators || failedAggregateUrls.has(bot.operatorApiUrl ?? '');
}

export function selectLatestTradeFallbackBots(
  bots: Bot[],
  failedAggregateUrls: ReadonlySet<string>,
  fallbackAllOperators: boolean,
  maxBots: number,
): Bot[] {
  return bots
    .filter(isOperatorTradeCandidate)
    .filter((bot) => shouldFetchOperatorFallback(bot, failedAggregateUrls, fallbackAllOperators))
    .slice(0, maxBots);
}
