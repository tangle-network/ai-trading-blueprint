import { Link } from 'react-router';
import type { Address } from 'viem';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import type { Bot } from '~/lib/types/bot';
import type { AgentActivityStats } from '~/lib/agentActivity';
import { botStatusLabel, formatCompactUsd, formatNumber, formatSignedPercent, STRATEGY_SHORT } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';
import {
  fillCountEvidenceTitle,
  resolveFillCountEvidence,
} from '~/lib/tradeEvidence';

interface ArenaTopAgentsPanelProps {
  bots: Bot[];
  className?: string;
  limit?: number;
  variant?: 'table' | 'rail';
  metricMode?: 'performance' | 'activity';
  activityStatsByBotId?: Map<string, AgentActivityStats>;
}

function valueTone(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return 'text-[#697371]';
  return value > 0 ? 'text-[#50d2c1]' : 'text-[#ff5d6c]';
}

function formatFlowUsd(value: number): string {
  return value > 0 ? formatCompactUsd(value) : '$0';
}

function sortByActivity(
  bots: Bot[],
  activityStatsByBotId?: Map<string, AgentActivityStats>,
): Bot[] {
  const ranked = rankLeaderboardBots(bots);
  if (!activityStatsByBotId) return ranked;
  const hasRecentActivity = ranked.some((bot) => (activityStatsByBotId.get(bot.id)?.recentFills ?? 0) > 0);
  if (!hasRecentActivity) return ranked;

  return [...ranked].sort((left, right) => {
    const leftStats = activityStatsByBotId.get(left.id);
    const rightStats = activityStatsByBotId.get(right.id);
    const notionalDelta = (rightStats?.recentNotionalUsd ?? 0) - (leftStats?.recentNotionalUsd ?? 0);
    if (notionalDelta !== 0) return notionalDelta;
    const fillsDelta = (rightStats?.recentFills ?? 0) - (leftStats?.recentFills ?? 0);
    if (fillsDelta !== 0) return fillsDelta;
    return (rightStats?.lastTradeAt ?? 0) - (leftStats?.lastTradeAt ?? 0);
  });
}

export function ArenaTopAgentsPanel({
  bots,
  className = '',
  limit = 8,
  variant = 'table',
  metricMode = 'performance',
  activityStatsByBotId,
}: ArenaTopAgentsPanelProps) {
  const isRail = variant === 'rail';
  const showActivity = metricMode === 'activity' && !isRail;
  const topAgents = (showActivity ? sortByActivity(bots, activityStatsByBotId) : rankLeaderboardBots(bots)).slice(0, limit);

  return (
    <section
      data-testid="top-agents-panel"
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-[6px] border border-[#273035] bg-[#0f1a1f] ${className}`}
      aria-label="Top agents"
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b border-[#273035] bg-[#0b1418] px-3">
        <h2 className="font-display text-base font-semibold tracking-tight text-[#f6fefd]">
          {isRail ? 'Agents' : 'Top agents'}
        </h2>
        <Link
          to="/leaderboard"
          className="inline-flex h-7 items-center rounded-[4px] border border-[#273035] bg-[#0f1a1f] px-2 font-display text-xs font-semibold text-[#d2dad7] transition-colors hover:bg-[#16242a] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
        >
          All
        </Link>
      </div>

      {!isRail && (
        <div className="grid grid-cols-[2.25rem_minmax(15rem,1fr)_5.5rem_4.25rem_5.25rem] border-b border-[#273035] bg-[#0b1418] px-3 py-2 font-data text-[10px] uppercase text-[#697371]">
          <span>#</span>
          <span>Agent</span>
          <span className="text-right">{showActivity ? '24H Vol' : '30D'}</span>
          <span className="text-right">{showActivity ? '24H' : 'Sharpe'}</span>
          <span className="text-right">{showActivity ? 'Total' : 'Fills'}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
        {topAgents.length === 0 ? (
          <div className="flex h-full min-h-[12rem] items-center justify-center px-6 text-center font-display text-sm text-[#949e9c]">
            No public agents yet.
          </div>
        ) : (
          <div className="divide-y divide-[#273035]">
            {topAgents.map((bot, index) => {
              const href = `/arena/bot/${encodeURIComponent(bot.id)}/performance`;
              const hasRailReturn = Number.isFinite(bot.pnlPercent) && bot.pnlPercent !== 0;
              const hasRailTrades = bot.totalTrades > 0;
              const activityStats = activityStatsByBotId?.get(bot.id);
              const totalFillEvidence = resolveFillCountEvidence({
                visibleTradeCount: activityStats?.totalVisibleFills,
                rosterTradeCount: bot.totalTrades,
              });
              return isRail ? (
                <Link
                  key={bot.id}
                  to={href}
                  className="group flex min-w-0 items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-[#16242a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                  aria-label={`Open ${bot.name} performance`}
                >
                  <span className="w-5 shrink-0 text-right font-data text-xs font-semibold text-[#697371]">
                    {formatNumber(index + 1, { maximumFractionDigits: 0 })}
                  </span>
                  <Identicon address={bot.operatorAddress as Address} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-sm font-semibold leading-tight text-[#f6fefd] group-hover:text-[#50d2c1]">
                      {bot.name}
                    </span>
                    <span className="mt-1 flex min-w-0 items-center gap-1.5 font-data text-[11px] text-[#949e9c]">
                      <span className="truncate">{STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}</span>
                      <span className="h-1 w-1 shrink-0 rounded-full bg-[#697371]" aria-hidden="true" />
                      <span className={bot.status === 'active' ? 'truncate text-[#50d2c1]' : 'truncate'}>
                        {botStatusLabel(bot.status)}
                      </span>
                    </span>
                  </span>
                  {hasRailReturn || hasRailTrades ? (
                    <span className="shrink-0 text-right">
                      {hasRailReturn && (
                        <span className={`block font-data text-sm font-bold leading-tight ${valueTone(bot.pnlPercent)}`}>
                          {formatSignedPercent(bot.pnlPercent)}
                        </span>
                      )}
                      {hasRailTrades && (
                        <span className="mt-1 inline-flex items-center justify-end gap-1 font-data text-[11px] text-[#697371]">
                          <span className="i-ph:swap text-[10px]" aria-hidden="true" />
                          {formatNumber(bot.totalTrades, { maximumFractionDigits: 0 })}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="i-ph:arrow-up-right shrink-0 text-sm text-[#697371] group-hover:text-[#50d2c1]" aria-hidden="true" />
                  )}
                </Link>
              ) : (
                <Link
                  key={bot.id}
                  to={href}
                  className="group grid grid-cols-[2.25rem_minmax(15rem,1fr)_5.5rem_4.25rem_5.25rem] items-center px-3 py-2.5 transition-colors hover:bg-[#16242a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                  aria-label={`Open ${bot.name} performance`}
                >
                  <span className="font-data text-sm font-semibold text-[#697371]">
                    {formatNumber(index + 1, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="flex min-w-0 items-center gap-3">
                    <Identicon address={bot.operatorAddress as Address} size={32} />
                    <span className="min-w-0">
                      <span className="block truncate font-display text-base font-semibold leading-tight text-[#f6fefd] group-hover:text-[#50d2c1]">
                        {bot.name}
                      </span>
                      <span className="mt-1 flex min-w-0 items-center gap-2 font-data text-xs text-[#949e9c]">
                        <span className="truncate">{STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}</span>
                        <span className="h-1 w-1 shrink-0 rounded-full bg-[#697371]" aria-hidden="true" />
                        <span className={bot.status === 'active' ? 'truncate text-[#50d2c1]' : 'truncate'}>
                          {botStatusLabel(bot.status)}
                        </span>
                        {bot.tvl > 0 && (
                          <>
                            <span className="h-1 w-1 shrink-0 rounded-full bg-[#697371]" aria-hidden="true" />
                            <span className="truncate">{formatCompactUsd(bot.tvl)}</span>
                          </>
                        )}
                      </span>
                    </span>
                  </span>
                  {showActivity ? (
                    <>
                      <span className="text-right font-data text-base font-bold text-[#f6fefd]">
                        {formatFlowUsd(activityStatsByBotId?.get(bot.id)?.recentNotionalUsd ?? 0)}
                      </span>
                      <span className="text-right font-data text-base text-[#f6fefd]">
                        {formatNumber(activityStats?.recentFills ?? 0, { maximumFractionDigits: 0 })}
                      </span>
                      <span
                        className="text-right font-data text-base text-[#d2dad7]"
                        title={fillCountEvidenceTitle(totalFillEvidence)}
                      >
                        {totalFillEvidence.value > 0
                          ? formatNumber(totalFillEvidence.value, { maximumFractionDigits: 0 })
                          : '—'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={`text-right font-data text-base font-bold ${valueTone(bot.pnlPercent)}`}>
                        {formatSignedPercent(bot.pnlPercent)}
                      </span>
                      <span className="text-right font-data text-base text-[#f6fefd]">
                        {bot.sharpeRatio !== 0 ? formatNumber(bot.sharpeRatio, { maximumFractionDigits: 1 }) : '—'}
                      </span>
                      <span className="text-right font-data text-base text-[#f6fefd]">
                        {bot.totalTrades > 0 ? formatNumber(bot.totalTrades, { maximumFractionDigits: 0 }) : '—'}
                      </span>
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
