import type { DecisionFeedItem, DecisionFeedTone } from '~/lib/decisionFeed';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const toneDotClass: Record<DecisionFeedTone, string> = {
  neutral: 'bg-arena-elements-textTertiary',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-crimson-500',
  active: 'bg-violet-500',
};

const toneTextClass: Record<DecisionFeedTone, string> = {
  neutral: 'text-arena-elements-textSecondary',
  success: 'text-emerald-700 dark:text-emerald-300',
  warning: 'text-amber-700 dark:text-amber-300',
  danger: 'text-crimson-600 dark:text-crimson-300',
  active: 'text-violet-700 dark:text-violet-300',
};

interface DecisionActivityStripProps {
  items: DecisionFeedItem[];
  selectedId?: string;
  onSelect?: (item: DecisionFeedItem) => void;
  className?: string;
  variant?: 'default' | 'terminal';
}

export function DecisionActivityStrip({
  items,
  selectedId,
  onSelect,
  className,
  variant = 'default',
}: DecisionActivityStripProps) {
  if (items.length === 0) return null;
  const isTerminal = variant === 'terminal';

  return (
    <div
      data-testid="decision-activity-strip"
      className={cx(
        'border-b',
        isTerminal
          ? 'border-[#273035] bg-[#081013]'
          : 'border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-2/28',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto px-3 py-2">
        {items.slice(0, 18).map((item) => {
          const selected = item.id === selectedId;
          const actionIsStatus =
            item.actionLabel.toLowerCase() === item.statusLabel.toLowerCase();
          const primaryLabel =
            actionIsStatus && item.instrumentLabel === 'Trace'
              ? 'Trace'
              : item.actionLabel;
          const secondaryLabel =
            actionIsStatus && item.instrumentLabel === 'Trace'
              ? null
              : item.instrumentLabel;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect?.(item)}
              className={cx(
                'group flex min-w-[220px] max-w-[320px] shrink-0 items-center gap-2 border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2',
                isTerminal ? 'rounded-[5px] focus-visible:ring-[var(--arena-terminal-accent)]' : 'rounded-lg focus-visible:ring-violet-500/60',
                selected
                  ? isTerminal
                    ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] shadow-[inset_3px_0_0_var(--arena-terminal-accent)]'
                    : 'border-violet-500/45 bg-violet-500/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                  : isTerminal
                    ? 'border-[#273035] bg-[#0f1a1f] hover:border-[var(--arena-terminal-border-hover)] hover:bg-[#16242a]'
                    : 'border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/26 hover:border-arena-elements-dividerColor/80 hover:bg-arena-elements-item-backgroundHover',
              )}
            >
              <span
                className={cx('h-2.5 w-2.5 shrink-0 rounded-full', toneDotClass[item.statusTone])}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-data text-sm font-semibold text-arena-elements-textPrimary">
                    {primaryLabel}
                  </span>
                  {item.notionalLabel && (
                    <span className="shrink-0 font-data text-xs text-arena-elements-textSecondary">
                      {item.notionalLabel}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2">
                  <span className={cx('shrink-0 font-data text-xs', toneTextClass[item.statusTone])}>
                    {item.statusLabel}
                  </span>
                  {secondaryLabel && (
                    <span className="truncate font-data text-xs text-arena-elements-textTertiary">
                      {secondaryLabel}
                    </span>
                  )}
                </span>
              </span>
              <span className="i-ph:caret-right text-sm text-arena-elements-textTertiary opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
