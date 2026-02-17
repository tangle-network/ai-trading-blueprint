import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useAccount } from 'wagmi';
import { useStore } from '@nanostores/react';
import { parseAbiItem, zeroAddress } from 'viem';
import { Card, CardContent } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
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
    case 'active':
      return 'Agent is running. Vault deployed on-chain.';
    case 'failed':
      return 'Provisioning failed.';
  }
}

const PROGRESS_LABELS: Record<string, string> = {
  initializing: 'Preparing environment...',
  creating_sidecar: 'Launching container...',
  running_setup: 'Installing strategy dependencies...',
  creating_workflow: 'Configuring trading loop...',
  storing_record: 'Saving bot configuration...',
  complete: 'Submitting on-chain result...',
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

  // Split into groups
  const activeBots = myProvisions.filter((p) => p.phase === 'active');
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
        {activeBots.length} active, {pendingBots.length} pending, {failedBots.length} failed
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

// ── Pending Bot Row ──────────────────────────────────────────────────────

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

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-500/20 bg-amber-500/5">
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
        <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5">
          {phaseDescription(prov.phase, prov.progressPhase)}
        </div>
        {(prov.phase === 'job_submitted' || prov.phase === 'job_processing') && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
            <span className="text-xs font-data text-amber-300">
              {prov.progressPhase
                ? (PROGRESS_LABELS[prov.progressPhase] ?? prov.progressPhase)
                : 'Waiting for operator...'}
            </span>
          </div>
        )}
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
