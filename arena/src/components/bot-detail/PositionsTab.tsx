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
  workspace?: boolean;
  workspaceLayout?: 'wide' | 'rail' | 'ledger';
}

export function PositionsTab({ botId, status, chainId, operatorApiUrl, operatorKind, verificationState, assetMetadata, workspace = false, workspaceLayout = 'wide' }: PositionsTabProps) {
  const isLive = isLiveBotStatus(status);
  const compactRail = workspace && workspaceLayout === 'rail';
  const ledger = workspace && workspaceLayout === 'ledger';
  const { data: portfolio, isLoading } = useBotPortfolio(botId, {
    chainId,
    operatorApiUrl,
    operatorKind,
    assetMetadata,
    enabled: true,
    refetchInterval: isLive ? 30_000 : false,
  });

  if (isLoading) {
    if (ledger) {
      return (
        <div className="h-full min-h-0 overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
          <div className="grid grid-cols-3 divide-x divide-[var(--arena-terminal-border)] border-b border-[var(--arena-terminal-border)]">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="px-3 py-2">
                <div className="h-2 w-12 animate-pulse rounded bg-[var(--arena-terminal-panel-strong)]" />
                <div className="mt-2 h-4 w-20 animate-pulse rounded bg-[var(--arena-terminal-panel-strong)]" />
              </div>
            ))}
          </div>
          <div className="divide-y divide-[var(--arena-terminal-border)]">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_5rem_5rem] gap-3 px-3 py-3">
                <div className="h-4 animate-pulse rounded bg-[var(--arena-terminal-panel-strong)]" />
                <div className="h-4 animate-pulse rounded bg-[var(--arena-terminal-panel-strong)]" />
                <div className="h-4 animate-pulse rounded bg-[var(--arena-terminal-panel-strong)]" />
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="glass-card rounded-xl text-center py-16 text-base text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading positions…
      </div>
    );
  }

  if (!portfolio) {
    if (ledger) {
      return (
        <div className="flex h-full min-h-[8rem] items-center justify-center rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-4 text-center font-display text-sm text-[var(--arena-terminal-text-muted)]">
          No portfolio data available{isLive ? '.' : ` while it is ${botStatusLabel(status).toLowerCase()}.`}
        </div>
      );
    }

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
  const totalNotionalUsd = perpPositions.reduce((sum, pos) => sum + (pos.notionalUsd ?? 0), 0);
  const unrealizedPnlValues = perpPositions
    .map((pos) => pos.unrealizedPnlUsd)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const totalUnrealizedPnl = unrealizedPnlValues.length > 0
    ? unrealizedPnlValues.reduce((sum, value) => sum + value, 0)
    : null;
  const totalMarginUsage = portfolio.totalValueUsd && portfolio.totalValueUsd > 0
    ? (totalMarginUsed / portfolio.totalValueUsd) * 100
    : null;
  const positionCountLabel = formatNumber(portfolio.positions.length, { maximumFractionDigits: 0 });
  const pnlTone = totalUnrealizedPnl == null
    ? 'text-[var(--arena-terminal-text)]'
    : totalUnrealizedPnl < 0
      ? 'text-[#ff5d6c]'
      : 'text-[#50d2c1]';
  const ledgerAccountMetrics = hasPerpPositions
    ? [
      {
        label: 'Equity',
        value: formatCurrency(portfolio.displayTotalValueUsd),
        detail: 'portfolio value',
        valueClassName: 'text-[var(--arena-terminal-text)]',
      },
      {
        label: 'Cash',
        value: formatCurrency(portfolio.displayCashBalance),
        detail: `${formatPercent(totalMarginUsage)} margin use`,
        valueClassName: 'text-[var(--arena-terminal-text)]',
      },
      {
        label: 'Notional',
        value: formatCurrency(totalNotionalUsd > 0 ? totalNotionalUsd : null),
        detail: `${formatCurrency(totalMarginUsed > 0 ? totalMarginUsed : null)} margin`,
        valueClassName: 'text-[var(--arena-terminal-text)]',
      },
      {
        label: 'uPNL',
        value: formatCurrency(totalUnrealizedPnl),
        detail: perpPositions.length > 0 ? 'open exposure' : 'flat',
        valueClassName: pnlTone,
      },
    ]
    : [
      {
        label: 'Value',
        value: formatCurrency(portfolio.displayTotalValueUsd),
        detail: `${positionCountLabel} position${portfolio.positions.length === 1 ? '' : 's'}`,
        valueClassName: 'text-[var(--arena-terminal-text)]',
      },
      {
        label: 'Cash',
        value: formatCurrency(portfolio.displayCashBalance),
        detail: 'available',
        valueClassName: 'text-[var(--arena-terminal-text)]',
      },
      {
        label: 'Positions',
        value: positionCountLabel,
        detail: portfolio.hasUnpricedPositions ? 'valuation pending' : 'priced',
        valueClassName: 'text-[var(--arena-terminal-text)]',
      },
    ];
  const positionHeadClass = (dense: boolean) => dense ? 'py-1.5 text-[11px]' : 'py-4 text-base';
  const positionCellClass = (dense: boolean) => dense ? 'py-1.5 text-[15px]' : 'py-4 text-base';
  const positionPrimaryCellClass = (dense: boolean) => dense ? 'py-1.5 text-[15px]' : 'py-4';

  const renderStandardPositionsTable = (positions: Position[], dense = false) => (
    <div className={`${ledger ? 'rounded-[5px] border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]' : 'rounded-lg border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36'} overflow-x-auto border`}>
      <Table className={dense ? 'min-w-[620px]' : 'min-w-[780px]'}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={positionHeadClass(dense)}>Asset</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Amount</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Value</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Price</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Weight</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => (
          <TableRow key={pos.token}>
            <TableCell className={`${positionPrimaryCellClass(dense)} font-display font-semibold`}>
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
            <TableCell className={`${positionCellClass(dense)} text-right font-data`}>{formatNumber(pos.amount)}</TableCell>
            <TableCell className={`${positionCellClass(dense)} text-right font-data ${pos.displayValueUsd == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.displayValueUsd)}
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} text-right font-data ${pos.currentPrice == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.currentPrice)}
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} text-right font-data ${pos.displayWeight == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textSecondary'}`}>
              {formatPercent(pos.displayWeight)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      </Table>
    </div>
  );

  const renderPerpPositionsTable = (positions: Position[], dense = false) => (
    <div className={`${ledger ? 'rounded-[5px] border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]' : 'rounded-lg border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36'} overflow-x-auto border`}>
      <Table className={dense ? 'min-w-[920px]' : 'min-w-[1120px]'}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={positionHeadClass(dense)}>Market</TableHead>
          <TableHead className={positionHeadClass(dense)}>Side</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Size</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Notional</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Margin</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Usage</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Lev</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>PnL</TableHead>
          <TableHead className={`${positionHeadClass(dense)} text-right`}>Liq</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => {
          const direction = perpDirection(pos);
          const pnl = pos.unrealizedPnlUsd ?? null;
          const directionClass = direction === 'Short'
            ? 'border-[#5a2934] bg-[#2a1016] text-[#ff5d6c]'
            : 'border-[#1d5b52] bg-[#0d302c] text-[#50d2c1]';
          const pnlClass = pnl == null
            ? 'text-[#949e9c]'
            : pnl < 0
              ? 'text-[#ff5d6c]'
              : 'text-[#50d2c1]';
          return (
          <TableRow key={`${pos.protocol}-${pos.positionType}-${pos.token}`}>
            <TableCell className={`${positionPrimaryCellClass(dense)} font-display font-semibold`}>
              <div className="flex items-center gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className={`${dense ? 'h-7 w-7 text-[11px]' : 'h-10 w-10 text-sm'} inline-flex shrink-0 items-center justify-center rounded-full bg-sky-100 font-data font-semibold text-sky-700 ring-1 ring-black/5 dark:bg-sky-500/20 dark:text-sky-200 dark:ring-white/10`}
                >
                  {pos.token}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-display font-semibold leading-5 text-arena-elements-textPrimary">
                    {perpAssetLabel(pos)}
                  </div>
                  <div className="truncate text-[12px] font-data leading-4 text-arena-elements-textTertiary">
                    Hyperliquid
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} font-data`}>
              <span className={`inline-flex h-[22px] min-w-[4.5rem] items-center justify-center rounded-[4px] border px-2 font-data text-xs font-bold uppercase ${directionClass}`}>
                {direction}
              </span>
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} whitespace-nowrap text-right font-data`}>{formatSize(pos)}</TableCell>
            <TableCell className={`${positionCellClass(dense)} whitespace-nowrap text-right font-data ${pos.notionalUsd == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.notionalUsd ?? null)}
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} whitespace-nowrap text-right font-data ${marginUsedUsd(pos) == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(marginUsedUsd(pos))}
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} whitespace-nowrap text-right font-data ${marginUsage(pos) == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textSecondary'}`}>
              {formatPercent(marginUsage(pos))}
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} whitespace-nowrap text-right font-data ${pos.leverage == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatLeverage(pos.leverage)}
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} whitespace-nowrap text-right font-data font-semibold ${pnlClass}`}>
              {formatCurrency(pnl)}
            </TableCell>
            <TableCell className={`${positionCellClass(dense)} whitespace-nowrap text-right font-data ${pos.liquidationPrice == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.liquidationPrice ?? null)}
            </TableCell>
          </TableRow>
        );
        })}
      </TableBody>
      </Table>
    </div>
  );

  const renderPerpPositionCards = (positions: Position[]) => (
    <div className={`grid gap-2 ${compactRail ? 'grid-cols-1' : 'xl:grid-cols-2 2xl:grid-cols-3'}`}>
      {positions.map((pos) => {
        const pnl = pos.unrealizedPnlUsd ?? null;
        const direction = perpDirection(pos);
        const cardClass = compactRail
          ? 'rounded-[5px] border border-[#273035] bg-[#0b1418] p-3'
          : 'rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/44 p-3';
        return (
          <div
            key={`${pos.protocol}-${pos.positionType}-${pos.token}`}
            className={cardClass}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-data font-semibold text-sky-700 ring-1 ring-black/5 dark:bg-sky-500/20 dark:text-sky-200 dark:ring-white/10"
                >
                  {pos.token}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-display text-lg font-semibold text-arena-elements-textPrimary">
                    {perpAssetLabel(pos)}
                  </div>
                  <div className="truncate text-sm font-data text-arena-elements-textTertiary">
                    {compactRail ? 'Hyperliquid' : `Hyperliquid · ${direction}`}
                  </div>
                </div>
              </div>
              <Badge
                variant={direction === 'Short' ? 'destructive' : 'success'}
                className="shrink-0 text-xs"
              >
                {direction}
              </Badge>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
              <div>
                <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                  Size
                </div>
                <div className="mt-0.5 font-data text-base font-semibold text-arena-elements-textPrimary">
                  {formatSize(pos)}
                </div>
              </div>
              <div>
                <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                  Notional
                </div>
                <div className={`mt-0.5 font-data text-base font-semibold ${pos.notionalUsd == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textPrimary'}`}>
                  {formatCurrency(pos.notionalUsd ?? null)}
                </div>
              </div>
              <div>
                <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                  Margin
                </div>
                <div className={`mt-0.5 font-data text-base font-semibold ${marginUsedUsd(pos) == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textPrimary'}`}>
                  {formatCurrency(marginUsedUsd(pos))}
                </div>
              </div>
              <div>
                <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                  PnL
                </div>
                <div className={`mt-0.5 font-data text-base font-semibold ${
                  pnl == null
                    ? 'text-arena-elements-textTertiary'
                    : pnl < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                }`}>
                  {formatCurrency(pnl)}
                </div>
              </div>
            </div>

            <div className={`mt-3 grid grid-cols-3 gap-2 px-3 py-2 ${compactRail ? 'rounded-[5px] border border-[#273035] bg-[#0f1a1f]' : 'rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/42'}`}>
              <div>
                <div className="font-data text-[10px] uppercase tracking-wider text-arena-elements-textTertiary">
                  Margin %
                </div>
                <div className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                  {formatPercent(marginUsage(pos))}
                </div>
              </div>
              <div>
                <div className="font-data text-[10px] uppercase tracking-wider text-arena-elements-textTertiary">
                  Lev
                </div>
                <div className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                  {formatLeverage(pos.leverage)}
                </div>
              </div>
              <div>
                <div className="font-data text-[10px] uppercase tracking-wider text-arena-elements-textTertiary">
                  Liq
                </div>
                <div className={`truncate font-data text-sm font-semibold ${pos.liquidationPrice == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textPrimary'}`}>
                  {formatCurrency(pos.liquidationPrice ?? null)}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderStandardPositionCards = (positions: Position[]) => (
    <div className={`grid gap-2 ${compactRail ? 'grid-cols-1' : 'xl:grid-cols-2 2xl:grid-cols-3'}`}>
      {positions.map((pos) => (
        <div
          key={pos.token}
          className={compactRail
            ? 'rounded-[5px] border border-[#273035] bg-[#0b1418] p-3'
            : 'rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/44 p-3'}
        >
          <div className="flex items-start justify-between gap-3">
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
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            <div>
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                Amount
              </div>
              <div className="mt-0.5 font-data text-base font-semibold text-arena-elements-textPrimary">
                {formatNumber(pos.amount)}
              </div>
            </div>
            <div>
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                Value
              </div>
              <div className={`mt-0.5 font-data text-base font-semibold ${pos.displayValueUsd == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textPrimary'}`}>
                {formatCurrency(pos.displayValueUsd)}
              </div>
            </div>
            <div>
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                Price
              </div>
              <div className={`mt-0.5 font-data text-base font-semibold ${pos.currentPrice == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textPrimary'}`}>
                {formatCurrency(pos.currentPrice)}
              </div>
            </div>
            <div>
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                Weight
              </div>
              <div className={`mt-0.5 font-data text-base font-semibold ${pos.displayWeight == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textPrimary'}`}>
                {formatPercent(pos.displayWeight)}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className={ledger ? 'space-y-2' : workspace ? 'space-y-3' : 'space-y-4'}>
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

      {ledger ? (
        <div className="grid overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] min-[820px]:grid-cols-4">
          {ledgerAccountMetrics.map((metric) => (
            <div
              key={metric.label}
              className="min-w-0 border-b border-[var(--arena-terminal-border)] px-3 py-2.5 last:border-b-0 min-[820px]:border-b-0 min-[820px]:border-r min-[820px]:last:border-r-0"
            >
              <div className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">
                {metric.label}
              </div>
              <div className={`mt-1 min-w-0 truncate font-data text-xl font-bold leading-none tracking-tight ${metric.valueClassName}`}>
                {metric.value}
              </div>
              <div className="mt-1 truncate font-data text-[11px] text-[var(--arena-terminal-text-muted)]" title={metric.detail}>
                {metric.detail}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={`${workspace ? compactRail ? 'mb-3 grid-cols-1 gap-2' : 'mb-3 grid-cols-2 gap-3 xl:grid-cols-3' : 'mb-4 gap-3 sm:grid-cols-2'} grid`}>
          <div className="glass-card min-w-0 rounded-lg px-4 py-3">
            <div className="font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
              {hasPerpPositions ? 'Equity' : 'Value'}
            </div>
            <div className="mt-1 min-w-0 break-words font-data text-2xl font-bold leading-tight tracking-tight text-arena-elements-textPrimary">
              {formatCurrency(portfolio.displayTotalValueUsd)}
            </div>
            {!hasPerpPositions && (
              <p className="mt-1 text-sm text-arena-elements-textTertiary">
                Includes priced positions plus available cash.
              </p>
            )}
          </div>
          <div className="glass-card min-w-0 rounded-lg px-4 py-3">
            <div className="font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
              Cash
            </div>
            <div className="mt-1 min-w-0 break-words font-data text-2xl font-bold leading-tight tracking-tight text-arena-elements-textPrimary">
              {formatCurrency(portfolio.displayCashBalance)}
            </div>
          </div>
          {hasPerpPositions ? (
            <div className="glass-card min-w-0 rounded-lg px-4 py-3">
              <div className="font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
                Margin
              </div>
              <div className="mt-1 min-w-0 break-words font-data text-2xl font-bold leading-tight tracking-tight text-arena-elements-textPrimary">
                {formatPercent(totalMarginUsage)}
              </div>
            </div>
          ) : (
            <div className="glass-card min-w-0 rounded-lg px-4 py-3">
              <div className="font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
                Positions
              </div>
              <div className="mt-1 min-w-0 break-words font-data text-2xl font-bold leading-tight tracking-tight text-arena-elements-textPrimary">
                {positionCountLabel}
              </div>
            </div>
          )}
        </div>
      )}

      {ledger ? (
        <>
          {hasPerpPositions && renderPerpPositionsTable(perpPositions, true)}
          {!hasPerpPositions && standardPositions.length > 0 && renderStandardPositionsTable(standardPositions, true)}
        </>
      ) : workspace ? (
        <>
          {hasPerpPositions && renderPerpPositionCards(perpPositions)}
          {standardPositions.length > 0 && renderStandardPositionCards(standardPositions)}
        </>
      ) : (
        <>
          {hasPerpPositions && renderPerpPositionsTable(perpPositions)}
          {standardPositions.length > 0 && renderStandardPositionsTable(standardPositions)}
        </>
      )}
    </div>
  );
}
