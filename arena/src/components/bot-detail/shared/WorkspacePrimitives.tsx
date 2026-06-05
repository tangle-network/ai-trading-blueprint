import type { ReactNode } from 'react';
import { Link } from 'react-router';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export interface WorkspaceNavItem<Value extends string> {
  value: Value;
  label: string;
  icon: string;
  badge?: ReactNode;
}

interface WorkspaceNavStripProps<Value extends string> {
  items: Array<WorkspaceNavItem<Value>>;
  activeValue: Value;
  onSelect?: (value: Value) => void;
  getHref?: (value: Value) => string;
  getState?: (value: Value) => unknown;
  ariaLabel: string;
  className?: string;
  buttonClassName?: string;
  itemClassName?: string;
  iconOnly?: boolean;
}

export function WorkspaceNavStrip<Value extends string>({
  items,
  activeValue,
  onSelect,
  getHref,
  getState,
  ariaLabel,
  className,
  buttonClassName,
  itemClassName,
  iconOnly = false,
}: WorkspaceNavStripProps<Value>) {
  return (
    <nav
      className={cx(
        'flex max-w-full gap-1 overflow-x-auto rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/58 p-1',
        className,
      )}
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const selected = item.value === activeValue;
        const itemClass = cx(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-display font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 lg:h-9 lg:px-3 lg:text-[15px]',
          selected
            ? 'bg-violet-500/14 text-arena-elements-textPrimary'
            : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary',
          buttonClassName,
          itemClassName,
        );
        const content = (
          <>
            <span
              className={cx(
                item.icon,
                'text-base',
                selected
                  ? 'text-violet-500 dark:text-violet-300'
                  : 'text-arena-elements-textTertiary',
              )}
              aria-hidden="true"
            />
            <span className={iconOnly ? 'sr-only' : undefined}>{item.label}</span>
            {item.badge}
          </>
        );
        const href = getHref?.(item.value);

        return href ? (
          <Link
            key={item.value}
            to={href}
            state={getState?.(item.value)}
            aria-current={selected ? 'page' : undefined}
            aria-label={iconOnly ? item.label : undefined}
            title={iconOnly ? item.label : undefined}
            className={itemClass}
            onClick={() => onSelect?.(item.value)}
          >
            {content}
          </Link>
        ) : (
          <button
            key={item.value}
            type="button"
            onClick={() => onSelect?.(item.value)}
            aria-current={selected ? 'page' : undefined}
            aria-label={iconOnly ? item.label : undefined}
            title={iconOnly ? item.label : undefined}
            className={itemClass}
          >
            {content}
          </button>
        );
      })}
    </nav>
  );
}

interface WorkspaceMetricProps {
  label: string;
  value: string;
  valueClassName?: string;
  className?: string;
}

export function WorkspaceMetric({
  label,
  value,
  valueClassName,
  className,
}: WorkspaceMetricProps) {
  return (
    <div
      className={cx(
        'min-w-[86px] rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/62 px-2.5 py-2 md:min-w-[96px]',
        className,
      )}
    >
      <div className="truncate font-data text-[11px] font-semibold uppercase text-arena-elements-textTertiary md:text-xs">
        {label}
      </div>
      <div className={cx('mt-0.5 truncate font-data text-base font-bold text-arena-elements-textPrimary md:text-lg', valueClassName)}>
        {value}
      </div>
    </div>
  );
}

interface TerminalEmptyStateProps {
  title: string;
  description?: string;
  icon?: string;
  className?: string;
  compact?: boolean;
  children?: ReactNode;
}

export function TerminalEmptyState({
  title,
  description,
  icon = 'i-ph:terminal-window',
  className,
  compact = false,
  children,
}: TerminalEmptyStateProps) {
  return (
    <section
      className={cx(
        'flex h-full min-h-[320px] flex-col items-center justify-center rounded-[7px] border border-[#273035] bg-[#081013] px-6 text-center text-[#f6fefd]',
        compact ? 'py-8' : 'py-12',
        className,
      )}
      aria-label={title}
    >
      <span
        className={cx(
          icon,
          'mb-3 inline-flex h-10 w-10 items-center justify-center rounded-[5px] border border-[#273035] bg-[#0f1a1f] text-xl text-[#50d2c1]',
        )}
        aria-hidden="true"
      />
      <h3 className="max-w-xl text-balance font-display text-lg font-semibold text-[#f6fefd]">
        {title}
      </h3>
      {description && (
        <p className="mt-2 max-w-xl text-pretty font-mono text-sm leading-6 text-[#949e9c]">
          {description}
        </p>
      )}
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}
