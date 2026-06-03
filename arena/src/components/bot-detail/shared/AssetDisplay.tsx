import { useState } from 'react';
import { VENUE_CONFIG, type Trade } from '~/lib/types/trade';
import type { ResolvedAssetDisplay } from '~/lib/tradeTokenMetadata';
import {
  getHyperliquidMarketLabel,
  getHyperliquidSizeLabel,
  getTradeMarketLabel,
} from '~/lib/tradeDisplay';

interface AssetDisplayProps {
  asset: ResolvedAssetDisplay;
  compact?: boolean;
  preferSymbol?: boolean;
  showSecondary?: boolean;
  className?: string;
}

interface AssetPairDisplayProps {
  left: ResolvedAssetDisplay;
  right: ResolvedAssetDisplay;
  className?: string;
  labelClassName?: string;
  size?: 'sm' | 'md' | 'lg';
}

interface TradeInstrumentDisplayProps {
  trade: Trade;
  className?: string;
  size?: 'sm' | 'md';
  showVenue?: boolean;
  showSecondary?: boolean;
  labelClassName?: string;
  terminal?: boolean;
}

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function assetTitle(asset: ResolvedAssetDisplay): string {
  if (asset.shortAddress) return `${asset.name} (${asset.shortAddress})`;
  return asset.name;
}

function assetSecondaryLabel(
  asset: ResolvedAssetDisplay,
  preferSymbol: boolean,
  showSecondary: boolean,
): string | undefined {
  if (!showSecondary) return undefined;
  if (preferSymbol) {
    if (asset.name !== asset.symbol) return asset.name;
    return asset.shortAddress;
  }

  return asset.secondaryLabel;
}

export function AssetIcon({
  asset,
  size = 'md',
}: {
  asset: ResolvedAssetDisplay;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const sizeClass = size === 'sm'
    ? 'h-5 w-5 text-[10px]'
    : size === 'lg'
      ? 'h-10 w-10 text-sm'
      : 'h-8 w-8 text-xs';
  const shellClassName = joinClasses(
    'inline-flex shrink-0 items-center justify-center rounded-full font-data font-semibold ring-1 ring-black/5 dark:ring-white/10',
    sizeClass,
  );

  if (asset.logoUri && !logoFailed) {
    return (
      <span
        aria-hidden="true"
        className={joinClasses(
          shellClassName,
          'overflow-hidden bg-white shadow-[0_1px_6px_rgba(15,23,42,0.14)] dark:bg-arena-elements-background-depth-2',
        )}
      >
        <img
          src={asset.logoUri}
          alt=""
          className="h-full w-full rounded-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setLogoFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={joinClasses(
        shellClassName,
        asset.accentClassName,
      )}
    >
      {asset.iconText}
    </span>
  );
}

export function AssetDisplay({
  asset,
  compact = false,
  preferSymbol = false,
  showSecondary = true,
  className,
}: AssetDisplayProps) {
  const primaryLabel = preferSymbol ? asset.symbol : asset.primaryLabel;
  const secondaryLabel = assetSecondaryLabel(asset, preferSymbol, showSecondary);

  if (compact) {
    return (
      <span className={joinClasses('inline-flex items-center gap-2 min-w-0', className)} title={assetTitle(asset)}>
        <AssetIcon asset={asset} size="sm" />
        <span className="max-w-[11rem] truncate text-base font-medium text-arena-elements-textPrimary">
          {primaryLabel}
        </span>
      </span>
    );
  }

  return (
    <div className={joinClasses('flex items-center gap-3 min-w-0', className)} title={assetTitle(asset)}>
      <AssetIcon asset={asset} />
      <div className="min-w-0">
        <div className="truncate text-sm font-display font-semibold text-arena-elements-textPrimary">
          {primaryLabel}
        </div>
        {secondaryLabel && (
          <div className="truncate text-xs font-data text-arena-elements-textTertiary">
            {secondaryLabel}
          </div>
        )}
      </div>
    </div>
  );
}

export function AssetPairDisplay({ left, right, className, labelClassName, size = 'md' }: AssetPairDisplayProps) {
  const iconSize = size === 'lg' ? 'lg' : 'sm';
  const sizeLabelClassName = size === 'lg'
    ? 'whitespace-nowrap text-lg font-semibold'
    : size === 'md'
      ? 'whitespace-nowrap text-base font-medium'
      : 'truncate text-sm font-medium';

  return (
    <div
      className={joinClasses('inline-flex min-w-0 items-center gap-2', className)}
      title={`${assetTitle(left)} / ${assetTitle(right)}`}
      aria-label={`${left.symbol}/${right.symbol}`}
    >
      <div className={joinClasses('flex shrink-0', size === 'lg' ? '-space-x-2' : '-space-x-1.5')}>
        <AssetIcon asset={left} size={iconSize} />
        <AssetIcon asset={right} size={iconSize} />
      </div>
      <span className={joinClasses('font-display text-arena-elements-textPrimary', sizeLabelClassName, labelClassName)}>
        {left.symbol}/{right.symbol}
      </span>
    </div>
  );
}

function predictionToneClass(outcomeLabel?: string): string {
  if (/^yes$/i.test(outcomeLabel ?? '')) {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200';
  }
  if (/^no$/i.test(outcomeLabel ?? '')) {
    return 'bg-crimson-100 text-crimson-800 dark:bg-crimson-500/20 dark:text-crimson-200';
  }
  return 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-500/20 dark:text-fuchsia-200';
}

function predictionIconText(outcomeLabel?: string): string {
  const label = outcomeLabel?.trim();
  if (!label) return 'PM';
  return label.length <= 3 ? label.toUpperCase() : label.slice(0, 3).toUpperCase();
}

function perpIconText(trade: Trade): string {
  return trade.hyperliquidMetadata?.asset?.trim().slice(0, 3).toUpperCase() || 'PERP';
}

function tradeInstrumentSecondary(trade: Trade): string | null {
  if (trade.targetProtocol === 'hyperliquid') {
    return getHyperliquidSizeLabel(trade) ?? 'Hyperliquid';
  }
  if (trade.targetProtocol === 'polymarket_clob') {
    return [
      trade.predictionMetadata?.outcomeLabel?.trim(),
      trade.predictionMetadata?.marketSlug?.trim(),
    ].filter(Boolean).join(' · ') || 'Prediction market';
  }
  return null;
}

export function TradeInstrumentDisplay({
  trade,
  className,
  size = 'md',
  showVenue = true,
  showSecondary = true,
  labelClassName,
  terminal = false,
}: TradeInstrumentDisplayProps) {
  const venue = VENUE_CONFIG[trade.venue];
  const isCompact = size === 'sm';

  if (trade.targetProtocol !== 'hyperliquid' && trade.targetProtocol !== 'polymarket_clob') {
    return (
      <div className={joinClasses('min-w-0', className)}>
        <AssetPairDisplay
          left={trade.assetIn}
          right={trade.assetOut}
          size={isCompact ? 'sm' : 'md'}
          labelClassName={labelClassName}
        />
        {showVenue && (
          <div className={joinClasses(
            'mt-0.5 flex min-w-0 items-center gap-1.5 font-data text-xs',
            terminal ? 'text-[#949e9c]' : 'text-arena-elements-textSecondary',
          )}>
            <span className={`${venue.color} inline-flex items-center gap-1`}>
              <span className={`${venue.icon} text-sm`} aria-hidden="true" />
              {venue.label}
            </span>
          </div>
        )}
      </div>
    );
  }

  const marketLabel = trade.targetProtocol === 'hyperliquid'
    ? getHyperliquidMarketLabel(trade) ?? getTradeMarketLabel(trade)
    : getTradeMarketLabel(trade);
  const iconClassName = trade.targetProtocol === 'hyperliquid'
    ? 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200'
    : predictionToneClass(trade.predictionMetadata?.outcomeLabel);
  const iconText = trade.targetProtocol === 'hyperliquid'
    ? perpIconText(trade)
    : predictionIconText(trade.predictionMetadata?.outcomeLabel);
  const secondary = showSecondary ? tradeInstrumentSecondary(trade) : null;

  return (
    <div
      className={joinClasses('flex min-w-0 items-center gap-2', className)}
      title={marketLabel}
      aria-label={marketLabel}
    >
      <span
        aria-hidden="true"
        className={joinClasses(
          'inline-flex shrink-0 items-center justify-center rounded-full font-data font-bold ring-1 ring-black/5 dark:ring-white/10',
          isCompact ? 'h-6 w-6 text-[9px]' : 'h-8 w-8 text-[10px]',
          iconClassName,
        )}
      >
        {iconText}
      </span>
      <div className="min-w-0">
        <div
          className={joinClasses(
            'truncate font-display font-semibold',
            terminal ? 'text-[#d2dad7]' : 'text-arena-elements-textPrimary',
            isCompact ? 'text-sm' : 'text-sm',
            labelClassName,
          )}
        >
          {marketLabel}
        </div>
        {(showVenue || secondary) && (
          <div className={joinClasses(
            'mt-0.5 flex min-w-0 items-center gap-2 font-data text-xs',
            terminal ? 'text-[#949e9c]' : 'text-arena-elements-textSecondary',
          )}>
            {showVenue && (
              <span className={`${venue.color} inline-flex shrink-0 items-center gap-1`}>
                <span className={`${venue.icon} text-sm`} aria-hidden="true" />
                {venue.label}
              </span>
            )}
            {secondary && <span className="truncate">{secondary}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
