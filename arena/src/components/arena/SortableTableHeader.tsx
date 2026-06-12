import type { ReactNode } from 'react';

/**
 * Neutralizes @tangle/blueprint-ui Table rounding/chrome so tables sit flush
 * inside the arena terminal panels. Single source for every arena table —
 * apply to both the scroll container and the `Table` element.
 */
export const SQUARE_TABLE_CLASS = 'rounded-none [&_[data-slot=table-container]]:!rounded-none [&_[data-slot=table-container]]:!border-0 [&_[data-slot=table-container]]:!bg-transparent [&_[data-slot=table-container]]:!shadow-none [&_.relative.overflow-auto]:!rounded-none [&_table]:!rounded-none [&_thead]:!rounded-none [&_tbody]:!rounded-none [&_tr]:!rounded-none [&_th]:!rounded-none [&_td]:!rounded-none';

export type SortDirection = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

export function nextSortState<K extends string>(
  current: SortState<K>,
  key: K,
  defaultDirection: SortDirection = 'desc',
): SortState<K> {
  if (current.key !== key) return { key, direction: defaultDirection };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

export function applySortDirection(value: number, direction: SortDirection): number {
  return direction === 'asc' ? value : -value;
}

export function compareStringValue(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? '').localeCompare(right ?? '', undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function compareNumberValue(left: number | null | undefined, right: number | null | undefined): number {
  const leftValue = Number.isFinite(left) ? Number(left) : Number.NEGATIVE_INFINITY;
  const rightValue = Number.isFinite(right) ? Number(right) : Number.NEGATIVE_INFINITY;
  return leftValue - rightValue;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function SortableHeaderButton<K extends string>({
  sortKey,
  sort,
  onSort,
  children,
  align = 'left',
  defaultDirection = 'desc',
  className,
}: {
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K, defaultDirection?: SortDirection) => void;
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  defaultDirection?: SortDirection;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const icon = !active
    ? 'i-ph:caret-up-down'
    : sort.direction === 'asc'
      ? 'i-ph:caret-up-bold'
      : 'i-ph:caret-down-bold';

  return (
    <button
      type="button"
      className={cx(
        'arena-sort-header-button group',
        align === 'right' && 'justify-end text-right',
        align === 'center' && 'justify-center text-center',
        className,
      )}
      aria-pressed={active}
      onClick={() => onSort(sortKey, defaultDirection)}
    >
      <span className="truncate">{children}</span>
      <span className={cx(icon, active ? 'opacity-100' : 'opacity-45 group-hover:opacity-80')} aria-hidden="true" />
    </button>
  );
}

export function StaticTableHeaderLabel({
  children,
  align = 'left',
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <span
      className={cx(
        'arena-table-header-label',
        align === 'right' && 'justify-end text-right',
        align === 'center' && 'justify-center text-center',
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}
