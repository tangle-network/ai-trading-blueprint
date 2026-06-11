import type { CreatePreviewState, CreatePreviewSummary } from '~/lib/createPreview'

const UNAVAILABLE_NOTE =
  'No historical preview available right now — the agent still launches into paper trading.'

function formatSignedPct(value: number): string {
  const fixed = Math.abs(value).toFixed(1)
  if (value > 0) return `+${fixed}%`
  if (value < 0) return `-${fixed}%`
  return '0.0%'
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`
}

function returnTone(value: number): string {
  if (value > 0) return 'text-[var(--arena-terminal-success)]'
  if (value < 0) return 'text-[var(--arena-terminal-danger)]'
  return 'text-[var(--arena-terminal-text-secondary)]'
}

function Metric({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="min-w-0 border-t border-[var(--arena-terminal-border)] px-3 py-2 odd:border-r">
      <dt className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">
        {label}
      </dt>
      <dd className={`mt-0.5 truncate font-mono text-sm font-semibold ${valueClassName ?? 'text-[var(--arena-terminal-text)]'}`}>
        {value}
      </dd>
    </div>
  )
}

function NoteLine({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warning' }) {
  return (
    <p
      className={`border-t border-[var(--arena-terminal-border)] px-3 py-2 font-mono text-[11px] leading-4 ${
        tone === 'warning'
          ? 'text-[var(--arena-terminal-warning)]'
          : 'text-[var(--arena-terminal-text-muted)]'
      }`}
    >
      {children}
    </p>
  )
}

function EvidenceMetrics({
  summary,
  drawdownLimitPct,
}: {
  summary: CreatePreviewSummary
  drawdownLimitPct: number | null
}) {
  const drawdownExceedsLimit =
    drawdownLimitPct !== null && summary.max_drawdown_pct > drawdownLimitPct
  return (
    <>
      <dl className="grid grid-cols-2">
        <Metric
          label="Return"
          value={formatSignedPct(summary.total_return_pct)}
          valueClassName={returnTone(summary.total_return_pct)}
        />
        <Metric label="Max DD" value={formatPct(summary.max_drawdown_pct)} />
        <Metric label="Win rate" value={`${Math.round(summary.win_rate * 100)}%`} />
        <Metric label="Trades" value={String(summary.total_trades)} />
      </dl>
      {drawdownExceedsLimit && (
        <NoteLine tone="warning">
          Historical max DD {formatPct(summary.max_drawdown_pct)} exceeds your{' '}
          {formatPct(drawdownLimitPct)} limit — the breaker would have fired.
        </NoteLine>
      )}
    </>
  )
}

/**
 * Trailing-window evidence for the mandate's strategy class. This card is the
 * contract the launch button acts on: real replayed history when the operator
 * has it, an honest note when it does not. Evidence being unavailable never
 * blocks launch.
 */
export function EvidenceCard({
  state,
  drawdownLimitPct,
}: {
  state: CreatePreviewState
  drawdownLimitPct: number | null
}) {
  const summary = state.status === 'ready' ? state.response.summary : undefined
  const windowLabel = `last ${summary?.lookback_days ?? 30}d`

  return (
    <section
      aria-label="Historical evidence"
      className="grid overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
        <h2 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
          Evidence
        </h2>
        {state.status === 'ready' && summary && (
          <span className="font-mono text-xs text-[var(--arena-terminal-text-secondary)]">{windowLabel}</span>
        )}
      </div>

      {state.status === 'loading' && (
        <p
          role="status"
          className="border-t border-[var(--arena-terminal-border)] px-3 py-2 font-mono text-[11px] leading-4 text-[var(--arena-terminal-text-muted)] motion-safe:animate-pulse"
        >
          Replaying the {windowLabel} of market history…
        </p>
      )}

      {state.status === 'ready' && summary && (
        <EvidenceMetrics summary={summary} drawdownLimitPct={drawdownLimitPct} />
      )}

      {state.status === 'ready' && <NoteLine>{state.response.note}</NoteLine>}

      {(state.status === 'unavailable' || state.status === 'idle') && (
        <NoteLine>{UNAVAILABLE_NOTE}</NoteLine>
      )}
    </section>
  )
}
