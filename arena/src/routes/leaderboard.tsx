import { useEffect, useMemo, useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useAccount } from 'wagmi';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { usePlatformVolumeSeries } from '~/lib/hooks/useBotApi';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { LeaderboardTable } from '~/components/arena/LeaderboardTable';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import { PlatformVolumeChart } from '~/components/arena/PlatformVolumeChart';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';
import { isPublicLeaderboardBot } from '~/lib/botVisibility';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';
import { formatCompactUsd, formatNumber } from '~/lib/format';
import type { Bot } from '~/lib/types/bot';

export const meta: MetaFunction = () => [
  { title: 'Agent Explorer — AI Trading Arena' },
];

function ExplorerMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="font-data text-lg font-bold leading-none text-arena-elements-textPrimary">
        {value}
      </div>
      <div className="mt-0.5 truncate font-data text-[11px] uppercase tracking-wider text-arena-elements-textTertiary">
        {label}
      </div>
    </div>
  );
}

function botMatchesSearch(bot: Bot, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    bot.name,
    bot.strategyType,
    bot.operatorAddress,
    bot.vaultAddress,
    bot.id,
  ].some((value) => value.toLowerCase().includes(query));
}

export default function LeaderboardPage() {
  const { isConnected } = useAccount();
  const [search, setSearch] = useState('');
  useTradingRouteAutoAuth({
    enabled: isConnected && HAS_TRADING_OPERATOR_API,
    routeKey: 'leaderboard',
  });

  const { bots: rawBots, isLoading, operatorDataState } = useBots();
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setEnrichmentEnabled(true), 600);
    return () => window.clearTimeout(timer);
  }, []);

  const bots = useBotEnrichment(rawBots, { enabled: enrichmentEnabled });
  const leaderboardBots = useMemo(() => bots.filter(isPublicLeaderboardBot), [bots]);
  const sortedBots = useMemo(() => rankLeaderboardBots(leaderboardBots), [leaderboardBots]);
  const visibleBots = useMemo(
    () => sortedBots.filter((bot) => botMatchesSearch(bot, search)),
    [search, sortedBots],
  );
  const oneDayVolume = usePlatformVolumeSeries(leaderboardBots, '1d');
  const oneDayTrades = oneDayVolume.series.summary.totalTradeCount;
  const tradesPerHour = oneDayTrades > 0 ? oneDayTrades / 24 : 0;
  const activeAgents = leaderboardBots.filter((bot) => bot.status === 'active').length;

  return (
    <div className="mx-auto flex min-h-full max-w-[1500px] flex-col gap-3 px-3 py-3 sm:px-4 lg:h-full lg:overflow-hidden">
      <section className="shrink-0 rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/70 px-3 py-2.5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex min-w-0 items-center gap-3 xl:min-w-[18rem]">
            <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-700 animate-glow-pulse dark:bg-emerald-400" />
            <h1 className="truncate font-display text-xl font-bold tracking-tight">
              Agent Explorer
            </h1>
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-4 gap-4 xl:max-w-2xl">
            <ExplorerMetric value={formatCompactUsd(oneDayVolume.series.summary.totalUsd)} label="24H Volume" />
            <ExplorerMetric value={oneDayTrades > 0 ? oneDayTrades.toLocaleString() : '—'} label="24H Fills" />
            <ExplorerMetric value={tradesPerHour > 0 ? formatNumber(tradesPerHour, { maximumFractionDigits: 1 }) : '—'} label="Fills/Hr" />
            <ExplorerMetric value={activeAgents.toLocaleString()} label="Active" />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/"
              className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/55 px-3 text-sm font-display font-medium text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary"
            >
              <span className="i-ph:chart-line-up text-sm" />
              Terminal
            </Link>
            <Link
              to="/provision"
              className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-violet-500/22 bg-violet-500/12 px-3 text-sm font-display font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
            >
              <span className="i-ph:plus-bold text-xs" />
              Deploy
            </Link>
          </div>
        </div>
      </section>

      <OperatorSessionBanner />

      {isLoading ? (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.42fr)]">
          <SkeletonCard className="h-full min-h-[360px]" />
          <SkeletonCard className="h-full min-h-[360px]" />
          <SkeletonCard className="h-full min-h-[300px] lg:col-span-2" />
        </div>
      ) : sortedBots.length === 0 ? (
        operatorDataState !== 'ready' && isConnected ? (
          <OperatorAccessCard
            apiUrls={ALL_TRADING_OPERATOR_API_URLS}
            title="Operator authentication required"
            description="Authenticate to load operator-managed agents and live leaderboard metrics."
          />
        ) : !isConnected ? (
          <ConnectWalletPanel
            title="Connect your wallet to get started"
            description="Connect a wallet to deploy an agent or follow live performance."
            bullets={['Deploy an agent', 'Track returns and fills', 'Configure operator secrets']}
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
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-rows-[minmax(260px,0.7fr)_minmax(220px,0.45fr)_minmax(300px,0.8fr)]">
          <PlatformVolumeChart
            bots={leaderboardBots}
            variant="command"
            className="min-h-0"
          />
          <LatestAgentTrades
            bots={leaderboardBots}
            variant="explorer"
            limit={50}
            className="min-h-0"
          />
          <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/54">
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-arena-elements-dividerColor/60 px-3">
              <h2 className="font-display text-lg font-semibold tracking-tight text-arena-elements-textPrimary">
                Agents
              </h2>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                <div className="relative min-w-[12rem] max-w-[24rem] flex-1 sm:flex-none">
                  <span className="i-ph:magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-arena-elements-textTertiary" aria-hidden="true" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    aria-label="Search agents"
                    placeholder="Search agent, strategy, address"
                    className="h-8 w-full rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/58 pl-8 pr-2 font-display text-sm text-arena-elements-textPrimary outline-none transition-colors placeholder:text-arena-elements-textTertiary focus:border-violet-500/55 focus:ring-2 focus:ring-violet-500/18"
                  />
                </div>
                <span className="hidden font-data text-sm text-arena-elements-textTertiary sm:inline">
                  {visibleBots.length.toLocaleString()} / {sortedBots.length.toLocaleString()}
                </span>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
              {visibleBots.length > 0 ? (
                <LeaderboardTable bots={visibleBots} />
              ) : (
                <div className="flex h-full min-h-[16rem] items-center justify-center px-6 text-center font-display text-sm text-arena-elements-textSecondary">
                  No agents match that search.
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
