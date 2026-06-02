import { Link, useNavigate } from 'react-router';
import { isAddress, type Address } from 'viem';
import { Badge, Identicon, Skeleton } from '@tangle-network/blueprint-ui/components';
import { AssetPairDisplay } from '~/components/bot-detail/shared/AssetDisplay';
import { useLatestAgentTrades } from '~/lib/hooks/useBotApi';
import type { Bot } from '~/lib/types/bot';
import { VENUE_CONFIG, type Trade } from '~/lib/types/trade';
import {
  formatTradeActionLabel,
  formatTradeAge,
  formatTradeModeLabel,
  formatTradeUsd,
  getTradeActionPillClass,
  getTradeInstrumentBadgeText,
  getTradeMarketLabel,
} from '~/lib/tradeDisplay';

interface LatestAgentTradesProps {
  bots: Bot[];
  className?: string;
  enabled?: boolean;
  limit?: number;
  variant?: 'standard' | 'panel';
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
  const visibleTrades = limit ? trades.slice(0, limit) : trades;

  return (
    <section
      className={`${isPanel ? 'flex h-full min-h-0 flex-col' : 'mb-6'} rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/42 ${className}`}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-4 border-b border-arena-elements-dividerColor/60 px-4 py-3 sm:px-5">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
            Live Fill Tape
          </h2>
        </div>
        <Badge variant="outline" className="font-data text-xs">
          {trades.length > 0
            ? `Last ${visibleTrades.length}`
            : `${candidateCount} operator${candidateCount === 1 ? '' : 's'}`}
        </Badge>
      </div>

      {isLoading ? (
        <div className={`${isPanel ? 'min-h-0 flex-1 overflow-hidden' : ''} divide-y divide-arena-elements-dividerColor/50`}>
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className={`grid grid-cols-[1fr_auto] gap-4 px-4 py-3 sm:px-5 ${isPanel ? '' : 'lg:grid-cols-[7rem_1.3fr_1.4fr_6rem_5rem]'}`}>
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-7 w-full" />
              {!isPanel && <Skeleton className="hidden h-7 w-full lg:block" />}
              {!isPanel && <Skeleton className="hidden h-7 w-16 lg:block" />}
              <Skeleton className="h-7 w-12" />
            </div>
          ))}
        </div>
      ) : visibleTrades.length === 0 ? (
        <div className={`${isPanel ? 'flex min-h-0 flex-1 items-center justify-center' : 'px-5 py-10'} text-center text-sm text-arena-elements-textSecondary`}>
          No recent fills reported by active agents.
        </div>
      ) : (
        <div className={`${isPanel ? 'min-h-0 flex-1 overflow-auto' : 'overflow-x-auto'}`}>
          <table className={`w-full border-separate border-spacing-0 ${isPanel ? 'min-w-[500px] [&_td]:px-3 [&_th]:px-3' : 'min-w-[760px]'}`}>
            <thead className="sticky top-0 z-10 bg-arena-elements-background-depth-2/96 backdrop-blur">
              <tr className="border-b border-arena-elements-dividerColor/60">
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Age</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Agent</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Action</th>
                <th className="px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Market</th>
                <th className="px-4 py-2 text-right font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">Notional</th>
                <th className={`${isPanel ? 'hidden' : ''} px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary`}>Mode</th>
                <th className={`${isPanel ? 'hidden' : ''} px-4 py-2 text-left font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary`}>Status</th>
                <th className={`${isPanel ? 'hidden' : ''} px-4 py-2 text-right font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary`}>Ref</th>
              </tr>
            </thead>
            <tbody>
              {visibleTrades.map(({ trade, bot, botId, botName }) => {
                const venue = VENUE_CONFIG[trade.venue];
                const label = getTradeMarketLabel(trade);
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
                        <span className={`${isPanel ? 'max-w-[126px]' : ''} truncate font-display text-sm font-semibold text-arena-elements-textPrimary group-hover:text-violet-700 dark:group-hover:text-violet-300`}>
                          {bot?.name ?? botName}
                        </span>
                      </Link>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <span className={`inline-flex h-7 ${isPanel ? 'min-w-[4rem] px-2 text-[11px]' : 'min-w-[3.75rem] px-2'} items-center justify-center rounded-md font-data text-xs font-bold ${getTradeActionPillClass(trade.action)}`}>
                        {formatTradeActionLabel(trade.action)}
                      </span>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle">
                      <div className="min-w-0">
                        {label ? (
                          <div className="flex min-w-0 items-center gap-2" title={label}>
                            <span
                              aria-hidden="true"
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-arena-elements-item-backgroundActive font-data text-[10px] font-bold text-arena-elements-textSecondary ring-1 ring-black/5 dark:ring-white/10"
                            >
                              {getTradeInstrumentBadgeText(trade)}
                            </span>
                            <span className={`${isPanel ? 'max-w-[120px]' : 'max-w-[240px]'} truncate font-display text-sm font-medium text-arena-elements-textPrimary`}>
                              {label}
                            </span>
                          </div>
                        ) : (
                          <AssetPairDisplay left={trade.assetIn} right={trade.assetOut} size="md" />
                        )}
                        <div className="mt-0.5 flex min-w-0 items-center gap-2 font-data text-xs text-arena-elements-textSecondary">
                          <span className={`${venue.color} inline-flex items-center gap-1`}>
                            <span className={`${venue.icon} text-sm`} aria-hidden="true" />
                            {venue.label}
                          </span>
                          {isPanel && (
                            <span className="truncate">
                              {formatTradeModeLabel(trade)}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="border-b border-arena-elements-dividerColor/45 px-4 py-3 text-right align-middle font-data text-base font-semibold text-arena-elements-textPrimary">
                      {formatTradeUsd(trade.notionalUsd)}
                    </td>
                    <td className={`${isPanel ? 'hidden' : ''} border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle font-data text-sm text-arena-elements-textSecondary`}>
                      {formatTradeModeLabel(trade)}
                    </td>
                    <td className={`${isPanel ? 'hidden' : ''} border-b border-arena-elements-dividerColor/45 px-4 py-3 align-middle font-data text-sm text-arena-elements-textSecondary`}>
                      {trade.status}
                    </td>
                    <td className={`${isPanel ? 'hidden' : ''} border-b border-arena-elements-dividerColor/45 px-4 py-3 text-right align-middle font-data text-sm text-arena-elements-textTertiary`}>
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
