import { useEffect, useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { usePlatformVolumeSeries } from '~/lib/hooks/useBotApi';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import { PlatformVolumeChart } from '~/components/arena/PlatformVolumeChart';
import { SparklineChart } from '~/components/arena/SparklineChart';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { formatCompactUsd, formatNumber, STRATEGY_SHORT, botStatusLabel } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';
import { isPublicLeaderboardBot } from '~/lib/botVisibility';
import type { Bot } from '~/lib/types/bot';

export const meta: MetaFunction = () => [
  { title: 'AI Trading Arena' },
];

function formatSignedPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${formatNumber(value, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })}%`;
}

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

function CompactLeaderboardPanel({
  bots,
  search,
  onSearchChange,
}: {
  bots: Bot[];
  search: string;
  onSearchChange: (value: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/54">
      <div className="flex shrink-0 items-center gap-3 border-b border-arena-elements-dividerColor/60 px-4 py-3">
        <h2 className="shrink-0 font-display text-lg font-semibold tracking-tight text-arena-elements-textPrimary">
          Top agents
        </h2>
        <div className="relative min-w-0 flex-1">
          <span className="i-ph:magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-arena-elements-textTertiary" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            aria-label="Search leaderboard by agent, strategy, or address"
            placeholder="Search"
            className="h-8 w-full rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/58 pl-8 pr-2 font-display text-sm text-arena-elements-textPrimary outline-none transition-colors placeholder:text-arena-elements-textTertiary focus:border-violet-500/55 focus:ring-2 focus:ring-violet-500/18"
          />
        </div>
      </div>

      {bots.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-arena-elements-textSecondary">
          No matching agents.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          <div className="divide-y divide-arena-elements-dividerColor/50">
            {bots.map((bot, index) => {
              const href = `/arena/bot/${encodeURIComponent(bot.id)}/performance`;
              const strategy = STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType;
              const positive = bot.pnlPercent >= 0;
              return (
                <Link
                  key={bot.id}
                  to={href}
                  className="grid min-h-[4.25rem] grid-cols-[2rem_minmax(0,1fr)_3.7rem] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-arena-elements-item-backgroundHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 2xl:grid-cols-[2rem_minmax(0,1fr)_4.6rem_3.7rem]"
                >
                  <div className="font-data text-sm font-semibold text-arena-elements-textTertiary">
                    {index + 1}
                  </div>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Identicon address={bot.operatorAddress as Address} size={26} />
                    <div className="min-w-0">
                      <div className="truncate font-display text-sm font-semibold text-arena-elements-textPrimary">
                        {bot.name || 'Unnamed agent'}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-arena-elements-textTertiary">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bot.status === 'active' ? 'bg-emerald-500' : 'bg-arena-elements-textTertiary/55'}`} />
                        <span className="truncate">{strategy}</span>
                        <span className="shrink-0">/</span>
                        <span className="truncate">{botStatusLabel(bot.status)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="hidden justify-self-end 2xl:block">
                    <SparklineChart data={bot.sparklineData} positive={positive} width={56} height={22} />
                  </div>
                  <div className="text-right">
                    {bot.pnlPercent !== 0 ? (
                      <div className={`font-data text-sm font-bold ${positive ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'}`}>
                        {formatSignedPercent(bot.pnlPercent)}
                      </div>
                    ) : (
                      <div className="font-data text-sm text-arena-elements-textTertiary">—</div>
                    )}
                    <div className="mt-0.5 font-data text-xs text-arena-elements-textTertiary">
                      {bot.totalTrades > 0 ? `${bot.totalTrades.toLocaleString()} fills` : '—'}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
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
              Leaderboard
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
          <div className="grid min-h-[620px] gap-3 lg:min-h-0 lg:grid-rows-2">
            <SkeletonCard className="h-full" />
            <SkeletonCard className="h-full" />
          </div>
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
        <section
          className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.44fr)]"
          aria-label="Arena market terminal"
        >
          <PlatformVolumeChart
            bots={leaderboardBots}
            variant="command"
            className="h-full min-h-0"
          />
          <div className="grid min-h-[620px] gap-3 lg:min-h-0 lg:grid-rows-[minmax(0,1.12fr)_minmax(240px,0.88fr)]">
            <LatestAgentTrades
              bots={leaderboardBots}
              variant="panel"
              limit={12}
              className="h-full min-h-0"
            />
            <CompactLeaderboardPanel
              bots={leaderboardRows}
              search={search}
              onSearchChange={setSearch}
            />
          </div>
        </section>
      )}
    </div>
  );
}
