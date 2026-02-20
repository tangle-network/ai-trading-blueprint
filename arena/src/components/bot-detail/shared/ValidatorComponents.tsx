import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { Badge } from '@tangle/blueprint-ui/components';
import { useThemeValue } from '@tangle/blueprint-ui';
import type { ValidatorResponseDetail } from '~/lib/types/trade';

// ── Utilities ───────────────────────────────────────────────────────────

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function truncateSignature(sig: string): string {
  if (sig.length <= 20) return sig;
  return `${sig.slice(0, 10)}...${sig.slice(-8)}`;
}

// ── CopyButton ──────────────────────────────────────────────────────────

export function CopyButton({ text, label }: { text: string; label?: string }) {
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

// ── ScoreRing ───────────────────────────────────────────────────────────

export function ScoreRing({ score, size = 44, indeterminate = false }: { score: number; size?: number; indeterminate?: boolean }) {
  const theme = useThemeValue();
  const isDark = theme === 'dark';
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = indeterminate
    ? (isDark ? '#A78BFA' : '#7C3AED')
    : score >= 80
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
          strokeDashoffset={indeterminate ? circumference * 0.7 : offset}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color}40)` }}
          className={indeterminate ? 'animate-spin origin-center' : undefined}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-xs font-data font-bold"
        style={{ color }}
      >
        {indeterminate ? '...' : score}
      </span>
    </div>
  );
}

// ── ValidatorCard ───────────────────────────────────────────────────────

export function ValidatorCard({ response, index }: { response: ValidatorResponseDetail; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasSignature = response.signature && response.signature !== `0x${'00'.repeat(65)}`;
  const hasEip712Domain = response.chainId != null && response.verifyingContract;

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.3 }}
    >
      <div className="rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-4 overflow-hidden">
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
            <m.div
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
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </m.div>
  );
}
