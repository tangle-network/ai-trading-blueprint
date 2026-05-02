import { useBotPortfolio } from '~/lib/hooks/useBotApi';
import type { BotStatus } from '~/lib/types/bot';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { OperatorAccessCard } from '~/components/operator/OperatorAccessCard';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import type { BotOperatorKind, BotVerificationState } from '~/lib/types/bot';
import { botStatusLabel, formatNumber, isLiveBotStatus } from '~/lib/format';
import { AssetDisplay } from './shared/AssetDisplay';

interface PositionsTabProps {
  botId: string;
  status: BotStatus;
  chainId?: number;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
}

export function PositionsTab({ botId, status, chainId, operatorApiUrl, operatorKind, verificationState }: PositionsTabProps) {
  const operatorAuth = useOperatorAuth(operatorApiUrl ?? '');
  const isLive = isLiveBotStatus(status);
  const { data: portfolio, isLoading } = useBotPortfolio(botId, {
    chainId,
    operatorApiUrl,
    operatorKind,
    enabled: true,
    refetchInterval: isLive ? 10_000 : false,
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
    return `$${formatNumber(value)}`;
  };

  const formatPercent = (value: number | null) => {
    if (value == null) return 'Unavailable';
    return `${formatNumber(value, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    })}%`;
  };

  const warningTitle = portfolio.hasUnpricedPositions
    ? 'Portfolio valuation unavailable'
    : portfolio.hasValueOnlyPositions
      ? 'Portfolio valuation partially available'
      : 'Portfolio warnings';
  const displayWarnings = portfolio.warnings.map((warning) => (
    warning.includes('entry price') || warning.includes('PnL')
      ? 'Some positions only have current market value available.'
      : warning
  ));

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

      <div className="flex items-center gap-6 mb-4">
        <div className="glass-card rounded-lg px-4 py-2">
          <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">Total Value </span>
          <span className="font-display font-bold text-lg">{formatCurrency(portfolio.displayTotalValueUsd)}</span>
        </div>
      </div>

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
          {portfolio.positions.map((pos) => (
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
    </div>
  );
}
