import { Link, useNavigate } from 'react-router';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Identicon, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { botStatusLabel, formatCompactUsd, formatNumber, STRATEGY_SHORT, truncateAddress } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';

interface LeaderboardTableProps {
  bots: Bot[];
}

function RankCell({ rank }: { rank: number }) {
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/54 font-data text-sm font-semibold text-arena-elements-textTertiary">
      {rank.toLocaleString()}
    </span>
  );
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '—';
  return `${value > 0 ? '+' : ''}${formatNumber(value, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })}%`;
}

export function LeaderboardTable({ bots }: LeaderboardTableProps) {
  const navigate = useNavigate();
  const sorted = rankLeaderboardBots(bots);

  return (
    <Table className="w-full min-w-[1080px] table-fixed">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[4%] py-3 text-xs uppercase">#</TableHead>
          <TableHead className="w-[30%] py-3 text-xs uppercase">Agent</TableHead>
          <TableHead className="w-[17%] py-3 text-xs uppercase">Operator</TableHead>
          <TableHead className="w-[9%] py-3 text-right text-xs uppercase">Account</TableHead>
          <TableHead className="w-[7%] py-3 text-right text-xs uppercase">30D</TableHead>
          <TableHead className="w-[7%] py-3 text-right text-xs uppercase">Sharpe</TableHead>
          <TableHead className="w-[6%] py-3 text-right text-xs uppercase">DD</TableHead>
          <TableHead className="w-[6%] py-3 text-right text-xs uppercase">Win</TableHead>
          <TableHead className="w-[7%] py-3 text-right text-xs uppercase">Fills</TableHead>
          <TableHead className="w-[7%] py-3 text-right text-xs uppercase">State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((bot, index) => {
          const href = `/arena/bot/${encodeURIComponent(bot.id)}/performance`;
          const positive = bot.pnlPercent >= 0;
          return (
          <TableRow
            key={bot.id}
            className="group cursor-pointer border-b border-arena-elements-dividerColor/70 transition-colors hover:bg-arena-elements-item-backgroundHover"
            role="button"
            tabIndex={0}
            aria-label={`Open ${bot.name} performance`}
            onClick={() => navigate(href)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                navigate(href);
              }
            }}
          >
            <TableCell className="py-4 align-middle">
              <RankCell rank={index + 1} />
            </TableCell>
            <TableCell className="min-w-0 py-4 align-middle">
              <div className="flex min-w-0 items-center gap-3">
                <Identicon address={bot.operatorAddress as Address} size={34} />
                <div className="min-w-0 flex-1">
                  <Link
                    to={href}
                    className="block truncate font-display text-lg font-semibold leading-tight text-arena-elements-textPrimary transition-colors duration-200 hover:text-violet-700 dark:hover:text-violet-300"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {bot.name}
                  </Link>
                  <div className="mt-1 flex min-w-0 items-center gap-2">
                    <span className="truncate font-data text-sm text-arena-elements-textTertiary">
                      {STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}
                    </span>
                    <span className="hidden h-1 w-1 shrink-0 rounded-full bg-arena-elements-textTertiary/45 min-[1180px]:block" aria-hidden="true" />
                    <span className="hidden truncate font-data text-sm text-arena-elements-textSecondary min-[1180px]:block">
                      {botStatusLabel(bot.status)}
                    </span>
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell className="min-w-0 py-4 align-middle">
              <div className="flex min-w-0 items-center gap-2 font-data text-base text-arena-elements-textSecondary">
                <Identicon address={bot.operatorAddress as Address} size={24} />
                <span className="truncate">{truncateAddress(bot.operatorAddress)}</span>
              </div>
            </TableCell>
            <TableCell className="py-4 text-right align-middle font-data text-base text-arena-elements-textPrimary">
              {bot.tvl > 0 ? formatCompactUsd(bot.tvl) : '—'}
            </TableCell>
            <TableCell className={`py-4 text-right align-middle font-data text-base font-bold ${bot.pnlPercent === 0 ? 'text-arena-elements-textTertiary' : positive ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'}`}>
              {formatPercent(bot.pnlPercent)}
            </TableCell>
            <TableCell className="py-4 text-right align-middle font-data text-base text-arena-elements-textPrimary">
              {bot.sharpeRatio !== 0 ? formatNumber(bot.sharpeRatio, { maximumFractionDigits: 1 }) : '—'}
            </TableCell>
            <TableCell className="py-4 text-right align-middle font-data text-base">
              {bot.maxDrawdown !== 0 ? (
                <span className="text-arena-elements-icon-error">{formatNumber(bot.maxDrawdown, { maximumFractionDigits: 1 })}%</span>
              ) : (
                <span className="text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="py-4 text-right align-middle font-data text-base text-arena-elements-textPrimary">
              {bot.winRate !== 0 ? `${formatNumber(bot.winRate, { maximumFractionDigits: 0 })}%` : '—'}
            </TableCell>
            <TableCell className="py-4 text-right align-middle font-data text-base text-arena-elements-textPrimary">
              {bot.totalTrades > 0 ? bot.totalTrades.toLocaleString() : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="py-4 text-right align-middle font-data text-sm text-arena-elements-textSecondary">
              {botStatusLabel(bot.status)}
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
