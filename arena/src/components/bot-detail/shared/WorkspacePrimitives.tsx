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
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-display font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60',
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
            <span>{item.label}</span>
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
        'min-w-[78px] rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/62 px-2 py-1.5 md:min-w-[86px]',
        className,
      )}
    >
      <div className="truncate font-data text-[10px] font-semibold uppercase text-arena-elements-textTertiary">
        {label}
      </div>
      <div className={cx('mt-0.5 truncate font-data text-sm font-bold text-arena-elements-textPrimary', valueClassName)}>
        {value}
      </div>
    </div>
  );
}
