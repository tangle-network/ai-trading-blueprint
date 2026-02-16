import { Input } from '~/components/ui/input';

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
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-6">
      <div className="relative flex-1 max-w-xs">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 i-ph:magnifying-glass text-arena-elements-textTertiary text-sm" />
        <Input
          placeholder="Search bots or strategies..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex items-center gap-0.5 glass-card rounded-lg p-1">
        {timePeriods.map((tp) => (
          <button
            key={tp.value}
            onClick={() => onTimePeriodChange(tp.value)}
            className={`px-3 py-1.5 text-xs font-data font-semibold uppercase tracking-wider rounded-md transition-all duration-200 ${
              timePeriod === tp.value
                ? 'bg-emerald-500/10 text-emerald-400 shadow-[0_0_10px_rgba(0,255,136,0.08)]'
                : 'text-arena-elements-textTertiary hover:text-arena-elements-textSecondary'
            }`}
          >
            {tp.label}
          </button>
        ))}
      </div>
    </div>
  );
}
