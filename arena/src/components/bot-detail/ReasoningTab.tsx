import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useBotTrades } from '~/lib/hooks/useBotApi';
import { Card, CardContent } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';
import { useThemeValue } from '~/lib/hooks/useThemeValue';
import type { Trade, ValidatorResponseDetail } from '~/lib/types/trade';

interface ReasoningTabProps {
  botId: string;
  botName?: string;
}

function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const theme = useThemeValue();
  const isDark = theme === 'dark';
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80
    ? (isDark ? '#00FF88' : '#007A42')
    : score >= 50
      ? (isDark ? '#FFB800' : '#B88000')
      : (isDark ? '#FF3B5C' : '#C81E34');

  return (
    <div className="score-ring relative" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(240, 240, 245, 0.06)"
          strokeWidth="3"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color}40)` }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-xs font-data font-bold"
        style={{ color }}
      >
        {score}
      </span>
    </div>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function truncateSignature(sig: string): string {
  if (sig.length <= 20) return sig;
  return `${sig.slice(0, 10)}...${sig.slice(-8)}`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="text-xs font-data text-arena-elements-textTertiary hover:text-arena-elements-textSecondary transition-colors cursor-pointer"
      title={`Copy ${label ?? 'value'}`}
    >
      {copied ? 'Copied' : (label ?? 'Copy')}
    </button>
  );
}

function ValidatorCard({ response, index }: { response: ValidatorResponseDetail; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasSignature = response.signature && response.signature !== `0x${'00'.repeat(65)}`;
  const hasEip712Domain = response.chainId != null && response.verifyingContract;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.3 }}
    >
      <div className="rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-2 overflow-hidden">
        {/* Validator header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-arena-elements-background-depth-3 transition-colors cursor-pointer"
        >
          <ScoreRing score={response.score} size={36} />
          <div className="flex-1 min-w-0 text-left">
            <div className="flex items-center gap-2">
              <span className="text-xs font-data font-medium text-arena-elements-textPrimary">
                {truncateAddress(response.validator)}
              </span>
              {hasSignature ? (
                <Badge variant="success" className="text-xs py-0">SIGNED</Badge>
              ) : (
                <Badge variant="secondary" className="text-xs py-0">NO SIG</Badge>
              )}
              {hasEip712Domain && (
                <Badge variant="accent" className="text-xs py-0">EIP-712</Badge>
              )}
            </div>
            {response.validatedAt && (
              <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5">
                {new Date(response.validatedAt).toLocaleString('en-US', {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
                })}
              </div>
            )}
          </div>
          <div className="i-ph:caret-down text-arena-elements-textTertiary transition-transform" style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />
        </button>

        {/* Expanded detail */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-4 pb-4 space-y-3 border-t border-arena-elements-dividerColor pt-3">
                {/* Reasoning */}
                <div>
                  <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
                    Reasoning
                  </div>
                  <p className="text-sm text-arena-elements-textSecondary leading-relaxed">
                    {response.reasoning}
                  </p>
                </div>

                {/* Signature */}
                {hasSignature && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                        Signature
                      </span>
                      <CopyButton text={response.signature} label="Copy" />
                    </div>
                    <code className="text-xs font-data text-arena-elements-textTertiary break-all">
                      {truncateSignature(response.signature)}
                    </code>
                  </div>
                )}

                {/* EIP-712 Domain */}
                {hasEip712Domain && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
                        Chain ID
                      </div>
                      <span className="text-xs font-data text-arena-elements-textPrimary">
                        {response.chainId}
                      </span>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                          Verifying Contract
                        </span>
                        <CopyButton text={response.verifyingContract!} label="Copy" />
                      </div>
                      <code className="text-xs font-data text-arena-elements-textTertiary">
                        {truncateAddress(response.verifyingContract!)}
                      </code>
                    </div>
                  </div>
                )}

                {/* Validator address full */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                      Validator Address
                    </span>
                    <CopyButton text={response.validator} label="Copy" />
                  </div>
                  <code className="text-xs font-data text-arena-elements-textTertiary break-all">
                    {response.validator}
                  </code>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function TradeValidationCard({ trade, index }: { trade: Trade; index: number }) {
  const responses = trade.validation?.responses ?? [];
  const signedCount = responses.filter(
    (r) => r.signature && r.signature !== `0x${'00'.repeat(65)}`
  ).length;

  return (
    <motion.div
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
    </motion.div>
  );
}

export function ReasoningTab({ botId, botName = '' }: ReasoningTabProps) {
  const { data: allTrades, isLoading } = useBotTrades(botId, botName);
  const trades = allTrades?.filter((t) => t.validatorReasoning || (t.validation?.responses?.length ?? 0) > 0) ?? [];

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading validator reasoning...
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:brain text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No validator reasoning available for this bot's trades.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {trades.map((trade, i) => (
        <TradeValidationCard key={trade.id} trade={trade} index={i} />
      ))}
    </div>
  );
}
