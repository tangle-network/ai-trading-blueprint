import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useBotTrades } from '~/lib/hooks/useBotApi';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { ValidatorCard, SimulationBadge, SimulationDetail } from './shared/ValidatorComponents';
import { AssetDisplay, AssetPairDisplay } from './shared/AssetDisplay';
import { SkeletonTableRow } from '~/components/ui/Skeleton';
import { getTradePairLabel, VENUE_CONFIG } from '~/lib/types/trade';
import type { TradeVenue } from '~/lib/types/trade';
import type { Trade, TradeStatus } from '~/lib/types/trade';
import { OperatorAccessCard } from '~/components/operator/OperatorAccessCard';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import type { BotOperatorKind, BotVerificationState } from '~/lib/types/bot';
import { countUsableValidatorSignatures, getTradeValidationDisplay } from '~/lib/tradeValidation';
import { formatNumber } from '~/lib/format';

interface TradeHistoryTabProps {
  botId: string;
  botName?: string;
  isLive?: boolean;
  chainId?: number;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
}

function VenueBadge({ venue }: { venue: TradeVenue }) {
  const config = VENUE_CONFIG[venue];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-data font-semibold ${config.color}`}>
      <span className={`${config.icon} text-sm`} />
      {config.label}
    </span>
  );
}

const EXPLORER_URLS: Record<number, { name: string; base: string }> = {
  1: { name: 'Etherscan', base: 'https://etherscan.io/tx/' },
  137: { name: 'Polygonscan', base: 'https://polygonscan.com/tx/' },
  42161: { name: 'Arbiscan', base: 'https://arbiscan.io/tx/' },
  8453: { name: 'Basescan', base: 'https://basescan.org/tx/' },
  10: { name: 'Optimistic', base: 'https://optimistic.etherscan.io/tx/' },
  31337: { name: 'Local', base: '' },
};

function explorerUrl(txHash: string, chainId?: number): string | null {
  if (!chainId || chainId === 31337) return null;
  const explorer = EXPLORER_URLS[chainId];
  return explorer ? `${explorer.base}${txHash}` : null;
}

function TradeTableHead() {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>Time</TableHead>
        <TableHead>Action</TableHead>
        <TableHead className="hidden sm:table-cell">Venue</TableHead>
        <TableHead>Trade</TableHead>
        <TableHead className="text-right">Price</TableHead>
        <TableHead className="text-right hidden sm:table-cell">Validation</TableHead>
        <TableHead className="text-center hidden md:table-cell">Sim</TableHead>
        <TableHead>Tx Hash</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
  );
}

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

function formatTradeAmount(amount: number): string {
  return formatNumber(amount, { maximumFractionDigits: 4 });
}

function formatExecutionStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function renderTradePrice(trade: Trade): string {
  if (trade.priceUsd != null && trade.priceUsd > 0) {
    return `$${formatNumber(trade.priceUsd, { maximumFractionDigits: 2 })}`;
  }
  if (
    trade.paperTrade &&
    trade.targetProtocol === 'polymarket_clob' &&
    trade.execution?.requestedPriceUsd != null &&
    trade.execution.requestedPriceUsd > 0
  ) {
    return `$${formatNumber(trade.execution.requestedPriceUsd, { maximumFractionDigits: 4 })}`;
  }
  if (trade.paperTrade) return 'No USD leg';
  return '—';
}

function getStatusLabel(status: TradeStatus): string {
  return status === 'failed' ? 'sim failed' : status;
}

function getStatusVariant(status: TradeStatus): 'success' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'executed') return 'success';
  if (status === 'rejected' || status === 'failed') return 'destructive';
  if (status === 'paper') return 'secondary';
  return 'outline';
}

function getErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}

function TradeDataUnavailableCard({ error }: { error: unknown }) {
  const errorMessage = getErrorMessage(error);

  return (
    <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
      <div className="i-ph:warning-circle text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
      <h3 className="font-display font-semibold text-base text-arena-elements-textPrimary mb-2">
        Trade history unavailable
      </h3>
      <p className="text-sm">
        We couldn&apos;t load this bot&apos;s verified trade history from the operator.
      </p>
      {errorMessage && (
        <p className="mt-3 text-xs font-data text-crimson-500">{errorMessage}</p>
      )}
    </div>
  );
}

function getActionLabel(action: Trade['action']): string {
  return action.toUpperCase();
}

function getActionVariant(action: Trade['action']): 'success' | 'destructive' | 'accent' {
  if (action === 'buy') return 'success';
  if (action === 'sell') return 'destructive';
  return 'accent';
}

function renderTxHash(trade: Trade) {
  if (!trade.txHash) {
    return <span className="text-xs font-data text-arena-elements-textTertiary">—</span>;
  }

  if (trade.txHash.startsWith('0xpaper_')) {
    return (
      <span className="text-xs font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {truncateHash(trade.txHash)}
      </span>
    );
  }

  const url = explorerUrl(trade.txHash, trade.chainId);
  if (!url) {
    return (
      <span className="text-xs font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {truncateHash(trade.txHash)}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-data text-arena-elements-textTertiary hover:text-arena-elements-textPrimary transition-colors inline-flex items-center gap-0.5"
      title={trade.txHash}
      onClick={(e) => e.stopPropagation()}
    >
      {truncateHash(trade.txHash)}
      <span className="i-ph:arrow-square-out text-[10px]" />
    </a>
  );
}

export function TradeHistoryTab({
  botId,
  botName = '',
  isLive = false,
  chainId,
  operatorApiUrl,
  operatorKind,
  verificationState,
}: TradeHistoryTabProps) {
  const operatorAuth = useOperatorAuth(operatorApiUrl ?? '');
  const { data: trades, isLoading, isError, error } = useBotTrades(botId, botName, 50, {
    chainId,
    operatorApiUrl,
    operatorKind,
    refetchInterval: isLive ? 15_000 : false,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Table>
        <TradeTableHead />
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonTableRow key={i} cols={9} />
          ))}
        </TableBody>
      </Table>
    );
  }

  if (verificationState === 'unverified') {
    return (
      <OperatorAccessCard
        title="Trade history unavailable"
        description="Trade history only appears for bots that have been freshly verified against their operator."
        apiUrl={operatorApiUrl ?? ''}
      />
    );
  }

  if (!operatorAuth.isAuthenticated) {
    return <OperatorAccessCard apiUrl={operatorApiUrl ?? ''} />;
  }

  if (isError) {
    return <TradeDataUnavailableCard error={error} />;
  }

  if (!trades || trades.length === 0) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:swap text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No trades recorded for this bot.
      </div>
    );
  }

  return (
    <Table>
      <TradeTableHead />
      <TableBody>
        {trades.map((trade) => {
          const responses = trade.validation?.responses ?? [];
          const signedCount = countUsableValidatorSignatures(responses);
          const validationDisplay = getTradeValidationDisplay(trade);
          const pairLabel = getTradePairLabel(trade);
          const hasValidation = responses.length > 0 || trade.validatorScore != null;
          const isExpanded = expandedId === trade.id;

          return (
            <TableRow
              key={trade.id}
              className={hasValidation ? 'cursor-pointer' : ''}
              onClick={() => hasValidation && setExpandedId(isExpanded ? null : trade.id)}
              {...(hasValidation ? {
                role: 'button' as const,
                tabIndex: 0,
                'aria-expanded': isExpanded,
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setExpandedId(isExpanded ? null : trade.id);
                  }
                },
              } : {})}
            >
              <TableCell className="text-arena-elements-textTertiary text-xs font-data" colSpan={isExpanded ? 9 : undefined}>
                {isExpanded ? (
                  /* Expanded view replaces the row */
                  <div className="py-2" onClick={(e) => e.stopPropagation()}>
                    {/* Trade summary header */}
                    <div className="flex items-center gap-3 mb-4">
                      <button
                        onClick={() => setExpandedId(null)}
                        className="text-arena-elements-textTertiary hover:text-arena-elements-textPrimary transition-colors cursor-pointer"
                      >
                        <div className="i-ph:caret-up text-sm" />
                      </button>
                      <Badge variant={getActionVariant(trade.action)} className="text-xs">
                        {getActionLabel(trade.action)}
                      </Badge>
                      <VenueBadge venue={trade.venue} />
                      {trade.targetProtocol === 'polymarket_clob' ? (
                        <span
                          className="text-sm font-display font-medium text-arena-elements-textPrimary"
                          title={pairLabel}
                        >
                          {pairLabel}
                        </span>
                      ) : (
                        <AssetPairDisplay left={trade.assetIn} right={trade.assetOut} />
                      )}
                      <span className="text-xs font-data text-arena-elements-textTertiary">
                        {new Date(trade.timestamp).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                      {validationDisplay && (
                        <Badge variant={validationDisplay.badgeVariant} className="text-xs">
                          {validationDisplay.label}
                        </Badge>
                      )}
                    </div>

                    <div className="mb-3 px-1 text-sm text-arena-elements-textSecondary">
                      <span className="font-data">
                        {formatTradeAmount(trade.amountIn)}
                      </span>
                      {' '}
                      <AssetDisplay asset={trade.assetIn} compact preferSymbol showSecondary={false} />
                      <span className="mx-2 text-arena-elements-textTertiary">→</span>
                      <span className="font-data">
                        {formatTradeAmount(trade.amountOut)}
                      </span>
                      {' '}
                      <AssetDisplay asset={trade.assetOut} compact preferSymbol showSecondary={false} />
                    </div>

                    {trade.txHash && (
                      <div className="flex items-center gap-2 mb-3 px-1">
                        <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                          Tx Hash
                        </span>
                        {renderTxHash(trade)}
                      </div>
                    )}

                    {validationDisplay?.helperText && (
                      <p className="mb-3 px-1 text-sm leading-relaxed text-arena-elements-textSecondary">
                        {validationDisplay.helperText}
                      </p>
                    )}

                    {trade.execution && (
                      <div className="mb-4 rounded-xl border border-arena-elements-border/60 bg-arena-elements-bg-surface/60 p-3">
                        <div className="mb-2 text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                          Execution QA
                        </div>
                        <div className="grid gap-2 text-sm text-arena-elements-textSecondary md:grid-cols-2">
                          <div>
                            <span className="text-arena-elements-textTertiary">Status:</span>{' '}
                            {formatExecutionStatus(trade.execution.status)}
                          </div>
                          {trade.execution.clobOrderId && (
                            <div>
                              <span className="text-arena-elements-textTertiary">CLOB order:</span>{' '}
                              <code className="font-data text-xs">{trade.execution.clobOrderId}</code>
                            </div>
                          )}
                          {trade.execution.requestedPriceUsd != null && (
                            <div>
                              <span className="text-arena-elements-textTertiary">Requested price:</span>{' '}
                              ${formatNumber(trade.execution.requestedPriceUsd, { maximumFractionDigits: 4 })}
                            </div>
                          )}
                          {trade.execution.filledPriceUsd != null && (
                            <div>
                              <span className="text-arena-elements-textTertiary">Filled price:</span>{' '}
                              ${formatNumber(trade.execution.filledPriceUsd, { maximumFractionDigits: 4 })}
                            </div>
                          )}
                          {trade.execution.filledAmount != null && (
                            <div>
                              <span className="text-arena-elements-textTertiary">Filled amount:</span>{' '}
                              {formatTradeAmount(trade.execution.filledAmount)}
                            </div>
                          )}
                          {trade.execution.slippageBps != null && (
                            <div>
                              <span className="text-arena-elements-textTertiary">Slippage:</span>{' '}
                              {formatNumber(trade.execution.slippageBps, { maximumFractionDigits: 2 })} bps
                            </div>
                          )}
                        </div>
                        {trade.execution.reason && (
                          <p className="mt-2 text-sm leading-relaxed text-arena-elements-textSecondary">
                            {trade.execution.reason}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Per-validator breakdown */}
                    <AnimatePresence>
                      <m.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                      >
                        <div className="space-y-2">
                          {responses.map((response, vi) => (
                            <ValidatorCard
                              key={`${trade.id}-expand-${response.validator}-${vi}`}
                              response={response}
                              index={vi}
                            />
                          ))}
                        </div>
                      </m.div>
                    </AnimatePresence>

                    {/* Simulation detail */}
                    {trade.validation?.simulation && (
                      <div className="mt-3">
                        <SimulationDetail simulation={trade.validation.simulation} />
                      </div>
                    )}

                    {/* Reasoning fallback */}
                    {responses.length === 0 && trade.validatorReasoning && (
                      <div className="mt-2 px-1">
                        <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
                          Reasoning
                        </div>
                        <p className="text-sm text-arena-elements-textSecondary leading-relaxed">
                          {trade.validatorReasoning}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Normal compact row content */
                  new Date(trade.timestamp).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })
                )}
              </TableCell>
              {!isExpanded && (
                <>
                  <TableCell>
                    <Badge variant={getActionVariant(trade.action)}>
                      {getActionLabel(trade.action)}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <VenueBadge venue={trade.venue} />
                  </TableCell>
                  <TableCell className="font-display font-medium text-sm" title={pairLabel}>
                    <div className="space-y-1">
                      {trade.targetProtocol === 'polymarket_clob' ? (
                        <div className="max-w-80 truncate">{pairLabel}</div>
                      ) : (
                        <AssetPairDisplay left={trade.assetIn} right={trade.assetOut} />
                      )}
                      <div className="text-xs font-data text-arena-elements-textSecondary">
                        <span>{formatTradeAmount(trade.amountIn)}</span>
                        {' '}
                        <AssetDisplay asset={trade.assetIn} compact preferSymbol showSecondary={false} />
                        <span className="mx-1.5 text-arena-elements-textTertiary">→</span>
                        <span>{formatTradeAmount(trade.amountOut)}</span>
                        {' '}
                        <AssetDisplay asset={trade.assetOut} compact preferSymbol showSecondary={false} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-data text-sm">
                    {renderTradePrice(trade)}
                  </TableCell>
                  <TableCell className="text-right hidden sm:table-cell">
                    <div className="flex items-center justify-end gap-1.5">
                      {/* Aggregate score */}
                      {trade.validatorScore != null && (
                        <span className={`font-data text-xs font-bold ${
                          trade.validatorScore >= 80 ? 'text-arena-elements-icon-success' :
                          trade.validatorScore >= 50 ? 'text-amber-700 dark:text-amber-400' : 'text-arena-elements-icon-error'
                        }`}>
                          {trade.validatorScore}
                        </span>
                      )}
                      {/* Validator count */}
                      {responses.length > 0 && (
                        <Badge
                          variant={signedCount === responses.length ? 'success' : 'amber'}
                          className="text-xs py-0"
                        >
                          {signedCount}/{responses.length}
                        </Badge>
                      )}
                      {/* Expand hint */}
                      {hasValidation && (
                        <div className="i-ph:caret-down text-arena-elements-textTertiary text-xs" />
                      )}
                      {/* No score */}
                      {trade.validatorScore == null && responses.length === 0 && (
                        <span className="text-arena-elements-textTertiary font-data text-xs">-</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-center hidden md:table-cell">
                    {trade.validation?.simulation ? (
                      <SimulationBadge simulation={trade.validation.simulation} />
                    ) : (
                      <span className="text-arena-elements-textTertiary font-data text-xs">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {renderTxHash(trade)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={getStatusVariant(trade.status)}
                      >
                        {trade.status === 'pending' ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="i-ph:arrow-clockwise text-xs animate-spin" />
                            pending
                          </span>
                        ) : (
                          getStatusLabel(trade.status)
                        )}
                      </Badge>
                    </div>
                  </TableCell>
                </>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
