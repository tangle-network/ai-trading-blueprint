import { Link } from 'react-router';
import { motion } from 'framer-motion';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Badge, Identicon, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle/blueprint-ui/components';
import { SparklineChart } from './SparklineChart';

interface LeaderboardTableProps {
  bots: Bot[];
}

const strategyColors: Record<string, 'accent' | 'success' | 'amber' | 'default' | 'secondary'> = {
  momentum: 'accent',
  'mean-reversion': 'success',
  arbitrage: 'amber',
  'trend-following': 'secondary',
  'market-making': 'default',
  sentiment: 'accent',
  dex: 'success',
  prediction: 'accent',
  prediction_politics: 'accent',
  prediction_crypto: 'accent',
  prediction_war: 'accent',
  prediction_trending: 'accent',
  prediction_celebrity: 'accent',
  yield: 'amber',
  perp: 'default',
  volatility: 'secondary',
  mm: 'default',
  multi: 'accent',
};

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
  const sorted = [...bots].sort((a, b) => b.pnlPercent - a.pnlPercent);

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-14">#</TableHead>
          <TableHead>Bot</TableHead>
          <TableHead className="hidden md:table-cell">Strategy</TableHead>
          <TableHead className="hidden lg:table-cell">Chart</TableHead>
          <TableHead className="text-right">PnL</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Sharpe</TableHead>
          <TableHead className="text-right hidden md:table-cell">Max DD</TableHead>
          <TableHead className="text-right hidden lg:table-cell">TVL</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Win Rate</TableHead>
          <TableHead className="text-right hidden md:table-cell">Score</TableHead>
          <TableHead className="hidden lg:table-cell">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((bot, index) => (
          <motion.tr
            key={bot.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.04, duration: 0.3 }}
            className="border-b border-arena-elements-dividerColor transition-all duration-200 hover:bg-arena-elements-item-backgroundHover group cursor-pointer"
          >
            <TableCell>
              <RankCell rank={index + 1} />
            </TableCell>
            <TableCell>
              <Link
                to={`/arena/bot/${bot.id}`}
                className="font-display font-semibold text-sm hover:text-violet-400 transition-colors duration-200"
              >
                {bot.name}
              </Link>
              <div className="flex items-center gap-1.5 text-xs font-data text-arena-elements-textTertiary mt-0.5">
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
                <span className={`font-data font-bold text-sm ${
                  bot.pnlPercent >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'
                }`}>
                  {bot.pnlPercent >= 0 ? '+' : ''}{bot.pnlPercent.toFixed(1)}%
                </span>
              ) : (
                <span className="font-data text-sm text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="text-right font-data text-sm hidden sm:table-cell">
              {bot.sharpeRatio !== 0 ? bot.sharpeRatio.toFixed(1) : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="text-right font-data text-sm hidden md:table-cell">
              {bot.maxDrawdown !== 0 ? (
                <span className="text-arena-elements-icon-error">{bot.maxDrawdown.toFixed(1)}%</span>
              ) : (
                <span className="text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="text-right font-data text-sm hidden lg:table-cell">
              {bot.tvl > 0 ? `$${(bot.tvl / 1000).toFixed(0)}K` : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="text-right font-data text-sm hidden sm:table-cell">
              {bot.winRate > 0 ? `${bot.winRate}%` : <span className="text-arena-elements-textTertiary">—</span>}
            </TableCell>
            <TableCell className="text-right hidden md:table-cell">
              {bot.avgValidatorScore > 0 ? (
                <ScoreIndicator score={bot.avgValidatorScore} />
              ) : (
                <span className="font-data text-xs text-arena-elements-textTertiary">—</span>
              )}
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <Badge variant={bot.status === 'active' ? 'success' : (bot.status === 'paused' || bot.status === 'needs_config') ? 'amber' : 'secondary'}>
                {bot.status === 'needs_config' ? 'needs config' : bot.status}
              </Badge>
            </TableCell>
          </motion.tr>
        ))}
      </TableBody>
    </Table>
  );
}
