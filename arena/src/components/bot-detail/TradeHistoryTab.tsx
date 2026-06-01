import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useBotTrades } from '~/lib/hooks/useBotApi';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import { ValidatorCard, SimulationDetail } from './shared/ValidatorComponents';
import { AssetDisplay, AssetPairDisplay } from './shared/AssetDisplay';
import { SkeletonTableRow } from '~/components/ui/Skeleton';
import { getTradePairLabel } from '~/lib/types/trade';
import type { Trade, TradeStatus } from '~/lib/types/trade';
import type { BotOperatorKind, BotVerificationState } from '~/lib/types/bot';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';
import { countUsableValidatorSignatures, getTradeValidationDisplay } from '~/lib/tradeValidation';
import { formatNumber } from '~/lib/format';
import { UnverifiedDataNotice } from './shared/DataAccessNotices';

interface TradeHistoryTabProps {
  botId: string;
  botName?: string;
  isLive?: boolean;
  chainId?: number;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
  assetMetadata?: TokenMetadata[];
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
        <TableHead className="w-44 py-4 text-base">Time</TableHead>
        <TableHead className="w-40 py-4 text-base">Action</TableHead>
        <TableHead className="min-w-[420px] py-4 text-base">Trade</TableHead>
        <TableHead className="hidden py-4 text-right text-base sm:table-cell">Validation</TableHead>
        <TableHead className="py-4 text-base">Ref</TableHead>
        <TableHead className="py-4 text-base">Status</TableHead>
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

function formatTradeCurrency(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  return `$${formatNumber(value, { maximumFractionDigits: 2 })}`;
}

function formatTradeTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatExecutionStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function isHyperliquidTrade(trade: Trade): boolean {
  return trade.targetProtocol === 'hyperliquid';
}

function hyperliquidMarketLabel(trade: Trade): string | null {
  const asset = trade.hyperliquidMetadata?.asset?.trim();
  return asset ? `${asset.toUpperCase()}-PERP` : null;
}

function hyperliquidSizeLabel(trade: Trade): string | null {
  const asset = trade.hyperliquidMetadata?.asset?.trim();
  const size = trade.hyperliquidMetadata?.assetSize?.trim();
  if (!asset || !size) return null;
  return `Size: ${size} ${asset.toUpperCase()}`;
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

function isInteractiveTradeTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('a,button,input,textarea,select'));
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
  return action.replace(/_/g, ' ').toUpperCase();
}

function getActionVariant(action: Trade['action']): 'success' | 'destructive' | 'accent' {
  if (action === 'buy' || action === 'open_long') return 'success';
  if (action === 'sell' || action === 'close_long' || action === 'close_short') return 'destructive';
  return 'accent';
}

function renderExecutionRef(trade: Trade) {
  if (!trade.txHash) {
    return <span className="text-base font-data text-arena-elements-textTertiary">—</span>;
  }

  if (isHyperliquidTrade(trade)) {
    const label = trade.txHash === 'hl:ok'
      ? 'HL accepted'
      : trade.txHash === 'hl:err'
        ? 'HL rejected'
        : trade.txHash;
    return (
      <span className="text-base font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {label}
      </span>
    );
  }

  if (trade.txHash.startsWith('0xpaper_')) {
    return (
      <span className="text-base font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {truncateHash(trade.txHash)}
      </span>
    );
  }

  const url = explorerUrl(trade.txHash, trade.chainId);
  if (!url) {
    return (
      <span className="text-base font-data text-arena-elements-textTertiary" title={trade.txHash}>
        {truncateHash(trade.txHash)}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-base font-data text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textPrimary"
      title={trade.txHash}
      onClick={(e) => e.stopPropagation()}
    >
      {truncateHash(trade.txHash)}
      <span className="i-ph:arrow-square-out text-xs" />
    </a>
  );
}

function renderHyperliquidTradeCell(trade: Trade) {
  const marketLabel = hyperliquidMarketLabel(trade);
  const details = [
    `Order: ${formatTradeAmount(trade.amountIn)} ${trade.tokenIn}`,
    hyperliquidSizeLabel(trade),
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="space-y-1">
      {marketLabel && (
        <div className="font-display text-lg font-semibold text-arena-elements-textPrimary">
          {marketLabel}
        </div>
      )}
      <div className="text-base font-data text-arena-elements-textSecondary">
        {details.join(' · ')}
      </div>
    </div>
  );
}

function TradeDetailMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'success' | 'danger';
}) {
  const toneClass = tone === 'success'
    ? 'text-emerald-600 dark:text-emerald-300'
    : tone === 'danger'
      ? 'text-crimson-600 dark:text-crimson-300'
      : 'text-arena-elements-textPrimary';

  return (
    <div className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/25 p-3">
      <div className="text-sm font-data font-medium uppercase tracking-wider text-arena-elements-textTertiary">
        {label}
      </div>
      <div className={`mt-1 break-words text-lg font-data ${toneClass}`}>
        {value}
      </div>
    </div>
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
  assetMetadata,
}: TradeHistoryTabProps) {
  const { data: trades, isLoading, isError, error } = useBotTrades(botId, botName, 50, {
    chainId,
    operatorApiUrl,
    operatorKind,
    assetMetadata,
    refetchInterval: isLive ? 15_000 : false,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="overflow-x-auto rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36">
        <Table className="min-w-[1120px]">
          <TradeTableHead />
          <TableBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonTableRow key={i} cols={6} />
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (isError) {
    return <TradeDataUnavailableCard error={error} />;
  }

  if (!trades || trades.length === 0) {
    return (
      <div className="space-y-4">
        {verificationState === 'unverified' && (
          <UnverifiedDataNotice subject="trade history" />
        )}
        <div className="glass-card rounded-xl text-center py-16 text-base text-arena-elements-textSecondary">
          <div className="i-ph:swap text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
          No trades recorded for this bot.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {verificationState === 'unverified' && (
        <UnverifiedDataNotice subject="trade history" />
      )}

      <div className="overflow-x-auto rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/36">
      <Table className="min-w-[1120px]">
        <TradeTableHead />
        <TableBody>
          {trades.map((trade) => {
            const responses = trade.validation?.responses ?? [];
            const signedCount = countUsableValidatorSignatures(responses);
            const validationDisplay = getTradeValidationDisplay(trade);
            const pairLabel = isHyperliquidTrade(trade)
              ? hyperliquidMarketLabel(trade)
              : getTradePairLabel(trade);
            const hasValidation = responses.length > 0 || trade.validatorScore != null;
            const isExpanded = expandedId === trade.id;

            return (
              <TableRow
              key={trade.id}
              className={hasValidation ? 'cursor-pointer' : ''}
              onClick={(event) => {
                if (!hasValidation || isInteractiveTradeTarget(event.target)) return;
                setExpandedId(isExpanded ? null : trade.id);
              }}
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
              <TableCell className="py-4 text-base font-data text-arena-elements-textTertiary" colSpan={isExpanded ? 6 : undefined}>
                {isExpanded ? (
                  /* Expanded view replaces the row */
                  <div className="py-3">
                    {/* Trade summary header */}
                    <div className="flex flex-wrap items-center gap-3 mb-4">
                      <button
                        type="button"
                        onClick={() => setExpandedId(null)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-arena-elements-textTertiary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                        aria-label="Collapse trade details"
                      >
                        <div className="i-ph:caret-up text-base" />
                      </button>
                      <Badge variant={getActionVariant(trade.action)} className="h-8 px-3 text-base">
                        {getActionLabel(trade.action)}
                      </Badge>
                      {isHyperliquidTrade(trade) && hyperliquidMarketLabel(trade) ? (
                        <span className="text-lg font-display font-medium text-arena-elements-textPrimary">
                          {hyperliquidMarketLabel(trade)}
                        </span>
                      ) : trade.targetProtocol === 'polymarket_clob' ? (
                        <span
                          className="text-lg font-display font-medium text-arena-elements-textPrimary"
                          title={pairLabel ?? undefined}
                        >
                          {pairLabel}
                        </span>
                      ) : (
                        <AssetPairDisplay left={trade.assetIn} right={trade.assetOut} size="lg" />
                      )}
                      <span className="text-base font-data text-arena-elements-textTertiary">
                        {formatTradeTimestamp(trade.timestamp)}
                      </span>
                      {validationDisplay && (
                        <Badge variant={validationDisplay.badgeVariant} className="h-8 px-3 text-base">
                          {validationDisplay.label}
                        </Badge>
                      )}
                    </div>

                    <div className="mb-4 grid gap-3 md:grid-cols-4">
                      <TradeDetailMetric
                        label="Notional"
                        value={formatTradeCurrency(trade.notionalUsd)}
                      />
                      <TradeDetailMetric
                        label="Route"
                        value={trade.targetProtocol ?? trade.venue}
                      />
                      <TradeDetailMetric
                        label="Execution"
                        value={trade.execution?.status ? formatExecutionStatus(trade.execution.status) : getStatusLabel(trade.status)}
                        tone={trade.status === 'failed' || trade.status === 'rejected' ? 'danger' : trade.status === 'executed' || trade.status === 'paper' ? 'success' : 'neutral'}
                      />
                      <TradeDetailMetric
                        label="Validation"
                        value={validationDisplay?.label ?? (hasValidation ? 'Pending detail' : 'Unavailable')}
                        tone={validationDisplay?.badgeVariant === 'success' ? 'success' : validationDisplay?.badgeVariant === 'destructive' ? 'danger' : 'neutral'}
                      />
                    </div>

                    {isHyperliquidTrade(trade) ? (
                      <div className="mb-3 px-1">
                        {renderHyperliquidTradeCell(trade)}
                      </div>
                    ) : (
                      <div className="mb-4 rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/20 px-4 py-3 text-base text-arena-elements-textSecondary">
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
                    )}

                    {trade.txHash && (
                      <div className="flex items-center gap-2 mb-4 px-1">
                        <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textTertiary">
                          {isHyperliquidTrade(trade) ? 'Exchange Ref' : 'Tx Hash'}
                        </span>
                        {renderExecutionRef(trade)}
                      </div>
                    )}

                    {validationDisplay?.helperText && (
                      <p className="mb-4 px-1 text-base leading-relaxed text-arena-elements-textSecondary">
                        {validationDisplay.helperText}
                      </p>
                    )}

                    {trade.execution && (
                      <div className="mb-4 rounded-xl border border-arena-elements-border/60 bg-arena-elements-bg-surface/60 p-4">
                        <div className="mb-3 text-base font-data uppercase tracking-wider text-arena-elements-textTertiary">
                          Execution QA
                        </div>
                        <div className="grid gap-3 text-base text-arena-elements-textSecondary md:grid-cols-2">
                          <div>
                            <span className="text-arena-elements-textTertiary">Status:</span>{' '}
                            {formatExecutionStatus(trade.execution.status)}
                          </div>
                          {trade.execution.clobOrderId && (
                            <div>
                              <span className="text-arena-elements-textTertiary">CLOB order:</span>{' '}
                              <code className="font-data text-base">{trade.execution.clobOrderId}</code>
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
                          <p className="mt-3 text-base leading-relaxed text-arena-elements-textSecondary">
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
                        <div className="text-sm font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
                          Reasoning
                        </div>
                        <p className="text-base text-arena-elements-textSecondary leading-relaxed">
                          {trade.validatorReasoning}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Normal compact row content */
                  formatTradeTimestamp(trade.timestamp)
                )}
              </TableCell>
              {!isExpanded && (
                <>
                  <TableCell className="py-4">
                    <Badge variant={getActionVariant(trade.action)} className="h-8 px-3 text-base">
                      {getActionLabel(trade.action)}
                    </Badge>
                  </TableCell>
                  <TableCell className="min-w-[420px] py-4 font-display text-lg font-medium" title={pairLabel ?? undefined}>
                    <div className="space-y-2">
                      {isHyperliquidTrade(trade) ? (
                        renderHyperliquidTradeCell(trade)
                      ) : trade.targetProtocol === 'polymarket_clob' ? (
                        <div className="max-w-[520px] whitespace-normal text-lg font-semibold leading-snug text-arena-elements-textPrimary">
                          {pairLabel}
                        </div>
                      ) : (
                        <AssetPairDisplay left={trade.assetIn} right={trade.assetOut} size="lg" />
                      )}
                      {!isHyperliquidTrade(trade) && (
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base font-data text-arena-elements-textSecondary">
                          <span>{formatTradeAmount(trade.amountIn)}</span>
                          <AssetDisplay asset={trade.assetIn} compact preferSymbol showSecondary={false} />
                          <span className="mx-1.5 text-arena-elements-textTertiary">→</span>
                          <span>{formatTradeAmount(trade.amountOut)}</span>
                          <AssetDisplay asset={trade.assetOut} compact preferSymbol showSecondary={false} />
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden py-4 text-right sm:table-cell">
                    <div className="flex items-center justify-end gap-1.5">
                      {/* Aggregate score */}
                      {trade.validatorScore != null && (
                        <span className={`font-data text-base font-bold ${
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
                          className="py-0 text-sm"
                        >
                          {signedCount}/{responses.length}
                        </Badge>
                      )}
                      {/* Expand hint */}
                      {hasValidation && (
                        <div className="i-ph:caret-down text-sm text-arena-elements-textTertiary" />
                      )}
                      {/* No score */}
                      {trade.validatorScore == null && responses.length === 0 && (
                        <span className="font-data text-base text-arena-elements-textTertiary">-</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="py-4">
                    {renderExecutionRef(trade)}
                  </TableCell>
                  <TableCell className="py-4">
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={getStatusVariant(trade.status)}
                        className="text-sm"
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
      </div>
    </div>
  );
}
