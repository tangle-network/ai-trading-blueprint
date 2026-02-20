import { m, AnimatePresence } from 'framer-motion';
import { useBotTrades, useBotRecentValidations } from '~/lib/hooks/useBotApi';
import { Badge, Card, CardContent } from '@tangle/blueprint-ui/components';
import type { Trade } from '~/lib/types/trade';
import { ScoreRing, ValidatorCard, CopyButton, truncateAddress } from './shared/ValidatorComponents';

interface ReasoningTabProps {
  botId: string;
  botName?: string;
}

// ── Pending Validation Card (live, animated) ────────────────────────────

function PendingValidationCard({ trade, index }: { trade: Trade; index: number }) {
  const responses = trade.validation?.responses ?? [];
  const signedCount = responses.filter(
    (r) => r.signature && r.signature !== `0x${'00'.repeat(65)}`
  ).length;
  const isPending = trade.status === 'pending';
  const elapsed = Math.floor((Date.now() - trade.timestamp) / 1000);
  const timeLabel = elapsed < 5 ? 'just now' : elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed / 60)}m ago`;

  return (
    <m.div
      key={trade.id}
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ delay: index * 0.05, duration: 0.35, type: 'spring', bounce: 0.15 }}
    >
      <Card className={`overflow-hidden border-l-2 ${
        isPending
          ? 'border-l-violet-500 dark:border-l-violet-400'
          : trade.validation?.approved
            ? 'border-l-emerald-500 dark:border-l-emerald-400'
            : 'border-l-crimson-500 dark:border-l-crimson-400'
      }`}>
        <CardContent className="pt-4 pb-4">
          {/* Header */}
          <div className="flex items-center gap-3 mb-3">
            <ScoreRing
              score={trade.validatorScore ?? 0}
              size={40}
              indeterminate={isPending && responses.length === 0}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={trade.action === 'buy' ? 'success' : 'destructive'} className="text-xs">
                  {trade.action.toUpperCase()}
                </Badge>
                {trade.paperTrade && (
                  <Badge variant="secondary" className="text-xs">PAPER</Badge>
                )}
                <span className="text-sm font-display font-medium">
                  {trade.tokenIn}/{trade.tokenOut}
                </span>
                <span className="text-xs font-data text-arena-elements-textTertiary">
                  {timeLabel}
                </span>
                {isPending && (
                  <span className="inline-flex items-center gap-1 text-xs font-data text-violet-600 dark:text-violet-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
                    validating
                  </span>
                )}
                {!isPending && trade.validation && (
                  <Badge variant={trade.validation.approved ? 'success' : 'destructive'} className="text-xs">
                    {trade.validation.approved ? 'APPROVED' : 'REJECTED'}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* Validator slots grid */}
          {responses.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
              {responses.map((r, vi) => {
                const hasSig = r.signature && r.signature !== `0x${'00'.repeat(65)}`;
                return (
                  <m.div
                    key={`${trade.id}-slot-${r.validator}-${vi}`}
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: vi * 0.08, duration: 0.3 }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                      hasSig
                        ? 'border-arena-elements-borderColor bg-arena-elements-background-depth-3'
                        : 'border-dashed border-arena-elements-borderColor/50 bg-transparent'
                    }`}
                  >
                    <ScoreRing score={r.score} size={28} />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-data text-arena-elements-textPrimary">
                        {truncateAddress(r.validator)}
                      </span>
                    </div>
                    {hasSig ? (
                      <Badge variant="success" className="text-xs py-0">SIGNED</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs py-0">NO SIG</Badge>
                    )}
                  </m.div>
                );
              })}
            </div>
          )}

          {/* Summary row */}
          <div className="flex items-center gap-3 text-xs">
            {responses.length > 0 && (
              <span className="font-data text-arena-elements-textTertiary">
                {signedCount}/{responses.length} responses
              </span>
            )}
            {trade.validatorScore != null && (
              <span className="font-data text-arena-elements-textTertiary">
                Aggregate: <span className="font-bold text-arena-elements-textPrimary">{trade.validatorScore}</span>
              </span>
            )}
            {trade.validation?.intentHash && (
              <div className="flex items-center gap-1">
                <span className="font-data text-arena-elements-textTertiary">Intent:</span>
                <code className="font-data text-arena-elements-textTertiary">
                  {truncateAddress(trade.validation.intentHash)}
                </code>
                <CopyButton text={trade.validation.intentHash} label="Copy" />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </m.div>
  );
}

// ── Full Trade Validation Card (history) ────────────────────────────────

function TradeValidationCard({ trade, index }: { trade: Trade; index: number }) {
  const responses = trade.validation?.responses ?? [];
  const signedCount = responses.filter(
    (r) => r.signature && r.signature !== `0x${'00'.repeat(65)}`
  ).length;

  return (
    <m.div
      key={trade.id}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.4 }}
    >
      <Card className="overflow-hidden">
        <CardContent className="pt-5 pb-5">
          {/* Trade header */}
          <div className="flex items-start gap-4 mb-4">
            <ScoreRing score={trade.validatorScore ?? 0} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={trade.action === 'buy' ? 'success' : 'destructive'}>
                  {trade.action.toUpperCase()}
                </Badge>
                {trade.paperTrade && (
                  <Badge variant="secondary">PAPER</Badge>
                )}
                <span className="text-sm font-display font-medium">
                  {trade.tokenIn}/{trade.tokenOut}
                </span>
                <span className="text-xs font-data text-arena-elements-textTertiary">
                  {new Date(trade.timestamp).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>

              {/* Validation summary */}
              <div className="flex items-center gap-3 mt-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                    Validators
                  </span>
                  <Badge variant={signedCount === responses.length && signedCount > 0 ? 'success' : 'amber'}>
                    {signedCount}/{responses.length} signed
                  </Badge>
                </div>
                {trade.validation?.intentHash && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                      Intent
                    </span>
                    <code className="text-xs font-data text-arena-elements-textTertiary">
                      {truncateAddress(trade.validation.intentHash)}
                    </code>
                    <CopyButton text={trade.validation.intentHash} label="Copy" />
                  </div>
                )}
                {trade.validation && (
                  <Badge variant={trade.validation.approved ? 'success' : 'destructive'}>
                    {trade.validation.approved ? 'APPROVED' : 'REJECTED'}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* Per-validator breakdown */}
          {responses.length > 0 && (
            <div className="space-y-2">
              {responses.map((response, vi) => (
                <ValidatorCard key={`${trade.id}-${response.validator}-${vi}`} response={response} index={vi} />
              ))}
            </div>
          )}

          {/* No validator responses */}
          {responses.length === 0 && trade.validatorReasoning && (
            <p className="text-sm text-arena-elements-textSecondary leading-relaxed mt-2">
              {trade.validatorReasoning}
            </p>
          )}
        </CardContent>
      </Card>
    </m.div>
  );
}

// ── Main Tab ────────────────────────────────────────────────────────────

export function ReasoningTab({ botId, botName = '' }: ReasoningTabProps) {
  const { data: allTrades, isLoading } = useBotTrades(botId, botName);
  const { data: recentTrades } = useBotRecentValidations(botId, botName);

  // Separate pending (live) from completed (history)
  const pendingTrades = (recentTrades ?? []).filter(
    (t) => t.status === 'pending' || (Date.now() - t.timestamp < 30_000 && t.validation)
  );

  const historicalTrades = (allTrades ?? []).filter(
    (t) => t.validatorReasoning || (t.validation?.responses?.length ?? 0) > 0
  );

  // Dedupe: don't show recently-completed trades in both sections
  const pendingIds = new Set(pendingTrades.map((t) => t.id));
  const filteredHistory = historicalTrades.filter((t) => !pendingIds.has(t.id));

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading validator reasoning...
      </div>
    );
  }

  if (pendingTrades.length === 0 && filteredHistory.length === 0) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:brain text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No validator reasoning available for this bot's trades.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Live validations section */}
      <AnimatePresence mode="popLayout">
        {pendingTrades.map((trade, i) => (
          <PendingValidationCard key={`pending-${trade.id}`} trade={trade} index={i} />
        ))}
      </AnimatePresence>

      {/* Divider */}
      {pendingTrades.length > 0 && filteredHistory.length > 0 && (
        <div className="flex items-center gap-3 py-1">
          <div className="flex-1 h-px bg-arena-elements-borderColor/30" />
          <span className="text-xs font-data text-arena-elements-textTertiary uppercase tracking-wider">History</span>
          <div className="flex-1 h-px bg-arena-elements-borderColor/30" />
        </div>
      )}

      {/* Historical validations */}
      {filteredHistory.map((trade, i) => (
        <TradeValidationCard key={trade.id} trade={trade} index={i} />
      ))}
    </div>
  );
}

/**
 * Returns the count of pending validations for a bot.
 * Used by the parent page to show a badge on the Reasoning tab.
 */
export function usePendingValidationCount(botId: string, botName: string = ''): number {
  const { data } = useBotRecentValidations(botId, botName);
  return (data ?? []).filter((t) => t.status === 'pending').length;
}
