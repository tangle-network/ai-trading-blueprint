import {
  formatRunCostUsd,
  formatRunTimestamp,
  formatTokenTotal,
  type IntelligenceUsageBreakdown,
  type IntelligenceUsageGranularity,
  type IntelligenceUsageSummary,
} from '~/lib/botRuns';

export type IntelligenceMetric = 'cost' | 'tokens';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function formatPercentShare(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  if (value > 0 && value < 1) return '<1%';
  return `${Math.round(value)}%`;
}

function formatTokenPair(inputTokens: number, outputTokens: number): string {
  return `${formatTokenTotal(inputTokens)} in / ${formatTokenTotal(outputTokens)} out`;
}

function formatUsageWindow(start: number | null, end: number | null): string {
  if (start == null || end == null) return 'No usage window';
  return `${formatRunTimestamp(start)} - ${formatRunTimestamp(end)}`;
}

function usageMetricValue(item: IntelligenceUsageBreakdown, metric: IntelligenceMetric): number {
  return metric === 'cost' ? item.costUsd ?? 0 : item.totalTokens;
}

function formatUsageMetric(item: IntelligenceUsageBreakdown, metric: IntelligenceMetric): string {
  if (metric === 'cost') return formatRunCostUsd(item.costUsd) ?? 'cost n/a';
  return formatTokenTotal(item.totalTokens);
}

function UsageSegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="grid grid-flow-col auto-cols-fr gap-0.5 rounded-[5px] bg-[var(--arena-terminal-bg)] p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={cx(
            'h-7 truncate rounded-[4px] px-2 font-data text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]',
            value === option.value
              ? 'bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-text)]'
              : 'text-[var(--arena-terminal-text-muted)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)]',
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function IntelligenceMetricTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2">
      <div className="truncate font-data text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
        {label}
      </div>
      <div className="mt-1 truncate font-data text-lg font-bold text-[var(--arena-terminal-text)]" title={value}>
        {value}
      </div>
      <div className="mt-0.5 truncate font-data text-[11px] text-[var(--arena-terminal-text-muted)]" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function UsageBreakdownRows({
  title,
  rows,
  metric,
  maxValue,
  testIdPrefix,
}: {
  title: string;
  rows: IntelligenceUsageBreakdown[];
  metric: IntelligenceMetric;
  maxValue: number;
  testIdPrefix: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-2.5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
          {title}
        </h4>
        <span className="shrink-0 font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
          {metric === 'cost' ? 'Cost' : 'Tokens'}
        </span>
      </div>
      <div className="space-y-2">
        {rows.slice(0, 5).map((row) => {
          const value = usageMetricValue(row, metric);
          const width = maxValue > 0 ? Math.max(4, Math.min(100, (value / maxValue) * 100)) : 0;
          return (
            <div key={row.id} className="min-w-0" data-testid={`${testIdPrefix}-${row.id}`}>
              <div className="flex min-w-0 items-center justify-between gap-3 font-data text-[11px]">
                <span className="min-w-0 truncate text-[var(--arena-terminal-text-secondary)]" title={row.label}>
                  {row.label}
                </span>
                <span className="shrink-0 text-[var(--arena-terminal-text)]">
                  {formatUsageMetric(row, metric)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--arena-terminal-panel-strong)]">
                <div
                  className="h-full rounded-full bg-[#50d2c1]"
                  style={{ width: `${width}%` }}
                />
              </div>
              <div className="mt-0.5 truncate font-data text-[10px] text-[var(--arena-terminal-text-muted)]">
                {row.runCount.toLocaleString()} {row.runCount === 1 ? 'run' : 'runs'} / {formatTokenPair(row.inputTokens, row.outputTokens)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function IntelligenceSpendPanel({
  summary,
  granularity,
  metric,
  onGranularityChange,
  onMetricChange,
  sourceLabel = 'Loaded run ledger',
  className,
}: {
  summary: IntelligenceUsageSummary;
  granularity: IntelligenceUsageGranularity;
  metric: IntelligenceMetric;
  onGranularityChange: (granularity: IntelligenceUsageGranularity) => void;
  onMetricChange: (metric: IntelligenceMetric) => void;
  sourceLabel?: string;
  className?: string;
}) {
  if (summary.runCount === 0) return null;

  const timelineRows = summary.timeline.slice(-8);
  const maxTimelineValue = Math.max(1, ...timelineRows.map((item) => usageMetricValue(item, metric)));
  const maxWorkflowValue = Math.max(1, ...summary.byWorkflow.map((item) => usageMetricValue(item, metric)));
  const maxModelValue = Math.max(1, ...summary.byModel.map((item) => usageMetricValue(item, metric)));
  const inputShare = summary.totalTokens > 0 ? (summary.inputTokens / summary.totalTokens) * 100 : 0;
  const outputShare = summary.totalTokens > 0 ? (summary.outputTokens / summary.totalTokens) * 100 : 0;
  const spendLabel = formatRunCostUsd(summary.costUsd) ?? 'cost n/a';
  const costDetail = summary.costUsd != null
    ? `${summary.costKnownRunCount.toLocaleString()} / ${summary.runCount.toLocaleString()} usage rows priced`
    : 'No priced usage rows loaded';
  const usageWindow = formatUsageWindow(summary.windowStart, summary.windowEnd);

  return (
    <section
      data-testid="intelligence-spend-panel"
      className={cx('shrink-0 border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 py-3', className)}
      aria-label="Intelligence spend"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="i-ph:brain text-base text-[#50d2c1]" aria-hidden="true" />
            <h3 className="truncate font-display text-base font-semibold text-[var(--arena-terminal-text)]">
              Intelligence Spend
            </h3>
          </div>
          <div className="mt-0.5 truncate font-data text-xs text-[var(--arena-terminal-text-muted)]" title={usageWindow}>
            {sourceLabel} / {summary.runCount.toLocaleString()} AI {summary.runCount === 1 ? 'run' : 'runs'} / {usageWindow}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <UsageSegmentedControl<IntelligenceMetric>
            label="Intelligence spend metric"
            value={metric}
            options={[
              { value: 'cost', label: 'Cost' },
              { value: 'tokens', label: 'Tokens' },
            ]}
            onChange={onMetricChange}
          />
          <UsageSegmentedControl<IntelligenceUsageGranularity>
            label="Intelligence spend time bucket"
            value={granularity}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'hour', label: 'Hour' },
            ]}
            onChange={onGranularityChange}
          />
        </div>
      </div>

      <div className="mt-3 grid min-w-0 gap-2 md:grid-cols-3">
        <IntelligenceMetricTile
          label="Spend"
          value={spendLabel}
          detail={costDetail}
        />
        <IntelligenceMetricTile
          label="Tokens"
          value={formatTokenTotal(summary.totalTokens)}
          detail={formatTokenPair(summary.inputTokens, summary.outputTokens)}
        />
        <div className="min-w-0 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2">
          <div className="truncate font-data text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
            Token Direction
          </div>
          <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-[var(--arena-terminal-panel-strong)]" aria-hidden="true">
            <div className="bg-[#6ea8ff]" style={{ width: `${inputShare}%` }} />
            <div className="bg-[#f2b84b]" style={{ width: `${outputShare}%` }} />
          </div>
          <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
            <span className="truncate">
              In <b className="font-semibold text-[var(--arena-terminal-text)]">{formatPercentShare(inputShare)}</b>
            </span>
            <span className="truncate">
              Out <b className="font-semibold text-[var(--arena-terminal-text)]">{formatPercentShare(outputShare)}</b>
            </span>
          </div>
        </div>
      </div>

      <div className="mt-2 grid min-w-0 gap-2 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="min-w-0 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-2.5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h4 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
              {granularity === 'hour' ? 'Hourly' : 'Daily'}
            </h4>
            <span className="shrink-0 font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
              {metric === 'cost' ? 'Cost' : 'Tokens'}
            </span>
          </div>
          <div className="grid min-h-[92px] items-end gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(1, timelineRows.length)}, minmax(0, 1fr))` }}>
            {timelineRows.map((bucket) => {
              const value = usageMetricValue(bucket, metric);
              const height = maxTimelineValue > 0 ? Math.max(6, Math.min(100, (value / maxTimelineValue) * 100)) : 0;
              return (
                <div key={bucket.id} className="flex min-w-0 flex-col items-center gap-1" title={`${bucket.label}: ${formatUsageMetric(bucket, metric)} / ${formatTokenPair(bucket.inputTokens, bucket.outputTokens)}`}>
                  <div className="flex h-20 w-full items-end rounded-[4px] bg-[var(--arena-terminal-panel-strong)]">
                    <div
                      className="w-full rounded-[4px] bg-[#50d2c1]"
                      style={{ height: `${height}%` }}
                    />
                  </div>
                  <span className="w-full truncate text-center font-data text-[9px] text-[var(--arena-terminal-text-muted)]">
                    {bucket.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-2">
          <UsageBreakdownRows
            title="Run Type"
            rows={summary.byWorkflow}
            metric={metric}
            maxValue={maxWorkflowValue}
            testIdPrefix="usage-workflow"
          />
          <UsageBreakdownRows
            title="Model"
            rows={summary.byModel}
            metric={metric}
            maxValue={maxModelValue}
            testIdPrefix="usage-model"
          />
        </div>
      </div>
    </section>
  );
}
