import { Card, CardContent } from '@tangle-network/blueprint-ui/components';
import type { TradingBlueprintDef } from '~/lib/blueprints';
import { instanceFraming } from '~/lib/blueprints/framing';

interface BlueprintSelectorProps {
  blueprints: TradingBlueprintDef[];
  selected: string | null;
  onSelect: (id: string) => void;
}

const colorClasses: Record<string, { border: string; bg: string; icon: string }> = {
  violet: {
    border: 'border-violet-500/50',
    bg: 'bg-violet-500/5',
    icon: 'text-violet-500',
  },
  teal: {
    border: 'border-teal-500/50',
    bg: 'bg-teal-500/5',
    icon: 'text-teal-500',
  },
  blue: {
    border: 'border-blue-500/50',
    bg: 'bg-blue-500/5',
    icon: 'text-blue-500',
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Where your bot runs">
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
            className="text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
          >
            <Card
              className={`relative overflow-hidden cursor-pointer hover:shadow-md motion-safe:transition-all motion-safe:duration-200 ${
                isSelected
                  ? `${colors.border} ${colors.bg} ring-2 ring-offset-1 ring-offset-arena-elements-bg ring-current shadow-lg`
                  : 'border-arena-elements-borderColor hover:border-arena-elements-textTertiary'
              }`}
            >
              <CardContent className="p-5">
                <div className="flex items-start gap-3 mb-3">
                  <div className={`${bp.icon} ${colors.icon} text-2xl shrink-0 mt-0.5`} />
                  <div className="min-w-0">
                    <h3 className="font-display font-bold text-base leading-tight">
                      {framing.label}
                    </h3>
                    {/* Technical blueprint name stays available, demoted. */}
                    <div className="mt-1 font-data text-xs text-arena-elements-textTertiary">
                      {bp.name}
                    </div>
                  </div>
                </div>

                <p className="text-sm text-arena-elements-textSecondary leading-relaxed">
                  {framing.summary}
                </p>

                {isSelected && (
                  <div className="absolute top-3 right-3">
                    <div className={`w-5 h-5 rounded-full ${colors.icon} bg-current/15 flex items-center justify-center`}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </button>
        );
      })}
    </div>
  );
}
