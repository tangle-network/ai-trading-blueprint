import { Link, useSearchParams } from 'react-router';
import { useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { isAddress, type Address } from 'viem';
import { Identicon, Skeleton } from '@tangle-network/blueprint-ui/components';
import { TradeInstrumentDisplay } from '~/components/bot-detail/shared/AssetDisplay';
import { useLatestAgentTrades } from '~/lib/hooks/useBotApi';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';
import {
  formatTradeActionLabel,
  formatTradeAge,
  formatTradeAmount,
  formatTradeModeLabel,
  formatTradeUsd,
  getTerminalTradeActionPillClass,
  getTradeActionToneClass,
  getTradeMarketLabel,
} from '~/lib/tradeDisplay';
import { formatNumber } from '~/lib/format';
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';

interface LatestAgentTradesProps {
  bots: Bot[];
  className?: string;
  enabled?: boolean;
  limit?: number;
  variant?: 'standard' | 'panel' | 'explorer';
  headerControls?: ReactNode;
}

function formatReference(trade: Trade): string {
  const ref = trade.txHash ?? trade.execution?.clobOrderId ?? trade.id;
  if (!ref) return '—';
  return ref.length > 14 ? `${ref.slice(0, 6)}…${ref.slice(-4)}` : ref;
}

const tradeTimestampFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const EXPLORER_PAGE_SIZE = 25;
const LATEST_TRADES_EXPLORER_LAYOUT_KEY = 'arena:latest-trades-explorer-layout';

interface LatestTradesExplorerLayout {
  inspectorWidth: number;
  inspectorCollapsed: boolean;
}

const DEFAULT_LATEST_TRADES_EXPLORER_LAYOUT: LatestTradesExplorerLayout = {
  inspectorWidth: 332,
  inspectorCollapsed: false,
};

function normalizeLatestTradesExplorerLayout(value: Partial<LatestTradesExplorerLayout>): LatestTradesExplorerLayout {
  return {
    inspectorWidth: clampNumber(
      Number(value.inspectorWidth) || DEFAULT_LATEST_TRADES_EXPLORER_LAYOUT.inspectorWidth,
      280,
      500,
    ),
    inspectorCollapsed: value.inspectorCollapsed === true,
  };
}

function formatTradeTimestamp(timestamp: number): string {
  return tradeTimestampFormatter.format(new Date(timestamp));
}

function parsePositiveInteger(value: string | null): number {
  if (!value) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function LatestAgentTrades({
  bots,
  className = '',
  enabled = true,
  limit,
  variant = 'standard',
  headerControls,
}: LatestAgentTradesProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { trades, isLoading, candidateCount } = useLatestAgentTrades(bots, {
    enabled,
    limit: limit ?? 10,
  });
  const isPanel = variant === 'panel';
  const isExplorer = variant === 'explorer';
  const explorerRef = useRef<HTMLDivElement>(null);
  const [explorerLayout, setExplorerLayout] = usePersistentWorkspaceLayout(
    LATEST_TRADES_EXPLORER_LAYOUT_KEY,
    DEFAULT_LATEST_TRADES_EXPLORER_LAYOUT,
    normalizeLatestTradesExplorerLayout,
  );
  const isBounded = isPanel || isExplorer;
  const visibleTrades = limit ? trades.slice(0, limit) : trades;
  const explorerPageCount = isExplorer
    ? Math.max(1, Math.ceil(visibleTrades.length / EXPLORER_PAGE_SIZE))
    : 1;
  const requestedExplorerPage = parsePositiveInteger(searchParams.get('fillsPage'));
  const explorerPage = Math.min(requestedExplorerPage, explorerPageCount);
  const explorerPageStart = (explorerPage - 1) * EXPLORER_PAGE_SIZE;
  const explorerPageEnd = Math.min(explorerPageStart + EXPLORER_PAGE_SIZE, visibleTrades.length);
  const explorerTrades = isExplorer
    ? visibleTrades.slice(explorerPageStart, explorerPageEnd)
    : visibleTrades;
  const selectedFillId = searchParams.get('fill');
  const selectedFill = isExplorer
    ? explorerTrades.find(({ trade }) => trade.id === selectedFillId) ?? explorerTrades[0]
    : undefined;

  function selectFill(fillId: string) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('fill', fillId);
    setSearchParams(nextParams, { replace: true });
  }

  function handleExplorerRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, fillId: string) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectFill(fillId);
  }

  function stopAgentLinkRowSelection(event: MouseEvent<HTMLAnchorElement>) {
    event.stopPropagation();
  }

  function selectExplorerPage(page: number) {
    const nextPage = Math.min(Math.max(page, 1), explorerPageCount);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('fillsPage', String(nextPage));
    nextParams.delete('fill');
    setSearchParams(nextParams, { replace: true });
  }

  function startExplorerInspectorResize(event: Parameters<typeof beginWorkspaceResize>[0]) {
    const explorer = explorerRef.current;
    if (!explorer) return;
    const rect = explorer.getBoundingClientRect();
    setExplorerLayout((current) => ({ ...current, inspectorCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const maxWidth = Math.min(500, Math.max(320, rect.width * 0.46));
        const nextWidth = clampNumber(rect.right - moveEvent.clientX, 280, maxWidth);
        setExplorerLayout((current) => ({
          ...current,
          inspectorWidth: nextWidth,
          inspectorCollapsed: false,
        }));
      },
    });
  }

  const explorerGridStyle = {
    '--latest-trades-inspector-width': `${explorerLayout.inspectorWidth}px`,
  } as CSSProperties;

  return (
    <section
      data-testid="live-fill-tape"
      className={`${isBounded ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'mb-6'} border ${isBounded ? 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]' : 'border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/42'} ${className}`}
      aria-live="polite"
    >
      <div className={`flex h-10 shrink-0 items-center justify-between gap-4 border-b px-3 ${isBounded ? 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]' : 'border-arena-elements-dividerColor/60 sm:px-5'} ${isExplorer ? 'py-2.5' : 'py-2'}`}>
        <h2 className={`font-display font-semibold tracking-tight ${isBounded ? 'text-[var(--arena-terminal-text)]' : 'text-arena-elements-textPrimary'} ${isExplorer ? 'text-lg' : 'text-base'}`}>
          {isExplorer ? 'Fills' : 'Fills'}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {trades.length === 0 && candidateCount > 0 && (
            <span className={`font-data text-xs ${isBounded ? 'text-[var(--arena-terminal-text-subtle)]' : 'text-arena-elements-textTertiary'}`}>
              {candidateCount}
            </span>
          )}
          {headerControls}
          {isExplorer && (
            <WorkspaceControlButton
              label={explorerLayout.inspectorCollapsed ? 'Restore fill inspector' : 'Minimize fill inspector'}
              icon={explorerLayout.inspectorCollapsed ? 'i-ph:sidebar-simple' : 'i-ph:minus-bold'}
              onClick={() => setExplorerLayout((current) => ({
                ...current,
                inspectorCollapsed: !current.inspectorCollapsed,
              }))}
            />
          )}
        </div>
      </div>

      {isLoading ? (
        <div className={`${isBounded ? 'min-h-0 flex-1 overflow-hidden' : ''} divide-y divide-arena-elements-dividerColor/50`}>
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className={`grid grid-cols-[1fr_auto] gap-4 px-4 py-3 sm:px-5 ${isBounded ? '' : 'lg:grid-cols-[7rem_1.3fr_1.4fr_6rem_5rem]'}`}>
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-7 w-full" />
              {!isBounded && <Skeleton className="hidden h-7 w-full lg:block" />}
              {!isBounded && <Skeleton className="hidden h-7 w-16 lg:block" />}
              <Skeleton className="h-7 w-12" />
            </div>
          ))}
        </div>
      ) : visibleTrades.length === 0 ? (
        <div className={`${isBounded ? 'flex min-h-0 flex-1 items-center justify-center text-[var(--arena-terminal-text-muted)]' : 'px-5 py-10 text-arena-elements-textSecondary'} text-center text-sm`}>
          No recent fills reported by active agents.
        </div>
      ) : isPanel ? (
        <div
          data-testid="live-fill-tape-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="divide-y divide-[var(--arena-terminal-border)]">
            {visibleTrades.map(({ trade, bot, botId, botName }) => {
              const operatorAddress = bot?.operatorAddress;
              const hasOperatorAddress = operatorAddress != null && isAddress(operatorAddress);
              const agentName = bot?.name ?? botName;
              const href = `/arena/bot/${encodeURIComponent(botId)}/performance`;
              return (
                <Link
                  key={`${botId}:${trade.id}`}
                  to={href}
                  className="group grid w-full grid-cols-[3rem_minmax(0,1fr)_5.75rem] items-center gap-2 px-2.5 py-2.5 text-left transition-colors hover:bg-[var(--arena-terminal-panel-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                  aria-label={`Open ${agentName} performance for ${formatTradeActionLabel(trade.action)} ${getTradeMarketLabel(trade)} fill ${formatTradeUsd(trade.notionalUsd)} ${formatTradeAge(trade.timestamp)}`}
                >
                  <span
                    className="font-data text-[13px] text-[var(--arena-terminal-text-subtle)]"
                    title={formatTradeTimestamp(trade.timestamp)}
                  >
                    {formatTradeAge(trade.timestamp)}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      {hasOperatorAddress ? (
                        <Identicon address={operatorAddress as Address} size={22} />
                      ) : (
                        <span className="i-ph:robot inline-block size-5 shrink-0 rounded-full bg-arena-elements-item-backgroundActive text-arena-elements-textTertiary" />
                      )}
                      <span className="truncate font-display text-[15px] font-semibold text-[var(--arena-terminal-text)] group-hover:text-[var(--arena-terminal-accent)]">
                        {agentName}
                      </span>
                    </span>
                    <span className="mt-1 block min-w-0">
                      <TradeInstrumentDisplay
                        trade={trade}
                        size="sm"
                        showVenue={false}
                        labelClassName="max-w-full text-[14px]"
                        terminal
                      />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col items-end gap-1">
                    <span className="truncate text-right font-data text-[14px] font-semibold text-[var(--arena-terminal-text)]">
                      {formatTradeUsd(trade.notionalUsd)}
                    </span>
                    <span className={`inline-flex h-6 max-w-full items-center justify-center truncate rounded-[4px] px-1.5 font-data text-[10px] font-bold ${getTerminalTradeActionPillClass(trade.action)}`}>
                      {formatTradeActionLabel(trade.action)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      ) : isExplorer ? (
        <div
          ref={explorerRef}
          className={`grid min-h-0 flex-1 gap-0 ${
            explorerLayout.inspectorCollapsed
              ? 'lg:grid-cols-[minmax(0,1fr)_8px_44px]'
              : 'lg:grid-cols-[minmax(0,1fr)_8px_minmax(280px,var(--latest-trades-inspector-width))]'
          }`}
          style={explorerGridStyle}
        >
          <div className="flex min-h-0 flex-col overflow-hidden">
            <div
              data-testid="live-fill-explorer-scroll"
              className="min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
            >
              <table className="w-full min-w-[640px] border-separate border-spacing-0 rounded-none">
                <thead className="sticky top-0 z-10 rounded-none bg-[var(--arena-terminal-surface)] backdrop-blur">
                  <tr>
                    <th className="rounded-none border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-left font-data text-[11px] font-medium text-[var(--arena-terminal-text-subtle)]">Time</th>
                    <th className="rounded-none border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-left font-data text-[11px] font-medium text-[var(--arena-terminal-text-subtle)]">Agent</th>
                    <th className="rounded-none border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-left font-data text-[11px] font-medium text-[var(--arena-terminal-text-subtle)]">Fill</th>
                    <th className="rounded-none border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-left font-data text-[11px] font-medium text-[var(--arena-terminal-text-subtle)]">Market</th>
                    <th className="rounded-none border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-right font-data text-[11px] font-medium text-[var(--arena-terminal-text-subtle)]">USD</th>
                    <th className="hidden rounded-none border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-right font-data text-[11px] font-medium text-[var(--arena-terminal-text-subtle)] 2xl:table-cell">Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {explorerTrades.map(({ trade, bot, botId, botName }) => {
                    const operatorAddress = bot?.operatorAddress;
                    const hasOperatorAddress = operatorAddress != null && isAddress(operatorAddress);
                    const agentName = bot?.name ?? botName;
                    const selected = selectedFill?.trade.id === trade.id;

                    return (
                      <tr
                        key={`${botId}:${trade.id}`}
                        className={`group cursor-default transition-colors hover:bg-[var(--arena-terminal-panel-strong)] ${
                          selected ? 'bg-[var(--arena-terminal-accent-soft)]' : ''
                        }`}
                        aria-current={selected ? 'true' : undefined}
                        tabIndex={0}
                        onClick={() => selectFill(trade.id)}
                        onKeyDown={(event) => handleExplorerRowKeyDown(event, trade.id)}
                      >
                        <td
                          className="border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 align-middle font-data text-xs text-[var(--arena-terminal-text-muted)]"
                          title={formatTradeTimestamp(trade.timestamp)}
                        >
                          {formatTradeAge(trade.timestamp)}
                        </td>
                        <td className="border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 align-middle">
                          <Link
                            to={`/arena/bot/${encodeURIComponent(botId)}/performance`}
                            onClick={stopAgentLinkRowSelection}
                            className="flex min-w-0 items-center gap-2.5 rounded-[5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                            aria-label={`Open ${agentName} performance`}
                          >
                            {hasOperatorAddress ? (
                              <Identicon address={operatorAddress as Address} size={20} />
                            ) : (
                              <span className="i-ph:robot inline-block size-5 shrink-0 rounded-full bg-arena-elements-item-backgroundActive text-arena-elements-textTertiary" />
                            )}
                            <span className="truncate font-display text-[13px] font-semibold text-[var(--arena-terminal-text)] group-hover:text-[var(--arena-terminal-accent)]">
                              {agentName}
                            </span>
                          </Link>
                        </td>
                        <td className="border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 align-middle">
                          <span
                            className={`inline-flex h-6 min-w-[4.75rem] items-center justify-start rounded-none bg-transparent px-0 font-data text-[11px] font-bold transition-[color,opacity] duration-150 ${getTradeActionToneClass(trade.action)}`}
                          >
                            {formatTradeActionLabel(trade.action)}
                          </span>
                        </td>
                        <td className="border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 align-middle">
                          <TradeInstrumentDisplay
                            trade={trade}
                            size="sm"
                            showVenue={false}
                            labelClassName="max-w-[240px]"
                            terminal
                          />
                        </td>
                        <td className="border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-right align-middle font-data text-sm font-semibold text-[var(--arena-terminal-text)]">
                          {formatTradeUsd(trade.notionalUsd)}
                        </td>
                        <td className="hidden border-b border-[var(--arena-terminal-border)] px-2.5 py-1.5 text-right align-middle font-data text-xs text-[var(--arena-terminal-text-muted)] 2xl:table-cell">
                          {formatReference(trade)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-3">
              <span className="font-data text-xs tabular-nums text-[var(--arena-terminal-text-muted)]">
                {visibleTrades.length > 0 ? `${formatNumber(explorerPageStart + 1, { maximumFractionDigits: 0 })}-${formatNumber(explorerPageEnd, { maximumFractionDigits: 0 })}` : '0'} / {formatNumber(visibleTrades.length, { maximumFractionDigits: 0 })}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className="inline-flex h-7 w-8 items-center justify-center rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-secondary)] transition-[background-color,border-color,color,opacity] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                  aria-label="Previous fills page"
                  disabled={explorerPage <= 1}
                  onClick={() => selectExplorerPage(explorerPage - 1)}
                >
                  <span className="i-ph:caret-left-bold text-xs" aria-hidden="true" />
                </button>
                <span className="min-w-12 text-center font-data text-xs tabular-nums text-[var(--arena-terminal-text-secondary)]">
                  {formatNumber(explorerPage, { maximumFractionDigits: 0 })} / {formatNumber(explorerPageCount, { maximumFractionDigits: 0 })}
                </span>
                <button
                  type="button"
                  className="inline-flex h-7 w-8 items-center justify-center rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-secondary)] transition-[background-color,border-color,color,opacity] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                  aria-label="Next fills page"
                  disabled={explorerPage >= explorerPageCount}
                  onClick={() => selectExplorerPage(explorerPage + 1)}
                >
                  <span className="i-ph:caret-right-bold text-xs" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
          <WorkspaceResizeHandle
            orientation="vertical"
            className="col-start-2 row-start-1 hidden lg:flex"
            ariaLabel="Resize fill inspector"
            title="Drag to resize fill inspector"
            onPointerDown={startExplorerInspectorResize}
          />
          {explorerLayout.inspectorCollapsed ? (
            <WorkspaceCollapsedPane
              label="Inspector"
              icon="i-ph:sidebar-simple"
              orientation="vertical"
              className="col-start-3 row-start-1 hidden lg:flex"
              onClick={() => setExplorerLayout((current) => ({ ...current, inspectorCollapsed: false }))}
            />
          ) : selectedFill ? (
            <FillInspector
              trade={selectedFill.trade}
              bot={selectedFill.bot}
              botId={selectedFill.botId}
              botName={selectedFill.botName}
              className="col-start-3 row-start-1"
            />
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-arena-elements-background-depth-2/96 backdrop-blur">
              <tr className="border-b border-arena-elements-dividerColor/60">
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Age</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Agent</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Action</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Market</th>
                <th className="px-4 py-2 text-right font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Notional</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Mode</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Status</th>
                <th className="px-4 py-2 text-right font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Ref</th>
              </tr>
            </thead>
            <tbody>
              {visibleTrades.map(({ trade, bot, botId, botName }) => {
                const operatorAddress = bot?.operatorAddress;
                const hasOperatorAddress = operatorAddress != null && isAddress(operatorAddress);
                return (
                  <tr
                    key={`${botId}:${trade.id}`}
                    className="group border-b border-arena-elements-dividerColor/50 transition-colors hover:bg-arena-elements-item-backgroundHover"
                  >
                    <td
                      className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle font-data text-sm text-arena-elements-textTertiary"
                      title={formatTradeTimestamp(trade.timestamp)}
                    >
                      {formatTradeAge(trade.timestamp)}
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <Link
                        to={`/arena/bot/${encodeURIComponent(botId)}/performance`}
                        className="flex min-w-0 items-center gap-2 rounded-[5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                      >
                        {hasOperatorAddress ? (
                          <Identicon address={operatorAddress as Address} size={22} />
                        ) : (
                          <span className="i-ph:robot inline-block size-5 shrink-0 rounded-full bg-arena-elements-item-backgroundActive text-arena-elements-textTertiary" />
                        )}
                        <span className="truncate font-display text-sm font-semibold text-arena-elements-textPrimary group-hover:text-violet-700 dark:group-hover:text-violet-300">
                          {bot?.name ?? botName}
                        </span>
                      </Link>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <span className={`inline-flex h-8 min-w-[4.25rem] items-center justify-start rounded-none bg-transparent px-0 font-data font-bold ${getTradeActionToneClass(trade.action)}`}>
                        {formatTradeActionLabel(trade.action)}
                      </span>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <TradeInstrumentDisplay
                        trade={trade}
                        size="md"
                        showVenue={false}
                        labelClassName="max-w-[280px]"
                        terminal
                      />
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 text-right align-middle font-data text-base font-semibold text-arena-elements-textPrimary">
                      {formatTradeUsd(trade.notionalUsd)}
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle font-data text-sm text-arena-elements-textSecondary">
                      {trade.paperTrade || trade.status === 'paper' ? 'Paper' : 'Live'}
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle font-data text-sm text-arena-elements-textSecondary">
                      {trade.status}
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 text-right align-middle font-data text-sm text-arena-elements-textTertiary">
                      {formatReference(trade)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FillInspector({
  trade,
  bot,
  botId,
  botName,
  className = '',
}: {
  trade: Trade;
  bot?: Bot;
  botId: string;
  botName: string;
  className?: string;
}) {
  const operatorAddress = bot?.operatorAddress;
  const hasOperatorAddress = operatorAddress != null && isAddress(operatorAddress);
  const agentName = bot?.name ?? botName;
  const venue = trade.venue.toUpperCase();
  const price = trade.priceUsd == null ? '—' : formatTradeUsd(trade.priceUsd);
  const executionStatus = trade.execution?.status ?? trade.status;
  const reasoning = trade.agentReasoning ?? trade.validatorReasoning ?? trade.execution?.reason;
  const identifiers = [
    trade.revisionId ? ['Revision', trade.revisionId] : null,
    trade.candidateHash ? ['Candidate', trade.candidateHash] : null,
    trade.strategyModuleId ? ['Module', trade.strategyModuleId] : null,
    trade.harnessVersion != null ? ['Harness', `v${trade.harnessVersion}`] : null,
  ].filter((value): value is [string, string] => Boolean(value));

  return (
    <aside
      data-testid="fill-inspector"
      className={`hidden min-h-0 flex-col border-l border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] lg:flex ${className}`}
      aria-label="Selected fill"
    >
      <div className="border-b border-[var(--arena-terminal-border)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <span className={`inline-flex h-7 items-center justify-center rounded-[4px] px-2 font-data text-[11px] font-bold ${getTerminalTradeActionPillClass(trade.action)}`}>
                {formatTradeActionLabel(trade.action)}
              </span>
              <span className="font-mono text-xs text-[var(--arena-terminal-text-muted)]">{formatTradeTimestamp(trade.timestamp)}</span>
            </div>
            <h3 className="truncate font-display text-lg font-semibold text-[var(--arena-terminal-text)]">
              {formatTradeUsd(trade.notionalUsd)}
            </h3>
            <p className="mt-1 truncate font-mono text-xs text-[var(--arena-terminal-text-muted)]">
              {getTradeMarketLabel(trade)}
            </p>
          </div>
          <Link
            to={`/arena/bot/${encodeURIComponent(botId)}/performance`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-2.5 font-display text-xs font-semibold text-[var(--arena-terminal-text-secondary)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
          >
            <span className="i-ph:arrow-square-out text-sm" aria-hidden="true" />
            Agent
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <section className="mb-3 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-3">
          <div className="mb-3 flex min-w-0 items-center gap-2.5">
            {hasOperatorAddress ? (
              <Identicon address={operatorAddress as Address} size={26} />
            ) : (
              <span className="i-ph:robot inline-block size-6 shrink-0 rounded-full bg-arena-elements-item-backgroundActive text-arena-elements-textTertiary" />
            )}
            <div className="min-w-0">
              <div className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{agentName}</div>
              <div className="truncate font-mono text-xs text-[var(--arena-terminal-text-muted)]">{bot?.strategyType ?? 'strategy'}</div>
            </div>
          </div>
          <TradeInstrumentDisplay
            trade={trade}
            size="md"
            showVenue
            labelClassName="max-w-full"
            terminal
          />
        </section>

        <section className="overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
          <InspectorRow label="Mode" value={formatTradeModeLabel(trade)} />
          <InspectorRow label="Venue" value={venue} />
          <InspectorRow label="Status" value={executionStatus} />
          <InspectorRow label="Price" value={price} />
          <InspectorRow label="Input" value={`${formatTradeAmount(trade.amountIn)} ${trade.tokenIn}`} />
          <InspectorRow label="Output" value={`${formatTradeAmount(trade.amountOut)} ${trade.tokenOut}`} />
          <InspectorRow label="Ref" value={formatReference(trade)} />
          {trade.decisionSource && (
            <InspectorRow label="Source" value={trade.decisionSource} />
          )}
          {trade.validatorScore != null && (
            <InspectorRow label="Score" value={`${trade.validatorScore}`} />
          )}
        </section>

        {(reasoning || identifiers.length > 0) && (
          <section className="mt-3 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-3">
            {reasoning && (
              <p className="line-clamp-4 text-sm leading-6 text-[var(--arena-terminal-text-secondary)]">
                {reasoning}
              </p>
            )}
            {identifiers.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {identifiers.map(([label, value]) => (
                  <span
                    key={`${label}:${value}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2 py-1 font-mono text-[11px] text-[var(--arena-terminal-text-muted)]"
                  >
                    <span className="text-[var(--arena-terminal-text-subtle)]">{label}</span>
                    <span className="max-w-[11rem] truncate text-[var(--arena-terminal-text-secondary)]">{value}</span>
                  </span>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-[var(--arena-terminal-text-secondary)]">{value || '—'}</span>
    </div>
  );
}
