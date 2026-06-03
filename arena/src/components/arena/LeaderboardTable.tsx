import { Link, useNavigate } from 'react-router';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Identicon, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import type { AgentActivityStats } from '~/lib/agentActivity';
import { botStatusLabel, formatCompactUsd, formatNumber, STRATEGY_SHORT, truncateAddress } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';
import { formatTradeAge } from '~/lib/tradeDisplay';
import {
  fillCountEvidenceTitle,
  resolveFillCountEvidence,
} from '~/lib/tradeEvidence';

interface LeaderboardTableProps {
  bots: Bot[];
  selectedBotId?: string;
  onSelectBot?: (bot: Bot) => void;
  activityStatsByBotId?: Map<string, AgentActivityStats>;
}

function RankCell({ rank }: { rank: number }) {
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[#273035] bg-[#0b1418] font-data text-sm font-semibold text-[#949e9c]">
      {formatNumber(rank, { maximumFractionDigits: 0 })}
    </span>
  );
}

function formatFlowUsd(value: number): string {
  return value > 0 ? formatCompactUsd(value) : '$0';
}

function modeLabel(bot: Bot): string {
  if (bot.paperTrade === true) return 'Paper';
  if (bot.paperTrade === false) return 'Live';
  return botStatusLabel(bot.status);
}

export function LeaderboardTable({
  bots,
  selectedBotId,
  onSelectBot,
  activityStatsByBotId,
}: LeaderboardTableProps) {
  const navigate = useNavigate();
  const sorted = rankLeaderboardBots(bots);

  return (
    <Table className="w-full min-w-[760px] table-fixed bg-[#0f1a1f]">
      <TableHeader>
        <TableRow className="border-b border-[#273035] bg-[#0b1418] hover:bg-[#0b1418]">
          <TableHead className="w-14 py-3 font-data text-[11px] uppercase text-[#697371]">#</TableHead>
          <TableHead className="w-[29%] py-3 font-data text-[11px] uppercase text-[#697371]">Agent</TableHead>
          <TableHead className="hidden w-[13%] py-3 font-data text-[11px] uppercase text-[#697371] min-[1460px]:table-cell">Operator</TableHead>
          <TableHead className="w-[11%] py-3 text-right font-data text-[11px] uppercase text-[#697371]">24H Vol</TableHead>
          <TableHead className="w-[7%] py-3 text-right font-data text-[11px] uppercase text-[#697371]">24H</TableHead>
          <TableHead className="w-[8%] py-3 text-right font-data text-[11px] uppercase text-[#697371]">Total</TableHead>
          <TableHead className="w-[10%] py-3 text-right font-data text-[11px] uppercase text-[#697371]">Last</TableHead>
          <TableHead className="hidden w-[8%] py-3 text-right font-data text-[11px] uppercase text-[#697371] min-[1320px]:table-cell">Mode</TableHead>
          <TableHead className="w-[10%] py-3 text-right font-data text-[11px] uppercase text-[#697371]">Return</TableHead>
          <TableHead className="w-[6%] py-3 text-right font-data text-[11px] uppercase text-[#697371]">Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((bot, index) => {
          const href = `/arena/bot/${encodeURIComponent(bot.id)}/performance`;
          const stats = activityStatsByBotId?.get(bot.id);
          const lastTradeAt = stats?.lastTradeAt ?? null;
          const totalFillEvidence = resolveFillCountEvidence({
            visibleTradeCount: stats?.totalVisibleFills,
            rosterTradeCount: bot.totalTrades,
          });
          const returnValue = bot.pnlPercent === 0 ? '0.0%' : `${bot.pnlPercent > 0 ? '+' : ''}${formatNumber(bot.pnlPercent, { maximumFractionDigits: 1 })}%`;
          const selected = bot.id === selectedBotId;
          const openRow = () => {
            if (onSelectBot) {
              onSelectBot(bot);
            } else {
              navigate(href);
            }
          };
          return (
          <TableRow
            key={bot.id}
            className={`group cursor-pointer border-b border-[#273035] transition-colors hover:bg-[#16242a] [content-visibility:auto] [contain-intrinsic-size:66px] ${
              selected ? 'bg-[#132329] shadow-[inset_3px_0_0_rgba(80,210,193,0.9)]' : 'bg-[#0f1a1f]'
            }`}
            role="button"
            tabIndex={0}
            aria-label={onSelectBot ? `Inspect ${bot.name}` : `Open ${bot.name} performance`}
            aria-current={selected ? 'true' : undefined}
            onClick={openRow}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openRow();
              }
            }}
          >
            <TableCell className="py-3 align-middle">
              <RankCell rank={index + 1} />
            </TableCell>
            <TableCell className="min-w-0 py-3 align-middle">
              <div className="flex min-w-0 items-center gap-3">
                <Identicon address={bot.operatorAddress as Address} size={36} />
                <div className="min-w-0 flex-1">
                  <Link
                    to={href}
                    className="block truncate font-display text-lg font-semibold leading-tight text-[#f6fefd] transition-colors duration-200 hover:text-[#50d2c1]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {bot.name}
                  </Link>
                  <div className="mt-1 flex min-w-0 items-center gap-2 font-data text-sm">
                    <span className="truncate text-[#949e9c]">
                      {STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}
                    </span>
                    <span className="h-1 w-1 shrink-0 rounded-full bg-[#697371]" aria-hidden="true" />
                    <span className={bot.status === 'active' ? 'truncate text-[#50d2c1]' : 'truncate text-[#949e9c]'}>
                      {botStatusLabel(bot.status)}
                    </span>
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell className="hidden min-w-0 py-3 align-middle min-[1460px]:table-cell">
              <div className="flex min-w-0 items-center gap-2 font-data text-base text-[#d2dad7]">
                <Identicon address={bot.operatorAddress as Address} size={24} />
                <span className="truncate">{truncateAddress(bot.operatorAddress)}</span>
              </div>
            </TableCell>
            <TableCell className="py-3 text-right align-middle font-data text-base text-[#f6fefd]">
              {formatFlowUsd(stats?.recentNotionalUsd ?? 0)}
            </TableCell>
            <TableCell className="py-3 text-right align-middle font-data text-base font-bold text-[#f6fefd]">
              {formatNumber(stats?.recentFills ?? 0, { maximumFractionDigits: 0 })}
            </TableCell>
            <TableCell
              className="py-3 text-right align-middle font-data text-base text-[#f6fefd]"
              title={fillCountEvidenceTitle(totalFillEvidence)}
            >
              {totalFillEvidence.value > 0
                ? formatNumber(totalFillEvidence.value, { maximumFractionDigits: 0 })
                : '—'}
            </TableCell>
            <TableCell className="py-3 text-right align-middle font-data text-base text-[#d2dad7]">
              {lastTradeAt != null ? formatTradeAge(lastTradeAt) : 'No fills'}
            </TableCell>
            <TableCell className="hidden py-3 text-right align-middle font-data text-base text-[#d2dad7] min-[1320px]:table-cell">
              {modeLabel(bot)}
            </TableCell>
            <TableCell className="py-3 text-right align-middle font-data text-base font-bold">
              {bot.pnlPercent === 0 ? (
                <span className="text-[#697371]">{returnValue}</span>
              ) : bot.pnlPercent > 0 ? (
                <span className="text-[#50d2c1]">{returnValue}</span>
              ) : (
                <span className="text-[#ff5d6c]">{returnValue}</span>
              )}
            </TableCell>
            <TableCell className="py-3 text-right align-middle">
              <Link
                to={href}
                className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[#273035] bg-[#0b1418] text-[#949e9c] transition-[background-color,border-color,color] duration-150 hover:border-[#50d2c1]/60 hover:bg-[#143c38] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                aria-label={`Open ${bot.name} performance`}
                title="Open performance"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="i-ph:arrow-square-out text-sm" aria-hidden="true" />
              </Link>
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
