import { useBotPortfolio } from '~/lib/hooks/useBotApi';
import type { BotStatus } from '~/lib/types/bot';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { OperatorAccessCard } from '~/components/operator/OperatorAccessCard';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import type { BotOperatorKind, BotVerificationState } from '~/lib/types/bot';
import { botStatusLabel, formatNumber, isLiveBotStatus } from '~/lib/format';
import { AssetDisplay } from './shared/AssetDisplay';
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
  const operatorAuth = useOperatorAuth(operatorApiUrl ?? '');
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
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading positions...
      </div>
    );
  }

  if (verificationState === 'unverified') {
    return (
      <OperatorAccessCard
        title="Live portfolio unavailable"
        description="This bot is still using unverified fallback data, so portfolio positions are hidden until the operator confirms the runtime state."
        apiUrl={operatorApiUrl ?? ''}
      />
    );
  }

  if (!operatorAuth.isAuthenticated) {
    return <OperatorAccessCard apiUrl={operatorApiUrl ?? ''} />;
  }

  if (!portfolio) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:wallet text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No portfolio data available for this bot{isLive ? '.' : ` while it is ${botStatusLabel(status).toLowerCase()}.`}
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

  const renderStandardPositionsTable = (positions: Position[]) => (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Token</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Current</TableHead>
          <TableHead className="text-right">Weight</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => (
          <TableRow key={pos.token}>
            <TableCell className="font-display font-semibold">
              <div className="flex items-center justify-between gap-2">
                <AssetDisplay asset={pos.asset} />
                {pos.valuationStatus !== 'priced' && (
                  <Badge
                    variant="amber"
                    className="text-[10px]"
                    title={pos.warnings.join(' ')}
                  >
                    {pos.valuationStatus === 'value_only' ? 'Value only' : 'Unpriced'}
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right font-data text-sm">{formatNumber(pos.amount)}</TableCell>
            <TableCell className={`text-right font-data text-sm ${pos.displayValueUsd == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.displayValueUsd)}
            </TableCell>
            <TableCell className={`text-right font-data text-sm ${pos.currentPrice == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.currentPrice)}
            </TableCell>
            <TableCell className={`text-right font-data text-sm ${pos.displayWeight == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textSecondary'}`}>
              {formatPercent(pos.displayWeight)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const renderPerpPositionsTable = (positions: Position[]) => (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Position</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead className="text-right">Size</TableHead>
          <TableHead className="text-right">Notional</TableHead>
          <TableHead className="text-right">Margin Used</TableHead>
          <TableHead className="text-right">Margin Usage</TableHead>
          <TableHead className="text-right">Leverage</TableHead>
          <TableHead className="text-right">PnL</TableHead>
          <TableHead className="text-right">Liquidation</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => (
          <TableRow key={`${pos.protocol}-${pos.positionType}-${pos.token}`}>
            <TableCell className="font-display font-semibold">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-data font-semibold text-sky-700 ring-1 ring-black/5 dark:bg-sky-500/20 dark:text-sky-200 dark:ring-white/10"
                >
                  {pos.token}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-display font-semibold text-arena-elements-textPrimary">
                    {perpAssetLabel(pos)}
                  </div>
                  <div className="truncate text-xs font-data text-arena-elements-textTertiary">
                    Hyperliquid
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell className="font-data text-sm text-arena-elements-textSecondary">
              {perpDirection(pos)}
            </TableCell>
            <TableCell className="text-right font-data text-sm">{formatSize(pos)}</TableCell>
            <TableCell className={`text-right font-data text-sm ${pos.notionalUsd == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.notionalUsd ?? null)}
            </TableCell>
            <TableCell className={`text-right font-data text-sm ${marginUsedUsd(pos) == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(marginUsedUsd(pos))}
            </TableCell>
            <TableCell className={`text-right font-data text-sm ${marginUsage(pos) == null ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textSecondary'}`}>
              {formatPercent(marginUsage(pos))}
            </TableCell>
            <TableCell className={`text-right font-data text-sm ${pos.leverage == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatLeverage(pos.leverage)}
            </TableCell>
            <TableCell className={`text-right font-data text-sm ${pos.unrealizedPnlUsd == null ? 'text-arena-elements-textTertiary' : pos.unrealizedPnlUsd < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {formatCurrency(pos.unrealizedPnlUsd ?? null)}
            </TableCell>
            <TableCell className={`text-right font-data text-sm ${pos.liquidationPrice == null ? 'text-arena-elements-textTertiary' : ''}`}>
              {formatCurrency(pos.liquidationPrice ?? null)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <div className="space-y-4">
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

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="glass-card rounded-lg px-4 py-2">
          <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">{hasPerpPositions ? 'Bot Equity ' : 'Total Value '}</span>
          <span className="font-display font-bold text-lg">{formatCurrency(portfolio.displayTotalValueUsd)}</span>
        </div>
        {hasPerpPositions && (
          <div className="glass-card rounded-lg px-4 py-2">
            <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">Margin Usage </span>
            <span className="font-display font-bold text-lg">{formatPercent(totalMarginUsage)}</span>
          </div>
        )}
      </div>

      {hasPerpPositions && renderPerpPositionsTable(perpPositions)}
      {standardPositions.length > 0 && renderStandardPositionsTable(standardPositions)}
    </div>
  );
}
