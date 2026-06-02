import { useEffect, useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { Identicon } from '@tangle-network/blueprint-ui/components';
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
import { isPublicLeaderboardBot } from '~/lib/botVisibility';

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

function formatSignedPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${formatNumber(value, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })}%`;
}

export default function IndexPage() {
  const { isConnected } = useAccount();
  const [search, setSearch] = useState('');
  useTradingRouteAutoAuth({
    enabled: isConnected && HAS_TRADING_OPERATOR_API,
    routeKey: 'leaderboard',
  });
  const { bots: rawBots, isLoading, operatorDataState } = useBots();
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setEnrichmentEnabled(true), 900);
    return () => window.clearTimeout(timer);
  }, []);
  const bots = useBotEnrichment(rawBots, { enabled: enrichmentEnabled });

  const leaderboardBots = bots.filter(isPublicLeaderboardBot);

  const filteredBots = leaderboardBots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(search.toLowerCase()) ||
      bot.strategyType.toLowerCase().includes(search.toLowerCase()) ||
      bot.vaultAddress.toLowerCase().includes(search.toLowerCase()) ||
      bot.operatorAddress.toLowerCase().includes(search.toLowerCase()),
  );

  const sorted = rankLeaderboardBots(filteredBots);

  const totalTrades = leaderboardBots.reduce((sum, b) => sum + b.totalTrades, 0);
  const leaderboardRows = sorted.slice(0, 10);
  const { series: homeVolumeSeries } = usePlatformVolumeSeries(leaderboardBots, '30d');
  const hasPlatformTradeCount = homeVolumeSeries.summary.totalTradeCount > 0;
  const platformTradeCount = hasPlatformTradeCount
    ? homeVolumeSeries.summary.totalTradeCount
    : totalTrades;
  const topReturnBot = leaderboardBots
    .filter((bot) => Number.isFinite(bot.pnlPercent))
    .sort((left, right) => right.pnlPercent - left.pnlPercent)[0];
  const mostActiveBot = leaderboardBots
    .filter((bot) => bot.totalTrades > 0)
    .sort((left, right) => right.totalTrades - left.totalTrades)[0];
  const showTopReturnBot = topReturnBot != null && Math.abs(topReturnBot.pnlPercent) >= 0.05;
  const showMostActiveBot = mostActiveBot != null && mostActiveBot.totalTrades > 0;

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6">
      <section className="mb-3 rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/70 px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-700 animate-glow-pulse dark:bg-emerald-400" />
            <h1 className="truncate font-display text-2xl font-bold tracking-tight">
              AI Trading Arena
            </h1>
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
            <div className="min-w-0 rounded-lg border border-arena-elements-dividerColor/55 bg-arena-elements-background-depth-1/40 px-3 py-2">
              <div className="font-data text-xl font-bold leading-none text-arena-elements-textPrimary">
                {leaderboardBots.length.toLocaleString()}
              </div>
              <div className="mt-1 truncate text-xs text-arena-elements-textSecondary">agents</div>
            </div>
            <div className="min-w-0 rounded-lg border border-arena-elements-dividerColor/55 bg-arena-elements-background-depth-1/40 px-3 py-2">
              <div className="font-data text-xl font-bold leading-none text-arena-elements-textPrimary">
                {formatCompactUsd(homeVolumeSeries.summary.totalUsd)}
              </div>
              <div className="mt-1 truncate text-xs text-arena-elements-textSecondary">30D volume</div>
            </div>
            <div className="min-w-0 rounded-lg border border-arena-elements-dividerColor/55 bg-arena-elements-background-depth-1/40 px-3 py-2">
              <div className="font-data text-xl font-bold leading-none text-arena-elements-textPrimary">
                {platformTradeCount > 0 ? platformTradeCount.toLocaleString() : '—'}
              </div>
              <div className="mt-1 truncate text-xs text-arena-elements-textSecondary">
                {hasPlatformTradeCount ? '30D trades' : 'trades'}
              </div>
            </div>
            {showTopReturnBot ? (
              <Link
                to={`/arena/bot/${encodeURIComponent(topReturnBot.id)}/performance`}
                className="min-w-0 rounded-lg border border-arena-elements-dividerColor/55 bg-arena-elements-background-depth-1/40 px-3 py-2 transition-colors hover:bg-arena-elements-item-backgroundHover"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Identicon address={topReturnBot.operatorAddress as Address} size={22} />
                  <div className="min-w-0">
                    <div className="font-data text-lg font-bold leading-none text-arena-elements-icon-success">
                      {formatSignedPercent(topReturnBot.pnlPercent)}
                    </div>
                    <div className="mt-1 truncate text-xs text-arena-elements-textSecondary">{topReturnBot.name}</div>
                  </div>
                </div>
              </Link>
            ) : null}
            {showMostActiveBot ? (
              <Link
                to={`/arena/bot/${encodeURIComponent(mostActiveBot.id)}/performance`}
                className="min-w-0 rounded-lg border border-arena-elements-dividerColor/55 bg-arena-elements-background-depth-1/40 px-3 py-2 transition-colors hover:bg-arena-elements-item-backgroundHover"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Identicon address={mostActiveBot.operatorAddress as Address} size={22} />
                  <div className="min-w-0">
                    <div className="font-data text-lg font-bold leading-none text-arena-elements-textPrimary">
                      {mostActiveBot.totalTrades.toLocaleString()}
                    </div>
                    <div className="mt-1 truncate text-xs text-arena-elements-textSecondary">{mostActiveBot.name}</div>
                  </div>
                </div>
              </Link>
            ) : null}
          </div>
          <Link
            to="/provision"
            className="inline-flex h-10 w-fit shrink-0 items-center gap-2 rounded-lg border border-violet-500/22 bg-violet-500/12 px-3 text-sm font-display font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
          >
            <span className="i-ph:plus-bold text-xs" />
            Deploy Agent
          </Link>
        </div>
      </section>

      <section
        className="mb-5 grid h-[min(620px,calc(100dvh-17rem))] min-h-[480px] gap-3 xl:grid-cols-[minmax(0,1fr)_540px]"
        aria-label="Platform volume and live fill tape"
      >
        <PlatformVolumeChart
          bots={leaderboardBots}
          variant="command"
          className="h-full min-h-0"
        />
        <LatestAgentTrades
          bots={leaderboardBots}
          variant="panel"
          limit={20}
          className="h-full min-h-0"
        />
      </section>

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight">Top agents</h2>
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
        <LeaderboardTable bots={leaderboardRows} />
      )}
    </div>
  );
}
