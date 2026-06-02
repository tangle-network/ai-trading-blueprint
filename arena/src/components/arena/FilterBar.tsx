import { Input } from '@tangle-network/blueprint-ui/components';

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
}

export function FilterBar({ search, onSearchChange }: FilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
      <div className="relative flex-1 min-w-[260px] max-w-sm">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 i-ph:magnifying-glass text-arena-elements-textTertiary text-sm" />
        <Input
          placeholder="Search agents, strategies, or addresses..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
          aria-label="Search agents, strategies, or addresses"
        />
      </div>
    </div>
  );
}
