import { Link, useNavigate } from 'react-router';
import { isAddress, type Address } from 'viem';
import { Identicon, Skeleton } from '@tangle-network/blueprint-ui/components';
import { TradeInstrumentDisplay } from '~/components/bot-detail/shared/AssetDisplay';
import { useLatestAgentTrades } from '~/lib/hooks/useBotApi';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';
import {
  formatTradeActionLabel,
  formatTradeAge,
  formatTradeUsd,
  getTradeActionPillClass,
} from '~/lib/tradeDisplay';

interface LatestAgentTradesProps {
  bots: Bot[];
  className?: string;
  enabled?: boolean;
  limit?: number;
  variant?: 'standard' | 'panel' | 'explorer';
}

function formatReference(trade: Trade): string {
  const ref = trade.txHash ?? trade.execution?.clobOrderId ?? trade.id;
  if (!ref) return '—';
  return ref.length > 14 ? `${ref.slice(0, 6)}...${ref.slice(-4)}` : ref;
}

export function LatestAgentTrades({
  bots,
  className = '',
  enabled = true,
  limit,
  variant = 'standard',
}: LatestAgentTradesProps) {
  const navigate = useNavigate();
  const { trades, isLoading, candidateCount } = useLatestAgentTrades(bots, {
    enabled,
    limit: limit ?? 10,
  });
  const isPanel = variant === 'panel';
  const isExplorer = variant === 'explorer';
  const isBounded = isPanel || isExplorer;
  const visibleTrades = limit ? trades.slice(0, limit) : trades;

  return (
    <section
      data-testid="live-fill-tape"
      className={`${isBounded ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'mb-6'} rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/42 ${className}`}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-4 border-b border-arena-elements-dividerColor/60 px-4 py-3 sm:px-5">
        <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
          {isExplorer ? 'Latest Fills' : 'Fills'}
        </h2>
        {trades.length === 0 && candidateCount > 0 && (
          <span className="font-data text-xs text-arena-elements-textTertiary">
            {candidateCount} source{candidateCount === 1 ? '' : 's'}
          </span>
        )}
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
        <div className={`${isBounded ? 'flex min-h-0 flex-1 items-center justify-center' : 'px-5 py-10'} text-center text-sm text-arena-elements-textSecondary`}>
          No recent fills reported by active agents.
        </div>
      ) : isPanel ? (
        <div
          data-testid="live-fill-tape-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="sticky top-0 z-10 grid grid-cols-[4.25rem_minmax(0,1fr)_6.25rem] gap-3 border-b border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/96 px-3 py-2 text-xs font-medium text-arena-elements-textTertiary backdrop-blur">
            <span>Time</span>
            <span>Agent / Market</span>
            <span className="text-right">USD</span>
          </div>
          <div className="divide-y divide-arena-elements-dividerColor/50">
            {visibleTrades.map(({ trade, bot, botId, botName }) => {
              const operatorAddress = bot?.operatorAddress;
              const hasOperatorAddress = operatorAddress != null && isAddress(operatorAddress);
              const agentName = bot?.name ?? botName;
              return (
                <button
                  key={`${botId}:${trade.id}`}
                  type="button"
                  className="group grid w-full grid-cols-[4.25rem_minmax(0,1fr)_6.25rem] items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-arena-elements-item-backgroundHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                  aria-label={`Open ${agentName} performance`}
                  onClick={() => navigate(`/arena/bot/${encodeURIComponent(botId)}/performance`)}
                >
                  <span
                    className="font-data text-sm text-arena-elements-textTertiary"
                    title={new Date(trade.timestamp).toLocaleString()}
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
                      <span className="truncate font-display text-sm font-semibold text-arena-elements-textPrimary group-hover:text-violet-700 dark:group-hover:text-violet-300">
                        {agentName}
                      </span>
                    </span>
                    <span className="mt-1 block min-w-0">
                      <TradeInstrumentDisplay
                        trade={trade}
                        size="sm"
                        showVenue={false}
                        labelClassName="max-w-full"
                      />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col items-end gap-1 text-right">
                    <span className={`inline-flex h-7 max-w-full items-center justify-center truncate rounded-md px-2 font-data text-[11px] font-bold ${getTradeActionPillClass(trade.action)}`}>
                      {formatTradeActionLabel(trade.action)}
                    </span>
                    <span className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                      {formatTradeUsd(trade.notionalUsd)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : isExplorer ? (
        <div
          data-testid="live-fill-explorer-scroll"
          className="min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          <table className="w-full min-w-[860px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-arena-elements-background-depth-2/96 backdrop-blur">
              <tr>
                <th className="border-b border-arena-elements-dividerColor/60 px-4 py-2 text-left font-data text-xs font-medium text-arena-elements-textTertiary">Time</th>
                <th className="border-b border-arena-elements-dividerColor/60 px-4 py-2 text-left font-data text-xs font-medium text-arena-elements-textTertiary">Agent</th>
                <th className="border-b border-arena-elements-dividerColor/60 px-4 py-2 text-left font-data text-xs font-medium text-arena-elements-textTertiary">Fill</th>
                <th className="border-b border-arena-elements-dividerColor/60 px-4 py-2 text-left font-data text-xs font-medium text-arena-elements-textTertiary">Market</th>
                <th className="border-b border-arena-elements-dividerColor/60 px-4 py-2 text-right font-data text-xs font-medium text-arena-elements-textTertiary">USD</th>
                <th className="border-b border-arena-elements-dividerColor/60 px-4 py-2 text-right font-data text-xs font-medium text-arena-elements-textTertiary">Ref</th>
              </tr>
            </thead>
            <tbody>
              {visibleTrades.map(({ trade, bot, botId, botName }) => {
                const operatorAddress = bot?.operatorAddress;
                const hasOperatorAddress = operatorAddress != null && isAddress(operatorAddress);
                const agentName = bot?.name ?? botName;
                return (
                  <tr
                    key={`${botId}:${trade.id}`}
                    className="group cursor-pointer transition-colors hover:bg-arena-elements-item-backgroundHover"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${agentName} performance`}
                    onClick={() => navigate(`/arena/bot/${encodeURIComponent(botId)}/performance`)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate(`/arena/bot/${encodeURIComponent(botId)}/performance`);
                      }
                    }}
                  >
                    <td
                      className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle font-data text-sm text-arena-elements-textTertiary"
                      title={new Date(trade.timestamp).toLocaleString()}
                    >
                      {formatTradeAge(trade.timestamp)}
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <Link
                        to={`/arena/bot/${encodeURIComponent(botId)}/performance`}
                        className="flex min-w-0 items-center gap-2.5"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {hasOperatorAddress ? (
                          <Identicon address={operatorAddress as Address} size={22} />
                        ) : (
                          <span className="i-ph:robot inline-block size-5 shrink-0 rounded-full bg-arena-elements-item-backgroundActive text-arena-elements-textTertiary" />
                        )}
                        <span className="truncate font-display text-sm font-semibold text-arena-elements-textPrimary group-hover:text-violet-700 dark:group-hover:text-violet-300">
                          {agentName}
                        </span>
                      </Link>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <span className={`inline-flex h-8 min-w-[4.75rem] items-center justify-center rounded-md px-2.5 font-data text-xs font-bold ${getTradeActionPillClass(trade.action)}`}>
                        {formatTradeActionLabel(trade.action)}
                      </span>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <TradeInstrumentDisplay
                        trade={trade}
                        size="md"
                        showVenue={false}
                        labelClassName="max-w-[320px]"
                      />
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 text-right align-middle font-data text-base font-semibold text-arena-elements-textPrimary">
                      {formatTradeUsd(trade.notionalUsd)}
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
                    className="group cursor-pointer border-b border-arena-elements-dividerColor/50 transition-colors hover:bg-arena-elements-item-backgroundHover"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${bot?.name ?? botName} performance`}
                    onClick={() => navigate(`/arena/bot/${encodeURIComponent(botId)}/performance`)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate(`/arena/bot/${encodeURIComponent(botId)}/performance`);
                      }
                    }}
                  >
                    <td
                      className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle font-data text-sm text-arena-elements-textTertiary"
                      title={new Date(trade.timestamp).toLocaleString()}
                    >
                      {formatTradeAge(trade.timestamp)}
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <Link
                        to={`/arena/bot/${encodeURIComponent(botId)}/performance`}
                        className="flex min-w-0 items-center gap-2"
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
                      <span className={`inline-flex h-8 min-w-[4.25rem] items-center justify-center rounded-md px-2.5 font-data font-bold ${getTradeActionPillClass(trade.action)}`}>
                        {formatTradeActionLabel(trade.action)}
                      </span>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <TradeInstrumentDisplay
                        trade={trade}
                        size="md"
                        showVenue={false}
                        labelClassName="max-w-[280px]"
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
