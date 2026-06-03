import type { ReactNode } from 'react';
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

const terminalToneBadgeClass: Record<DecisionFeedTone, string> = {
  neutral: 'border-[#273035] bg-[#16242a] text-[#d2dad7]',
  success: 'border-[#50d2c1]/28 bg-[#143c38] text-[#50d2c1]',
  warning: 'border-amber-400/28 bg-amber-500/10 text-amber-300',
  danger: 'border-[#ed7088]/32 bg-[#3a1d26] text-[#ed7088]',
  active: 'border-[#50d2c1]/28 bg-[#123f3a] text-[#50d2c1]',
};

const terminalToneIconClass: Record<DecisionFeedTone, string> = {
  neutral: 'text-[#949e9c]',
  success: 'text-[#50d2c1]',
  warning: 'text-amber-300',
  danger: 'text-[#ed7088]',
  active: 'text-[#50d2c1]',
};

interface DecisionInspectorProps {
  item: DecisionFeedItem | null | undefined;
  className?: string;
  variant?: 'default' | 'terminal';
  instrumentSlot?: ReactNode;
}

function StageRow({ stage, isTerminal = false }: { stage: DecisionFeedStage; isTerminal?: boolean }) {
  const stageValue = isTerminal && stage.value === 'Not captured' && stage.detail
    ? 'Summary'
    : stage.value;

  return (
    <div className={cx(
      'grid grid-cols-[24px_minmax(0,1fr)] gap-2 p-2.5',
      isTerminal
        ? 'rounded-[5px] border border-[#273035] bg-[#0f1a1f]'
        : 'rounded-lg border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/25',
    )}>
      <span
        className={cx(stage.iconClass, 'mt-0.5 text-base', isTerminal ? terminalToneIconClass[stage.tone] : toneIconClass[stage.tone])}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className={cx('font-display text-xs font-semibold', isTerminal ? 'text-[#f6fefd]' : 'text-arena-elements-textPrimary')}>
            {stage.label}
          </span>
          <span className={cx('rounded-full border px-1.5 py-0.5 font-data text-[11px]', isTerminal ? terminalToneBadgeClass[stage.tone] : toneBadgeClass[stage.tone])}>
            {stageValue}
          </span>
        </div>
        {stage.detail && (
          <p className={cx('mt-1 line-clamp-2 text-xs leading-5', isTerminal ? 'text-[#949e9c]' : 'text-arena-elements-textSecondary')}>
            {stage.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function sourceLabel(source: DecisionFeedItem['source']): string {
  return source === 'trade' ? 'Execution decision' : 'Agent run decision';
}

function venuePresentation(label: string | undefined, instrumentLabel: string) {
  const source = (label ?? instrumentLabel).toLowerCase();
  if (source.includes('aerodrome')) {
    return { mark: 'AERO', label: 'Aerodrome', iconClass: 'i-ph:swap', toneClass: 'border-[#5fd7ff]/30 bg-[#0a2a34] text-[#7be6ff]' };
  }
  if (source.includes('hyperliquid')) {
    return { mark: 'HL', label: 'Hyperliquid', iconClass: 'i-ph:chart-line-up', toneClass: 'border-[#50d2c1]/28 bg-[#0d302c] text-[#50d2c1]' };
  }
  if (source.includes('paper')) {
    return { mark: 'SIM', label: 'Paper', iconClass: 'i-ph:notepad', toneClass: 'border-[#6f5723] bg-[#201808] text-[#f2c066]' };
  }
  if (source.includes('polymarket') || source.includes('clob')) {
    return { mark: 'CLOB', label: 'CLOB', iconClass: 'i-ph:book-open', toneClass: 'border-[#7f5cff]/28 bg-[#1b1234] text-[#c9bcff]' };
  }
  if (source.includes('uniswap') || source.includes('dex')) {
    return { mark: 'DEX', label: label ?? 'DEX', iconClass: 'i-ph:swap', toneClass: 'border-[#5fd7ff]/30 bg-[#0a2434] text-[#7be6ff]' };
  }
  return { mark: 'RUN', label: label ?? 'Execution venue', iconClass: 'i-ph:activity', toneClass: 'border-[#273035] bg-[#16242a] text-[#d2dad7]' };
}

function TerminalStatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border border-[#273035] bg-[#081013] px-2.5 py-2">
      <div className="truncate font-data text-[10px] font-semibold uppercase tracking-[0.12em] text-[#697371]">
        {label}
      </div>
      <div className="mt-1 truncate font-data text-sm font-bold text-[#f6fefd]" title={value}>
        {value}
      </div>
    </div>
  );
}

export function DecisionInspector({
  item,
  className,
  variant = 'default',
  instrumentSlot,
}: DecisionInspectorProps) {
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

  const isTerminal = variant === 'terminal';
  const primaryStats = [
    item.notionalLabel ? { label: 'Notional', value: item.notionalLabel } : null,
    item.venueLabel ? {
      label: item.venueLabel.toLowerCase() === 'paper' ? 'Mode' : 'Venue',
      value: item.venueLabel.toLowerCase() === 'paper' ? 'Paper' : item.venueLabel,
    } : null,
    item.validationLabel ? { label: 'Validation', value: item.validationLabel } : null,
    item.executionLabel ? { label: 'Execution', value: item.executionLabel } : null,
  ].filter((entry): entry is { label: string; value: string } => (
    entry !== null && !(isTerminal && entry.label === 'Notional')
  ));
  const capturedStages = item.stages.filter((stage) => stage.value !== 'Not captured' || Boolean(stage.detail));
  const venue = venuePresentation(item.venueLabel, item.instrumentLabel);
  const terminalSections = item.sections?.filter((section) => section.items.length > 0).slice(0, 3) ?? [];

  return (
    <aside
      className={cx(
        'flex min-h-0 flex-col overflow-y-auto',
        isTerminal ? 'bg-[#0b1418] text-[#f6fefd]' : 'bg-arena-elements-background-depth-2/24',
        isTerminal ? 'p-3' : 'p-4',
        className,
      )}
      aria-label="Decision inspector"
    >
      <div className={cx(
        isTerminal
          ? 'rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-3'
          : 'rounded-xl border-0 border-arena-elements-dividerColor/45 bg-transparent p-0',
      )}>
        {isTerminal && (
          <div className="mb-3 flex min-w-0 items-center gap-3 border-b border-[#273035] pb-3">
            <div className={cx('flex h-12 w-12 shrink-0 items-center justify-center border font-data text-[13px] font-black tracking-tight', venue.toneClass)}>
              {venue.mark}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5 font-data text-[11px] uppercase tracking-[0.12em] text-[#50d2c1]">
                <span className={`${venue.iconClass} shrink-0 text-sm`} aria-hidden="true" />
                <span className="truncate">{venue.label}</span>
              </div>
              <div className="mt-1 truncate font-display text-lg font-semibold text-[#f6fefd]">
                {item.instrumentLabel}
              </div>
            </div>
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={cx(
                'rounded-full border px-2 py-0.5 font-data text-[10px] font-semibold uppercase tracking-wider',
                isTerminal
                  ? 'border-[#273035] bg-[#16242a] text-[#949e9c]'
                  : 'border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/62 text-arena-elements-textTertiary',
              )}>
                {sourceLabel(item.source)}
              </span>
              <span className={cx('rounded-full border px-2 py-0.5 font-data text-xs', isTerminal ? terminalToneBadgeClass[item.statusTone] : toneBadgeClass[item.statusTone])}>
                {item.statusLabel}
              </span>
            </div>
            <h3 className={cx(
              'mt-2 truncate font-display font-semibold tracking-tight',
              isTerminal ? 'text-[#f6fefd]' : 'text-arena-elements-textPrimary',
              isTerminal ? 'text-xl' : 'text-base',
            )}>
              {item.actionLabel}
            </h3>
          </div>
          <div className="shrink-0 pt-1 text-right">
            <span className={cx('font-data text-xs', isTerminal ? 'text-[#949e9c]' : 'text-arena-elements-textTertiary')}>
              {item.subtitle}
            </span>
            {isTerminal && item.notionalLabel && (
              <div className="mt-2 font-data text-xl font-bold tabular-nums text-[#f6fefd]">
                {item.notionalLabel}
              </div>
            )}
          </div>
        </div>

        <div className={cx('mt-3', instrumentSlot ? 'min-w-0' : '')}>
          {instrumentSlot ?? (
            <p className={cx(
              'truncate font-data',
              isTerminal ? 'text-[#d2dad7] sr-only' : 'text-arena-elements-textSecondary',
              isTerminal ? 'text-base' : 'text-sm',
            )}>
              {item.instrumentLabel}
            </p>
          )}
        </div>
        {isTerminal && primaryStats.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {primaryStats.map((stat) => (
              <TerminalStatCard key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </div>
        )}
        {isTerminal && (
          <div className="mt-2.5 rounded-[5px] border border-[#273035] bg-[#0b1418] p-2.5">
            <div className="text-[10px] font-display font-semibold uppercase tracking-wider text-[#949e9c]">
              Thesis
            </div>
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-[#f6fefd]">
              {item.reason}
            </p>
          </div>
        )}
      </div>

      {!isTerminal && (
        <div className="mt-3 rounded-lg border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/28 p-3">
          <div className="text-xs font-display font-semibold uppercase text-arena-elements-textTertiary">
            Agent Thesis
          </div>
          <p className="mt-2 text-sm leading-6 text-arena-elements-textPrimary">
            {item.reason}
          </p>
        </div>
      )}

      {primaryStats.length > 0 && !isTerminal && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {primaryStats.map((stat) => (
            <div
              key={stat.label}
              className={cx(
                'rounded-lg border border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/25 px-3',
                isTerminal ? 'py-2.5' : 'py-2',
              )}
            >
              <div className="font-display text-[11px] font-semibold uppercase text-arena-elements-textTertiary">
                {stat.label}
              </div>
              <div className={cx(
                'mt-1 truncate font-data text-arena-elements-textPrimary',
                isTerminal ? 'text-base font-semibold' : 'text-sm',
              )}>
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {capturedStages.length > 0 && (
        <div className={cx('mt-3 grid gap-2', isTerminal ? 'grid-cols-1 min-[1440px]:grid-cols-2' : 'grid-cols-1')}>
          {capturedStages.map((stage) => (
            <StageRow key={stage.key} stage={stage} isTerminal={isTerminal} />
          ))}
        </div>
      )}

      {isTerminal && terminalSections.length > 0 && (
        <div className="mt-4 grid gap-2">
          <div className="font-data text-[10px] font-semibold uppercase tracking-[0.14em] text-[#949e9c]">
            Parsed Output
          </div>
          {terminalSections.map((section) => (
            <section key={section.title} className="border border-[#273035] bg-[#0f1a1f] p-2.5">
              <div className="truncate font-display text-xs font-semibold text-[#f6fefd]">
                {section.title}
              </div>
              <div className="mt-2 grid gap-1.5">
                {section.items.slice(0, 5).map((entry) => (
                  <div key={`${section.title}-${entry.label}`} className="grid min-w-0 grid-cols-[6.25rem_minmax(0,1fr)] gap-2 font-data text-[11px]">
                    <span className="truncate uppercase tracking-[0.08em] text-[#697371]">
                      {entry.label}
                    </span>
                    <span className="min-w-0 truncate text-right text-[#d2dad7]" title={entry.value}>
                      {entry.value}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {item.provenance.length > 0 && (
        <div className="mt-4">
          <div className={cx('text-xs font-display font-semibold uppercase', isTerminal ? 'text-[#949e9c]' : 'text-arena-elements-textTertiary')}>
            Evidence
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.provenance.slice(0, 8).map((fact) => (
              <span
                key={`${fact.label}-${fact.value}`}
                className={cx(
                  'max-w-full truncate rounded-full border px-2 py-1 font-data text-xs',
                  isTerminal
                    ? 'border-[#273035] bg-[#0f1a1f] text-[#d2dad7]'
                    : 'border-arena-elements-dividerColor/45 bg-arena-elements-background-depth-1/30 text-arena-elements-textSecondary',
                )}
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
