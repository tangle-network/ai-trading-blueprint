import type {
  DecisionFeedItem,
  DecisionFeedStage,
  DecisionFeedTone,
} from '~/lib/decisionFeed';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const toneBadgeClass: Record<DecisionFeedTone, string> = {
  neutral: 'border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/50 text-arena-elements-textSecondary',
  success: 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300',
  danger: 'border-crimson-500/25 bg-crimson-500/8 text-crimson-600 dark:text-crimson-300',
  active: 'border-violet-500/25 bg-violet-500/8 text-violet-700 dark:text-violet-300',
};

const toneIconClass: Record<DecisionFeedTone, string> = {
  neutral: 'text-arena-elements-textTertiary',
  success: 'text-emerald-600 dark:text-emerald-300',
  warning: 'text-amber-600 dark:text-amber-300',
  danger: 'text-crimson-600 dark:text-crimson-300',
  active: 'text-violet-600 dark:text-violet-300',
};

interface DecisionInspectorProps {
  item: DecisionFeedItem | null | undefined;
  className?: string;
}

function StageRow({ stage }: { stage: DecisionFeedStage }) {
  return (
    <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-2 rounded-lg border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/25 p-2.5">
      <span
        className={cx(stage.iconClass, 'mt-0.5 text-base', toneIconClass[stage.tone])}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="font-display text-xs font-semibold text-arena-elements-textPrimary">
            {stage.label}
          </span>
          <span className={cx('rounded-full border px-1.5 py-0.5 font-data text-[11px]', toneBadgeClass[stage.tone])}>
            {stage.value}
          </span>
        </div>
        {stage.detail && (
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-arena-elements-textSecondary">
            {stage.detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function DecisionInspector({ item, className }: DecisionInspectorProps) {
  if (!item) {
    return (
      <aside
        className={cx(
          'flex min-h-0 flex-col justify-center p-4 text-center text-sm text-arena-elements-textTertiary',
          className,
        )}
        aria-label="Decision inspector"
      >
        No decisions captured yet.
      </aside>
    );
  }

  const primaryStats = [
    item.notionalLabel ? { label: 'Notional', value: item.notionalLabel } : null,
    item.venueLabel ? { label: 'Venue', value: item.venueLabel } : null,
    item.validationLabel ? { label: 'Validation', value: item.validationLabel } : null,
    item.executionLabel ? { label: 'Execution', value: item.executionLabel } : null,
  ].filter((entry): entry is { label: string; value: string } => entry !== null);
  const capturedStages = item.stages.filter((stage) => stage.value !== 'Not captured' || Boolean(stage.detail));

  return (
    <aside
        className={cx(
        'flex min-h-0 flex-col overflow-y-auto bg-arena-elements-background-depth-2/24 p-4',
        className,
      )}
      aria-label="Decision inspector"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-display font-semibold text-arena-elements-textPrimary">
              {item.actionLabel}
            </h3>
            <span className={cx('rounded-full border px-2 py-0.5 font-data text-xs', toneBadgeClass[item.statusTone])}>
              {item.statusLabel}
            </span>
          </div>
          <p className="mt-1 truncate font-data text-sm text-arena-elements-textSecondary">
            {item.instrumentLabel}
          </p>
        </div>
        <span className="shrink-0 font-data text-xs text-arena-elements-textTertiary">
          {item.subtitle}
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/28 p-3">
        <div className="text-xs font-display font-semibold uppercase text-arena-elements-textTertiary">
          Reason
        </div>
        <p className="mt-2 text-sm leading-6 text-arena-elements-textPrimary">
          {item.reason}
        </p>
      </div>

      {primaryStats.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {primaryStats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/25 px-3 py-2"
            >
              <div className="font-display text-[11px] font-semibold uppercase text-arena-elements-textTertiary">
                {stat.label}
              </div>
              <div className="mt-1 truncate font-data text-sm text-arena-elements-textPrimary">
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {capturedStages.length > 0 && (
        <div className="mt-3 space-y-2">
          {capturedStages.map((stage) => (
            <StageRow key={stage.key} stage={stage} />
          ))}
        </div>
      )}

      {item.provenance.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-display font-semibold uppercase text-arena-elements-textTertiary">
            Evidence
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.provenance.slice(0, 8).map((fact) => (
              <span
                key={`${fact.label}-${fact.value}`}
                className="max-w-full truncate rounded-full border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/30 px-2 py-1 font-data text-xs text-arena-elements-textSecondary"
                title={`${fact.label}: ${fact.value}`}
              >
                {fact.label}: {fact.value}
              </span>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
