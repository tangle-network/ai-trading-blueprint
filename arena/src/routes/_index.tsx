import { useEffect, useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useAccount } from 'wagmi';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { usePlatformVolumeSeries } from '~/lib/hooks/useBotApi';
import { FilterBar } from '~/components/arena/FilterBar';
import { LeaderboardTable } from '~/components/arena/LeaderboardTable';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import { PlatformVolumeChart } from '~/components/arena/PlatformVolumeChart';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { formatNumber } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';

export const meta: MetaFunction = () => [
  { title: 'AI Trading Arena' },
];

function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000) {
    return `$${formatNumber(value / 1_000_000, {
      maximumFractionDigits: 2,
      minimumFractionDigits: value >= 10_000_000 ? 1 : 2,
    })}M`;
  }
  if (value >= 1_000) {
    return `$${formatNumber(value / 1_000, {
      maximumFractionDigits: 1,
      minimumFractionDigits: value >= 10_000 ? 0 : 1,
    })}K`;
  }
  return `$${formatNumber(value, { maximumFractionDigits: 2 })}`;
}

export default function IndexPage() {
  const { isConnected } = useAccount();
  const [search, setSearch] = useState('');
  useTradingRouteAutoAuth({
    enabled: isConnected && HAS_TRADING_OPERATOR_API,
    routeKey: 'leaderboard',
  });
  const { bots: rawBots, isLoading, isOnChain, operatorDataState } = useBots();
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setEnrichmentEnabled(true), 900);
    return () => window.clearTimeout(timer);
  }, []);
  const bots = useBotEnrichment(rawBots, { enabled: enrichmentEnabled });

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

  const sorted = rankLeaderboardBots(filteredBots);

  const totalTrades = leaderboardBots.reduce((sum, b) => sum + b.totalTrades, 0);
  const visibleTrades = sorted.reduce((sum, b) => sum + b.totalTrades, 0);
  const { series: homeVolumeSeries } = usePlatformVolumeSeries(leaderboardBots, '30d');
  const hasPlatformTradeCount = homeVolumeSeries.summary.totalTradeCount > 0;
  const platformTradeCount = hasPlatformTradeCount
    ? homeVolumeSeries.summary.totalTradeCount
    : totalTrades;
  const activeAgents = leaderboardBots.filter((bot) => bot.status === 'active').length;
  const scoredAgents = leaderboardBots.filter((bot) => bot.avgValidatorScore > 0);
  const avgRiskScore = scoredAgents.length > 0
    ? Math.round(scoredAgents.reduce((sum, bot) => sum + bot.avgValidatorScore, 0) / scoredAgents.length)
    : null;
  const cloudStats = [
    { label: 'Agents', value: leaderboardBots.length.toLocaleString(), sublabel: `${activeAgents} active` },
    {
      label: 'Notional',
      value: formatCompactUsd(homeVolumeSeries.summary.totalUsd),
      sublabel: '30D connected operators',
    },
    {
      label: hasPlatformTradeCount ? '30D Trades' : 'All-Time Trades',
      value: platformTradeCount > 0 ? platformTradeCount.toLocaleString() : '—',
      sublabel: hasPlatformTradeCount ? 'priced + unpriced' : 'operator totals',
    },
    { label: 'Risk Score', value: avgRiskScore != null ? avgRiskScore.toLocaleString() : '—', sublabel: scoredAgents.length > 0 ? 'validator average' : 'awaiting validation' },
  ];

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6">
      <section className="mb-4 grid items-stretch gap-3 xl:grid-cols-[minmax(0,0.68fr)_minmax(0,1.32fr)]">
        <div className="rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/48 p-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1.5 rounded border border-emerald-700/20 bg-emerald-700/10 px-2 py-1 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                <div className="w-2 h-2 rounded-full bg-emerald-700 dark:bg-emerald-400 animate-glow-pulse" />
                <span className="text-xs font-data font-semibold text-arena-elements-icon-success uppercase tracking-wider">
                  {isOnChain ? 'Live Operator Data' : 'Live Data'}
                </span>
              </div>
            </div>
            <div className="mt-3">
              <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                AI Trading Arena
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-arena-elements-textSecondary sm:text-base">
                Live agent volume, trades, returns, and decision traces from connected operators.
              </p>
            </div>
            <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2">
              <Link
                to="/provision"
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-violet-500/22 bg-violet-500/12 px-3 text-sm font-display font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
              >
                <span className="i-ph:plus-bold text-xs" />
                Deploy Agent
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

      <section className="mb-5 grid min-h-[480px] gap-3 xl:grid-cols-[minmax(0,1fr)_540px]">
        <PlatformVolumeChart
          bots={leaderboardBots}
          variant="command"
          className="min-h-[480px]"
        />
        <LatestAgentTrades
          bots={leaderboardBots}
          variant="panel"
          limit={20}
          className="min-h-[480px]"
        />
      </section>

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight">Leaderboard</h2>
          <div className="mt-1 flex items-center gap-5 text-sm font-data text-arena-elements-textSecondary">
            <span><span className="font-semibold text-arena-elements-textPrimary">{sorted.length}</span> agents</span>
            {visibleTrades > 0 && <span><span className="font-semibold text-arena-elements-textPrimary">{visibleTrades.toLocaleString()}</span> trades</span>}
          </div>
        </div>
        <FilterBar
          search={search}
          onSearchChange={setSearch}
        />
      </div>

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
              'Watch real-time returns, trades, and risk scores',
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
      ) : (
        <LeaderboardTable bots={sorted} />
      )}
    </div>
  );
}
