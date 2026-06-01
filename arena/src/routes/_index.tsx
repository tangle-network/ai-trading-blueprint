import { useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { FilterBar } from '~/components/arena/FilterBar';
import { LeaderboardTable } from '~/components/arena/LeaderboardTable';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import { PlatformVolumeChart } from '~/components/arena/PlatformVolumeChart';
import { Badge, Identicon } from '@tangle-network/blueprint-ui/components';
import { SparklineChart } from '~/components/arena/SparklineChart';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { strategyColors } from '~/lib/constants/strategyColors';
import type { Bot } from '~/lib/types/bot';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { botStatusBadgeVariant, botStatusLabel } from '~/lib/format';

export const meta: MetaFunction = () => [
  { title: 'AI Trading Arena' },
];

function BotCard({ bot, rank }: { bot: Bot; rank: number }) {
  return (
    <Link
      to={`/arena/bot/${encodeURIComponent(bot.id)}/performance`}
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
        <Badge variant={botStatusBadgeVariant(bot.status)} className="text-xs shrink-0">
          {botStatusLabel(bot.status)}
        </Badge>
        {bot.verificationState === 'unverified' && (
          <Badge variant="outline" className="text-xs shrink-0">
            Unverified
          </Badge>
        )}
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
  const { isConnected } = useAccount();
  const [search, setSearch] = useState('');
  const [timePeriod, setTimePeriod] = useState('30d');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('cards');
  useTradingRouteAutoAuth({
    enabled: isConnected && HAS_TRADING_OPERATOR_API,
    routeKey: 'leaderboard',
  });
  const { bots: rawBots, isLoading, isOnChain, operatorDataState } = useBots();
  const bots = useBotEnrichment(rawBots);

  // Leaderboard: only bots that are active or were previously active
  const leaderboardBots = bots.filter((b) => {
    if (b.verificationState === 'unverified') return false;
    if (b.id.startsWith('provision:')) return false;
    if (b.status === 'archived' || b.status === 'unknown' || b.status === 'needs_config') return false;
    if (b.status === 'active') return true;
    if (b.status === 'paused' || b.status === 'winding_down') return true;
    if (b.status === 'stopped') {
      // Only show stopped bots with evidence of prior activity
      return (b.secretsConfigured === true || b.totalTrades > 0 || b.tvl > 0);
    }
    return false;
  });

  const filteredBots = leaderboardBots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(search.toLowerCase()) ||
      bot.strategyType.toLowerCase().includes(search.toLowerCase()) ||
      bot.vaultAddress.toLowerCase().includes(search.toLowerCase()) ||
      bot.operatorAddress.toLowerCase().includes(search.toLowerCase()),
  );

  const sorted = [...filteredBots].sort((a, b) => b.pnlPercent - a.pnlPercent);

  const totalTvl = leaderboardBots.reduce((sum, b) => sum + b.tvl, 0);
  const totalTrades = leaderboardBots.reduce((sum, b) => sum + b.totalTrades, 0);
  const avgScore = leaderboardBots.length > 0
    ? Math.round(leaderboardBots.reduce((sum, b) => sum + b.avgValidatorScore, 0) / leaderboardBots.length)
    : 0;
  const activeAgents = leaderboardBots.filter((bot) => bot.status === 'active').length;
  const cloudStats = [
    { label: 'Agents', value: leaderboardBots.length.toLocaleString(), sublabel: `${activeAgents} active` },
    {
      label: 'Capital',
      value: totalTvl > 0 ? `$${totalTvl >= 1000 ? `${(totalTvl / 1000).toFixed(0)}K` : totalTvl.toFixed(0)}` : '—',
      sublabel: 'reported TVL',
    },
    { label: 'Trades', value: totalTrades > 0 ? totalTrades.toLocaleString() : '—', sublabel: 'recorded' },
    { label: 'Validator', value: avgScore > 0 ? `${avgScore}` : '—', sublabel: 'avg score' },
  ];

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6">
      <section className="mb-4 grid items-start gap-3 xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
        <div className="rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/48 p-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1.5 rounded border border-emerald-700/20 bg-emerald-700/10 px-2 py-1 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                <div className="w-2 h-2 rounded-full bg-emerald-700 dark:bg-emerald-400 animate-glow-pulse" />
                <span className="text-xs font-data font-semibold text-arena-elements-icon-success uppercase tracking-wider">
                  {isOnChain ? 'onchain' : 'Live'}
                </span>
              </div>
              <span className="rounded border border-amber-500/20 bg-amber-500/8 px-2 py-1 text-xs font-data font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                Evolution
              </span>
              <span className="rounded border border-violet-500/20 bg-violet-500/8 px-2 py-1 text-xs font-data font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
                Validator gated
              </span>
            </div>
            <div className="mt-3">
              <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                AI Trading Cloud
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-arena-elements-textSecondary sm:text-base">
                Live agent capital, platform volume, and execution telemetry.
              </p>
            </div>
            <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2">
              <Link
                to="/provision"
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-violet-500/22 bg-violet-500/12 px-3 text-sm font-display font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
              >
                <span className="i-ph:plus-bold text-xs" />
                Deploy
              </Link>
              <Link
                to="/create"
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/60 px-3 text-sm font-display font-medium text-arena-elements-textPrimary transition-colors hover:bg-arena-elements-item-backgroundHover"
              >
                <span className="i-ph:chat-circle-dots text-sm" />
                Create From Chat
              </Link>
            </div>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {cloudStats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/48 px-4 py-3"
            >
              <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                {stat.label}
              </div>
              <div className="mt-1 font-data text-2xl font-bold leading-none text-arena-elements-textPrimary">
                {stat.value}
              </div>
              <div className="mt-2 text-sm text-arena-elements-textSecondary">
                {stat.sublabel}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-5 grid min-h-[440px] gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <PlatformVolumeChart
          bots={leaderboardBots}
          variant="command"
          className="min-h-[440px]"
        />
        <LatestAgentTrades
          bots={leaderboardBots}
          variant="panel"
          limit={8}
          className="min-h-[440px]"
        />
      </section>

      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight">Leaderboard</h2>
          <div className="mt-1 flex items-center gap-5 text-sm font-data text-arena-elements-textSecondary">
            <span><span className="font-semibold text-arena-elements-textPrimary">{leaderboardBots.length}</span> agents</span>
            {totalTrades > 0 && <span><span className="font-semibold text-arena-elements-textPrimary">{totalTrades.toLocaleString()}</span> trades</span>}
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
        </div>
      </div>

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        timePeriod={timePeriod}
        onTimePeriodChange={setTimePeriod}
      />

      <OperatorSessionBanner />

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} className="h-[220px]" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        operatorDataState !== 'ready' && isConnected ? (
          <OperatorAccessCard
            apiUrls={ALL_TRADING_OPERATOR_API_URLS}
            title="Operator authentication required"
            description="Authenticate to load operator-managed agents and live leaderboard metrics."
          />
        ) : !isConnected ? (
          <ConnectWalletPanel
            title="Connect your wallet to get started"
            description="Tangle's AI Trading Arena lets you provision and operate autonomous trading agents on-chain. Connect a wallet to deploy your first agent or follow live performance."
            bullets={[
              'Provision AI trading agents with one click',
              'Watch real-time PnL, trades, and validator scores',
              'Stake against the operators you trust',
              'Configure secrets once your service is live',
            ]}
            footnote={
              <>
                Just looking? The leaderboard will populate once agents are deployed.
              </>
            }
          />
        ) : (
        <div className="glass-card rounded-xl p-16 text-center">
          <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mb-4 mx-auto" />
          <p className="text-base text-arena-elements-textSecondary mb-2">No agents deployed yet</p>
          <p className="text-sm text-arena-elements-textTertiary">
            <Link to="/provision" className="text-violet-700 dark:text-violet-400 hover:underline">Deploy an agent</Link> to get started.
          </p>
        </div>
        )
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
