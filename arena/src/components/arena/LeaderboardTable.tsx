import { Link } from 'react-router';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Badge, Identicon, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { strategyColors } from '~/lib/constants/strategyColors';
import { SparklineChart } from './SparklineChart';
import { botStatusBadgeVariant, botStatusLabel } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';

interface LeaderboardTableProps {
  bots: Bot[];
}

function RankCell({ rank }: { rank: number }) {
  if (rank <= 3) {
    const cls = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : 'rank-3';
    return <div className={`rank-medal ${cls}`}>{rank}</div>;
  }
  return (
    <span className="font-data text-sm text-arena-elements-textTertiary font-medium">
      {rank}
    </span>
  );
}

function ScoreIndicator({ score }: { score: number }) {
  const color = score >= 85 ? 'text-arena-elements-icon-success' : score >= 70 ? 'text-amber-700 dark:text-amber-400' : 'text-arena-elements-icon-error';
  const bg = score >= 85 ? 'bg-emerald-700/10 dark:bg-emerald-500/10' : score >= 70 ? 'bg-amber-500/10' : 'bg-crimson-500/10';
  return (
    <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${bg}`}>
      <span className={`font-data text-xs font-bold ${color}`}>{score}</span>
    </div>
  );
}

export function LeaderboardTable({ bots }: LeaderboardTableProps) {
  const sorted = rankLeaderboardBots(bots);

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-14">#</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead className="hidden md:table-cell">Strategy</TableHead>
          <TableHead className="hidden lg:table-cell">Chart</TableHead>
          <TableHead className="text-right">Return</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Sharpe</TableHead>
          <TableHead className="text-right hidden md:table-cell">Max DD</TableHead>
          <TableHead className="text-right hidden lg:table-cell">Account</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Trades</TableHead>
          <TableHead className="text-right hidden md:table-cell">Risk Score</TableHead>
          <TableHead className="hidden lg:table-cell">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((bot, index) => (
          <TableRow
            key={bot.id}
            className="border-b border-arena-elements-dividerColor transition-colors hover:bg-arena-elements-item-backgroundHover group"
          >
            <TableCell>
              <RankCell rank={index + 1} />
            </TableCell>
            <TableCell>
              <Link
                to={`/arena/bot/${encodeURIComponent(bot.id)}/performance`}
                className="font-display text-base font-semibold hover:text-violet-700 transition-colors duration-200 dark:hover:text-violet-300"
              >
                {bot.name}
              </Link>
              <div className="flex items-center gap-1.5 text-sm font-data text-arena-elements-textTertiary mt-0.5">
                <Identicon address={bot.operatorAddress as Address} size={14} />
                {bot.operatorAddress.slice(0, 6)}...{bot.operatorAddress.slice(-4)}
              </div>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <Badge variant={strategyColors[bot.strategyType] ?? 'default'}>
                {bot.strategyType}
              </Badge>
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <SparklineChart data={bot.sparklineData} positive={bot.pnlPercent >= 0} />
            </TableCell>
            <TableCell className="text-right">
              {bot.pnlPercent !== 0 ? (
                <span className={`font-data font-bold text-lg ${
                  bot.pnlPercent >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'
                }`}>
                  {bot.pnlPercent >= 0 ? '+' : ''}{bot.pnlPercent.toFixed(1)}%
                </span>
              ) : (
                <span className="font-data text-sm text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="text-right font-data text-base hidden sm:table-cell">
              {bot.sharpeRatio !== 0 ? bot.sharpeRatio.toFixed(1) : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="text-right font-data text-base hidden md:table-cell">
              {bot.maxDrawdown !== 0 ? (
                <span className="text-arena-elements-icon-error">{bot.maxDrawdown.toFixed(1)}%</span>
              ) : (
                <span className="text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="text-right font-data text-base hidden lg:table-cell">
              {bot.tvl > 0 ? `$${(bot.tvl / 1000).toFixed(0)}K` : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="text-right font-data text-base hidden sm:table-cell">
              {bot.totalTrades > 0 ? bot.totalTrades.toLocaleString() : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="text-right hidden md:table-cell">
              {bot.avgValidatorScore > 0 ? (
                <ScoreIndicator score={bot.avgValidatorScore} />
              ) : (
                <span className="font-data text-xs text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <Badge variant={botStatusBadgeVariant(bot.status)}>
                {botStatusLabel(bot.status)}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
