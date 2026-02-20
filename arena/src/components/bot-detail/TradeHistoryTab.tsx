import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useBotTrades } from '~/lib/hooks/useBotApi';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle/blueprint-ui/components';
import { ValidatorCard, CopyButton, truncateAddress } from './shared/ValidatorComponents';

interface TradeHistoryTabProps {
  botId: string;
  botName?: string;
}

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

export function TradeHistoryTab({ botId, botName = '' }: TradeHistoryTabProps) {
  const { data: trades, isLoading } = useBotTrades(botId, botName);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading trades...
      </div>
    );
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
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Time</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Pair</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Validation</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => {
          const responses = trade.validation?.responses ?? [];
          const signedCount = responses.filter(
            (r) => r.signature && r.signature !== `0x${'00'.repeat(65)}`
          ).length;
          const hasValidation = responses.length > 0 || trade.validatorScore != null;
          const isExpanded = expandedId === trade.id;

          return (
            <TableRow
              key={trade.id}
              className={hasValidation ? 'cursor-pointer' : ''}
              onClick={() => hasValidation && setExpandedId(isExpanded ? null : trade.id)}
            >
              <TableCell className="text-arena-elements-textTertiary text-xs font-data" colSpan={isExpanded ? 7 : undefined}>
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
                      <Badge variant={trade.action === 'buy' ? 'success' : 'destructive'} className="text-xs">
                        {trade.action.toUpperCase()}
                      </Badge>
                      <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
                        {trade.tokenIn}/{trade.tokenOut}
                      </span>
                      <span className="text-xs font-data text-arena-elements-textTertiary">
                        {new Date(trade.timestamp).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                      {trade.validation && (
                        <Badge variant={trade.validation.approved ? 'success' : 'destructive'} className="text-xs">
                          {trade.validation.approved ? 'APPROVED' : 'REJECTED'}
                        </Badge>
                      )}
                    </div>

                    {/* Intent hash */}
                    {trade.validation?.intentHash && (
                      <div className="flex items-center gap-2 mb-3 px-1">
                        <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                          Intent Hash
                        </span>
                        <code className="text-xs font-data text-arena-elements-textSecondary">
                          {truncateAddress(trade.validation.intentHash)}
                        </code>
                        <CopyButton text={trade.validation.intentHash} label="Copy" />
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
                    <Badge variant={trade.action === 'buy' ? 'success' : 'destructive'}>
                      {trade.action.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-display font-medium text-sm">
                    {trade.tokenIn}/{trade.tokenOut}
                  </TableCell>
                  <TableCell className="text-right font-data text-sm">
                    {trade.amountOut.toLocaleString()} {trade.tokenOut}
                  </TableCell>
                  <TableCell className="text-right font-data text-sm">
                    {trade.priceUsd > 0 ? `$${trade.priceUsd.toLocaleString()}` : '—'}
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
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={
                          trade.status === 'executed' ? 'success' :
                          trade.status === 'rejected' ? 'destructive' :
                          trade.status === 'paper' ? 'secondary' : 'outline'
                        }
                      >
                        {trade.status === 'pending' ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="i-ph:arrow-clockwise text-xs animate-spin" />
                            pending
                          </span>
                        ) : (
                          trade.status
                        )}
                      </Badge>
                      {trade.txHash && !trade.txHash.startsWith('0xpaper_') && (
                        <span className="text-xs font-data text-arena-elements-textTertiary" title={trade.txHash}>
                          {truncateHash(trade.txHash)}
                        </span>
                      )}
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
