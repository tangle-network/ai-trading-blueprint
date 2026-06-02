import { useEffect, useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useAccount } from 'wagmi';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { usePlatformVolumeSeries } from '~/lib/hooks/useBotApi';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import { PlatformVolumeChart } from '~/components/arena/PlatformVolumeChart';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { formatCompactUsd } from '~/lib/format';
import { isPublicLeaderboardBot } from '~/lib/botVisibility';

export const meta: MetaFunction = () => [
  { title: 'AI Trading Arena' },
];

function HeaderMetric({ value, label }: { value: string; label: string }) {
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

export default function IndexPage() {
  const { isConnected } = useAccount();
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

  const totalTrades = leaderboardBots.reduce((sum, b) => sum + b.totalTrades, 0);
  const { series: homeVolumeSeries } = usePlatformVolumeSeries(leaderboardBots, '30d');
  const hasPlatformTradeCount = homeVolumeSeries.summary.totalTradeCount > 0;
  const platformTradeCount = hasPlatformTradeCount
    ? homeVolumeSeries.summary.totalTradeCount
    : totalTrades;

  return (
    <div className="mx-auto flex min-h-full max-w-[1500px] flex-col gap-3 px-3 py-3 sm:px-4 lg:h-full lg:overflow-hidden">
      <section className="shrink-0 rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/70 px-3 py-2.5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex min-w-0 items-center gap-3 xl:min-w-[18rem]">
            <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-700 animate-glow-pulse dark:bg-emerald-400" />
            <h1 className="truncate font-display text-xl font-bold tracking-tight">
              AI Trading Arena
            </h1>
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-3 gap-4 xl:max-w-xl">
            <HeaderMetric value={leaderboardBots.length.toLocaleString()} label="Agents" />
            <HeaderMetric value={formatCompactUsd(homeVolumeSeries.summary.totalUsd)} label="30D Volume" />
            <HeaderMetric value={platformTradeCount > 0 ? platformTradeCount.toLocaleString() : '—'} label={hasPlatformTradeCount ? '30D Fills' : 'Fills'} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/leaderboard"
              className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/55 px-3 text-sm font-display font-medium text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary"
            >
              <span className="i-ph:table text-sm" />
              Agent Explorer
            </Link>
            <Link
              to="/provision"
              className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-violet-500/22 bg-violet-500/12 px-3 text-sm font-display font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
            >
              <span className="i-ph:plus-bold text-xs" />
              Deploy Agent
            </Link>
          </div>
        </div>
      </section>

      <OperatorSessionBanner />

      {isLoading ? (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.44fr)]">
          <SkeletonCard className="h-full min-h-[420px]" />
          <SkeletonCard className="h-full min-h-[420px]" />
        </div>
      ) : leaderboardBots.length === 0 ? (
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
        <section
          className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.44fr)]"
          aria-label="Arena market terminal"
        >
          <PlatformVolumeChart
            bots={leaderboardBots}
            variant="command"
            className="h-full min-h-0"
          />
          <LatestAgentTrades
            bots={leaderboardBots}
            variant="panel"
            limit={18}
            className="h-full min-h-0"
          />
        </section>
      )}
    </div>
  );
}
