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

function AssetIcon({ asset, size = 'md' }: { asset: ResolvedAssetDisplay; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={joinClasses(
        'inline-flex shrink-0 items-center justify-center rounded-full font-data font-semibold ring-1 ring-black/5 dark:ring-white/10',
        size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-8 w-8 text-xs',
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
        <span className="truncate text-sm font-medium text-arena-elements-textPrimary">
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

export function AssetPairDisplay({ left, right, className }: AssetPairDisplayProps) {
  return (
    <div
      className={joinClasses('inline-flex min-w-0 items-center gap-2', className)}
      title={`${assetTitle(left)} / ${assetTitle(right)}`}
      aria-label={`${left.symbol}/${right.symbol}`}
    >
      <div className="flex -space-x-1.5">
        <AssetIcon asset={left} size="sm" />
        <AssetIcon asset={right} size="sm" />
      </div>
      <span className="truncate text-sm font-display font-medium text-arena-elements-textPrimary">
        {left.symbol}/{right.symbol}
      </span>
    </div>
  );
}
