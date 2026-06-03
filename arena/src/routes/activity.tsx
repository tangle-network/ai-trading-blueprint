import { useEffect, useMemo, useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useAccount } from 'wagmi';
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
  { title: 'Execution Activity — AI Trading Arena' },
];

function ActivityMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="font-data text-sm font-bold leading-none text-[#f6fefd]">
        {value}
      </div>
      <div className="mt-0.5 truncate font-data text-[10px] uppercase text-[#697371]">
        {label}
      </div>
    </div>
  );
}

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
    <div className="mx-auto flex min-h-full max-w-[1560px] flex-col gap-2 px-2 py-2 sm:px-3 lg:h-full lg:overflow-hidden">
      <section className="shrink-0 overflow-hidden rounded-[6px] border border-[#273035] bg-[#0f1a1f]">
        <div className="flex min-h-12 flex-col gap-2 px-3 py-2 min-[1120px]:flex-row min-[1120px]:items-center">
          <div className="flex min-w-0 items-center gap-3 min-[1120px]:w-[18rem] min-[1120px]:shrink-0">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#50d2c1] shadow-[0_0_16px_rgba(80,210,193,0.5)]" aria-hidden="true" />
            <h1 className="truncate font-display text-lg font-semibold tracking-tight text-[#f6fefd]">
              Activity
            </h1>
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-3 gap-4 min-[1120px]:max-w-md">
            <ActivityMetric value={formatCompactUsd(oneDayVolume.series.summary.totalUsd)} label="24H Vol" />
            <ActivityMetric value={displayTradeCount > 0 ? formatNumber(displayTradeCount, { maximumFractionDigits: 0 }) : '—'} label={oneDayTradeCount > 0 ? '24H Fills' : 'Fills'} />
            <ActivityMetric value={formatNumber(activityBots.length, { maximumFractionDigits: 0 })} label="Agents" />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Link
              to="/"
              className="inline-flex h-9 w-fit items-center gap-2 rounded-[5px] border border-[#273035] bg-[#0b1418] px-3 text-sm font-display font-medium text-[#d2dad7] transition-colors hover:bg-[#16242a] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
            >
              <span className="i-ph:chart-line-up text-sm" aria-hidden="true" />
              Terminal
            </Link>
            <Link
              to="/leaderboard"
              className="inline-flex h-9 w-fit items-center gap-2 rounded-[5px] border border-[#273035] bg-[#0b1418] px-3 text-sm font-display font-medium text-[#d2dad7] transition-colors hover:bg-[#16242a] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
            >
              <span className="i-ph:table text-sm" aria-hidden="true" />
              Agents
            </Link>
            <Link
              to="/provision"
              className="inline-flex h-9 w-fit items-center gap-2 rounded-[5px] border border-[#50d2c1]/30 bg-[#123f3a] px-3 text-sm font-display font-medium text-[#c8fffb] transition-colors hover:bg-[#18544e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
            >
              <span className="i-ph:plus-bold text-xs" aria-hidden="true" />
              Deploy
            </Link>
          </div>
        </div>
      </section>

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
