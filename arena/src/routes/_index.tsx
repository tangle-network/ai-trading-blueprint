import { useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import type { Address } from 'viem';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { FilterBar } from '~/components/arena/FilterBar';
import { LeaderboardTable } from '~/components/arena/LeaderboardTable';
import { Badge } from '~/components/ui/badge';
import { Identicon } from '~/components/shared/Identicon';
import { SparklineChart } from '~/components/arena/SparklineChart';
import type { Bot } from '~/lib/types/bot';

export const meta: MetaFunction = () => [
  { title: 'AI Trading Arena' },
];

const strategyColors: Record<string, 'accent' | 'success' | 'amber' | 'default' | 'secondary'> = {
  momentum: 'accent',
  'mean-reversion': 'success',
  arbitrage: 'amber',
  'trend-following': 'secondary',
  'market-making': 'default',
  sentiment: 'accent',
  dex: 'success',
  prediction: 'accent',
  yield: 'amber',
  perp: 'default',
  volatility: 'secondary',
  mm: 'default',
  multi: 'accent',
};

function BotCard({ bot, rank }: { bot: Bot; rank: number }) {
  return (
    <Link
      to={`/arena/bot/${bot.id}`}
      className="glass-card rounded-xl p-5 hover:border-violet-500/20 transition-all duration-200 block"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-data font-bold text-arena-elements-textTertiary w-5 shrink-0">
            {rank}
          </span>
          <Identicon address={bot.operatorAddress as Address} size={32} />
          <div className="min-w-0">
            <div className="font-display font-semibold text-base truncate">{bot.name}</div>
            <div className="text-xs font-data text-arena-elements-textTertiary truncate">
              {bot.operatorAddress.slice(0, 6)}...{bot.operatorAddress.slice(-4)}
            </div>
          </div>
        </div>
        <Badge variant={bot.status === 'active' ? 'success' : bot.status === 'paused' ? 'amber' : 'destructive'} className="text-xs shrink-0">
          {bot.status}
        </Badge>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="space-y-2">
          <div>
            {bot.pnlPercent !== 0 ? (
              <span className={`font-data font-bold text-xl ${bot.pnlPercent >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'}`}>
                {bot.pnlPercent >= 0 ? '+' : ''}{bot.pnlPercent.toFixed(1)}%
              </span>
            ) : (
              <span className="font-data text-xl text-arena-elements-textTertiary">&mdash;</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs font-data text-arena-elements-textSecondary">
            {bot.tvl > 0 && <span>${bot.tvl >= 1000 ? `${(bot.tvl / 1000).toFixed(0)}K` : bot.tvl.toFixed(0)} TVL</span>}
            {bot.totalTrades > 0 && <span>{bot.totalTrades} trades</span>}
            {bot.sharpeRatio > 0 && <span>{bot.sharpeRatio.toFixed(1)} Sharpe</span>}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={strategyColors[bot.strategyType] ?? 'default'} className="text-xs">{bot.strategyType}</Badge>
            {bot.avgValidatorScore > 0 && (
              <span className={`text-xs font-data font-bold px-1.5 py-0.5 rounded ${
                bot.avgValidatorScore >= 85 ? 'bg-emerald-700/10 dark:bg-emerald-500/10 text-arena-elements-icon-success' :
                bot.avgValidatorScore >= 70 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-crimson-500/10 text-crimson-600 dark:text-crimson-400'
              }`}>{bot.avgValidatorScore}</span>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <SparklineChart data={bot.sparklineData} positive={bot.pnlPercent >= 0} width={100} height={40} />
        </div>
      </div>

      {bot.vaultAddress && bot.vaultAddress !== '0x0000000000000000000000000000000000000000' && (
        <div className="mt-3 pt-3 border-t border-arena-elements-dividerColor/50">
          <div className="text-xs font-data text-arena-elements-textTertiary truncate">
            Vault: {bot.vaultAddress}
          </div>
        </div>
      )}
    </Link>
  );
}

export default function IndexPage() {
  const [search, setSearch] = useState('');
  const [timePeriod, setTimePeriod] = useState('30d');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('cards');
  const { bots: rawBots, isLoading, isOnChain } = useBots();
  const bots = useBotEnrichment(rawBots);

  const filteredBots = bots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(search.toLowerCase()) ||
      bot.strategyType.toLowerCase().includes(search.toLowerCase()) ||
      bot.vaultAddress.toLowerCase().includes(search.toLowerCase()) ||
      bot.operatorAddress.toLowerCase().includes(search.toLowerCase()),
  );

  const sorted = [...filteredBots].sort((a, b) => b.pnlPercent - a.pnlPercent);

  const totalTvl = bots.reduce((sum, b) => sum + b.tvl, 0);
  const totalTrades = bots.reduce((sum, b) => sum + b.totalTrades, 0);
  const avgScore = bots.length > 0
    ? Math.round(bots.reduce((sum, b) => sum + b.avgValidatorScore, 0) / bots.length)
    : 0;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1.5">
            <h1 className="font-display font-bold text-3xl tracking-tight">Leaderboard</h1>
            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-700/10 dark:bg-emerald-500/10 border border-emerald-700/20 dark:border-emerald-500/20">
              <div className="w-2 h-2 rounded-full bg-emerald-700 dark:bg-emerald-400 animate-glow-pulse" />
              <span className="text-xs font-data font-semibold text-arena-elements-icon-success uppercase tracking-wider">
                {isOnChain ? 'onchain' : 'Live'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-5 text-sm font-data text-arena-elements-textSecondary">
            <span><span className="text-arena-elements-textPrimary font-semibold">{bots.length}</span> agents</span>
            {totalTvl > 0 && <span><span className="text-arena-elements-textPrimary font-semibold">${totalTvl >= 1000 ? `${(totalTvl / 1000).toFixed(0)}K` : totalTvl.toFixed(0)}</span> TVL</span>}
            {totalTrades > 0 && <span><span className="text-arena-elements-textPrimary font-semibold">{totalTrades.toLocaleString()}</span> trades</span>}
            {avgScore > 0 && <span><span className="text-arena-elements-textPrimary font-semibold">{avgScore}</span>/100</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center gap-0.5 glass-card rounded-lg p-1">
            <button
              onClick={() => setViewMode('cards')}
              className={`p-2 rounded-md transition-all ${viewMode === 'cards' ? 'bg-violet-500/10 text-violet-700 dark:text-violet-400' : 'text-arena-elements-textTertiary hover:text-arena-elements-textSecondary'}`}
              title="Card view"
            >
              <div className="i-ph:squares-four text-base" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-2 rounded-md transition-all ${viewMode === 'table' ? 'bg-violet-500/10 text-violet-700 dark:text-violet-400' : 'text-arena-elements-textTertiary hover:text-arena-elements-textSecondary'}`}
              title="Table view"
            >
              <div className="i-ph:list text-base" />
            </button>
          </div>
          <Link
            to="/provision"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-700 dark:text-violet-400 text-sm font-display font-medium hover:bg-violet-500/20 transition-colors"
          >
            <span className="i-ph:plus-bold text-xs" />
            Deploy
          </Link>
        </div>
      </div>

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        timePeriod={timePeriod}
        onTimePeriodChange={setTimePeriod}
      />

      {isLoading ? (
        <div className="glass-card rounded-xl p-16 text-center">
          <div className="i-ph:arrow-clockwise text-2xl text-arena-elements-textTertiary mb-3 mx-auto animate-spin" />
          <p className="text-sm text-arena-elements-textSecondary">Loading...</p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="glass-card rounded-xl p-16 text-center">
          <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mb-4 mx-auto" />
          <p className="text-base text-arena-elements-textSecondary mb-2">No agents deployed yet</p>
          <p className="text-sm text-arena-elements-textTertiary">
            <Link to="/provision" className="text-violet-700 dark:text-violet-400 hover:underline">Deploy an agent</Link> to get started.
          </p>
        </div>
      ) : viewMode === 'table' ? (
        <LeaderboardTable bots={sorted} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map((bot, i) => (
            <BotCard key={bot.id} bot={bot} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
