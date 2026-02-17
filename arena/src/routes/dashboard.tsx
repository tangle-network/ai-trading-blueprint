import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useAccount } from 'wagmi';
import { useStore } from '@nanostores/react';
import { parseAbiItem, zeroAddress } from 'viem';
import { Card, CardContent } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '~/components/ui/dialog';
import { toast } from 'sonner';
import {
  provisionsForOwner,
  updateProvision,
  removeProvision,
  type ProvisionPhase,
  type TrackedProvision,
} from '~/lib/stores/provisions';
import { publicClient, selectedChainIdStore } from '~/lib/contracts/publicClient';
import { addresses } from '~/lib/contracts/addresses';
import { networks } from '~/lib/contracts/chains';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

export const meta: MetaFunction = () => [
  { title: 'My Bots — AI Trading Arena' },
];

// ── Helpers ──────────────────────────────────────────────────────────────

const STRATEGY_NAMES: Record<string, string> = {
  dex: 'DEX Spot Trading',
  prediction: 'Prediction Markets',
  yield: 'Yield Optimization',
  perp: 'Perpetual Futures',
  volatility: 'Volatility Trading',
  mm: 'Market Making',
  multi: 'Cross-Strategy',
};

const STRATEGY_SHORT: Record<string, string> = {
  dex: 'DEX',
  prediction: 'Pred',
  yield: 'Yield',
  perp: 'Perps',
  volatility: 'Vol',
  mm: 'MM',
  multi: 'Multi',
};

function phaseLabel(phase: ProvisionPhase): string {
  switch (phase) {
    case 'pending_confirmation': return 'Confirming';
    case 'job_submitted': return 'Submitted';
    case 'job_processing': return 'Processing';
    case 'awaiting_secrets': return 'Needs Config';
    case 'active': return 'Active';
    case 'failed': return 'Failed';
  }
}

function phaseDescription(phase: ProvisionPhase, progressPhase?: string): string {
  switch (phase) {
    case 'pending_confirmation':
      return 'Waiting for your transaction to confirm on-chain.';
    case 'job_submitted':
      return 'Job confirmed. An operator is picking it up.';
    case 'job_processing':
      return progressPhaseLabel(progressPhase) ?? 'Operator is provisioning your agent.';
    case 'awaiting_secrets':
      return 'Infrastructure deployed. Configure your API keys to start trading.';
    case 'active':
      return 'Agent is running. Vault deployed on-chain.';
    case 'failed':
      return 'Provisioning failed.';
  }
}

const PROGRESS_LABELS: Record<string, string> = {
  queued: 'Preparing environment...',
  image_pull: 'Pulling container image...',
  container_create: 'Launching container...',
  container_start: 'Container ready, configuring...',
  health_check: 'Saving bot configuration...',
  ready: 'Submitting on-chain result...',
};

function progressPhaseLabel(phase?: string): string | undefined {
  if (!phase) return undefined;
  return PROGRESS_LABELS[phase];
}

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function explorerTxUrl(chainId: number, txHash: string): string | null {
  const net = networks[chainId];
  const base = net?.chain.blockExplorers?.default?.url;
  if (!base) return null;
  return `${base}/tx/${txHash}`;
}

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

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

function isStuck(prov: TrackedProvision): boolean {
  return prov.phase === 'job_submitted' && Date.now() - prov.updatedAt > STUCK_THRESHOLD_MS;
}

// ── Main Page ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { address: userAddress, isConnected } = useAccount();
  const selectedChainId = useStore(selectedChainIdStore);
  const ownerProvisions = useMemo(() => provisionsForOwner(userAddress), [userAddress]);
  const myProvisions = useStore(ownerProvisions);

  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [secretsModalProv, setSecretsModalProv] = useState<TrackedProvision | null>(null);

  // Split into groups
  const activeBots = myProvisions.filter((p) => p.phase === 'active');
  const awaitingSecretsBots = myProvisions.filter((p) => p.phase === 'awaiting_secrets');
  const pendingBots = myProvisions.filter((p) =>
    ['pending_confirmation', 'job_submitted', 'job_processing'].includes(p.phase),
  );
  const failedBots = myProvisions.filter((p) => p.phase === 'failed');

  const dismissProvision = useCallback((id: string) => {
    removeProvision(id);
    toast.info('Removed');
  }, []);

  const clearAllFailed = useCallback(() => {
    failedBots.forEach((p) => removeProvision(p.id));
    toast.info(`Cleared ${failedBots.length} failed`);
  }, [failedBots]);

  const checkStuckProvision = useCallback(async (prov: TrackedProvision) => {
    if (prov.callId == null || prov.serviceId == null) {
      toast.info('Missing call ID or service ID');
      return;
    }
    setCheckingId(prov.id);
    try {
      const logs = await publicClient.getLogs({
        address: addresses.tangle,
        event: parseAbiItem(
          'event JobResultSubmitted(uint64 indexed serviceId, uint64 indexed callId, address indexed operator, bytes output)',
        ),
        args: { callId: BigInt(prov.callId) },
        fromBlock: 0n,
      });
      if (logs.length > 0) {
        updateProvision(prov.id, { phase: 'active' });
        toast.success('Result found — bot is active!');
      } else {
        toast.info('No result yet — operator may still be processing');
      }
    } catch (err) {
      toast.error(`Check failed: ${err instanceof Error ? err.message.slice(0, 100) : 'Unknown error'}`);
    } finally {
      setCheckingId(null);
    }
  }, []);

  // ── Not connected ──────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6">
        <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">My Bots</h1>
        <p className="text-base text-arena-elements-textSecondary mb-8">
          Agents you've provisioned on the network.
        </p>
        <Card>
          <CardContent className="py-16 text-center space-y-2">
            <svg className="w-12 h-12 mx-auto text-arena-elements-textTertiary opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <p className="text-sm text-arena-elements-textSecondary">
              Connect your wallet to see your bots.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── No provisions ──────────────────────────────────────────────────────
  if (myProvisions.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6">
        <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">My Bots</h1>
        <p className="text-base text-arena-elements-textSecondary mb-8">
          Agents you've provisioned on the network.
        </p>
        <Card>
          <CardContent className="py-16 text-center space-y-4">
            <svg className="w-14 h-14 mx-auto text-arena-elements-textTertiary opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <p className="text-sm font-display font-medium text-arena-elements-textPrimary">
              No bots yet
            </p>
            <p className="text-sm text-arena-elements-textSecondary max-w-sm mx-auto">
              Deploy an autonomous trading agent and it will appear here.
            </p>
            <Button asChild className="mt-2">
              <Link to="/provision">Deploy your first agent</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Has provisions ─────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6">
      <div className="flex items-center justify-between mb-1.5">
        <h1 className="font-display font-bold text-3xl tracking-tight">My Bots</h1>
        <Button variant="outline" size="sm" asChild>
          <Link to="/provision">Deploy new</Link>
        </Button>
      </div>
      <p className="text-base text-arena-elements-textSecondary mb-6">
        {activeBots.length} active{awaitingSecretsBots.length > 0 ? `, ${awaitingSecretsBots.length} awaiting config` : ''}, {pendingBots.length} pending, {failedBots.length} failed
      </p>

      <div className="space-y-8">
        {/* ── Active Bots ─────────────────────────────────────────────── */}
        {activeBots.length > 0 && (
          <section>
            <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-3">
              Active
            </h2>
            <div className="grid gap-3">
              {activeBots.map((prov) => (
                <ActiveBotCard key={prov.id} prov={prov} />
              ))}
            </div>
          </section>
        )}

        {/* ── Awaiting Configuration ──────────────────────────────────── */}
        {awaitingSecretsBots.length > 0 && (
          <section>
            <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-3">
              Awaiting Configuration
            </h2>
            <div className="grid gap-3">
              {awaitingSecretsBots.map((prov) => (
                <AwaitingSecretsCard
                  key={prov.id}
                  prov={prov}
                  onConfigure={() => setSecretsModalProv(prov)}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Pending / In-Progress ───────────────────────────────────── */}
        {pendingBots.length > 0 && (
          <section>
            <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-3">
              In Progress
            </h2>
            <div className="grid gap-2">
              {pendingBots.map((prov) => (
                <PendingBotRow
                  key={prov.id}
                  prov={prov}
                  onDismiss={dismissProvision}
                  onCheckStatus={checkStuckProvision}
                  isChecking={checkingId === prov.id}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Failed ──────────────────────────────────────────────────── */}
        {failedBots.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
                Failed
              </h2>
              <button
                type="button"
                onClick={clearAllFailed}
                className="text-xs font-data text-arena-elements-textTertiary hover:text-crimson-400 transition-colors"
              >
                Clear all
              </button>
            </div>
            <div className="grid gap-2">
              {failedBots.map((prov) => (
                <FailedBotRow key={prov.id} prov={prov} onDismiss={dismissProvision} />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Secrets configuration modal */}
      <SecretsModal
        prov={secretsModalProv}
        onClose={() => setSecretsModalProv(null)}
      />
    </div>
  );
}

// ── Active Bot Card ──────────────────────────────────────────────────────

function ActiveBotCard({ prov }: { prov: TrackedProvision }) {
  const hasVault = prov.vaultAddress && prov.vaultAddress !== zeroAddress;

  return (
    <Card className="border-emerald-700/20 dark:border-emerald-500/20">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-700/10 dark:bg-emerald-500/10 flex items-center justify-center shrink-0">
            <span className="text-lg font-display font-bold text-arena-elements-icon-success">
              {STRATEGY_SHORT[prov.strategyType]?.[0] ?? 'A'}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-display font-semibold text-arena-elements-textPrimary truncate">
                {prov.name}
              </span>
              <Badge variant="success" className="text-[10px]">Active</Badge>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs font-data text-arena-elements-textTertiary">
              <span>{STRATEGY_NAMES[prov.strategyType] ?? prov.strategyType}</span>
              {prov.serviceId != null && (
                <>
                  <span className="text-arena-elements-borderColor">&middot;</span>
                  <span>Service #{prov.serviceId}</span>
                </>
              )}
              <span className="text-arena-elements-borderColor">&middot;</span>
              <span>{timeAgo(prov.updatedAt)}</span>
            </div>
          </div>
        </div>

        {/* Info chips */}
        <div className="flex flex-wrap gap-2">
          {hasVault && (
            <Link
              to={`/vault/${prov.vaultAddress}`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-data bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor/60 hover:border-violet-500/40 transition-colors"
            >
              <span className="text-arena-elements-textTertiary">Vault</span>
              <span className="text-violet-700 dark:text-violet-400 truncate max-w-[120px]">
                {prov.vaultAddress!.slice(0, 6)}...{prov.vaultAddress!.slice(-4)}
              </span>
            </Link>
          )}
          {prov.sandboxId && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-data bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor/60">
              <span className="text-arena-elements-textTertiary">Sandbox</span>
              <span className="text-arena-elements-textPrimary truncate max-w-[120px]">
                {prov.sandboxId}
              </span>
            </div>
          )}
          {prov.callId != null && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-data bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor/60">
              <span className="text-arena-elements-textTertiary">Call</span>
              <span className="text-arena-elements-textPrimary">#{prov.callId}</span>
            </div>
          )}
          {prov.txHash && (
            <TxHashChip txHash={prov.txHash} chainId={prov.chainId} />
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          {prov.serviceId != null && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/arena/bot/service-${prov.serviceId}-vault-0`}>Leaderboard</Link>
            </Button>
          )}
          {hasVault && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/vault/${prov.vaultAddress}`}>Manage Vault</Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Provision Progress Card ──────────────────────────────────────────────

const PROVISION_STEPS = [
  { key: 'queued', label: 'Init' },
  { key: 'container_create', label: 'Container' },
  { key: 'container_start', label: 'Ready' },
  { key: 'health_check', label: 'Config' },
  { key: 'ready', label: 'Submit' },
] as const;

function PendingBotRow({
  prov,
  onDismiss,
  onCheckStatus,
  isChecking,
}: {
  prov: TrackedProvision;
  onDismiss: (id: string) => void;
  onCheckStatus: (prov: TrackedProvision) => void;
  isChecking: boolean;
}) {
  const stuck = isStuck(prov);

  // Determine active step index from progressPhase
  const activeStepIdx = prov.progressPhase
    ? PROVISION_STEPS.findIndex((s) => s.key === prov.progressPhase)
    : -1;

  const isProcessing = prov.phase === 'job_submitted' || prov.phase === 'job_processing';

  return (
    <Card className="border-amber-500/20 bg-amber-500/5">
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-center gap-3 mb-3">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-display font-medium text-arena-elements-textPrimary truncate">
                {prov.name}
              </span>
              <Badge variant="amber" className="text-[10px]">
                {phaseLabel(prov.phase)}
              </Badge>
            </div>
          </div>
          <ElapsedTime since={prov.createdAt} />
          {stuck && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCheckStatus(prov)}
              disabled={isChecking}
              className="text-xs h-7 px-2"
            >
              {isChecking ? 'Checking...' : 'Check'}
            </Button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(prov.id)}
            className="text-arena-elements-textTertiary hover:text-crimson-400 transition-colors p-1 shrink-0"
            title="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step indicator */}
        {isProcessing && (
          <div className="mb-2">
            <div className="flex items-center gap-0">
              {PROVISION_STEPS.map((step, i) => {
                const isDone = activeStepIdx > i;
                const isActive = activeStepIdx === i;
                return (
                  <div key={step.key} className="flex items-center flex-1 last:flex-none">
                    {/* Dot */}
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-2.5 h-2.5 rounded-full transition-colors duration-500 ${
                          isDone
                            ? 'bg-arena-elements-icon-success'
                            : isActive
                              ? 'bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.4)]'
                              : 'bg-arena-elements-background-depth-3 border border-arena-elements-borderColor'
                        }`}
                      />
                      <span className={`text-[9px] font-data mt-1 ${
                        isDone
                          ? 'text-arena-elements-icon-success'
                          : isActive
                            ? 'text-amber-400'
                            : 'text-arena-elements-textTertiary'
                      }`}>
                        {step.label}
                      </span>
                    </div>
                    {/* Connecting line */}
                    {i < PROVISION_STEPS.length - 1 && (
                      <div className={`flex-1 h-px mx-1 transition-all duration-500 ${
                        isDone ? 'bg-arena-elements-icon-success' : 'bg-arena-elements-borderColor'
                      }`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Phase label with spinner */}
        <div className="flex items-center gap-2">
          {isProcessing && (
            <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin shrink-0" />
          )}
          <span className="text-xs font-data text-arena-elements-textTertiary transition-opacity duration-300">
            {isProcessing
              ? (prov.progressPhase
                  ? (PROGRESS_LABELS[prov.progressPhase] ?? prov.progressPhase)
                  : 'Waiting for operator...')
              : phaseDescription(prov.phase, prov.progressPhase)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Failed Bot Row ───────────────────────────────────────────────────────

function FailedBotRow({
  prov,
  onDismiss,
}: {
  prov: TrackedProvision;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-crimson-500/20 bg-crimson-500/5">
      <div className="w-2 h-2 rounded-full bg-crimson-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-display font-medium text-arena-elements-textPrimary truncate">
            {prov.name}
          </span>
          <span className="text-[11px] font-data text-arena-elements-textTertiary">
            {STRATEGY_NAMES[prov.strategyType] ?? prov.strategyType}
          </span>
        </div>
        {prov.errorMessage && (
          <p className="text-xs font-data text-crimson-400/80 mt-0.5 line-clamp-1">
            {prov.errorMessage}
          </p>
        )}
        {!prov.errorMessage && (
          <p className="text-xs font-data text-arena-elements-textTertiary mt-0.5">
            {timeAgo(prov.updatedAt)}
          </p>
        )}
      </div>
      <Button variant="outline" size="sm" asChild className="text-xs h-7 px-2 shrink-0">
        <Link to="/provision">Retry</Link>
      </Button>
      <button
        type="button"
        onClick={() => onDismiss(prov.id)}
        className="text-arena-elements-textTertiary hover:text-crimson-400 transition-colors p-1 shrink-0"
        title="Dismiss"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ── TX Hash Chip ─────────────────────────────────────────────────────────

function TxHashChip({ txHash, chainId }: { txHash: string; chainId: number }) {
  const url = explorerTxUrl(chainId, txHash);
  const display = `${txHash.slice(0, 6)}...${txHash.slice(-4)}`;

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-data bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor/60 hover:border-violet-500/40 transition-colors"
      >
        <span className="text-arena-elements-textTertiary">TX</span>
        <span className="text-violet-700 dark:text-violet-400">{display}</span>
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(txHash);
        toast.info('TX hash copied');
      }}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-data bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor/60 hover:border-arena-elements-borderColorActive/40 transition-colors"
      title="Click to copy"
    >
      <span className="text-arena-elements-textTertiary">TX</span>
      <span className="text-arena-elements-textPrimary">{display}</span>
    </button>
  );
}

// ── Awaiting Secrets Card ─────────────────────────────────────────────────

function AwaitingSecretsCard({
  prov,
  onConfigure,
}: {
  prov: TrackedProvision;
  onConfigure: () => void;
}) {
  const hasVault = prov.vaultAddress && prov.vaultAddress !== zeroAddress;

  return (
    <Card className="border-amber-500/20 dark:border-amber-400/20">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-display font-semibold text-arena-elements-textPrimary truncate">
                {prov.name}
              </span>
              <Badge variant="amber" className="text-[10px]">Needs Config</Badge>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs font-data text-arena-elements-textTertiary">
              <span>{STRATEGY_NAMES[prov.strategyType] ?? prov.strategyType}</span>
              <span className="text-arena-elements-borderColor">&middot;</span>
              <span>{timeAgo(prov.updatedAt)}</span>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-sm text-arena-elements-textSecondary">
          Infrastructure is deployed. Configure your API keys (e.g. AI provider key) to activate the trading agent.
        </div>

        <div className="flex flex-wrap gap-2">
          {hasVault && (
            <Link
              to={`/vault/${prov.vaultAddress}`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-data bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor/60 hover:border-violet-500/40 transition-colors"
            >
              <span className="text-arena-elements-textTertiary">Vault</span>
              <span className="text-violet-700 dark:text-violet-400 truncate max-w-[120px]">
                {prov.vaultAddress!.slice(0, 6)}...{prov.vaultAddress!.slice(-4)}
              </span>
            </Link>
          )}
          {prov.sandboxId && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-data bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor/60">
              <span className="text-arena-elements-textTertiary">Sandbox</span>
              <span className="text-arena-elements-textPrimary truncate max-w-[120px]">
                {prov.sandboxId}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={onConfigure} size="sm">
            Configure API Keys
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── AI Provider Config ────────────────────────────────────────────────────

const DEFAULT_AI_PROVIDER = import.meta.env.VITE_DEFAULT_AI_PROVIDER ?? '';
const DEFAULT_AI_API_KEY = import.meta.env.VITE_DEFAULT_AI_API_KEY ?? '';

type AiProvider = 'anthropic' | 'zai';

const AI_PROVIDERS: { id: AiProvider; label: string; placeholder: string; envKey: string; modelProvider: string; modelName: string }[] = [
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    placeholder: 'your-zai-api-key',
    envKey: 'ZAI_API_KEY',
    modelProvider: 'zai-coding-plan',
    modelName: 'glm-4.7',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-...',
    envKey: 'ANTHROPIC_API_KEY',
    modelProvider: 'anthropic',
    modelName: 'claude-sonnet-4-20250514',
  },
];

function buildEnvForProvider(provider: AiProvider, key: string): Record<string, string> {
  const config = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const env: Record<string, string> = {
    OPENCODE_MODEL_PROVIDER: config.modelProvider,
    OPENCODE_MODEL_NAME: config.modelName,
    OPENCODE_MODEL_API_KEY: key,
  };
  // Also set the provider-native key so inner session reads it
  env[config.envKey] = key;
  return env;
}

const ACTIVATION_LABELS: Record<string, string> = {
  validating: 'Loading bot configuration...',
  recreating_sidecar: 'Recreating container with secrets...',
  running_setup: 'Installing strategy dependencies...',
  creating_workflow: 'Configuring trading loop...',
  complete: 'Agent activated!',
};

// ── Secrets Modal ─────────────────────────────────────────────────────────

function SecretsModal({
  prov,
  onClose,
}: {
  prov: TrackedProvision | null;
  onClose: () => void;
}) {
  const defaultProvider = (DEFAULT_AI_PROVIDER === 'zai' ? 'zai' : 'anthropic') as AiProvider;
  const [provider, setProvider] = useState<AiProvider>(defaultProvider);
  const [apiKey, setApiKey] = useState(DEFAULT_AI_API_KEY);
  const [extraEnvs, setExtraEnvs] = useState<{ id: number; key: string; value: string }[]>([]);
  const envIdRef = useRef(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activationPhase, setActivationPhase] = useState<string | null>(null);
  const operatorAuth = useOperatorAuth(OPERATOR_API_URL);

  const providerConfig = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];

  // Look up bot ID lazily (resolved in handleSubmit to avoid fetch-in-effect)
  const [lookupError, setLookupError] = useState<string | null>(null);

  /** Resolve operator bot ID from the sandbox ID. Returns null if not found. */
  const resolveBotId = useCallback(async (sandboxId: string): Promise<string | null> => {
    if (!OPERATOR_API_URL) {
      setLookupError('Operator API URL not configured');
      return null;
    }
    try {
      const res = await fetch(`${OPERATOR_API_URL}/api/bots?limit=200`);
      if (!res.ok) {
        setLookupError('Failed to fetch bots from operator API');
        return null;
      }
      const data = await res.json();
      const match = data.bots?.find(
        (b: { sandbox_id: string }) => b.sandbox_id === sandboxId,
      );
      if (match) {
        setLookupError(null);
        return match.id as string;
      }
      setLookupError('Bot not found on operator. It may still be registering.');
      return null;
    } catch {
      setLookupError('Could not reach operator API');
      return null;
    }
  }, []);

  const handleSubmit = async () => {
    if (!prov || !apiKey.trim() || !prov.sandboxId) return;

    setIsSubmitting(true);
    setActivationPhase(null);
    setLookupError(null);

    // Resolve bot ID first
    const botId = await resolveBotId(prov.sandboxId);
    if (!botId) {
      setIsSubmitting(false);
      return;
    }

    // Start polling activation progress
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}/activation-progress`);
        if (res.ok) {
          const data = await res.json();
          setActivationPhase(data.phase ?? null);
        }
      } catch {
        // Ignore polling errors
      }
    }, 1000);

    try {
      // Build env_json from selected provider
      const envJson: Record<string, string> = buildEnvForProvider(provider, apiKey.trim());
      for (const e of extraEnvs) {
        if (e.key.trim() && e.value.trim()) {
          envJson[e.key.trim()] = e.value.trim();
        }
      }

      // Authenticate with operator API (challenge/response + PASETO token)
      let authToken = operatorAuth.token;
      if (!authToken) {
        authToken = await operatorAuth.authenticate();
        if (!authToken) throw new Error('Wallet authentication failed');
      }

      // POST to operator API with Bearer token
      const res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}/secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ env_json: envJson }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const result = await res.json();

      // Update provision store
      updateProvision(prov.id, {
        phase: 'active',
        workflowId: result.workflow_id,
        sandboxId: result.sandbox_id ?? prov.sandboxId,
      });

      toast.success('API keys configured — agent is now active!');
      setApiKey('');
      setExtraEnvs([]);
      onClose();
    } catch (err) {
      toast.error(
        `Configuration failed: ${err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'}`,
      );
    } finally {
      clearInterval(pollInterval);
      setIsSubmitting(false);
      setActivationPhase(null);
    }
  };

  return (
    <Dialog open={prov !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure API Keys</DialogTitle>
          <DialogDescription>
            Your agent infrastructure is ready. Provide your API keys to activate trading. Keys are sent directly to the operator over HTTPS — never stored on-chain.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {lookupError && (
            <div className="text-sm text-amber-500 p-2 rounded bg-amber-500/5 border border-amber-500/20">
              {lookupError}
            </div>
          )}

          {/* Provider selector */}
          <div role="group" aria-label="AI Provider">
            <span className="text-sm font-display font-medium text-arena-elements-textPrimary block mb-1.5">
              AI Provider
            </span>
            <div className="flex gap-2">
              {AI_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setProvider(p.id);
                    // Auto-fill key if switching to the default provider
                    if (p.id === defaultProvider && DEFAULT_AI_API_KEY) {
                      setApiKey(DEFAULT_AI_API_KEY);
                    } else {
                      setApiKey('');
                    }
                  }}
                  className={`flex-1 px-3 py-2 rounded-md text-sm font-data border transition-colors ${
                    provider === p.id
                      ? 'border-violet-500 bg-violet-500/10 text-arena-elements-textPrimary'
                      : 'border-arena-elements-borderColor bg-arena-elements-background-depth-3 text-arena-elements-textSecondary hover:border-arena-elements-borderColorActive'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-arena-elements-textTertiary mt-1">
              Model: {providerConfig.modelName}
            </p>
          </div>

          <div>
            <label htmlFor="secrets-api-key" className="text-sm font-display font-medium text-arena-elements-textPrimary block mb-1.5">
              API Key <span className="text-crimson-400">*</span>
            </label>
            <Input
              id="secrets-api-key"
              type="password"
              placeholder={providerConfig.placeholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            {apiKey && DEFAULT_AI_API_KEY && apiKey === DEFAULT_AI_API_KEY && (
              <p className="text-xs text-emerald-500 mt-1">
                Pre-filled from local config
              </p>
            )}
          </div>

          {/* Extra env vars */}
          {extraEnvs.map((env, i) => (
            <div key={env.id} className="flex gap-2">
              <Input
                placeholder="KEY"
                value={env.key}
                onChange={(e) => {
                  const updated = [...extraEnvs];
                  updated[i] = { ...env, key: e.target.value };
                  setExtraEnvs(updated);
                }}
                className="flex-1"
              />
              <Input
                type="password"
                placeholder="value"
                value={env.value}
                onChange={(e) => {
                  const updated = [...extraEnvs];
                  updated[i] = { ...env, value: e.target.value };
                  setExtraEnvs(updated);
                }}
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => setExtraEnvs(extraEnvs.filter((_, j) => j !== i))}
                className="text-arena-elements-textTertiary hover:text-crimson-400 transition-colors px-1"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              envIdRef.current += 1;
              setExtraEnvs([...extraEnvs, { id: envIdRef.current, key: '', value: '' }]);
            }}
            className="text-xs font-data text-violet-700 dark:text-violet-400 hover:underline"
          >
            + Add environment variable
          </button>

          {/* Activation progress */}
          {isSubmitting && activationPhase && (
            <div className="flex items-center gap-2 p-2 rounded bg-amber-500/5 border border-amber-500/20">
              <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin shrink-0" />
              <span className="text-xs font-data text-amber-300">
                {ACTIVATION_LABELS[activationPhase] ?? activationPhase}
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!apiKey.trim() || isSubmitting}
            >
              {isSubmitting ? 'Signing & Configuring...' : 'Sign & Configure'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
