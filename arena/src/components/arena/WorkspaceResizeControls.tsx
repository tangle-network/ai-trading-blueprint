import {
  useEffect,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function usePersistentWorkspaceLayout<T extends object>(
  storageKey: string,
  defaultLayout: T,
  normalizeLayout: (value: Partial<T>) => T,
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [layout, setLayout] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultLayout;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return defaultLayout;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return defaultLayout;
      return normalizeLayout(parsed as Partial<T>);
    } catch (_error) {
      return defaultLayout;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch (_error) {
      // Layout persistence should never block the trading workspace.
    }
  }, [layout, storageKey]);

  return [layout, setLayout] as const;
}

export function beginWorkspaceResize(
  event: ReactPointerEvent<HTMLElement>,
  {
    cursor,
    onMove,
    onEnd,
  }: {
    cursor: 'col-resize' | 'row-resize';
    onMove: (event: PointerEvent) => void;
    onEnd?: () => void;
  },
) {
  event.preventDefault();
  const body = document.body;
  const previousCursor = body.style.cursor;
  const previousUserSelect = body.style.userSelect;
  body.style.cursor = cursor;
  body.style.userSelect = 'none';

  function handlePointerMove(moveEvent: PointerEvent) {
    onMove(moveEvent);
  }

  function handlePointerUp() {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    body.style.cursor = previousCursor;
    body.style.userSelect = previousUserSelect;
    onEnd?.();
  }

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp, { once: true });
}

export function WorkspaceControlButton({
  label,
  icon,
  onClick,
  className,
  testId,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className={cx(
        'inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-muted)] transition-[background-color,border-color,color] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60',
        className,
      )}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span className={`${icon} text-sm`} aria-hidden="true" />
    </button>
  );
}

export function WorkspaceResizeHandle({
  orientation,
  ariaLabel,
  onPointerDown,
  title,
  className,
  testId,
}: {
  orientation: 'horizontal' | 'vertical';
  ariaLabel: string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  title?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className={cx(
        'hidden shrink-0 items-center justify-center bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text-subtle)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60 lg:flex',
        orientation === 'vertical' ? 'cursor-col-resize' : 'cursor-row-resize',
        className,
      )}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      onPointerDown={onPointerDown}
    >
      <span
        className={orientation === 'vertical' ? 'h-12 w-px bg-current' : 'h-px w-12 bg-current'}
        aria-hidden="true"
      />
    </button>
  );
}

export function WorkspaceCollapsedPane({
  label,
  icon,
  onClick,
  orientation = 'horizontal',
  className,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cx(
        'flex min-h-0 min-w-0 items-center justify-between border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-left text-[var(--arena-terminal-text-secondary)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60',
        orientation === 'vertical' ? 'flex-col px-0 py-3' : 'px-3 py-0',
        className,
      )}
      onClick={onClick}
      aria-label={`Restore ${label}`}
    >
      <span className={`${icon} text-base`} aria-hidden="true" />
      <span
        className={cx(
          'font-display text-xs font-semibold uppercase tracking-[0.12em]',
          orientation === 'vertical' && '[writing-mode:vertical-rl]',
        )}
      >
        {label}
      </span>
      <span className="i-ph:arrows-out-simple text-base" aria-hidden="true" />
    </button>
  );
}
