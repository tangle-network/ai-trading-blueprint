import { useState, useEffect } from 'react';

// ── Timeline Stage Component ────────────────────────────────────────────

export function TimelineStage({
  label,
  description,
  status,
  isFirst,
  isLast,
}: {
  label: string;
  description: string;
  status: 'pending' | 'active' | 'done' | 'error';
  isFirst?: boolean;
  isLast?: boolean;
}) {
  return (
    <div className={`relative flex gap-3 ${isFirst ? '' : 'mt-5'} ${isLast ? '' : 'pb-0'}`}>
      {/* Node dot — positioned over the connecting line */}
      <div
        className={`absolute -left-6 top-[2px] z-10 flex items-center justify-center w-[17px] h-[17px] rounded-full border-2 transition-all duration-500 ${
          status === 'done'
            ? 'bg-emerald-400 border-emerald-400 shadow-[0_0_12px_rgba(0,255,136,0.3)]'
            : status === 'active'
              ? 'bg-amber-400 border-amber-400 shadow-[0_0_12px_rgba(255,184,0,0.4),0_0_24px_rgba(255,184,0,0.15)]'
              : status === 'error'
                ? 'bg-crimson-400 border-crimson-400 shadow-[0_0_10px_rgba(255,59,92,0.3)]'
                : 'bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border-arena-elements-borderColor'
        }`}
      >
        {status === 'done' && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
        {status === 'active' && (
          <>
            <div className="w-1.5 h-1.5 rounded-full bg-white" />
            {/* Pulsing ring */}
            <div className="absolute inset-0 rounded-full border-2 border-amber-400/50 animate-ping" />
          </>
        )}
        {status === 'error' && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm font-display font-semibold transition-colors duration-300 ${
            status === 'done'
              ? 'text-emerald-400'
              : status === 'active'
                ? 'text-amber-400'
                : status === 'error'
                  ? 'text-crimson-400'
                  : 'text-arena-elements-textTertiary'
          }`}
        >
          {label}
        </div>
        <div
          className={`text-xs font-data leading-relaxed mt-0.5 transition-all duration-300 ${
            status === 'active'
              ? 'text-arena-elements-textSecondary opacity-100'
              : status === 'done'
                ? 'text-arena-elements-textTertiary opacity-70'
                : 'text-arena-elements-textTertiary opacity-50'
          }`}
        >
          {description}
        </div>
      </div>
    </div>
  );
}

// ── Elapsed Time Counter ────────────────────────────────────────────────

export function ElapsedTime({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - since) / 1000)));
  useEffect(() => {
    setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    const interval = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000))), 1000);
    return () => clearInterval(interval);
  }, [since]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <span className="text-xs font-data text-arena-elements-textTertiary tabular-nums">
      {mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`}
    </span>
  );
}
