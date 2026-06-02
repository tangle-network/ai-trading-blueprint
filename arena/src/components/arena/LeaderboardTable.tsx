import { Link, useNavigate } from 'react-router';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Identicon, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { SparklineChart } from './SparklineChart';
import { botStatusLabel, formatCompactUsd, formatNumber, STRATEGY_SHORT, truncateAddress } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';

interface LeaderboardTableProps {
  bots: Bot[];
}

function RankCell({ rank }: { rank: number }) {
  return (
    <span className="font-data text-sm font-semibold text-arena-elements-textTertiary">
      {rank}
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
    <Table className="w-full table-fixed">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-11 py-3 text-base">#</TableHead>
          <TableHead className="w-[18%] py-3 text-base">Agent</TableHead>
          <TableHead className="w-[15%] py-3 text-base">Operator</TableHead>
          <TableHead className="w-[10%] py-3 text-base">Strategy</TableHead>
          <TableHead className="w-[9%] py-3 text-right text-base">Account</TableHead>
          <TableHead className="w-[7%] py-3 text-right text-base">30D</TableHead>
          <TableHead className="w-[7%] py-3 text-right text-base">Sharpe</TableHead>
          <TableHead className="w-[6%] py-3 text-right text-base">DD</TableHead>
          <TableHead className="w-[6%] py-3 text-right text-base">Win</TableHead>
          <TableHead className="w-[7%] py-3 text-right text-base">Fills</TableHead>
          <TableHead className="w-[9%] py-3 text-right text-base">State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((bot, index) => {
          const href = `/arena/bot/${encodeURIComponent(bot.id)}/performance`;
          const positive = bot.pnlPercent >= 0;
          return (
          <TableRow
            key={bot.id}
            className="group cursor-pointer border-b border-arena-elements-dividerColor transition-colors hover:bg-arena-elements-item-backgroundHover"
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
            <TableCell className="py-3">
              <RankCell rank={index + 1} />
            </TableCell>
            <TableCell className="min-w-0 py-3">
              <Link
                to={href}
                className="block truncate font-display text-base font-semibold text-arena-elements-textPrimary transition-colors duration-200 hover:text-violet-700 dark:hover:text-violet-300"
              >
                {bot.name}
              </Link>
              <div className="mt-1 w-24">
                <SparklineChart data={bot.sparklineData} positive={positive} width={90} height={24} />
              </div>
            </TableCell>
            <TableCell className="min-w-0 py-3">
              <div className="flex min-w-0 items-center gap-2 font-data text-base text-arena-elements-textSecondary">
                <Identicon address={bot.operatorAddress as Address} size={22} />
                <span className="truncate">{truncateAddress(bot.operatorAddress)}</span>
              </div>
            </TableCell>
            <TableCell className="truncate py-3 font-data text-base text-arena-elements-textSecondary">
              {STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}
            </TableCell>
            <TableCell className="py-3 text-right font-data text-base text-arena-elements-textPrimary">
              {bot.tvl > 0 ? formatCompactUsd(bot.tvl) : '—'}
            </TableCell>
            <TableCell className={`py-3 text-right font-data text-base font-bold ${bot.pnlPercent === 0 ? 'text-arena-elements-textTertiary' : positive ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'}`}>
              {formatPercent(bot.pnlPercent)}
            </TableCell>
            <TableCell className="py-3 text-right font-data text-base text-arena-elements-textPrimary">
              {bot.sharpeRatio !== 0 ? formatNumber(bot.sharpeRatio, { maximumFractionDigits: 1 }) : '—'}
            </TableCell>
            <TableCell className="py-3 text-right font-data text-base">
              {bot.maxDrawdown !== 0 ? (
                <span className="text-arena-elements-icon-error">{formatNumber(bot.maxDrawdown, { maximumFractionDigits: 1 })}%</span>
              ) : (
                <span className="text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="py-3 text-right font-data text-base text-arena-elements-textPrimary">
              {bot.winRate !== 0 ? `${formatNumber(bot.winRate, { maximumFractionDigits: 0 })}%` : '—'}
            </TableCell>
            <TableCell className="py-3 text-right font-data text-base text-arena-elements-textPrimary">
              {bot.totalTrades > 0 ? bot.totalTrades.toLocaleString() : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="py-3 text-right text-sm text-arena-elements-textSecondary">
              {botStatusLabel(bot.status)}
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
