import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router';

export interface ArenaPageMetric {
  label: string;
  value: string;
  title?: string;
}

interface ArenaPageHeaderProps {
  title: string;
  badge?: ReactNode;
  metrics: ArenaPageMetric[];
  children?: ReactNode;
  controls?: ReactNode;
  titleWidthClassName?: string;
  metricsClassName?: string;
}

export const ArenaHeaderUtilitiesContext = createContext<ReactNode>(null);

export function ArenaHeaderMetric({ value, label, title }: ArenaPageMetric) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate font-data text-sm font-bold leading-none text-[var(--arena-terminal-text)]">
        {value}
      </div>
      <div className="mt-0.5 truncate font-data text-[10px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
        {label}
      </div>
    </div>
  );
}

export function ArenaHeaderLink({
  to,
  icon,
  children,
  variant = 'secondary',
}: {
  to: string;
  icon: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  const variantClassName = variant === 'primary'
    ? 'arena-command-link-primary'
    : 'arena-command-link-secondary';

  return (
    <Link
      to={to}
      className={`inline-flex h-9 w-fit items-center gap-2 rounded-[5px] border px-3 text-sm font-display font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${variantClassName}`}
    >
      <span className={`${icon} text-sm`} aria-hidden="true" />
      {children}
    </Link>
  );
}

export function ArenaPageHeader({
  title,
  badge,
  metrics,
  children,
  controls,
  titleWidthClassName = 'min-[1180px]:w-40',
  metricsClassName = 'grid-cols-3 min-[1180px]:w-[17rem] min-[1180px]:shrink-0',
}: ArenaPageHeaderProps) {
  const utilities = useContext(ArenaHeaderUtilitiesContext);

  return (
    <section className="shrink-0 overflow-hidden rounded-[6px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <div className="flex min-h-12 flex-col gap-2 px-3 py-2 min-[1180px]:flex-row min-[1180px]:items-center">
        <div className={`flex min-w-0 items-center gap-3 ${titleWidthClassName}`}>
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-[var(--arena-terminal-accent)]"
          style={{ boxShadow: '0 0 16px color-mix(in srgb, var(--arena-terminal-accent) 48%, transparent)' }}
          aria-hidden="true"
        />
          <h1 className="truncate font-display text-xl font-semibold tracking-tight text-[var(--arena-terminal-text)]">
            {title}
          </h1>
          {badge}
        </div>

        <div className={`grid min-w-0 gap-3 ${metricsClassName}`}>
          {metrics.map((metric) => (
            <ArenaHeaderMetric key={metric.label} {...metric} />
          ))}
        </div>

        {children && (
          <div className="min-w-0 flex-1">
            {children}
          </div>
        )}

        <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 min-[1180px]:ml-auto min-[1180px]:w-auto">
          {controls}
          {utilities}
        </div>
      </div>
    </section>
  );
}
