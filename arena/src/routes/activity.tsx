import { useEffect, useMemo, useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useAccount } from 'wagmi';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { isPublicLeaderboardBot } from '~/lib/botVisibility';
import { formatCompactUsd, formatNumber } from '~/lib/format';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { useBots } from '~/lib/hooks/useBots';
import { usePlatformVolumeSeries } from '~/lib/hooks/useBotApi';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';

export const meta: MetaFunction = () => [
  { title: 'Execution Activity — Tangle Trading' },
];

export default function ActivityPage() {
  const { isConnected } = useAccount();
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(false);

  useTradingRouteAutoAuth({
    enabled: isConnected && HAS_TRADING_OPERATOR_API,
    routeKey: 'activity',
  });

  const { bots: rawBots, isLoading, operatorDataState } = useBots();

  useEffect(() => {
    const timer = window.setTimeout(() => setEnrichmentEnabled(true), 600);
    return () => window.clearTimeout(timer);
  }, []);

  const bots = useBotEnrichment(rawBots, { enabled: enrichmentEnabled });
  const activityBots = useMemo(() => bots.filter(isPublicLeaderboardBot), [bots]);
  const oneDayVolume = usePlatformVolumeSeries(activityBots, '1d');
  const oneDayTradeCount = oneDayVolume.series.summary.totalTradeCount;
  const fallbackTradeCount = activityBots.reduce((sum, bot) => sum + bot.totalTrades, 0);
  const displayTradeCount = oneDayTradeCount > 0 ? oneDayTradeCount : fallbackTradeCount;

  return (
    <div className="flex min-h-full w-full flex-col gap-2 lg:h-full lg:overflow-hidden">
      <ArenaPageHeader
        title="Activity"
        titleWidthClassName="min-[1180px]:w-[11rem]"
        metrics={[
          { value: formatCompactUsd(oneDayVolume.series.summary.totalUsd), label: '24H Vol' },
          { value: displayTradeCount > 0 ? formatNumber(displayTradeCount, { maximumFractionDigits: 0 }) : '—', label: oneDayTradeCount > 0 ? '24H Fills' : 'Fills' },
          { value: formatNumber(activityBots.length, { maximumFractionDigits: 0 }), label: 'Agents' },
        ]}
        controls={(
          <>
            <ArenaHeaderLink to="/" icon="i-ph:chart-line-up">Terminal</ArenaHeaderLink>
            <ArenaHeaderLink to="/leaderboard" icon="i-ph:table">Agents</ArenaHeaderLink>
            <ArenaHeaderLink to="/provision" icon="i-ph:plus-bold" variant="primary">Deploy</ArenaHeaderLink>
          </>
        )}
      />

      <OperatorSessionBanner />

      {isLoading ? (
        <div className="min-h-0 flex-1">
          <SkeletonCard className="h-full min-h-[520px]" />
        </div>
      ) : activityBots.length === 0 ? (
        operatorDataState !== 'ready' && isConnected ? (
          <OperatorAccessCard
            apiUrls={ALL_TRADING_OPERATOR_API_URLS}
            title="Operator authentication required"
            description="Authenticate to load operator-managed agents and live execution activity."
          />
        ) : !isConnected ? (
          <ConnectWalletPanel
            title="Connect your wallet to get started"
            description="Connect a wallet to deploy agents or follow live execution activity."
            bullets={['Deploy an agent', 'Track live fills', 'Inspect agent performance']}
          />
        ) : (
          <div className="flex min-h-[20rem] items-center justify-center rounded-[6px] border border-[#273035] bg-[#0f1a1f] px-6 text-center">
            <div>
              <div className="i-ph:pulse mx-auto mb-4 text-4xl text-[#697371]" aria-hidden="true" />
              <p className="font-display text-base font-semibold text-[#f6fefd]">No execution activity yet</p>
              <Link to="/provision" className="mt-2 inline-flex text-sm font-display text-[#50d2c1] hover:text-[#c8fffb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60">
                Deploy an agent
              </Link>
            </div>
          </div>
        )
      ) : (
        <section
          className="min-h-0 flex-1 overflow-hidden"
          aria-label="Execution explorer"
        >
          <LatestAgentTrades
            bots={activityBots}
            variant="explorer"
            limit={100}
            className="h-full min-h-0"
          />
        </section>
      )}
    </div>
  );
}
