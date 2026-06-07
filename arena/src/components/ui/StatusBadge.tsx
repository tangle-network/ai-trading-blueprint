import type { RunStatus } from '~/lib/botRuns';

/**
 * Tone determines the badge palette. Sourced from the arena terminal tokens so
 * badges read consistently against the terminal surfaces.
 *
 * Tone semantics (the audit flagged amber as overloaded):
 *  - `progress` — work actively in flight (teal accent). Distinct from caution.
 *  - `positive` — successful terminal state (success teal-green).
 *  - `caution`  — warning / needs attention (amber). Caution ONLY.
 *  - `negative` — failure / rejection (danger red).
 *  - `neutral`  — idle / inert / unknown (muted grey).
 */
type StatusTone = 'progress' | 'positive' | 'caution' | 'negative' | 'neutral';

interface StatusConfig {
  label: string;
  tone: StatusTone;
}

const toneStyles: Record<StatusTone, { container: string; dot: string }> = {
  progress: {
    container:
      'border-[var(--arena-terminal-accent)]/45 bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]',
    dot: 'bg-[var(--arena-terminal-accent)]',
  },
  positive: {
    container:
      'border-[var(--arena-terminal-success-border)] bg-[var(--arena-terminal-success-soft)] text-[var(--arena-terminal-success)]',
    dot: 'bg-[var(--arena-terminal-success)]',
  },
  caution: {
    container:
      'border-[var(--arena-terminal-warning)]/45 bg-[var(--arena-terminal-warning)]/[0.10] text-[var(--arena-terminal-warning)]',
    dot: 'bg-[var(--arena-terminal-warning)]',
  },
  negative: {
    container:
      'border-[var(--arena-terminal-danger)]/45 bg-[var(--arena-terminal-danger)]/[0.10] text-[var(--arena-terminal-danger)]',
    dot: 'bg-[var(--arena-terminal-danger)]',
  },
  neutral: {
    container:
      'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-muted)]',
    dot: 'bg-[var(--arena-terminal-text-subtle)]',
  },
};

/**
 * Canonical status → presentation map. Covers run statuses
 * ({@link RunStatus}), bot lifecycle, and trade execution states. Keys are
 * normalized to lowercase; callers may pass any casing.
 *
 * IMPORTANT: in-progress states (`running`/`live`) use the teal `progress`
 * tone, NOT amber — amber is reserved for `caution` (pending / paused /
 * interrupted) so a single colour never means two different things.
 */
const statusConfig: Record<string, StatusConfig> = {
  // In-progress
  running: { label: 'Running', tone: 'progress' },
  live: { label: 'Live', tone: 'progress' },
  active: { label: 'Active', tone: 'progress' },
  submitted: { label: 'Submitted', tone: 'progress' },
  partial: { label: 'Partial', tone: 'progress' },

  // Successful terminal
  completed: { label: 'Completed', tone: 'positive' },
  filled: { label: 'Filled', tone: 'positive' },
  confirmed: { label: 'Confirmed', tone: 'positive' },
  executed: { label: 'Executed', tone: 'positive' },

  // Caution / needs attention (amber — caution only)
  pending: { label: 'Pending', tone: 'caution' },
  paused: { label: 'Paused', tone: 'caution' },
  interrupted: { label: 'Interrupted', tone: 'caution' },
  winding_down: { label: 'Winding Down', tone: 'caution' },
  needs_config: { label: 'Needs Config', tone: 'caution' },
  awaiting_secrets: { label: 'Awaiting Secrets', tone: 'caution' },

  // Negative terminal
  error: { label: 'Error', tone: 'negative' },
  failed: { label: 'Failed', tone: 'negative' },
  rejected: { label: 'Rejected', tone: 'negative' },
  no_fill: { label: 'No Fill', tone: 'negative' },

  // Neutral / inert
  idle: { label: 'Idle', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  paper: { label: 'Paper', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

/**
 * Fail-open fallback. An API roll-forward can surface a status the UI doesn't
 * yet know about; render a neutral badge (titled with the raw value) instead of
 * crashing or showing nothing.
 */
function resolveConfig(status: string, labelOverride?: string): StatusConfig {
  const known = statusConfig[status.toLowerCase()];
  if (known) {
    return labelOverride ? { ...known, label: labelOverride } : known;
  }
  return {
    label: labelOverride ?? humanizeUnknown(status),
    tone: 'neutral',
  };
}

function humanizeUnknown(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) return 'Unknown';
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

type StatusBadgeSize = 'sm' | 'md';

const sizeStyles: Record<StatusBadgeSize, string> = {
  sm: 'h-5 px-1.5 text-[10px] gap-1',
  md: 'h-6 px-2 text-[11px] gap-1.5',
};

export interface StatusBadgeProps {
  status: string;
  labelOverride?: string;
  size?: StatusBadgeSize;
  /** Hide the leading status dot (label-only badge). */
  hideDot?: boolean;
  className?: string;
}

/**
 * Canonical status pill for the arena. Square borders, terminal palette,
 * fail-open. Use this instead of bespoke per-call className maps.
 */
export function StatusBadge({
  status,
  labelOverride,
  size = 'md',
  hideDot = false,
  className,
}: StatusBadgeProps) {
  const config = resolveConfig(status, labelOverride);
  const tone = toneStyles[config.tone];

  return (
    <span
      className={`inline-flex shrink-0 items-center border font-data font-bold uppercase tracking-[0.1em] ${sizeStyles[size]} ${tone.container} ${className ?? ''}`}
    >
      {!hideDot && (
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${
            config.tone === 'progress' ? 'animate-pulse' : ''
          }`}
          aria-hidden="true"
        />
      )}
      {config.label}
    </span>
  );
}

/** Re-export for callers that only need the {@link RunStatus} union. */
export type { RunStatus };
