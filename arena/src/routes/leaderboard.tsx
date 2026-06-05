import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useAccount } from 'wagmi';
import type { Address } from 'viem';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { useLatestAgentTrades, usePlatformVolumeSeries, type LatestAgentTrade } from '~/lib/hooks/useBotApi';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { LeaderboardTable } from '~/components/arena/LeaderboardTable';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';
import { isPublicLeaderboardBot } from '~/lib/botVisibility';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';
import { botStatusLabel, formatCompactUsd, formatNumber, formatSignedPercent, STRATEGY_SHORT, truncateAddress } from '~/lib/format';
import { buildAgentActivityStats, type AgentActivityStats } from '~/lib/agentActivity';
import { formatTradeActionLabel, formatTradeAge, getTradeMarketLabel } from '~/lib/tradeDisplay';
import type { Bot } from '~/lib/types/bot';
import {
  fillCountEvidenceTitle,
  resolveFillCountEvidence,
} from '~/lib/tradeEvidence';
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePanePercent,
  shouldCollapsePaneSize,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';

export const meta: MetaFunction = () => [
  { title: 'Agents | Tangle Trading' },
];

interface LeaderboardWorkspaceLayout {
  tablePercent: number;
  cockpitWidth: number;
  dossierCollapsed: boolean;
  cockpitCollapsed: boolean;
}

const LEADERBOARD_WORKSPACE_LAYOUT_KEY = 'arena:leaderboard-workspace-layout';
const DEFAULT_LEADERBOARD_WORKSPACE_LAYOUT: LeaderboardWorkspaceLayout = {
  tablePercent: 58,
  cockpitWidth: 372,
  dossierCollapsed: false,
  cockpitCollapsed: false,
};

function normalizeLeaderboardWorkspaceLayout(value: Partial<LeaderboardWorkspaceLayout>): LeaderboardWorkspaceLayout {
  return {
    tablePercent: clampNumber(
      Number(value.tablePercent) || DEFAULT_LEADERBOARD_WORKSPACE_LAYOUT.tablePercent,
      42,
      76,
    ),
    cockpitWidth: clampNumber(
      Number(value.cockpitWidth) || DEFAULT_LEADERBOARD_WORKSPACE_LAYOUT.cockpitWidth,
      320,
      500,
    ),
    dossierCollapsed: value.dossierCollapsed === true,
    cockpitCollapsed: value.cockpitCollapsed === true,
  };
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

function valueTone(value: number): string {
  if (!Number.isFinite(value) || value === 0) return 'text-[#697371]';
  return value > 0 ? 'text-[var(--arena-terminal-success)]' : 'text-[#ff5d6c]';
}

function formatFlowUsd(value: number): string {
  return value > 0 ? formatCompactUsd(value) : '$0';
}

function formatMode(bot: Bot): string {
  if (bot.paperTrade === true) return 'Paper';
  if (bot.paperTrade === false) return 'Live';
  return 'Unknown';
}

function formatTrust(bot: Bot): string {
  switch (bot.validationTrust) {
    case 'envelope':
      return 'Envelope';
    case 'self_operated':
      return 'Self';
    case 'per_trade':
      return 'Per trade';
    default:
      return 'Per trade';
  }
}

function AgentStat({
  label,
  value,
  tone = 'text-[#f6fefd]',
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 border border-[#273035] bg-[#081013] px-3 py-2.5" title={title}>
      <div className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-[#697371]">{label}</div>
      <div className={`mt-1 truncate font-data text-xl font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 border-b border-[#273035] py-2 last:border-b-0">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#697371]">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-[#f6fefd]">{value}</span>
    </div>
  );
}

function AgentDossierCell({
  label,
  value,
  tone = 'text-[#f6fefd]',
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 border-r border-[#273035] px-3 py-2 last:border-r-0" title={title}>
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[#697371]">{label}</span>
      <span className={`mt-1 block truncate font-data text-base font-bold tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

function SelectedAgentDossier({
  bot,
  activityStats,
  trades,
}: {
  bot: Bot;
  activityStats?: AgentActivityStats;
  trades: LatestAgentTrade[];
}) {
  const hrefBase = `/arena/bot/${encodeURIComponent(bot.id)}`;
  const accountValue = bot.tvl > 0 ? formatCompactUsd(bot.tvl) : 'No NAV';
  const returnValue = bot.pnlPercent !== 0 ? formatSignedPercent(bot.pnlPercent) : '0.0%';
  const recentFills = activityStats?.recentFills ?? 0;
  const recentNotionalUsd = activityStats?.recentNotionalUsd ?? 0;
  const totalFillEvidence = resolveFillCountEvidence({
    visibleTradeCount: activityStats?.totalVisibleFills,
    rosterTradeCount: bot.totalTrades,
  });
  const lastActionValue = activityStats?.lastAction
    ? formatTradeActionLabel(activityStats.lastAction)
    : 'No fills';

  return (
    <section
      aria-label="Selected agent details"
      className="hidden min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] border-t border-[#273035] bg-[#0b1418] min-[1024px]:grid"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#273035] px-3 py-2 min-[1360px]:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <Identicon address={bot.operatorAddress as Address} size={34} />
          <div className="min-w-0">
            <div className="truncate font-display text-base font-semibold text-[#f6fefd]">{bot.name}</div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-[#949e9c]">
              <span>{STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}</span>
              <span className="h-1 w-1 rounded-full bg-[#697371]" aria-hidden="true" />
              <span className={bot.status === 'active' ? 'text-[var(--arena-terminal-success)]' : 'text-[#949e9c]'}>
                {botStatusLabel(bot.status)}
              </span>
              <span className="h-1 w-1 rounded-full bg-[#697371]" aria-hidden="true" />
              <span>{formatMode(bot)}</span>
            </div>
          </div>
        </div>
        <nav className="flex shrink-0 items-center gap-1.5 min-[1360px]:hidden" aria-label={`${bot.name} workspace`}>
          {[
            ['Performance', `${hrefBase}/performance`],
            ['Portfolio', `${hrefBase}/portfolio`],
            ['Runs', `${hrefBase}/runs`],
            ['Chat', `${hrefBase}/chat`],
          ].map(([label, href]) => (
            <Link
              key={href}
              to={href}
              className="inline-flex h-8 items-center justify-center rounded-[5px] border border-[#273035] bg-[#0f1a1f] px-2.5 font-display text-xs font-semibold text-[#d2dad7] transition-[background-color,border-color,color] duration-150 hover:border-[#50d2c1]/50 hover:bg-[#143c38] hover:text-[#f6fefd] focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid grid-cols-6 border-b border-[#273035] min-[1360px]:hidden">
        <AgentDossierCell label="Account" value={accountValue} />
        <AgentDossierCell label="24H Vol" value={formatFlowUsd(recentNotionalUsd)} />
        <AgentDossierCell label="Return" value={returnValue} tone={valueTone(bot.pnlPercent)} />
        <AgentDossierCell label="24H" value={formatNumber(recentFills, { maximumFractionDigits: 0 })} />
        <AgentDossierCell label="Total" value={totalFillEvidence.value > 0 ? formatNumber(totalFillEvidence.value, { maximumFractionDigits: 0 }) : '—'} title={fillCountEvidenceTitle(totalFillEvidence)} />
        <AgentDossierCell label="Last" value={activityStats?.lastTradeAt ? formatTradeAge(activityStats.lastTradeAt) : '—'} />
      </div>

      <div className="grid min-h-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-0 overflow-hidden min-[1360px]:grid-cols-1">
        <div className="min-w-0 overflow-hidden border-r border-[#273035] px-3 py-2 min-[1360px]:hidden">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="font-display text-sm font-semibold text-[#f6fefd]">Execution</span>
            <span className={`rounded-[4px] border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
              bot.tradingActive === false
                ? 'border-[#6f5723] bg-[#201808] text-[#f2c066]'
                : 'border-[#1d5b52] bg-[#143c38] text-[#9cf5e7]'
            }`}>
              {bot.tradingActive === false ? 'Idle' : 'Armed'}
            </span>
          </div>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 font-mono text-xs">
            <span className="uppercase tracking-[0.12em] text-[#697371]">Last</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd]">{lastActionValue}</span>
            <span className="uppercase tracking-[0.12em] text-[#697371]">Trust</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd]">{formatTrust(bot)}</span>
            <span className="uppercase tracking-[0.12em] text-[#697371]">Score</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd]">
              {bot.avgValidatorScore > 0 ? formatNumber(bot.avgValidatorScore, { maximumFractionDigits: 0 }) : 'No score'}
            </span>
            <span className="uppercase tracking-[0.12em] text-[#697371]">Strategy</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd]">{STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}</span>
            <span className="uppercase tracking-[0.12em] text-[#697371]">Mode</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd]">{formatMode(bot)}</span>
            <span className="uppercase tracking-[0.12em] text-[#697371] min-[1360px]:hidden">Chain</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd] min-[1360px]:hidden">{bot.chainId ? String(bot.chainId) : '—'}</span>
            <span className="uppercase tracking-[0.12em] text-[#697371] min-[1360px]:hidden">Operator</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd] min-[1360px]:hidden">{truncateAddress(bot.operatorAddress)}</span>
            <span className="uppercase tracking-[0.12em] text-[#697371] min-[1360px]:hidden">Vault</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd] min-[1360px]:hidden">{truncateAddress(bot.vaultAddress)}</span>
            <span className="uppercase tracking-[0.12em] text-[#697371] min-[1360px]:hidden">Service</span>
            <span className="min-w-0 truncate text-right text-[#f6fefd] min-[1360px]:hidden">{bot.serviceId ? String(bot.serviceId) : '—'}</span>
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col px-3 py-2">
          <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
            <span className="font-display text-sm font-semibold text-[#f6fefd]">Recent fills</span>
            <span className="font-mono text-xs text-[#697371]">{formatNumber(trades.length, { maximumFractionDigits: 0 })}</span>
          </div>
          {trades.length > 0 ? (
            <div
              data-testid="selected-agent-fills-scroll"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain border border-[#273035] [scrollbar-gutter:stable]"
              aria-label="Selected agent recent fills"
            >
              {trades.map(({ trade }) => (
                <div
                  key={trade.id}
                  className="grid grid-cols-[3.75rem_6.25rem_minmax(0,1fr)_5.5rem] items-center gap-2 border-b border-[#273035] px-2.5 py-1.5 last:border-b-0"
                >
                  <span className="font-mono text-[11px] text-[#697371]">{formatTradeAge(trade.timestamp)}</span>
                  <span className="min-w-0 truncate font-data text-xs font-bold text-[var(--arena-terminal-accent)]">
                    {formatTradeActionLabel(trade.action)}
                  </span>
                  <span className="min-w-0 truncate font-mono text-xs text-[#d2dad7]">{getTradeMarketLabel(trade)}</span>
                  <span className="min-w-0 truncate text-right font-data text-xs font-bold text-[#f6fefd]">
                    {formatFlowUsd(trade.notionalUsd ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center border border-[#273035] font-display text-sm text-[#949e9c]">
              No recent fills.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SelectedAgentCockpit({
  bot,
  activityStats,
  className = '',
}: {
  bot: Bot;
  activityStats?: AgentActivityStats;
  className?: string;
}) {
  const hrefBase = `/arena/bot/${encodeURIComponent(bot.id)}`;
  const accountValue = bot.tvl > 0 ? formatCompactUsd(bot.tvl) : 'No NAV';
  const returnValue = bot.pnlPercent !== 0 ? formatSignedPercent(bot.pnlPercent) : '0.0%';
  const recentFills = activityStats?.recentFills ?? 0;
  const recentNotionalUsd = activityStats?.recentNotionalUsd ?? 0;
  const totalFillEvidence = resolveFillCountEvidence({
    visibleTradeCount: activityStats?.totalVisibleFills,
    rosterTradeCount: bot.totalTrades,
  });
  const lastActionValue = activityStats?.lastAction
    ? formatTradeActionLabel(activityStats.lastAction)
    : 'No fills';
  const validatorScore = bot.avgValidatorScore > 0
    ? formatNumber(bot.avgValidatorScore, { maximumFractionDigits: 0 })
    : '—';

  return (
    <aside
      aria-label="Selected agent cockpit"
      className={`min-h-0 flex-col overflow-hidden border-l border-[#273035] bg-[#0b1418] ${className}`}
    >
      <div className="border-b border-[#273035] p-3">
        <div className="flex min-w-0 items-start gap-3">
          <Identicon address={bot.operatorAddress as Address} size={44} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-xl font-semibold tracking-tight text-[#f6fefd]">{bot.name}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-[#949e9c]">
              <span>{STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}</span>
              <span className="h-1 w-1 rounded-full bg-[#697371]" aria-hidden="true" />
              <span className={bot.status === 'active' ? 'text-[var(--arena-terminal-success)]' : 'text-[#949e9c]'}>
                {botStatusLabel(bot.status)}
              </span>
              <span className="h-1 w-1 rounded-full bg-[#697371]" aria-hidden="true" />
              <span>{formatMode(bot)}</span>
            </div>
          </div>
        </div>

        <nav className="mt-3 grid grid-cols-2 gap-2" aria-label={`${bot.name} actions`}>
          {[
            ['Performance', `${hrefBase}/performance`],
            ['Portfolio', `${hrefBase}/portfolio`],
            ['Runs', `${hrefBase}/runs`],
            ['Chat', `${hrefBase}/chat`],
          ].map(([label, href]) => (
            <Link
              key={href}
              to={href}
              className="inline-flex h-9 items-center justify-center rounded-[5px] border border-[#273035] bg-[#0f1a1f] px-2 font-display text-sm font-semibold text-[#d2dad7] transition-[background-color,border-color,color] duration-150 hover:border-[#50d2c1]/50 hover:bg-[#143c38] hover:text-[#f6fefd] focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b border-[#273035] p-3">
        <AgentStat label="Account" value={accountValue} />
        <AgentStat label="24H Vol" value={formatFlowUsd(recentNotionalUsd)} />
        <AgentStat label="Return" value={returnValue} tone={valueTone(bot.pnlPercent)} />
        <AgentStat label="24H" value={formatNumber(recentFills, { maximumFractionDigits: 0 })} />
        <AgentStat label="Total" value={totalFillEvidence.value > 0 ? formatNumber(totalFillEvidence.value, { maximumFractionDigits: 0 }) : '—'} title={fillCountEvidenceTitle(totalFillEvidence)} />
        <AgentStat label="Last" value={activityStats?.lastTradeAt ? formatTradeAge(activityStats.lastTradeAt) : '—'} />
      </div>

      <div className="min-h-0 flex-1 border-t border-[#273035] p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-display text-sm font-semibold text-[#f6fefd]">Routing</h3>
          <span className={`rounded-[4px] border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.12em] ${
            bot.tradingActive === false
              ? 'border-[#6f5723] bg-[#201808] text-[#f2c066]'
              : 'border-[#1d5b52] bg-[#143c38] text-[#9cf5e7]'
          }`}>
            {bot.tradingActive === false ? 'Idle' : 'Armed'}
          </span>
        </div>
        <div>
          <DetailRow label="Operator" value={truncateAddress(bot.operatorAddress)} />
          <DetailRow label="Vault" value={truncateAddress(bot.vaultAddress)} />
          <DetailRow label="Chain" value={bot.chainId ? String(bot.chainId) : '—'} />
          <DetailRow label="Trust" value={formatTrust(bot)} />
          <DetailRow label="Action" value={lastActionValue} />
          <DetailRow label="Score" value={validatorScore === '—' ? 'No score' : validatorScore} />
          <DetailRow label="Service" value={bot.serviceId ? String(bot.serviceId) : '—'} />
        </div>
      </div>
    </aside>
  );
}

export default function LeaderboardPage() {
  const { isConnected } = useAccount();
  const [search, setSearch] = useState('');
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    LEADERBOARD_WORKSPACE_LAYOUT_KEY,
    DEFAULT_LEADERBOARD_WORKSPACE_LAYOUT,
    normalizeLeaderboardWorkspaceLayout,
  );
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
  const latestAgentActivity = useLatestAgentTrades(leaderboardBots, {
    enabled: leaderboardBots.length > 0,
    limit: 200,
    perBotLimit: 50,
    maxBots: 64,
  });
  const activityStatsByBotId = useMemo(
    () => buildAgentActivityStats(latestAgentActivity.trades),
    [latestAgentActivity.trades],
  );
  const sortedBots = useMemo(() => {
    const ranked = rankLeaderboardBots(leaderboardBots);
    const baselineRank = new Map(ranked.map((bot, index) => [bot.id, index]));
    const hasRecentActivity = ranked.some((bot) => (activityStatsByBotId.get(bot.id)?.recentFills ?? 0) > 0);

    if (!hasRecentActivity) return ranked;

    return [...ranked].sort((left, right) => {
      const leftStats = activityStatsByBotId.get(left.id);
      const rightStats = activityStatsByBotId.get(right.id);
      const rightNotional = rightStats?.recentNotionalUsd ?? 0;
      const leftNotional = leftStats?.recentNotionalUsd ?? 0;
      if (rightNotional !== leftNotional) return rightNotional - leftNotional;

      const rightFills = rightStats?.recentFills ?? 0;
      const leftFills = leftStats?.recentFills ?? 0;
      if (rightFills !== leftFills) return rightFills - leftFills;

      const rightLast = rightStats?.lastTradeAt ?? 0;
      const leftLast = leftStats?.lastTradeAt ?? 0;
      if (rightLast !== leftLast) return rightLast - leftLast;

      return (baselineRank.get(left.id) ?? 0) - (baselineRank.get(right.id) ?? 0);
    });
  }, [activityStatsByBotId, leaderboardBots]);
  const visibleBots = useMemo(
    () => sortedBots.filter((bot) => botMatchesSearch(bot, search)),
    [search, sortedBots],
  );
  const oneDayVolume = usePlatformVolumeSeries(leaderboardBots, '1d');
  const oneDayTrades = oneDayVolume.series.summary.totalTradeCount;
  const activeAgents = leaderboardBots.filter((bot) => bot.status === 'active').length;
  const selectedBot = useMemo(
    () => visibleBots.find((bot) => bot.id === selectedBotId) ?? visibleBots[0],
    [selectedBotId, visibleBots],
  );
  const selectedAgentTrades = useMemo(() => {
    if (!selectedBot) return [];
    return latestAgentActivity.trades
      .filter((item) => item.botId === selectedBot.id || item.trade.botId === selectedBot.id);
  }, [latestAgentActivity.trades, selectedBot]);

  useEffect(() => {
    if (visibleBots.length === 0) {
      if (selectedBotId !== null) setSelectedBotId(null);
      return;
    }
    if (!visibleBots.some((bot) => bot.id === selectedBotId)) {
      setSelectedBotId(visibleBots[0].id);
    }
  }, [selectedBotId, visibleBots]);
  const resetLayout = () => setLayout(DEFAULT_LEADERBOARD_WORKSPACE_LAYOUT);
  const explorerStyle = {
    '--leaderboard-cockpit-width': `${layout.cockpitWidth}px`,
  } as CSSProperties;
  const explorerGridClass = layout.cockpitCollapsed
    ? 'min-[1360px]:grid-cols-[minmax(0,1fr)_8px_44px]'
    : 'min-[1360px]:grid-cols-[minmax(0,1fr)_8px_minmax(320px,var(--leaderboard-cockpit-width))]';
  const leftPaneStyle = layout.dossierCollapsed
    ? {
        gridTemplateRows: 'minmax(0,1fr) 8px 44px',
      }
    : {
        gridTemplateRows: `minmax(230px, ${layout.tablePercent}fr) 8px minmax(180px, ${100 - layout.tablePercent}fr)`,
      };
  const startCockpitResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setLayout((current) => ({ ...current, cockpitCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const maxWidth = Math.min(500, Math.max(360, rect.width * 0.42));
        const rawWidth = rect.right - moveEvent.clientX;
        if (shouldCollapsePaneSize(rawWidth)) {
          setLayout((current) => ({
            ...current,
            cockpitCollapsed: true,
          }));
          return;
        }
        const nextWidth = clampNumber(rawWidth, 320, maxWidth);
        setLayout((current) => ({
          ...current,
          cockpitWidth: nextWidth,
          cockpitCollapsed: false,
        }));
      },
    });
  };
  const startDossierResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setLayout((current) => ({ ...current, dossierCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'row-resize',
      onMove: (moveEvent) => {
        const rawPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
        if (shouldCollapsePanePercent(100 - rawPercent)) {
          setLayout((current) => ({
            ...current,
            dossierCollapsed: true,
          }));
          return;
        }
        const nextPercent = clampNumber(rawPercent, 42, 76);
        setLayout((current) => ({
          ...current,
          tablePercent: nextPercent,
          dossierCollapsed: false,
        }));
      },
    });
  };

  return (
    <div className="arena-trace-terminal flex min-h-full w-full flex-col lg:h-full lg:overflow-hidden">
      <ArenaPageHeader
        title="Agents"
        titleWidthClassName="min-[1180px]:w-[11rem]"
        metrics={[
          { value: formatCompactUsd(oneDayVolume.series.summary.totalUsd), label: '24H Vol' },
          { value: oneDayTrades > 0 ? formatNumber(oneDayTrades, { maximumFractionDigits: 0 }) : '—', label: '24H Fills' },
          { value: formatNumber(activeAgents, { maximumFractionDigits: 0 }), label: 'Active' },
        ]}
      >
        <div className="grid min-w-0 gap-2 min-[920px]:grid-cols-[minmax(12rem,1fr)_auto]">
          <div className="relative min-w-[12rem]">
            <span className="i-ph:magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#697371]" aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search agents"
              name="agent-search"
              autoComplete="off"
              placeholder="Search agents…"
              className="h-9 w-full rounded-[5px] border border-[#273035] bg-[#0b1418] pl-8 pr-2 font-display text-sm text-[#f6fefd] placeholder:text-[#697371] focus:border-[#50d2c1]/70 focus:ring-2 focus:ring-[#50d2c1]/20"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <WorkspaceControlButton
              label={layout.cockpitCollapsed ? 'Restore agent cockpit' : 'Minimize agent cockpit'}
              icon={layout.cockpitCollapsed ? 'i-ph:sidebar-simple' : 'i-ph:minus-bold'}
              onClick={() => setLayout((current) => ({
                ...current,
                cockpitCollapsed: !current.cockpitCollapsed,
              }))}
            />
            <WorkspaceControlButton
              label="Reset workspace"
              icon="i-ph:arrow-counter-clockwise"
              onClick={resetLayout}
            />
            <ArenaHeaderLink to="/" icon="i-ph:chart-line-up">Terminal</ArenaHeaderLink>
            <ArenaHeaderLink to="/create" icon="i-ph:plus-bold" variant="primary">New Agent</ArenaHeaderLink>
          </div>
        </div>
      </ArenaPageHeader>

      <OperatorSessionBanner />

      {isLoading ? (
        <div className="min-h-0 flex-1">
          <SkeletonCard className="h-full min-h-[520px]" />
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
            description="Connect a wallet to create an agent or follow live performance."
            bullets={['Create an agent', 'Track returns and fills', 'Configure operator secrets']}
          />
        ) : (
          <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-16 text-center">
            <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mb-4 mx-auto" />
            <p className="text-base text-arena-elements-textSecondary mb-2">No agents deployed yet</p>
            <p className="text-sm text-arena-elements-textTertiary">
              <Link to="/create" className="text-violet-700 dark:text-violet-400 hover:underline">Create an agent</Link> to get started.
            </p>
          </div>
        )
      ) : (
        <section
          ref={workspaceRef}
          className={`grid min-h-0 flex-1 overflow-hidden border border-[#273035] bg-[#0f1a1f] ${explorerGridClass}`}
          style={explorerStyle}
          aria-label="Agent explorer"
        >
          <div
            className="grid min-h-0 flex-1 overflow-hidden"
            style={leftPaneStyle as CSSProperties}
          >
            <div className="row-start-1 flex min-h-0 flex-col overflow-hidden">
              <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#273035] bg-[#0b1418] px-3">
                <h2 className="font-data text-[11px] font-semibold uppercase tracking-[0.12em] text-[#949e9c]">
                  Leaderboard
                </h2>
                <div className="flex items-center gap-2">
                  <span className="font-data text-xs tabular-nums text-[#d2dad7]">
                    {formatNumber(visibleBots.length, { maximumFractionDigits: 0 })} / {formatNumber(sortedBots.length, { maximumFractionDigits: 0 })}
                  </span>
                  <WorkspaceControlButton
                    label={layout.dossierCollapsed ? 'Restore selected agent details' : 'Minimize selected agent details'}
                    icon={layout.dossierCollapsed ? 'i-ph:arrows-out-line-vertical' : 'i-ph:minus-bold'}
                    onClick={() => setLayout((current) => ({
                      ...current,
                      dossierCollapsed: !current.dossierCollapsed,
                    }))}
                  />
                </div>
              </div>
              <div
                className={`min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable] ${
                  selectedBot && visibleBots.length <= 4 ? 'max-h-[260px]' : ''
                }`}
                aria-label="Agent leaderboard"
              >
                {visibleBots.length > 0 ? (
                  <LeaderboardTable
                    bots={visibleBots}
                    selectedBotId={selectedBot?.id}
                    onSelectBot={(bot) => setSelectedBotId(bot.id)}
                    activityStatsByBotId={activityStatsByBotId}
                  />
                ) : (
                  <div className="flex h-full min-h-[16rem] items-center justify-center px-6 text-center font-display text-sm text-[#949e9c]">
                    No agents match that search.
                  </div>
                )}
              </div>
            </div>
            <WorkspaceResizeHandle
              orientation="horizontal"
              className="row-start-2"
              ariaLabel="Resize leaderboard and selected agent details"
              title="Drag to resize leaderboard and selected agent details"
              onPointerDown={startDossierResize}
            />
            {layout.dossierCollapsed ? (
              <WorkspaceCollapsedPane
                label="Details"
                icon="i-ph:identification-card"
                className="row-start-3"
                onClick={() => setLayout((current) => ({ ...current, dossierCollapsed: false }))}
              />
            ) : selectedBot ? (
              <SelectedAgentDossier
                bot={selectedBot}
                activityStats={activityStatsByBotId.get(selectedBot.id)}
                trades={selectedAgentTrades}
              />
            ) : null}
          </div>
          <WorkspaceResizeHandle
            orientation="vertical"
            className="col-start-2 row-start-1 hidden min-[1360px]:flex"
            ariaLabel="Resize selected agent cockpit"
            title="Drag to resize selected agent cockpit"
            onPointerDown={startCockpitResize}
          />
          {layout.cockpitCollapsed ? (
            <WorkspaceCollapsedPane
              label="Cockpit"
              icon="i-ph:sidebar-simple"
              orientation="vertical"
              className="col-start-3 row-start-1 hidden min-[1360px]:flex"
              onClick={() => setLayout((current) => ({ ...current, cockpitCollapsed: false }))}
            />
          ) : selectedBot ? (
            <SelectedAgentCockpit
              bot={selectedBot}
              activityStats={activityStatsByBotId.get(selectedBot.id)}
              className="hidden min-[1360px]:col-start-3 min-[1360px]:row-start-1 min-[1360px]:flex"
            />
          ) : (
            <div className="flex min-h-0 items-center justify-center border-t border-[#273035] bg-[#0b1418] px-6 text-center font-display text-sm text-[#949e9c]">
              Select an agent.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
