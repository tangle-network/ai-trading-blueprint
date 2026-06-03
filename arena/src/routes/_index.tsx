import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { useLatestAgentTrades, usePlatformVolumeSeries, type LatestAgentTrade } from '~/lib/hooks/useBotApi';
import { LatestAgentTrades } from '~/components/arena/LatestAgentTrades';
import { PlatformVolumeChart } from '~/components/arena/PlatformVolumeChart';
import { ArenaTopAgentsPanel } from '~/components/arena/ArenaTopAgentsPanel';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { formatCompactUsd, formatNumber } from '~/lib/format';
import { isPublicLeaderboardBot } from '~/lib/botVisibility';
import { buildAgentActivityStats, type AgentActivityStats } from '~/lib/agentActivity';
import type { Bot } from '~/lib/types/bot';
import {
  formatTradeActionLabel,
  formatTradeAge,
  formatTradeUsd,
  getTradeActionToneClass,
  getTradeMarketLabel,
} from '~/lib/tradeDisplay';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';

export const meta: MetaFunction = () => [
  { title: 'AI Trading Arena' },
];

interface HomeWorkspaceLayout {
  volumePercent: number;
  fillsWidth: number;
  fillsCollapsed: boolean;
  agentsCollapsed: boolean;
}

const HOME_WORKSPACE_LAYOUT_KEY = 'arena:home-workspace-layout';
const DEFAULT_HOME_WORKSPACE_LAYOUT: HomeWorkspaceLayout = {
  volumePercent: 68,
  fillsWidth: 380,
  fillsCollapsed: false,
  agentsCollapsed: false,
};

function normalizeHomeWorkspaceLayout(value: Partial<HomeWorkspaceLayout>): HomeWorkspaceLayout {
  return {
    volumePercent: clampNumber(Number(value.volumePercent) || DEFAULT_HOME_WORKSPACE_LAYOUT.volumePercent, 46, 78),
    fillsWidth: clampNumber(Number(value.fillsWidth) || DEFAULT_HOME_WORKSPACE_LAYOUT.fillsWidth, 320, 560),
    fillsCollapsed: value.fillsCollapsed === true,
    agentsCollapsed: value.agentsCollapsed === true,
  };
}

function formatPulseNumber(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 0 });
}

function formatPulsePercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  return `${formatNumber(value * 100, { maximumFractionDigits: 0 })}%`;
}

function PulseCell({
  label,
  value,
  detail,
  children,
  to,
}: {
  label: string;
  value?: string;
  detail?: string;
  children?: ReactNode;
  to?: string;
}) {
  const content = (
    <>
      <div className="font-data text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
        {label}
      </div>
      {children ?? (
        <>
          <div className="mt-1 truncate font-data text-xl font-bold leading-none tabular-nums text-[var(--arena-terminal-text)]">
            {value ?? '—'}
          </div>
          {detail && (
            <div className="mt-1 truncate font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
              {detail}
            </div>
          )}
        </>
      )}
    </>
  );
  const className = 'min-w-0 border-b border-[var(--arena-terminal-border)] px-3 py-2.5 last:border-b-0 min-[980px]:border-b-0 min-[980px]:border-r min-[980px]:last:border-r-0';

  if (to) {
    return (
      <Link
        to={to}
        className={`${className} block transition-colors hover:bg-[var(--arena-terminal-panel-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60`}
      >
        {content}
      </Link>
    );
  }

  return (
    <div className={className}>
      {content}
    </div>
  );
}

function HomePulseBoard({
  latestActivity,
  topActivityBot,
  topActivityStats,
  recentFlowUsd,
  recentFills,
  platformVolumeUsd,
  platformLiveUsd,
  platformFills,
}: {
  latestActivity: LatestAgentTrade | null;
  topActivityBot: Bot | null;
  topActivityStats: AgentActivityStats | null;
  recentFlowUsd: number;
  recentFills: number;
  platformVolumeUsd: number;
  platformLiveUsd: number;
  platformFills: number;
}) {
  const latestTrade = latestActivity?.trade ?? null;
  const latestBot = latestActivity?.bot ?? null;
  const latestMarket = latestTrade
    ? getTradeMarketLabel(latestTrade)
    : topActivityStats?.lastMarket ?? '—';
  const topAgentHref = topActivityBot ? `/arena/bot/${encodeURIComponent(topActivityBot.id)}/performance` : undefined;
  const latestHref = latestActivity ? `/arena/bot/${encodeURIComponent(latestActivity.botId)}/performance` : topAgentHref;
  const liveShare = platformVolumeUsd > 0 ? platformLiveUsd / platformVolumeUsd : 0;

  return (
    <section
      aria-label="Market pulse"
      className="grid shrink-0 overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] min-[980px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,0.95fr)_minmax(0,0.95fr)]"
    >
      <PulseCell label="Latest" to={latestHref}>
        {latestTrade ? (
          <>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <span className={`shrink-0 font-data text-sm font-bold uppercase ${getTradeActionToneClass(latestTrade.action)}`}>
                {formatTradeActionLabel(latestTrade.action)}
              </span>
              <span className="min-w-0 truncate font-display text-lg font-semibold leading-none text-[var(--arena-terminal-text)]">
                {latestMarket}
              </span>
              <span className="shrink-0 font-data text-base font-bold tabular-nums text-[var(--arena-terminal-text)]">
                {formatTradeUsd(latestTrade.notionalUsd)}
              </span>
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2">
              {latestBot && (
                <Identicon address={latestBot.operatorAddress as Address} size={20} />
              )}
              <span className="min-w-0 truncate font-display text-sm font-semibold text-[var(--arena-terminal-text-secondary)]">
                {latestActivity?.botName ?? latestTrade.botName}
              </span>
              <span className="shrink-0 font-data text-[11px] tabular-nums text-[var(--arena-terminal-text-muted)]">
                {formatTradeAge(latestTrade.timestamp)}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="mt-1 truncate font-data text-xl font-bold leading-none text-[var(--arena-terminal-text)]">
              No fills yet
            </div>
            <div className="mt-1 truncate font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
              Waiting for active agents
            </div>
          </>
        )}
      </PulseCell>

      <PulseCell
        label="24H Flow"
        value={formatCompactUsd(recentFlowUsd)}
        detail={`${formatPulseNumber(recentFills)} fills`}
      />

      <PulseCell label="Top Agent" to={topAgentHref}>
        {topActivityBot ? (
          <>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <Identicon address={topActivityBot.operatorAddress as Address} size={24} />
              <span className="min-w-0 truncate font-display text-lg font-semibold leading-none text-[var(--arena-terminal-text)]">
                {topActivityBot.name}
              </span>
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
              <span className="shrink-0 tabular-nums text-[var(--arena-terminal-text-secondary)]">
                24h {formatCompactUsd(topActivityStats?.recentNotionalUsd ?? 0)}
              </span>
              <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--arena-terminal-text-subtle)]" aria-hidden="true" />
              <span className="truncate">
                {formatPulseNumber(topActivityStats?.recentFills ?? 0)} fills
              </span>
              {topActivityStats?.lastTradeAt && (
                <>
                  <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--arena-terminal-text-subtle)]" aria-hidden="true" />
                  <span className="shrink-0 tabular-nums">{formatTradeAge(topActivityStats.lastTradeAt)}</span>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="mt-1 truncate font-data text-xl font-bold leading-none text-[var(--arena-terminal-text)]">
              —
            </div>
            <div className="mt-1 truncate font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
              No active public agent
            </div>
          </>
        )}
      </PulseCell>

      <PulseCell
        label="30D Platform"
        value={formatCompactUsd(platformVolumeUsd)}
        detail={`${formatPulseNumber(platformFills)} fills · ${formatPulsePercent(liveShare)} live`}
      />
    </section>
  );
}

function HomeWorkspacePanels({
  leaderboardBots,
  activityStatsByBotId,
}: {
  leaderboardBots: Bot[];
  activityStatsByBotId: Map<string, AgentActivityStats>;
}) {
  const workspaceRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    HOME_WORKSPACE_LAYOUT_KEY,
    DEFAULT_HOME_WORKSPACE_LAYOUT,
    normalizeHomeWorkspaceLayout,
  );
  const restoreAgents = () => setLayout((current) => ({ ...current, agentsCollapsed: false }));
  const toggleAgents = () => setLayout((current) => ({ ...current, agentsCollapsed: !current.agentsCollapsed }));
  const toggleFills = () => setLayout((current) => ({ ...current, fillsCollapsed: !current.fillsCollapsed }));
  const resetLayout = () => setLayout(DEFAULT_HOME_WORKSPACE_LAYOUT);

  function startColumnResize(event: Parameters<typeof beginWorkspaceResize>[0]) {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setLayout((current) => ({ ...current, fillsCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const maxWidth = Math.min(560, Math.max(340, rect.width * 0.48));
        const nextWidth = clampNumber(rect.right - moveEvent.clientX, 320, maxWidth);
        setLayout((current) => ({ ...current, fillsWidth: nextWidth, fillsCollapsed: false }));
      },
    });
  }

  function startRowResize(event: Parameters<typeof beginWorkspaceResize>[0]) {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setLayout((current) => ({ ...current, agentsCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'row-resize',
      onMove: (moveEvent) => {
        const nextPercent = clampNumber(((moveEvent.clientY - rect.top) / rect.height) * 100, 46, 78);
        setLayout((current) => ({ ...current, volumePercent: nextPercent, agentsCollapsed: false }));
      },
    });
  }

  const gridStyle: CSSProperties = {
    gridTemplateColumns: layout.fillsCollapsed
      ? 'minmax(0,1fr) 8px 44px'
      : `minmax(0,1fr) 8px minmax(320px, ${layout.fillsWidth}px)`,
    gridTemplateRows: layout.agentsCollapsed
      ? 'minmax(0,1fr) 8px 44px'
      : `minmax(260px, ${layout.volumePercent}fr) 8px minmax(190px, ${100 - layout.volumePercent}fr)`,
  };

  return (
    <section
      ref={workspaceRef}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden lg:grid lg:gap-0"
      style={gridStyle}
      aria-label="Arena fleet terminal"
    >
      <PlatformVolumeChart
        bots={leaderboardBots}
        variant="command"
        className="col-start-1 row-start-1 min-h-[320px] lg:min-h-0"
        headerControls={(
          <>
            <WorkspaceControlButton
              label={layout.agentsCollapsed ? 'Restore top agents' : 'Expand volume'}
              icon={layout.agentsCollapsed ? 'i-ph:arrows-in-line-vertical' : 'i-ph:arrows-out-line-vertical'}
              onClick={toggleAgents}
            />
            <WorkspaceControlButton
              label="Reset workspace"
              icon="i-ph:arrow-counter-clockwise"
              onClick={resetLayout}
            />
          </>
        )}
      />

      <WorkspaceResizeHandle
        testId="home-row-resize-handle"
        orientation="horizontal"
        className="col-start-1 row-start-2"
        ariaLabel="Resize volume and top agents"
        title="Drag to resize volume and top agents"
        onPointerDown={startRowResize}
      />

      {layout.agentsCollapsed ? (
        <WorkspaceCollapsedPane
          label="Top agents"
          icon="i-ph:table"
          className="col-start-1 row-start-3 flex min-h-0 items-center justify-between border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-3 text-left text-[var(--arena-terminal-text-secondary)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60"
          onClick={restoreAgents}
        />
      ) : (
        <ArenaTopAgentsPanel
          bots={leaderboardBots}
          variant="table"
          metricMode="activity"
          activityStatsByBotId={activityStatsByBotId}
          limit={7}
          className="col-start-1 row-start-3 min-h-[220px] lg:min-h-0"
          headerControls={(
            <WorkspaceControlButton
              label="Minimize top agents"
              icon="i-ph:minus-bold"
              onClick={toggleAgents}
            />
          )}
        />
      )}

      <WorkspaceResizeHandle
        testId="home-column-resize-handle"
        orientation="vertical"
        className="col-start-2 row-start-1 row-span-3"
        ariaLabel="Resize fills rail"
        title="Drag to resize fills rail"
        onPointerDown={startColumnResize}
      />

      {layout.fillsCollapsed ? (
        <WorkspaceCollapsedPane
          label="Fills"
          icon="i-ph:list-bullets"
          orientation="vertical"
          className="col-start-3 row-start-1 row-span-3 flex min-h-0 flex-col items-center justify-between border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] py-3 text-[var(--arena-terminal-text-secondary)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60"
          onClick={toggleFills}
        />
      ) : (
        <LatestAgentTrades
          bots={leaderboardBots}
          variant="panel"
          limit={14}
          className="col-start-3 row-start-1 row-span-3 min-h-[280px] lg:min-h-0"
          headerControls={(
            <WorkspaceControlButton
              label="Minimize fills"
              icon="i-ph:sidebar-simple"
              onClick={toggleFills}
            />
          )}
        />
      )}
    </section>
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
  const { trades: homeActivityTrades } = useLatestAgentTrades(leaderboardBots, {
    limit: 120,
    perBotLimit: 50,
    maxBots: 64,
  });
  const activityStatsByBotId = useMemo(
    () => buildAgentActivityStats(homeActivityTrades),
    [homeActivityTrades],
  );
  const latestActivity = homeActivityTrades[0] ?? null;
  const recentActivitySummary = useMemo(() => {
    return Array.from(activityStatsByBotId.values()).reduce(
      (summary, stats) => ({
        recentFlowUsd: summary.recentFlowUsd + stats.recentNotionalUsd,
        recentFills: summary.recentFills + stats.recentFills,
      }),
      { recentFlowUsd: 0, recentFills: 0 },
    );
  }, [activityStatsByBotId]);
  const topActivity = useMemo(() => {
    return leaderboardBots.reduce<{ bot: Bot; stats: AgentActivityStats | null } | null>((best, bot) => {
      const stats = activityStatsByBotId.get(bot.id) ?? null;
      if (!best) return { bot, stats };
      const bestStats = best.stats;
      const notionalDelta = (stats?.recentNotionalUsd ?? 0) - (bestStats?.recentNotionalUsd ?? 0);
      if (notionalDelta > 0) return { bot, stats };
      if (notionalDelta < 0) return best;
      const fillsDelta = (stats?.recentFills ?? 0) - (bestStats?.recentFills ?? 0);
      if (fillsDelta > 0) return { bot, stats };
      if (fillsDelta < 0) return best;
      if ((stats?.lastTradeAt ?? 0) > (bestStats?.lastTradeAt ?? 0)) return { bot, stats };
      return best;
    }, null);
  }, [activityStatsByBotId, leaderboardBots]);
  const hasPlatformTradeCount = homeVolumeSeries.summary.totalTradeCount > 0;
  const platformTradeCount = hasPlatformTradeCount
    ? homeVolumeSeries.summary.totalTradeCount
    : totalTrades;

  return (
    <div className="arena-trace-terminal mx-auto flex min-h-full max-w-[1560px] flex-col gap-2 px-2 py-2 sm:px-3 lg:h-full lg:overflow-hidden">
      <ArenaPageHeader
        title="Arena"
        titleWidthClassName="min-[1180px]:w-[11rem]"
        metrics={[
          { value: formatNumber(leaderboardBots.length, { maximumFractionDigits: 0 }), label: 'Agents' },
          { value: formatCompactUsd(homeVolumeSeries.summary.totalUsd), label: '30D Vol' },
          {
            value: platformTradeCount > 0 ? formatNumber(platformTradeCount, { maximumFractionDigits: 0 }) : '—',
            label: hasPlatformTradeCount ? '30D Fills' : 'Fills',
          },
        ]}
        controls={(
          <>
            <ArenaHeaderLink to="/leaderboard" icon="i-ph:table">Agents</ArenaHeaderLink>
            <ArenaHeaderLink to="/provision" icon="i-ph:plus-bold" variant="primary">Deploy</ArenaHeaderLink>
          </>
        )}
      />

      <OperatorSessionBanner />

      {isLoading ? (
        <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.34fr)]">
          <SkeletonCard className="h-full min-h-[420px]" />
          <SkeletonCard className="h-full min-h-[240px]" />
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
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <HomePulseBoard
            latestActivity={latestActivity}
            topActivityBot={topActivity?.bot ?? null}
            topActivityStats={topActivity?.stats ?? null}
            recentFlowUsd={recentActivitySummary.recentFlowUsd}
            recentFills={recentActivitySummary.recentFills}
            platformVolumeUsd={homeVolumeSeries.summary.totalUsd}
            platformLiveUsd={homeVolumeSeries.summary.liveUsd}
            platformFills={platformTradeCount}
          />
          <HomeWorkspacePanels
            leaderboardBots={leaderboardBots}
            activityStatsByBotId={activityStatsByBotId}
          />
        </div>
      )}
    </div>
  );
}
