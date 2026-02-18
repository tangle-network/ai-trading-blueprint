import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { Card, CardContent } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import type { TrackedProvision } from '~/lib/stores/provisions';
import {
  phaseLabel,
  PROVISION_STEPS,
  PROGRESS_LABELS,
  STRATEGY_NAMES,
  isStuck,
  timeAgo,
} from '~/lib/format';

function ElapsedTime({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - since) / 1000)), 1000);
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

export function ProvisionsBanner({
  provisions,
  failedProvisions,
  onConfigure,
  onDismiss,
  onCheckStatus,
  onClearFailed,
  checkingId,
}: {
  provisions: TrackedProvision[];
  failedProvisions: TrackedProvision[];
  onConfigure: (prov: TrackedProvision) => void;
  onDismiss: (id: string) => void;
  onCheckStatus: (prov: TrackedProvision) => void;
  onClearFailed: () => void;
  checkingId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const total = provisions.length + failedProvisions.length;
  if (total === 0) return null;

  // Separate awaiting secrets from truly in-progress
  const awaitingSecrets = provisions.filter((p) => p.phase === 'awaiting_secrets');
  const inProgress = provisions.filter((p) =>
    ['pending_confirmation', 'job_submitted', 'job_processing'].includes(p.phase),
  );

  return (
    <div className="mb-8">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 mb-3 group"
      >
        <div className={`i-ph:caret-right text-sm text-arena-elements-textTertiary transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary group-hover:text-arena-elements-textPrimary transition-colors">
          Provisioning
        </h2>
        <Badge variant="secondary" className="text-[10px]">{total}</Badge>
      </button>

      {!collapsed && (
        <div className="space-y-2">
          {/* Awaiting secrets */}
          {awaitingSecrets.map((prov) => (
            <Card key={prov.id} className="border-amber-500/20">
              <CardContent className="p-3 flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-display font-medium truncate">{prov.name}</span>
                    <Badge variant="amber" className="text-[10px]">Needs Config</Badge>
                  </div>
                  <span className="text-xs font-data text-arena-elements-textTertiary">
                    {STRATEGY_NAMES[prov.strategyType] ?? prov.strategyType}
                  </span>
                </div>
                <Button size="sm" onClick={() => onConfigure(prov)} className="text-xs h-7 px-3 shrink-0">
                  Configure
                </Button>
              </CardContent>
            </Card>
          ))}

          {/* In progress */}
          {inProgress.map((prov) => {
            const stuck = isStuck(prov.updatedAt, prov.phase);
            const isProcessing = prov.phase === 'job_submitted' || prov.phase === 'job_processing';
            const activeStepIdx = prov.progressPhase
              ? PROVISION_STEPS.findIndex((s) => s.key === prov.progressPhase)
              : -1;

            return (
              <Card key={prov.id} className="border-arena-elements-borderColor/40">
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-display font-medium truncate">{prov.name}</span>
                        <Badge variant="amber" className="text-[10px]">{phaseLabel(prov.phase)}</Badge>
                      </div>
                    </div>
                    <ElapsedTime since={prov.createdAt} />
                    {stuck && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onCheckStatus(prov)}
                        disabled={checkingId === prov.id}
                        className="text-xs h-7 px-2"
                      >
                        {checkingId === prov.id ? '...' : 'Check'}
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDismiss(prov.id)}
                      className="text-arena-elements-textTertiary hover:text-crimson-400 transition-colors p-1 shrink-0"
                    >
                      <div className="i-ph:x text-sm" />
                    </button>
                  </div>

                  {/* Step indicator */}
                  {isProcessing && (
                    <div className="mt-2 flex items-center gap-0">
                      {PROVISION_STEPS.map((step, i) => {
                        const isDone = activeStepIdx > i;
                        const isActive = activeStepIdx === i;
                        return (
                          <div key={step.key} className="flex items-center flex-1 last:flex-none">
                            <div className="flex flex-col items-center">
                              <div
                                className={`w-2 h-2 rounded-full transition-colors duration-500 ${
                                  isDone
                                    ? 'bg-arena-elements-icon-success'
                                    : isActive
                                      ? 'bg-amber-400 animate-pulse'
                                      : 'bg-arena-elements-background-depth-3 border border-arena-elements-borderColor'
                                }`}
                              />
                              <span className={`text-[8px] font-data mt-0.5 ${
                                isDone ? 'text-arena-elements-icon-success' : isActive ? 'text-amber-400' : 'text-arena-elements-textTertiary'
                              }`}>
                                {step.label}
                              </span>
                            </div>
                            {i < PROVISION_STEPS.length - 1 && (
                              <div className={`flex-1 h-px mx-0.5 ${isDone ? 'bg-arena-elements-icon-success' : 'bg-arena-elements-borderColor'}`} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {isProcessing && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="w-2.5 h-2.5 rounded-full border-[1.5px] border-amber-400 border-t-transparent animate-spin shrink-0" />
                      <span className="text-[11px] font-data text-arena-elements-textTertiary">
                        {prov.progressPhase
                          ? (PROGRESS_LABELS[prov.progressPhase] ?? prov.progressPhase)
                          : 'Waiting for operator...'}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* Failed */}
          {failedProvisions.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-data uppercase tracking-wider text-crimson-400/70">
                  Failed ({failedProvisions.length})
                </span>
                <button
                  type="button"
                  onClick={onClearFailed}
                  className="text-[11px] font-data text-arena-elements-textTertiary hover:text-crimson-400 transition-colors"
                >
                  Clear all
                </button>
              </div>
              {failedProvisions.map((prov) => (
                <div key={prov.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-crimson-500/15 bg-crimson-500/5">
                  <div className="w-1.5 h-1.5 rounded-full bg-crimson-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-display font-medium truncate block">{prov.name}</span>
                    {prov.errorMessage && (
                      <span className="text-[11px] font-data text-crimson-400/70 line-clamp-1">{prov.errorMessage}</span>
                    )}
                  </div>
                  <Button variant="outline" size="sm" asChild className="text-[11px] h-6 px-2 shrink-0">
                    <Link to="/provision">Retry</Link>
                  </Button>
                  <button
                    type="button"
                    onClick={() => onDismiss(prov.id)}
                    className="text-arena-elements-textTertiary hover:text-crimson-400 transition-colors p-0.5 shrink-0"
                  >
                    <div className="i-ph:x text-xs" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
