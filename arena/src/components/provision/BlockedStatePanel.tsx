import type { Address } from 'viem';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import type { QuoteFailure, QuoteFailureKind } from '~/lib/hooks/useQuotes';

type BlockedTone = 'danger' | 'warn' | 'info';

interface BlockedStateConfig {
  tone: BlockedTone;
  icon: string;
  title: string;
  detail: string;
  /** Label for the inline recovery affordance, when one applies. */
  action?: 'retry' | 'pick_other';
}

/**
 * Map a classified quote failure onto a designed, tone-coded blocked state.
 *
 * The `detail` here is the operator-facing explanation of what to do; the raw
 * transport/operator message is preserved separately on {@link QuoteFailure}
 * and surfaced under an expandable "Technical detail" affordance so the human
 * copy stays clean while debugging information remains one click away.
 */
function describeFailure(kind: QuoteFailureKind): BlockedStateConfig {
  switch (kind) {
    case 'unauthorized':
      return {
        tone: 'danger',
        icon: 'i-ph:lock-key',
        title: 'Wallet not allowlisted',
        detail:
          'This operator only quotes wallets it has admitted. Ask the operator to allowlist this wallet, or pick another operator below.',
        action: 'pick_other',
      };
    case 'at_capacity':
      return {
        tone: 'warn',
        icon: 'i-ph:stack',
        title: 'Operator at capacity',
        detail:
          'This operator has no free slots right now. Choose another operator, or retry once a slot frees up.',
        action: 'pick_other',
      };
    case 'cannot_price':
      return {
        tone: 'warn',
        icon: 'i-ph:receipt-x',
        title: 'Operator could not price this request',
        detail:
          'The operator answered but the quote was unusable. This operator can’t be selected for this service — choose a different one.',
        action: 'pick_other',
      };
    case 'unreachable':
      return {
        tone: 'info',
        icon: 'i-ph:plugs',
        title: 'Operator unreachable',
        detail:
          'Could not reach this operator’s pricing endpoint. It may be restarting or temporarily offline.',
        action: 'retry',
      };
    case 'misconfigured':
    default:
      return {
        tone: 'danger',
        icon: 'i-ph:warning-octagon',
        title: 'Operator misconfigured',
        detail:
          'This operator returned an unexpected error. It can’t be used until the operator resolves it — pick another operator.',
        action: 'pick_other',
      };
  }
}

const toneStyles: Record<BlockedTone, { container: string; icon: string; title: string }> = {
  danger: {
    container:
      'border-[var(--arena-terminal-danger)]/45 bg-[var(--arena-terminal-danger)]/[0.08]',
    icon: 'text-[var(--arena-terminal-danger)]',
    title: 'text-[var(--arena-terminal-danger)]',
  },
  warn: {
    container:
      'border-[var(--arena-terminal-warning)]/45 bg-[var(--arena-terminal-warning)]/[0.08]',
    icon: 'text-[var(--arena-terminal-warning)]',
    title: 'text-[var(--arena-terminal-warning)]',
  },
  info: {
    container:
      'border-[var(--arena-terminal-accent)]/40 bg-[var(--arena-terminal-accent-soft)]',
    icon: 'text-[var(--arena-terminal-accent)]',
    title: 'text-[var(--arena-terminal-accent)]',
  },
};

export interface BlockedStatePanelProps {
  operator: Address;
  failure: QuoteFailure;
  /** Refetch all quotes; wired to the `retry` affordance. */
  onRetry?: () => void;
  /** Whether a refetch is currently in flight (disables the retry button). */
  retrying?: boolean;
}

/**
 * Per-operator blocked state for the provision flow. Replaces raw
 * `errors.get(op).message` rendering with a tone-coded, classified, actionable
 * card matching the arena terminal visual language.
 */
export function BlockedStatePanel({
  operator,
  failure,
  onRetry,
  retrying = false,
}: BlockedStatePanelProps) {
  const config = describeFailure(failure.kind);
  const tone = toneStyles[config.tone];
  const showRetry = config.action === 'retry' && Boolean(onRetry);
  const showRawDetail =
    failure.detail.trim().length > 0 &&
    failure.detail.trim().toLowerCase() !== config.detail.trim().toLowerCase();

  return (
    <div
      className={`border ${tone.container} px-3 py-2.5`}
      role="status"
      aria-label={`${config.title} for operator ${operator}`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`${config.icon} mt-0.5 shrink-0 text-base ${tone.icon}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`font-display text-sm font-semibold ${tone.title}`}>
              {config.title}
            </span>
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              <Identicon address={operator} size={14} />
              <span className="font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
                {operator.slice(0, 6)}…{operator.slice(-4)}
              </span>
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
            {config.detail}
          </p>

          {(showRetry || showRawDetail) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {showRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={retrying}
                  className="inline-flex h-7 items-center gap-1.5 border border-[var(--arena-terminal-accent)]/50 bg-[var(--arena-terminal-accent-soft)] px-2.5 font-data text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-accent)] transition-colors hover:border-[var(--arena-terminal-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className={`i-ph:arrow-clockwise text-xs ${retrying ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  {retrying ? 'Retrying…' : 'Retry'}
                </button>
              )}
              {showRawDetail && (
                <details className="min-w-0 flex-1">
                  <summary className="cursor-pointer select-none font-data text-[10px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)] hover:text-[var(--arena-terminal-text-muted)]">
                    Technical detail
                  </summary>
                  <p className="mt-1 break-words font-data text-[11px] leading-relaxed text-[var(--arena-terminal-text-muted)]">
                    {failure.detail}
                  </p>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
