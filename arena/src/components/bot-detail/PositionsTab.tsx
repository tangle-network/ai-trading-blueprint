import { useBotPortfolio } from '~/lib/hooks/useBotApi';
import type { BotStatus } from '~/lib/types/bot';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import type { BotOperatorKind, BotVerificationState } from '~/lib/types/bot';
import { botStatusLabel, formatNumber, isLiveBotStatus } from '~/lib/format';
import { AssetDisplay } from './shared/AssetDisplay';
import { UnverifiedDataNotice } from './shared/DataAccessNotices';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';
import type { Position } from '~/lib/types/portfolio';

interface PositionsTabProps {
  botId: string;
  status: BotStatus;
  chainId?: number;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
  assetMetadata?: TokenMetadata[];
}

export function PositionsTab({ botId, status, chainId, operatorApiUrl, operatorKind, verificationState, assetMetadata }: PositionsTabProps) {
  const isLive = isLiveBotStatus(status);
  const { data: portfolio, isLoading } = useBotPortfolio(botId, {
    chainId,
    operatorApiUrl,
    operatorKind,
    assetMetadata,
    enabled: true,
    refetchInterval: isLive ? 30_000 : false,
  });

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-base text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading positions...
      </div>
    );
  }

  if (!portfolio) {
    return (
      <div className="space-y-4">
        {verificationState === 'unverified' && (
          <UnverifiedDataNotice subject="portfolio state" />
        )}
        <div className="glass-card rounded-xl text-center py-16 text-base text-arena-elements-textSecondary">
          <div className="i-ph:wallet text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
          No portfolio data available for this bot{isLive ? '.' : ` while it is ${botStatusLabel(status).toLowerCase()}.`}
        </div>
      </div>
    );
  }

  const formatCurrency = (value: number | null) => {
    if (value == null) return 'Unavailable';
    const formatted = `$${formatNumber(Math.abs(value))}`;
    return value < 0 ? `-${formatted}` : formatted;
  };

  const formatPercent = (value: number | null) => {
    if (value == null) return 'Unavailable';
    return `${formatNumber(value, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    })}%`;
  };

  const isHyperliquidPerpPosition = (pos: Position) => (
    pos.protocol === 'hyperliquid'
    && (pos.positionType === 'long_perp' || pos.positionType === 'short_perp')
  );

  const perpDirection = (pos: Position) => (
    pos.positionType === 'short_perp' ? 'Short' : 'Long'
  );

  const perpAssetLabel = (pos: Position) => `${pos.token || pos.symbol} Perp`;

  const formatSize = (pos: Position) => `${formatNumber(Math.abs(pos.amount), {
    maximumFractionDigits: 6,
  })} ${pos.token || pos.symbol}`;

  const marginUsedUsd = (pos: Position) => pos.marginUsedUsd ?? pos.valueUsd;

  const marginUsage = (pos: Position) => {
    const margin = marginUsedUsd(pos);
    if (margin == null || portfolio.totalValueUsd == null || portfolio.totalValueUsd <= 0) {
      return pos.weight ?? null;
    }
    return (margin / portfolio.totalValueUsd) * 100;
  };

  const formatLeverage = (value: number | null | undefined) => {
    if (value == null) return 'Unavailable';
    return `${formatNumber(value, {
      maximumFractionDigits: 1,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    })}x`;
  };

  const warningTitle = portfolio.hasUnpricedPositions
    ? 'Portfolio valuation unavailable'
    : 'Portfolio warnings';
  const displayWarnings = portfolio.warnings;
  const perpPositions = portfolio.positions.filter(isHyperliquidPerpPosition);
  const standardPositions = portfolio.positions.filter((pos) => !isHyperliquidPerpPosition(pos));
  const hasPerpPositions = perpPositions.length > 0;
  const totalMarginUsed = perpPositions.reduce((sum, pos) => sum + (marginUsedUsd(pos) ?? 0), 0);
  const totalMarginUsage = portfolio.totalValueUsd && portfolio.totalValueUsd > 0
    ? (totalMarginUsed / portfolio.totalValueUsd) * 100
    : null;
  const pricedPositionValue = portfolio.positions.reduce(
    (sum, pos) => sum + (pos.displayValueUsd ?? 0),
    0,
  );
  const hasPricedPositionValue = portfolio.positions.some((pos) => pos.displayValueUsd != null);

  const renderStandardPositionsTable = (positions: Position[]) => (
    <div className="overflow-x-auto rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36">
      <Table className="min-w-[780px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="py-4 text-base">Token</TableHead>
          <TableHead className="py-4 text-right text-base">Amount</TableHead>
          <TableHead className="py-4 text-right text-base">Value</TableHead>
          <TableHead className="py-4 text-right text-base">Current</TableHead>
          <TableHead className="py-4 text-right text-base">Weight</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => (
          <TableRow key={pos.token}>
            <TableCell className="py-4 font-display text-lg font-semibold">
              <div className="flex items-center justify-between gap-2">
                <AssetDisplay asset={pos.asset} />
                {pos.valuationStatus !== 'priced' && (
                  <Badge
                    variant="amber"
                    className="text-xs"
                    title={pos.warnings.join(' ')}
                  >
                    {pos.valuationStatus === 'value_only' ? 'Value only' : 'Unpriced'}
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="py-4 text-right font-data text-lg">{formatNumber(pos.amount)}</TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${pos.displayValueUsd == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.displayValueUsd)}
            </TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${pos.currentPrice == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.currentPrice)}
            </TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${pos.displayWeight == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textSecondary'}`}>
              {formatPercent(pos.displayWeight)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      </Table>
    </div>
  );

  const renderPerpPositionsTable = (positions: Position[]) => (
    <div className="overflow-x-auto rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36">
      <Table className="min-w-[1120px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="py-4 text-base">Position</TableHead>
          <TableHead className="py-4 text-base">Direction</TableHead>
          <TableHead className="py-4 text-right text-base">Size</TableHead>
          <TableHead className="py-4 text-right text-base">Notional</TableHead>
          <TableHead className="py-4 text-right text-base">Margin Used</TableHead>
          <TableHead className="py-4 text-right text-base">Margin Usage</TableHead>
          <TableHead className="py-4 text-right text-base">Leverage</TableHead>
          <TableHead className="py-4 text-right text-base">PnL</TableHead>
          <TableHead className="py-4 text-right text-base">Liquidation</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => (
          <TableRow key={`${pos.protocol}-${pos.positionType}-${pos.token}`}>
            <TableCell className="py-4 font-display font-semibold">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-data font-semibold text-sky-700 ring-1 ring-black/5 dark:bg-sky-500/20 dark:text-sky-200 dark:ring-white/10"
                >
                  {pos.token}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-lg font-display font-semibold text-arena-elements-textPrimary">
                    {perpAssetLabel(pos)}
                  </div>
                  <div className="truncate text-base font-data text-arena-elements-textTertiary">
                    Hyperliquid
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell className="py-4 font-data text-lg text-arena-elements-textSecondary">
              {perpDirection(pos)}
            </TableCell>
            <TableCell className="py-4 text-right font-data text-lg">{formatSize(pos)}</TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${pos.notionalUsd == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.notionalUsd ?? null)}
            </TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${marginUsedUsd(pos) == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(marginUsedUsd(pos))}
            </TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${marginUsage(pos) == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textSecondary'}`}>
              {formatPercent(marginUsage(pos))}
            </TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${pos.leverage == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatLeverage(pos.leverage)}
            </TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${pos.unrealizedPnlUsd == null ? 'text-arena-elements-textTertiary' : pos.unrealizedPnlUsd < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {formatCurrency(pos.unrealizedPnlUsd ?? null)}
            </TableCell>
            <TableCell className={`py-4 text-right font-data text-lg ${pos.liquidationPrice == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.liquidationPrice ?? null)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      </Table>
    </div>
  );

  return (
    <div className="space-y-4">
      {verificationState === 'unverified' && (
        <UnverifiedDataNotice subject="portfolio state" />
      )}

      {displayWarnings.length > 0 && (
        <div className="glass-card rounded-xl px-4 py-3 flex items-start gap-3 text-sm text-amber-700 dark:text-amber-400">
          <div className="i-ph:warning-circle text-lg shrink-0 mt-0.5" />
          <div>
            <div className="font-display font-semibold text-arena-elements-textPrimary mb-1">
              {warningTitle}
            </div>
            <div className="space-y-1">
              {displayWarnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 mb-4 md:grid-cols-3 xl:grid-cols-4">
        <div className="glass-card rounded-lg px-4 py-3">
          <div className="text-base font-data uppercase tracking-wider text-arena-elements-textTertiary">
            {hasPerpPositions ? 'Bot Equity' : 'Account Total'}
          </div>
          <div className="mt-1 font-display font-bold text-3xl">
            {formatCurrency(portfolio.displayTotalValueUsd)}
          </div>
          {!hasPerpPositions && (
            <p className="mt-1 text-sm text-arena-elements-textTertiary">
              Includes priced positions plus available cash.
            </p>
          )}
        </div>
        <div className="glass-card rounded-lg px-4 py-3">
          <div className="text-base font-data uppercase tracking-wider text-arena-elements-textTertiary">
            Positions Value
          </div>
          <div className="mt-1 font-display font-bold text-3xl">
            {hasPricedPositionValue ? formatCurrency(pricedPositionValue) : 'Unavailable'}
          </div>
          <p className="mt-1 text-sm text-arena-elements-textTertiary">
            Sum of visible rows, excluding cash.
          </p>
        </div>
        <div className="glass-card rounded-lg px-4 py-3">
          <div className="text-base font-data uppercase tracking-wider text-arena-elements-textTertiary">
            Cash
          </div>
          <div className="mt-1 font-display font-bold text-3xl">
            {formatCurrency(portfolio.displayCashBalance)}
          </div>
        </div>
        {hasPerpPositions && (
          <div className="glass-card rounded-lg px-4 py-3">
            <div className="text-base font-data uppercase tracking-wider text-arena-elements-textTertiary">
              Margin Usage
            </div>
            <div className="mt-1 font-display font-bold text-3xl">
              {formatPercent(totalMarginUsage)}
            </div>
          </div>
        )}
      </div>

      {hasPerpPositions && renderPerpPositionsTable(perpPositions)}
      {standardPositions.length > 0 && renderStandardPositionsTable(standardPositions)}
    </div>
  );
}
