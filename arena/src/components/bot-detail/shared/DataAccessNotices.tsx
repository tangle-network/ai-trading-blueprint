interface UnverifiedDataNoticeProps {
  subject: string;
}

export function UnverifiedDataNotice({ subject }: UnverifiedDataNoticeProps) {
  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
      <div className="flex gap-3">
        <span
          className="i-ph:warning-circle mt-0.5 shrink-0 text-base text-amber-600 dark:text-amber-300"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="font-display text-base font-semibold text-arena-elements-textPrimary">
            Operator verification pending
          </div>
          <p className="mt-0.5 text-sm leading-relaxed text-arena-elements-textSecondary">
            Showing the latest {subject} available from this operator. Treat it as provisional until
            a fresh verification sync confirms the runtime state.
          </p>
        </div>
      </div>
    </div>
  );
}

export function TradingRiskDisclosure() {
  return (
    <div className="mb-5 rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/54 px-4 py-3 text-sm text-arena-elements-textSecondary">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="i-ph:shield-warning shrink-0 text-base text-amber-600 dark:text-amber-300"
            aria-hidden="true"
          />
          <span>
            Automated trading involves substantial risk of loss. Past performance is not a
            guarantee, and this telemetry is not financial advice.
          </span>
        </div>
        <span className="shrink-0 font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
          Read-only public telemetry
        </span>
      </div>
    </div>
  );
}
