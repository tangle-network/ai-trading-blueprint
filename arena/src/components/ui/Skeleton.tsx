interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse bg-[var(--arena-terminal-surface)] ${className ?? ''}`}
    />
  );
}

export function SkeletonCard({ className }: SkeletonProps) {
  return (
    <div className={`border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-3 ${className ?? ''}`}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="mt-3 h-3 w-full" />
      <Skeleton className="mt-3 h-3 w-2/3" />
    </div>
  );
}

export function SkeletonTableRow({ cols = 8 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}
