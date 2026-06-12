import { useMemo, useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useBotTradePage, type TradePage } from '~/lib/hooks/useBotApi';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { ValidatorCard, SimulationDetail } from './shared/ValidatorComponents';
import { AssetDisplay, TradeInstrumentDisplay } from './shared/AssetDisplay';
import { SkeletonTableRow } from '~/components/ui/Skeleton';
import type { Trade, TradeStatus } from '~/lib/types/trade';
import type { BotOperatorKind, BotVerificationState } from '~/lib/types/bot';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';
import { countUsableValidatorSignatures, getTradeValidationDisplay } from '~/lib/tradeValidation';
import { formatNumber } from '~/lib/format';
import { UnverifiedDataNotice } from './shared/DataAccessNotices';
import { formatTradeModeLabel, getTerminalTradeActionPillClass } from '~/lib/tradeDisplay';
import {
  applySortDirection,
  compareNumberValue,
  compareStringValue,
  nextSortState,
  SortableHeaderButton,
  SQUARE_TABLE_CLASS,
  type SortState,
} from '~/components/arena/SortableTableHeader';

interface TradeHistoryTabProps {
  botId: string;
  botName?: string;
  isLive?: boolean;
  chainId?: number;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
  assetMetadata?: TokenMetadata[];
  compact?: boolean;
}

const TRADE_HISTORY_LIMIT = 50;

const EXPLORER_URLS: Record<number, { name: string; base: string }> = {
  1: { name: 'Etherscan', base: 'https://etherscan.io/tx/' },
  137: { name: 'Polygonscan', base: 'https://polygonscan.com/tx/' },
  42161: { name: 'Arbiscan', base: 'https://arbiscan.io/tx/' },
  8453: { name: 'Basescan', base: 'https://basescan.org/tx/' },
  10: { name: 'Optimistic', base: 'https://optimistic.etherscan.io/tx/' },
  31337: { name: 'Local', base: '' },
};

const tradeTimestampFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

type TradeHistorySortKey = 'time' | 'trade' | 'market' | 'size' | 'usd' | 'risk' | 'ref' | 'status';

function explorerUrl(txHash: string, chainId?: number): string | null {
  if (!chainId || chainId === 31337) return null;
  const explorer = EXPLORER_URLS[chainId];
  return explorer ? `${explorer.base}${txHash}` : null;
}

function TradeTableHead({
  compact = false,
  sort,
  onSort,
}: {
  compact?: boolean;
  sort: SortState<TradeHistorySortKey>;
  onSort: (key: TradeHistorySortKey, defaultDirection?: 'asc' | 'desc') => void;
}) {
  if (compact) {
    return (
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[7.6rem] py-1">
            <SortableHeaderButton sortKey="time" sort={sort} onSort={onSort}>Time</SortableHeaderButton>
          </TableHead>
          <TableHead className="w-[7.25rem] py-1">
            <SortableHeaderButton sortKey="trade" sort={sort} onSort={onSort} defaultDirection="asc">Trade</SortableHeaderButton>
          </TableHead>
          <TableHead className="py-1">
            <SortableHeaderButton sortKey="market" sort={sort} onSort={onSort} defaultDirection="asc">Market</SortableHeaderButton>
          </TableHead>
          <TableHead className="w-[7rem] py-1 text-right">
            <SortableHeaderButton sortKey="size" sort={sort} onSort={onSort} align="right">Size</SortableHeaderButton>
          </TableHead>
          <TableHead className="w-[7.35rem] py-1 text-right">
            <SortableHeaderButton sortKey="usd" sort={sort} onSort={onSort} align="right">USD</SortableHeaderButton>
          </TableHead>
          <TableHead className="hidden w-[7rem] py-1 text-right min-[1500px]:table-cell">
            <SortableHeaderButton sortKey="ref" sort={sort} onSort={onSort} align="right" defaultDirection="asc">Ref</SortableHeaderButton>
          </TableHead>
        </TableRow>
      </TableHeader>
    );
  }

  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead className="w-44 py-2.5">
          <SortableHeaderButton sortKey="time" sort={sort} onSort={onSort}>Time</SortableHeaderButton>
        </TableHead>
        <TableHead className="w-44 py-2.5">
          <SortableHeaderButton sortKey="trade" sort={sort} onSort={onSort} defaultDirection="asc">Decision</SortableHeaderButton>
        </TableHead>
        <TableHead className="min-w-[420px] py-2.5">
          <SortableHeaderButton sortKey="market" sort={sort} onSort={onSort} defaultDirection="asc">Market</SortableHeaderButton>
        </TableHead>
        <TableHead className="hidden py-2.5 text-right sm:table-cell">
          <SortableHeaderButton sortKey="risk" sort={sort} onSort={onSort} align="right">Risk</SortableHeaderButton>
        </TableHead>
        <TableHead className="py-2.5">
          <SortableHeaderButton sortKey="ref" sort={sort} onSort={onSort} defaultDirection="asc">Reference</SortableHeaderButton>
        </TableHead>
        <TableHead className="py-2.5">
          <SortableHeaderButton sortKey="status" sort={sort} onSort={onSort} defaultDirection="asc">Status</SortableHeaderButton>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

function formatTradePageRange(page: TradePage | undefined): string | null {
  if (!page || page.loaded === 0) return null;
  const start = page.offset + 1;
  const end = page.offset + page.loaded;
  const startLabel = formatNumber(start, { maximumFractionDigits: 0 });
  const endLabel = formatNumber(end, { maximumFractionDigits: 0 });
  if (page.total != null) {
    return `${startLabel}-${endLabel} / ${formatNumber(page.total, { maximumFractionDigits: 0 })}`;
  }
  return `${startLabel}-${endLabel}`;
}

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function formatTradeAmount(amount: number): string {
  return formatNumber(amount, { maximumFractionDigits: 4 });
}

function formatTradeCurrency(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `$${formatNumber(value, { maximumFractionDigits: 2 })}`;
}

function formatTradeTimestamp(timestamp: number): string {
  return tradeTimestampFormatter.format(new Date(timestamp));
}

function formatCompactTradeTimestamp(timestamp: number): { date: string; time: string; inline: string } {
  const date = new Date(timestamp);
  const dayLabel = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  }).format(date);
  return {
    date: dayLabel,
    time: timeLabel,
    inline: `${dayLabel} ${timeLabel}`,
  };
}

function formatExecutionStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function isHyperliquidTrade(trade: Trade): boolean {
  return trade.targetProtocol === 'hyperliquid';
}

function hyperliquidMarketLabel(trade: Trade): string | null {
  const asset = trade.hyperliquidMetadata?.asset?.trim();
  return asset ? `${asset.toUpperCase()}-PERP` : null;
}

function hyperliquidSizeLabel(trade: Trade): string | null {
  const asset = trade.hyperliquidMetadata?.asset?.trim();
  const size = trade.hyperliquidMetadata?.assetSize?.trim();
  if (!asset || !size) return null;
  return `${size} ${asset.toUpperCase()}`;
}

function getStatusLabel(status: TradeStatus): string {
  return status === 'failed' ? 'sim failed' : status;
}

function getStatusVariant(status: TradeStatus): 'success' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'executed') return 'success';
  if (status === 'rejected' || status === 'failed') return 'destructive';
  if (status === 'paper') return 'secondary';
  return 'outline';
}

function getErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}

function isInteractiveTradeTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('a,button,input,textarea,select'));
}

function TradeDataUnavailableCard({ error }: { error: unknown }) {
  const errorMessage = getErrorMessage(error);

  return (
    <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
      <div className="i-ph:warning-circle text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
      <h3 className="font-display font-semibold text-base text-arena-elements-textPrimary mb-2">
        Trade history unavailable
      </h3>
      <p className="text-sm">
        We couldn&apos;t load this bot&apos;s verified trade history from the operator.
      </p>
      {errorMessage && (
        <p className="mt-3 text-xs font-data text-crimson-500">{errorMessage}</p>
      )}
    </div>
  );
}

function getActionLabel(action: Trade['action']): string {
  if (action === 'open_long') return 'LONG';
  if (action === 'close_long') return 'CLOSE LONG';
  if (action === 'open_short') return 'SHORT';
  if (action === 'close_short') return 'CLOSE SHORT';
  return action.replace(/_/g, ' ').toUpperCase();
}

function getActionVariant(action: Trade['action']): 'success' | 'destructive' | 'accent' {
  if (action === 'buy' || action === 'open_long' || action === 'close_short') return 'success';
  if (action === 'sell' || action === 'close_long' || action === 'open_short') return 'destructive';
  return 'accent';
}

function renderExecutionRef(trade: Trade) {
  if (!trade.txHash) {
    return <span className="text-base font-data text-arena-elements-textTertiary">-</span>;
  }

  if (isHyperliquidTrade(trade)) {
    const label = trade.txHash === 'hl:ok'
      ? 'HL accepted'
      : trade.txHash === 'hl:err'
        ? 'HL rejected'
        : trade.txHash;
    return (
      <span className="text-base font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {label}
      </span>
    );
  }

  if (trade.txHash.startsWith('0xpaper_')) {
    return (
      <span className="text-base font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {truncateHash(trade.txHash)}
      </span>
    );
  }

  const url = explorerUrl(trade.txHash, trade.chainId);
  if (!url) {
    return (
      <span className="text-base font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {truncateHash(trade.txHash)}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-base font-data text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textPrimary"
      title={trade.txHash}
      onClick={(e) => e.stopPropagation()}
    >
      {truncateHash(trade.txHash)}
      <span className="i-ph:arrow-square-out text-xs" />
    </a>
  );
}

function renderHyperliquidTradeCell(trade: Trade) {
  const sizeLabel = hyperliquidSizeLabel(trade);
  const details = [
    `${formatTradeAmount(trade.amountIn)} ${trade.tokenIn}`,
    sizeLabel,
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="flex min-w-0 items-start gap-3">
      <TradeInstrumentDisplay trade={trade} size="md" showVenue={false} className="min-w-[10rem]" />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-base font-data leading-snug text-arena-elements-textSecondary">
          {details.map((detail) => (
            <span key={detail} className="break-words">
              {detail}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function renderTradeInstrumentCell(trade: Trade, compact: boolean) {
  if (isHyperliquidTrade(trade)) {
    if (compact) {
      return (
        <TradeInstrumentDisplay
          trade={trade}
          size="sm"
          showVenue={false}
          showSecondary={false}
          labelClassName="max-w-full text-[14px]"
        />
      );
    }
    return renderHyperliquidTradeCell(trade);
  }

  return (
    <div className={compact ? 'space-y-0.5' : 'space-y-2'}>
      <TradeInstrumentDisplay
        trade={trade}
        size={compact ? 'sm' : 'md'}
        showVenue={!compact}
        labelClassName={compact ? 'max-w-full text-[14px]' : 'max-w-full'}
      />
      <div className={`${compact ? 'mt-0.5 text-[12px] leading-4' : 'text-base'} flex flex-wrap items-center gap-x-1.5 gap-y-1 font-data text-arena-elements-textSecondary`}>
        <span>{formatTradeAmount(trade.amountIn)}</span>
        <AssetDisplay asset={trade.assetIn} compact preferSymbol showSecondary={false} />
        <span className="mx-1.5 text-arena-elements-textTertiary">→</span>
        <span>{formatTradeAmount(trade.amountOut)}</span>
        <AssetDisplay asset={trade.assetOut} compact preferSymbol showSecondary={false} />
      </div>
    </div>
  );
}

function getTradeSizeLabel(trade: Trade): string {
  return hyperliquidSizeLabel(trade) ?? `${formatTradeAmount(trade.amountIn)} ${trade.tokenIn}`;
}

function getTradeReferenceValue(trade: Trade): string {
  return trade.txHash ?? trade.execution?.clobOrderId ?? trade.id;
}

function sortTradeHistory(trades: Trade[], sort: SortState<TradeHistorySortKey>): Trade[] {
  return [...trades].sort((left, right) => {
    const compare = (() => {
      switch (sort.key) {
        case 'time':
          return compareNumberValue(left.timestamp, right.timestamp);
        case 'trade':
          return compareStringValue(getActionLabel(left.action), getActionLabel(right.action));
        case 'market':
          return compareStringValue(
            hyperliquidMarketLabel(left) ?? `${left.tokenIn}/${left.tokenOut}`,
            hyperliquidMarketLabel(right) ?? `${right.tokenIn}/${right.tokenOut}`,
          );
        case 'size':
          return compareNumberValue(Math.abs(left.amountIn), Math.abs(right.amountIn));
        case 'usd':
          return compareNumberValue(left.notionalUsd, right.notionalUsd);
        case 'risk':
          return compareNumberValue(left.validatorScore, right.validatorScore);
        case 'ref':
          return compareStringValue(getTradeReferenceValue(left), getTradeReferenceValue(right));
        case 'status':
          return compareStringValue(left.status, right.status);
        default:
          return 0;
      }
    })();
    if (compare !== 0) return applySortDirection(compare, sort.direction);
    return compareNumberValue(right.timestamp, left.timestamp);
  });
}

function getModeToneClass(trade: Trade): string {
  if (trade.status === 'failed' || trade.status === 'rejected') return 'text-crimson-600 dark:text-crimson-300';
  if (trade.paperTrade || trade.status === 'paper') return 'text-arena-elements-textSecondary';
  return 'text-emerald-600 dark:text-emerald-300';
}

function TradePager({
  page,
  onPrevious,
  onNext,
  className,
  terminal = false,
}: {
  page: TradePage | undefined;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
  terminal?: boolean;
}) {
  const range = formatTradePageRange(page);
  const canPrevious = Boolean(page && page.offset > 0);
  const canNext = Boolean(page && page.loaded > 0 && page.isCapped);

  if (!range) return null;

  return (
    <div className={`flex items-center justify-end gap-2 ${className ?? ''}`}>
      <span className={`font-data text-sm tabular-nums ${terminal ? 'text-[var(--arena-terminal-text-secondary)]' : 'text-arena-elements-textSecondary'}`}>
        {range}
      </span>
      <div className={`inline-flex overflow-hidden rounded-[5px] border ${terminal ? 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]' : 'border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/55'}`}>
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canPrevious}
          className={`inline-flex h-8 w-8 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-35 ${
            terminal
              ? 'text-[var(--arena-terminal-text-muted)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)]'
              : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
          }`}
          aria-label="Previous trades page"
        >
          <span className="i-ph:caret-left-bold text-sm" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          className={`inline-flex h-8 w-8 items-center justify-center border-l transition-colors disabled:pointer-events-none disabled:opacity-35 ${
            terminal
              ? 'border-[var(--arena-terminal-border)] text-[var(--arena-terminal-text-muted)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)]'
              : 'border-arena-elements-dividerColor/70 text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
          }`}
          aria-label="Next trades page"
        >
          <span className="i-ph:caret-right-bold text-sm" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function TradeDetailMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'success' | 'danger';
}) {
  const toneClass = tone === 'success'
    ? 'text-emerald-600 dark:text-emerald-300'
    : tone === 'danger'
      ? 'text-crimson-600 dark:text-crimson-300'
      : 'text-arena-elements-textPrimary';

  return (
    <div className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/25 p-3">
      <div className="text-sm font-data font-medium uppercase tracking-wider text-arena-elements-textTertiary">
        {label}
      </div>
      <div className={`mt-1 break-words text-lg font-data ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

export function TradeHistoryTab({
  botId,
  botName = '',
  isLive = false,
  chainId,
  operatorApiUrl,
  operatorKind,
  verificationState,
  assetMetadata,
  compact = false,
}: TradeHistoryTabProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const offset = pageIndex * TRADE_HISTORY_LIMIT;
  const {
    data: tradePage,
    isLoading,
    isError,
    error,
  } = useBotTradePage(botId, botName, TRADE_HISTORY_LIMIT, {
    chainId,
    operatorApiUrl,
    operatorKind,
    assetMetadata,
    offset,
    refetchInterval: isLive ? 15_000 : false,
  });
  const trades = tradePage?.trades;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState<TradeHistorySortKey>>({ key: 'time', direction: 'desc' });
  const sortedTrades = useMemo(
    () => trades ? sortTradeHistory(trades, sort) : undefined,
    [sort, trades],
  );
  const columnCount = compact ? 6 : 6;
  const handleSort = (key: TradeHistorySortKey, defaultDirection: 'asc' | 'desc' = 'desc') => {
    setExpandedId(null);
    setSort((current) => nextSortState(current, key, defaultDirection));
  };
  const previousPage = () => {
    setExpandedId(null);
    setPageIndex((page) => Math.max(0, page - 1));
  };
  const nextPage = () => {
    setExpandedId(null);
    setPageIndex((page) => page + 1);
  };

  if (isLoading) {
    if (compact) {
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-none border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
          <div className="grid grid-cols-[7.6rem_7.25rem_minmax(0,1fr)_7rem_7.35rem] gap-2 border-b border-[var(--arena-terminal-border)] px-3 py-1 font-data text-[11px] uppercase text-[var(--arena-terminal-text-subtle)]">
            <span>Time</span>
            <span>Trade</span>
            <span>Market</span>
            <span className="text-right">Size</span>
            <span className="text-right">USD</span>
          </div>
          <div className="divide-y divide-[var(--arena-terminal-border)]">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="grid grid-cols-[7.6rem_7.25rem_minmax(0,1fr)_7rem_7.35rem] gap-2 px-3 py-1.5">
                {Array.from({ length: 5 }).map((__, cellIndex) => (
                  <div key={cellIndex} className="h-4 animate-pulse rounded bg-[var(--arena-terminal-panel-strong)]" />
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className={compact ? 'flex h-full min-h-0 flex-col gap-2' : 'space-y-3'}>
        <div className={`${compact ? 'min-h-0 flex-1' : ''} overflow-x-auto rounded-none border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36 ${SQUARE_TABLE_CLASS}`}>
          <Table className={`${compact ? 'w-full table-fixed' : 'min-w-[1120px]'} ${SQUARE_TABLE_CLASS}`}>
            <TradeTableHead compact={compact} sort={sort} onSort={handleSort} />
            <TableBody>
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonTableRow key={i} cols={columnCount} />
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }

  if (isError) {
    return <TradeDataUnavailableCard error={error} />;
  }

  if (!trades || trades.length === 0) {
    if (compact) {
      return (
        <div className="flex h-full min-h-[10rem] items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-4 text-center font-display text-sm text-[var(--arena-terminal-text-muted)]">
          No executions recorded for this agent.
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {verificationState === 'unverified' && (
          <UnverifiedDataNotice subject="trade history" />
        )}
        <div className="glass-card rounded-xl text-center py-16 text-base text-arena-elements-textSecondary">
          <div className="i-ph:swap text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
          No executions recorded for this agent.
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? 'relative flex h-full min-h-0 flex-col' : 'space-y-3'}>
      {verificationState === 'unverified' && (
        <UnverifiedDataNotice subject="trade history" />
      )}

      <TradePager
        page={tradePage}
        onPrevious={previousPage}
        onNext={nextPage}
        className={compact ? 'absolute -top-[2.55rem] right-0 z-10' : undefined}
        terminal={compact}
      />

      <div className={`${compact ? 'min-h-0 flex-1 overflow-auto border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]' : 'overflow-x-auto border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36'} rounded-none border ${SQUARE_TABLE_CLASS}`}>
        <Table className={`${compact ? 'w-full table-fixed' : 'min-w-[1120px]'} ${SQUARE_TABLE_CLASS}`}>
          <TradeTableHead compact={compact} sort={sort} onSort={handleSort} />
          <TableBody>
            {(sortedTrades ?? trades).map((trade) => {
            const responses = trade.validation?.responses ?? [];
            const signedCount = countUsableValidatorSignatures(responses);
            const validationDisplay = getTradeValidationDisplay(trade);
            const hasValidation = responses.length > 0 || trade.validatorScore != null;
            const isExpanded = expandedId === trade.id;
            const fallbackReason = trade.validatorReasoning ?? trade.agentReasoning;
            const compactTimestamp = formatCompactTradeTimestamp(trade.timestamp);

            return (
              <TableRow
                key={trade.id}
                className={`${compact ? 'h-[34px]' : ''} cursor-pointer`}
                onClick={(event) => {
                  if (isInteractiveTradeTarget(event.target)) return;
                  setExpandedId(isExpanded ? null : trade.id);
                }}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setExpandedId(isExpanded ? null : trade.id);
                  }
                }}
              >
              <TableCell className={`${compact ? 'py-0.5 align-middle text-[15px] leading-none text-[var(--arena-terminal-text-secondary)]' : 'py-3'} font-data text-arena-elements-textTertiary`} colSpan={isExpanded ? columnCount : undefined}>
                {isExpanded ? (
                  /* Expanded view replaces the row */
                  <div className="py-2">
                    {/* Trade summary header */}
                    <div className="mb-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setExpandedId(null)}
                        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-arena-elements-textTertiary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:ring-2 focus-visible:ring-violet-500/60"
                        aria-label="Collapse trade details"
                      >
                        <div className="i-ph:caret-up text-base" />
                      </button>
                      <Badge variant={getActionVariant(trade.action)} className="h-8 px-3 text-base">
                        {getActionLabel(trade.action)}
                      </Badge>
                      <TradeInstrumentDisplay trade={trade} size="md" />
                      <span className="text-base font-data text-arena-elements-textTertiary">
                        {formatTradeTimestamp(trade.timestamp)}
                      </span>
                      <span className={`font-data text-base ${getModeToneClass(trade)}`}>
                        {formatTradeModeLabel(trade)}
                      </span>
                      {validationDisplay && (
                        <Badge variant={validationDisplay.badgeVariant} className="h-8 px-3 text-base">
                          {validationDisplay.label}
                        </Badge>
                      )}
                    </div>

                    <div className="mb-3 grid gap-2 md:grid-cols-4">
                      <TradeDetailMetric
                        label="Notional"
                        value={formatTradeCurrency(trade.notionalUsd)}
                      />
                      <TradeDetailMetric
                        label="Route"
                        value={trade.targetProtocol ?? trade.venue}
                      />
                      <TradeDetailMetric
                        label="Fill"
                        value={trade.execution?.status ? formatExecutionStatus(trade.execution.status) : getStatusLabel(trade.status)}
                        tone={trade.status === 'failed' || trade.status === 'rejected' ? 'danger' : trade.status === 'executed' || trade.status === 'paper' ? 'success' : 'neutral'}
                      />
                      <TradeDetailMetric
                        label="Checks"
                        value={validationDisplay?.label ?? (hasValidation ? 'Pending' : '-')}
                        tone={validationDisplay?.badgeVariant === 'success' ? 'success' : validationDisplay?.badgeVariant === 'destructive' ? 'danger' : 'neutral'}
                      />
                    </div>

                    {isHyperliquidTrade(trade) ? (
                      <div className="mb-3 px-1">
                        {renderHyperliquidTradeCell(trade)}
                      </div>
                    ) : (
                      <div className="mb-4 rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/20 px-4 py-3 text-base text-arena-elements-textSecondary">
                        <span className="font-data">
                          {formatTradeAmount(trade.amountIn)}
                        </span>
                        {' '}
                        <AssetDisplay asset={trade.assetIn} compact preferSymbol showSecondary={false} />
                        <span className="mx-2 text-arena-elements-textTertiary">→</span>
                        <span className="font-data">
                          {formatTradeAmount(trade.amountOut)}
                        </span>
                        {' '}
                        <AssetDisplay asset={trade.assetOut} compact preferSymbol showSecondary={false} />
                      </div>
                    )}

                    {trade.txHash && (
                      <div className="flex items-center gap-2 mb-4 px-1">
                        {renderExecutionRef(trade)}
                      </div>
                    )}

                    {validationDisplay?.helperText && (
                      <p className="mb-4 px-1 text-base leading-relaxed text-arena-elements-textSecondary">
                        {validationDisplay.helperText}
                      </p>
                    )}

                    {trade.execution && (
                      <div className="mb-4 rounded-lg border border-arena-elements-border/60 bg-arena-elements-bg-surface/60 p-3">
                        <div className="grid gap-x-5 gap-y-2 text-base text-arena-elements-textSecondary md:grid-cols-3">
                          {trade.execution.clobOrderId && (
                            <div>
                              <code className="font-data text-base">{trade.execution.clobOrderId}</code>
                            </div>
                          )}
                          {trade.execution.requestedPriceUsd != null && (
                            <div>
                              ${formatNumber(trade.execution.requestedPriceUsd, { maximumFractionDigits: 4 })}
                            </div>
                          )}
                          {trade.execution.filledPriceUsd != null && (
                            <div>
                              ${formatNumber(trade.execution.filledPriceUsd, { maximumFractionDigits: 4 })}
                            </div>
                          )}
                          {trade.execution.filledAmount != null && (
                            <div>
                              {formatTradeAmount(trade.execution.filledAmount)}
                            </div>
                          )}
                          {trade.execution.slippageBps != null && (
                            <div>
                              {formatNumber(trade.execution.slippageBps, { maximumFractionDigits: 2 })} bps
                            </div>
                          )}
                        </div>
                        {trade.execution.reason && (
                          <p className="mt-3 text-base leading-relaxed text-arena-elements-textSecondary">
                            {trade.execution.reason}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Per-validator breakdown */}
                    <AnimatePresence>
                      <m.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                      >
                        <div className="space-y-2">
                          {responses.map((response, vi) => (
                            <ValidatorCard
                              key={`${trade.id}-expand-${response.validator}-${vi}`}
                              response={response}
                              index={vi}
                            />
                          ))}
                        </div>
                      </m.div>
                    </AnimatePresence>

                    {/* Simulation detail */}
                    {trade.validation?.simulation && (
                      <div className="mt-3">
                        <SimulationDetail simulation={trade.validation.simulation} />
                      </div>
                    )}

                    {/* Reasoning fallback */}
                    {responses.length === 0 && fallbackReason && (
                      <div className="mt-2 px-1">
                        <div className="text-sm font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
                          Reasoning
                        </div>
                        <p className="text-base text-arena-elements-textSecondary leading-relaxed">
                          {fallbackReason}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Normal compact row content */
                  compact ? (
                    <span className="block truncate whitespace-nowrap tabular-nums">
                      {compactTimestamp.inline}
                    </span>
                  ) : (
                    formatTradeTimestamp(trade.timestamp)
                  )
              )}
              </TableCell>
              {!isExpanded && (
                <>
                  <TableCell className={compact ? 'py-0.5 align-middle' : 'py-4 align-top'}>
                    {compact ? (
                      <span className={`inline-flex h-[22px] min-w-[6.7rem] items-center justify-center rounded-none px-2 font-data text-[13px] font-bold leading-none ${getTerminalTradeActionPillClass(trade.action)}`}>
                        {getActionLabel(trade.action)}
                      </span>
                    ) : (
                      <Badge variant={getActionVariant(trade.action)} className="h-8 px-3 text-base">
                        {getActionLabel(trade.action)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className={compact ? 'min-w-0 py-0.5 align-middle font-display text-[14px] font-semibold' : 'min-w-[420px] py-3 align-top font-display text-lg font-medium'}>
                    {renderTradeInstrumentCell(trade, compact)}
                  </TableCell>
                  {compact && (
                    <>
                      <TableCell className="min-w-0 truncate py-0.5 text-right align-middle font-data text-[14px] tabular-nums text-[var(--arena-terminal-text-secondary)]" title={getTradeSizeLabel(trade)}>
                        {getTradeSizeLabel(trade)}
                      </TableCell>
                      <TableCell className="py-0.5 text-right align-middle font-data text-[16px] font-semibold tabular-nums text-[var(--arena-terminal-text)]">
                        {formatTradeCurrency(trade.notionalUsd)}
                      </TableCell>
                      <TableCell className="hidden py-0.5 text-right align-middle font-data text-[13px] text-[var(--arena-terminal-text-muted)] min-[1500px]:table-cell">
                        {renderExecutionRef(trade)}
                      </TableCell>
                    </>
                  )}
                  {!compact && (
                    <>
                      <TableCell className="hidden py-4 text-right sm:table-cell">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Aggregate score */}
                          {trade.validatorScore != null && (
                            <span className={`font-data text-base font-bold ${
                              trade.validatorScore >= 80 ? 'text-arena-elements-icon-success' :
                              trade.validatorScore >= 50 ? 'text-amber-700 dark:text-amber-400' : 'text-arena-elements-icon-error'
                            }`}>
                              {trade.validatorScore}
                            </span>
                          )}
                          {/* Validator count */}
                          {responses.length > 0 && (
                            <Badge
                              variant={signedCount === responses.length ? 'success' : 'amber'}
                              className="py-0 text-sm"
                            >
                              {signedCount}/{responses.length}
                            </Badge>
                          )}
                          {/* Expand hint */}
                          <div className="i-ph:caret-down text-sm text-arena-elements-textTertiary" />
                          {/* No score */}
                          {trade.validatorScore == null && responses.length === 0 && (
                            <span className="font-data text-base text-arena-elements-textTertiary">-</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="py-4">
                        {renderExecutionRef(trade)}
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={getStatusVariant(trade.status)}
                            className="text-sm"
                          >
                            {trade.status === 'pending' ? (
                              <span className="inline-flex items-center gap-1">
                                <span className="i-ph:arrow-clockwise text-xs animate-spin" />
                                pending
                              </span>
                            ) : (
                              getStatusLabel(trade.status)
                            )}
                          </Badge>
                        </div>
                      </TableCell>
                    </>
                  )}
                </>
              )}
              </TableRow>
            );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
