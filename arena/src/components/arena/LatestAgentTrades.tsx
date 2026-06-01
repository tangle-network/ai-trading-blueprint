import { Link } from 'react-router';
import { isAddress, type Address } from 'viem';
import { Badge, Identicon, Skeleton } from '@tangle-network/blueprint-ui/components';
import { AssetPairDisplay } from '~/components/bot-detail/shared/AssetDisplay';
import { formatNumber } from '~/lib/format';
import { useLatestAgentTrades } from '~/lib/hooks/useBotApi';
import type { Bot } from '~/lib/types/bot';
import { getTradePairLabel, VENUE_CONFIG, type Trade } from '~/lib/types/trade';

interface LatestAgentTradesProps {
  bots: Bot[];
  className?: string;
  limit?: number;
  variant?: 'standard' | 'panel';
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatNotional(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return `$${formatNumber(value, { maximumFractionDigits: 0 })}`;
  return `$${formatNumber(value, { maximumFractionDigits: 2 })}`;
}

function actionTone(action: Trade['action']): string {
  if (action === 'buy' || action === 'open_long') {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (action === 'sell' || action === 'close_long' || action === 'close_short') {
    return 'bg-crimson-500/10 text-crimson-700 dark:text-crimson-300';
  }
  return 'bg-violet-500/10 text-violet-700 dark:text-violet-300';
}

function actionLabel(action: Trade['action']): string {
  return action.replace(/_/g, ' ').toUpperCase();
}

function marketLabel(trade: Trade): string | null {
  if (trade.targetProtocol === 'hyperliquid') {
    const asset = trade.hyperliquidMetadata?.asset?.trim();
    return asset ? `${asset.toUpperCase()}-PERP` : getTradePairLabel(trade);
  }
  if (trade.targetProtocol === 'polymarket_clob') {
    return getTradePairLabel(trade);
  }
  return null;
}

export function LatestAgentTrades({
  bots,
  className = '',
  limit,
  variant = 'standard',
}: LatestAgentTradesProps) {
  const { trades, isLoading, candidateCount } = useLatestAgentTrades(bots);
  const isPanel = variant === 'panel';
  const visibleTrades = limit ? trades.slice(0, limit) : trades;

  return (
    <section className={`${isPanel ? 'flex h-full min-h-0 flex-col' : 'mb-6'} rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/42 ${className}`}>
      <div className="flex items-center justify-between gap-4 border-b border-arena-elements-dividerColor/60 px-4 py-3 sm:px-5">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
            {isPanel ? 'Execution Tape' : 'Latest Trades'}
          </h2>
          <p className="mt-0.5 text-sm text-arena-elements-textSecondary">
            Agent execution feed
          </p>
        </div>
        <Badge variant="outline" className="font-data text-xs">
          {trades.length > 0
            ? `${visibleTrades.length} recent`
            : `${candidateCount} source${candidateCount === 1 ? '' : 's'}`}
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
          No recent trades reported by active agents.
        </div>
      ) : (
        <div className={`${isPanel ? 'min-h-0 flex-1 overflow-y-auto' : ''} divide-y divide-arena-elements-dividerColor/50`}>
          {visibleTrades.map(({ trade, bot, botId, botName }) => {
            const venue = VENUE_CONFIG[trade.venue];
            const label = marketLabel(trade);
            const showStatus = trade.status.toLowerCase() !== venue.label.toLowerCase();
            const operatorAddress = bot?.operatorAddress;
            const hasOperatorAddress = operatorAddress != null && isAddress(operatorAddress);
            return (
              <Link
                key={`${botId}:${trade.id}`}
                to={`/arena/bot/${encodeURIComponent(botId)}/portfolio`}
                className={`group grid grid-cols-[1fr_auto] gap-3 px-4 py-3 transition-colors hover:bg-arena-elements-item-backgroundHover sm:px-5 ${isPanel ? '' : 'lg:grid-cols-[7rem_1.3fr_1.4fr_6rem_5rem]'}`}
              >
                <div className={isPanel ? 'col-span-2 flex items-center justify-between gap-2' : 'flex items-center gap-2'}>
                  <span className={`inline-flex h-7 min-w-[3.75rem] items-center justify-center rounded-md px-2 font-data text-xs font-bold ${actionTone(trade.action)}`}>
                    {actionLabel(trade.action)}
                  </span>
                  <div className="flex items-center gap-2">
                    {isPanel && (
                      <span className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                        {formatNotional(trade.notionalUsd)}
                      </span>
                    )}
                    <span className="font-data text-xs text-arena-elements-textTertiary lg:hidden">
                      {formatAge(trade.timestamp)}
                    </span>
                  </div>
                </div>

                <div className={isPanel ? 'col-span-2 min-w-0' : 'min-w-0'}>
                  <div className="flex min-w-0 items-center gap-2">
                    {hasOperatorAddress ? (
                      <Identicon address={operatorAddress as Address} size={20} />
                    ) : (
                      <span className="i-ph:robot inline-block size-5 shrink-0 rounded-full bg-arena-elements-item-backgroundActive text-arena-elements-textTertiary" />
                    )}
                    <span className="truncate font-display text-base font-semibold text-arena-elements-textPrimary group-hover:text-violet-700 dark:group-hover:text-violet-300">
                      {bot?.name ?? botName}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-data text-xs text-arena-elements-textTertiary">
                    {hasOperatorAddress && operatorAddress
                      ? `${operatorAddress.slice(0, 6)}...${operatorAddress.slice(-4)}`
                      : botId}
                  </div>
                </div>

                <div className={`col-span-2 min-w-0 ${isPanel ? '' : 'lg:col-span-1'}`}>
                  {label ? (
                    <div className="truncate font-display text-base font-medium text-arena-elements-textPrimary" title={label}>
                      {label}
                    </div>
                  ) : (
                    <AssetPairDisplay left={trade.assetIn} right={trade.assetOut} size="md" />
                  )}
                  <div className="mt-0.5 flex min-w-0 items-center gap-2 font-data text-xs text-arena-elements-textSecondary">
                    <span className={`${venue.color} inline-flex items-center gap-1`}>
                      <span className={`${venue.icon} text-sm`} aria-hidden="true" />
                      {venue.label}
                    </span>
                    {showStatus && <span className="truncate">{trade.status}</span>}
                  </div>
                </div>

                <div className={`${isPanel ? 'hidden' : 'hidden lg:flex'} items-center justify-end font-data text-base font-semibold text-arena-elements-textPrimary`}>
                  {formatNotional(trade.notionalUsd)}
                </div>

                <div className={`${isPanel ? 'hidden' : 'hidden lg:flex'} items-center justify-end font-data text-sm text-arena-elements-textTertiary`}>
                  {formatAge(trade.timestamp)}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
