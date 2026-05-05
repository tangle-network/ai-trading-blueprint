import { Input } from '@tangle-network/blueprint-ui/components';

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  timePeriod: string;
  onTimePeriodChange: (value: string) => void;
}

const timePeriods = [
  { label: '7D', value: '7d' },
  { label: '30D', value: '30d' },
  { label: 'All', value: 'all' },
];

export function FilterBar({ search, onSearchChange, timePeriod, onTimePeriodChange }: FilterBarProps) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-end gap-3.5 mb-6">
      <div className="flex-1 max-w-xl">
        <label
          htmlFor="bot-search"
          className="mb-2 block text-[11px] font-data font-semibold uppercase tracking-[0.22em] text-arena-elements-textTertiary"
        >
          Search
        </label>
        <div className="arena-control-shell relative rounded-xl px-1.5">
          <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 i-ph:magnifying-glass text-arena-elements-textTertiary text-sm" />
          <div className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 text-[10px] font-data uppercase tracking-[0.22em] text-arena-elements-textTertiary md:block">
            Bots / strategies
          </div>
        
        <Input
          id="bot-search"
          placeholder="Search bots or strategies..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="arena-control-input h-12 pl-11 pr-28 text-sm font-data text-arena-elements-textPrimary placeholder:text-arena-elements-textTertiary"
          aria-label="Search bots or strategies"
        />
        </div>
      </div>

      <div>
        <span className="mb-2 block text-[11px] font-data font-semibold uppercase tracking-[0.22em] text-arena-elements-textTertiary">
          Window
        </span>
        <div className="arena-control-shell flex items-center gap-1 rounded-xl p-1.5">
        {timePeriods.map((tp) => (
          <button
            key={tp.value}
            onClick={() => onTimePeriodChange(tp.value)}
            className={`px-3.5 py-2 text-sm font-data font-semibold uppercase tracking-[0.18em] rounded-lg transition-all duration-200 ${
              timePeriod === tp.value
                ? 'bg-violet-500/12 text-violet-700 dark:text-violet-400 shadow-[0_10px_26px_rgba(109,40,217,0.12)]'
                : 'text-arena-elements-textTertiary hover:text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover/70'
            }`}
          >
            {tp.label}
          </button>
        ))}
        </div>
      </div>
    </div>
  );
}
