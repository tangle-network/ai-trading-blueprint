export interface ConnectionChipProps {
  /** True while the SSE stream is open and delivering events. */
  connected: boolean;
  /** True while a reconnect is scheduled/in flight after a drop. */
  isReconnecting: boolean;
  /** Whole seconds until the next reconnect attempt (0 when not waiting). */
  retryInSeconds?: number;
  className?: string;
}

/**
 * Live connection indicator for streamed surfaces (transcript / session
 * headers). Three states:
 *  - connected           → green "Live" (steady, healthy)
 *  - reconnecting         → amber "Reconnecting" with a retry-in countdown
 *  - offline (neither)    → grey "Offline"
 *
 * Reconnecting is the only amber state here, consistent with the rest of the
 * arena where amber means caution, not in-progress.
 */
export function ConnectionChip({
  connected,
  isReconnecting,
  retryInSeconds = 0,
  className,
}: ConnectionChipProps) {
  const state = connected
    ? ('live' as const)
    : isReconnecting
      ? ('reconnecting' as const)
      : ('offline' as const);

  const styles = {
    live: {
      container:
        'border-[var(--arena-terminal-success-border)] bg-[var(--arena-terminal-success-soft)] text-[var(--arena-terminal-success)]',
      dot: 'bg-[var(--arena-terminal-success)]',
      pulse: false,
    },
    reconnecting: {
      container:
        'border-[var(--arena-terminal-warning)]/45 bg-[var(--arena-terminal-warning)]/[0.10] text-[var(--arena-terminal-warning)]',
      dot: 'bg-[var(--arena-terminal-warning)]',
      pulse: true,
    },
    offline: {
      container:
        'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-muted)]',
      dot: 'bg-[var(--arena-terminal-text-subtle)]',
      pulse: false,
    },
  }[state];

  const label =
    state === 'live'
      ? 'Live'
      : state === 'reconnecting'
        ? retryInSeconds > 0
          ? `Reconnecting (retry in ${retryInSeconds}s)`
          : 'Reconnecting…'
        : 'Offline';

  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 border px-1.5 font-data text-[10px] font-bold uppercase tracking-[0.1em] ${styles.container} ${className ?? ''}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot} ${styles.pulse ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
