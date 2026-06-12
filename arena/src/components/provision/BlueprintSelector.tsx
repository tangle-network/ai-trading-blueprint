import type { TradingBlueprintDef } from '~/lib/blueprints';
import { instanceFraming } from '~/lib/blueprints/framing';

interface BlueprintSelectorProps {
  blueprints: TradingBlueprintDef[];
  selected: string | null;
  onSelect: (id: string) => void;
}

const colorClasses: Record<string, { accent: string; soft: string }> = {
  violet: {
    accent: 'text-[#b99cff]',
    soft: 'bg-[#7c5cff]/10',
  },
  teal: {
    accent: 'text-[#50d2c1]',
    soft: 'bg-[#50d2c1]/10',
  },
  blue: {
    accent: 'text-[#7db7ff]',
    soft: 'bg-[#2f86ff]/10',
  },
};

export function BlueprintSelector({ blueprints, selected, onSelect }: BlueprintSelectorProps) {
  if (blueprints.length === 0) {
    return (
      <div className="text-center py-12 text-arena-elements-textTertiary">
        No blueprints configured. Set VITE_BLUEPRINT_ID, VITE_INSTANCE_BLUEPRINT_ID, or VITE_TEE_BLUEPRINT_ID in .env.
      </div>
    );
  }

  return (
    <div
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      role="radiogroup"
      aria-label="Where your bot runs"
    >
      {blueprints.map((bp) => {
        const isSelected = selected === bp.id;
        const colors = colorClasses[bp.color] ?? colorClasses.violet;
        const framing = instanceFraming(bp);

        return (
          <button
            key={bp.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(bp.id)}
            className={[
              'group relative min-h-[164px] w-full border bg-[var(--arena-terminal-panel)] p-4 text-left transition-[background-color,border-color,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]',
              isSelected
                ? 'border-[var(--arena-terminal-accent)] bg-[color-mix(in_srgb,var(--arena-terminal-accent)_8%,var(--arena-terminal-panel))]'
                : 'border-[var(--arena-terminal-border)] hover:border-[color-mix(in_srgb,var(--arena-terminal-accent)_44%,var(--arena-terminal-border))] hover:bg-[var(--arena-terminal-panel-strong)]',
            ].join(' ')}
          >
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--arena-terminal-border)] ${colors.soft}`}>
                    <span className={`${bp.icon} ${colors.accent} text-lg`} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-display text-base font-semibold leading-tight text-[var(--arena-terminal-text)]">
                      {framing.label}
                    </h3>
                    <div className="mt-1 truncate font-data text-xs text-[var(--arena-terminal-text-subtle)]">
                      {bp.name}
                    </div>
                  </div>
                </div>

                <span
                  className={[
                    'flex h-5 w-5 shrink-0 items-center justify-center border text-xs transition-colors',
                    isSelected
                      ? 'border-[var(--arena-terminal-accent)] bg-[var(--arena-terminal-accent)] text-[var(--arena-terminal-accent-text)]'
                      : 'border-[var(--arena-terminal-border)] text-transparent group-hover:text-[var(--arena-terminal-muted)]',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  <span className="i-ph:check text-sm" />
                </span>
              </div>

              <p className="text-sm leading-relaxed text-[var(--arena-terminal-muted)]">
                {framing.summary}
              </p>

              <div className="mt-auto flex items-center justify-between gap-3 font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                <span>Blueprint #{bp.blueprintId}</span>
                <span>{bp.isTee ? 'TEE' : bp.isFleet ? 'Shared' : 'Dedicated'}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
