import type { Bot } from './types/bot';

function isActive(bot: Bot): boolean {
  return bot.status === 'active';
}

export function compareLeaderboardBots(a: Bot, b: Bot): number {
  if (b.pnlPercent !== a.pnlPercent) return b.pnlPercent - a.pnlPercent;
  if (b.sharpeRatio !== a.sharpeRatio) return b.sharpeRatio - a.sharpeRatio;
  if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
  if (b.totalTrades !== a.totalTrades) return b.totalTrades - a.totalTrades;
  if (b.tvl !== a.tvl) return b.tvl - a.tvl;
  return a.name.localeCompare(b.name);
}

export function rankLeaderboardBots(bots: Bot[]): Bot[] {
  return [...bots].sort(compareLeaderboardBots);
}
