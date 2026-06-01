import { useState } from 'react';
import type { ResolvedAssetDisplay } from '~/lib/tradeTokenMetadata';

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
  size?: 'sm' | 'md' | 'lg';
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

function AssetIcon({
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

export function AssetPairDisplay({ left, right, className, size = 'md' }: AssetPairDisplayProps) {
  const iconSize = size === 'lg' ? 'lg' : 'sm';
  const labelClassName = size === 'lg'
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
      <span className={joinClasses('font-display text-arena-elements-textPrimary', labelClassName)}>
        {left.symbol}/{right.symbol}
      </span>
    </div>
  );
}
