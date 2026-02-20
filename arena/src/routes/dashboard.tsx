import { useState, useMemo, useCallback, useRef, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useAccount } from 'wagmi';
import { parseAbiItem } from 'viem';
import { Badge, Button, Card, CardContent, Skeleton, StaggerContainer, StaggerItem } from '@tangle/blueprint-ui/components';
import { toast } from 'sonner';
import {
  provisionsForOwner,
  updateProvision,
  removeProvision,
  type TrackedProvision,
} from '~/lib/stores/provisions';
import { publicClient } from '@tangle/blueprint-ui';
import { addresses } from '~/lib/contracts/addresses';
import { useStore } from '@nanostores/react';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { useUserServices } from '~/lib/hooks/useUserServices';
import { dismissedBotsStore, dismissBot } from '~/lib/stores/dismissedBots';
import { AnimatedNumber } from '~/components/motion/AnimatedNumber';
import { ServiceCard } from '~/components/home/ServiceCard';
import { HomeBotCard } from '~/components/home/HomeBotCard';
import { ProvisionsBanner } from '~/components/home/ProvisionsBanner';
import { SecretsModal, type SecretsTarget } from '~/components/home/SecretsModal';

/**
 * Subscribe to provisions but only re-render when structural fields change
 * (phase, serviceId, vaultAddress, callId, id count). Ignores progressDetail/progressPhase
 * updates that the watcher emits every few seconds.
 */
function useStableProvisions(userAddress: string | undefined): TrackedProvision[] {
  const storeRef = useRef(provisionsForOwner(userAddress as any));
  const snapshotRef = useRef<TrackedProvision[]>([]);
  const fingerprintRef = useRef('');

  // Update computed store ref when address changes
  if (userAddress) {
    storeRef.current = provisionsForOwner(userAddress as any);
  }

  return useSyncExternalStore(
    (cb) => storeRef.current.subscribe(cb),
    (): TrackedProvision[] => {
      const next = storeRef.current.get() as TrackedProvision[];
      // Fingerprint: only fields that affect dashboard layout
      const fp = next.map((p: TrackedProvision) => `${p.id}|${p.phase}|${p.serviceId}|${p.vaultAddress}|${p.callId}|${p.progressPhase}`).join(';');
      if (fp !== fingerprintRef.current) {
        fingerprintRef.current = fp;
        snapshotRef.current = next;
      }
      return snapshotRef.current;
    },
  );
}

export const meta: MetaFunction = () => [
  { title: 'Home — AI Trading Arena' },
];

export default function HomePage() {
  const { address: userAddress, isConnected } = useAccount();

  // Data sources
  const { services, isLoading: servicesLoading } = useUserServices(userAddress);
  const { bots: rawBots, isLoading: botsLoading } = useBots();
  const bots = useBotEnrichment(rawBots);

  const myProvisions = useStableProvisions(userAddress);

  // State
  const [secretsTarget, setSecretsTarget] = useState<SecretsTarget | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  // Derived data
  const myServiceIds = useMemo(() => {
    const ids = new Set(services.map((s) => s.serviceId));
    // Also include service IDs from provisions (catches newly created services)
    for (const p of myProvisions) {
      if (p.serviceId != null) ids.add(p.serviceId);
    }
    return ids;
  }, [services, myProvisions]);

  // Bots the user has actually provisioned or that are confirmed active.
  // Excludes on-chain-only bots that were never provisioned by anyone.
  const myBots = useMemo(() => {
    const provVaults = new Set(
      myProvisions
        .filter((p) => p.vaultAddress)
        .map((p) => p.vaultAddress!.toLowerCase()),
    );
    const provIds = new Set(myProvisions.map((p) => p.id));

    return bots.filter((b) => {
      // Provision-derived bots (directly from provisions store)
      if (b.id.startsWith('provision:') && provIds.has(b.id.slice('provision:'.length))) return true;
      // Bot vault matches a user provision
      if (provVaults.has(b.vaultAddress.toLowerCase())) return true;
      // Bot belongs to one of the user's services
      if (myServiceIds.has(b.serviceId)) return true;
      return false;
    });
  }, [bots, myServiceIds, myProvisions]);

  // Filter out dismissed bots from user's view
  const dismissedBots = useStore(dismissedBotsStore);
  const dismissedSet = useMemo(() => new Set(dismissedBots), [dismissedBots]);
  const visibleMyBots = useMemo(
    () => myBots.filter((b) => !dismissedSet.has(b.id)),
    [myBots, dismissedSet],
  );

  // Bots grouped by service
  const botsByService = useMemo(() => {
    const map = new Map<number, typeof bots>();
    for (const bot of bots) {
      const list = map.get(bot.serviceId) ?? [];
      list.push(bot);
      map.set(bot.serviceId, list);
    }
    return map;
  }, [bots]);

  // Provision groups
  const inProgressProvisions = myProvisions.filter((p) =>
    ['pending_confirmation', 'job_submitted', 'job_processing', 'awaiting_secrets'].includes(p.phase),
  );
  const failedProvisions = myProvisions.filter((p) => p.phase === 'failed');

  // Match awaiting-secrets provisions to bots for the configure button
  const awaitingSecretsForBot = useMemo(() => {
    const map = new Map<string, TrackedProvision>();
    for (const prov of myProvisions) {
      if (prov.phase !== 'awaiting_secrets') continue;
      if (prov.vaultAddress) {
        map.set(prov.vaultAddress.toLowerCase(), prov);
      }
    }
    return map;
  }, [myProvisions]);

  // Aggregate stats (use visible bots for display)
  const activeBots = visibleMyBots.filter((b) => b.status === 'active');
  const pendingBots = visibleMyBots.filter((b) => b.status === 'needs_config');
  const totalTvl = visibleMyBots.reduce((sum, b) => sum + b.tvl, 0);
  const totalPnl = visibleMyBots.reduce((sum, b) => sum + b.pnlAbsolute, 0);
  const totalPnlPct = visibleMyBots.reduce((sum, b) => sum + b.pnlPercent, 0);
  const totalTrades = visibleMyBots.reduce((sum, b) => sum + b.totalTrades, 0);

  // Handlers
  const dismissProvision = useCallback((id: string) => {
    removeProvision(id);
    toast.info('Removed');
  }, []);

  const clearAllFailed = useCallback(() => {
    failedProvisions.forEach((p) => removeProvision(p.id));
    toast.info(`Cleared ${failedProvisions.length} failed`);
  }, [failedProvisions]);

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

  const isLoading = servicesLoading || botsLoading;

  // ── Not connected ──────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">Home</h1>
        <p className="text-base text-arena-elements-textSecondary mb-8">
          Your services and trading agents.
        </p>
        <Card>
          <CardContent className="py-16 text-center space-y-3">
            <div className="i-ph:wallet text-4xl text-arena-elements-textTertiary mx-auto opacity-40" />
            <p className="text-sm text-arena-elements-textSecondary">
              Connect your wallet to see your services and bots.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────
  if (isLoading && services.length === 0 && visibleMyBots.length === 0) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">Home</h1>
        <p className="text-base text-arena-elements-textSecondary mb-8">
          Your services and trading agents.
        </p>
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </div>
    );
  }

  const hasContent = services.length > 0 || visibleMyBots.length > 0 || inProgressProvisions.length > 0;

  // ── Main content ───────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">Home</h1>
          <p className="text-sm text-arena-elements-textSecondary">
            Your services and trading agents.
          </p>
        </div>
        <Button asChild>
          <Link to="/provision">
            <span className="i-ph:plus-bold text-xs mr-1.5" />
            Deploy Agent
          </Link>
        </Button>
      </div>

      {/* ── Stats bar ───────────────────────────────────────────────────── */}
      {hasContent && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-8">
          <StatTile label="Services" value={services.length} />
          <StatTile label="Active Bots" value={activeBots.length} />
          <StatTile
            label="Total TVL"
            value={totalTvl}
            prefix="$"
            format={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(0)}
          />
          <StatTile
            label="Total PnL"
            value={totalPnlPct}
            suffix="%"
            format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`}
            valueColor={totalPnlPct >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'}
          />
          <StatTile label="Trades" value={totalTrades} className="hidden lg:block" />
          <StatTile
            label="Avg Score"
            value={visibleMyBots.length > 0 ? Math.round(visibleMyBots.reduce((s, b) => s + b.avgValidatorScore, 0) / visibleMyBots.length) : 0}
            className="hidden lg:block"
          />
        </div>
      )}

      {/* ── Provisions banner ───────────────────────────────────────────── */}
      {(inProgressProvisions.length > 0 || failedProvisions.length > 0) && (
        <ProvisionsBanner
          provisions={inProgressProvisions}
          failedProvisions={failedProvisions}
          onConfigure={(prov) => setSecretsTarget({
            sandboxId: prov.sandboxId,
            callId: prov.callId,
            serviceId: prov.serviceId,
            provisionId: prov.id,
          })}
          onDismiss={dismissProvision}
          onCheckStatus={checkStuckProvision}
          onClearFailed={clearAllFailed}
          checkingId={checkingId}
        />
      )}

      {/* ── Services ────────────────────────────────────────────────────── */}
      {services.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
              Services
            </h2>
            <Badge variant="secondary" className="text-[10px]">{services.length}</Badge>
          </div>
          <StaggerContainer>
            <div className="space-y-2">
              {services.map((svc) => (
                <StaggerItem key={svc.serviceId}>
                  <ServiceCard
                    service={svc}
                    bots={botsByService.get(svc.serviceId) ?? []}
                  />
                </StaggerItem>
              ))}
            </div>
          </StaggerContainer>
        </section>
      )}

      {/* ── My Bots ─────────────────────────────────────────────────────── */}
      {visibleMyBots.length > 0 ? (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
              My Bots
            </h2>
            <Badge variant="secondary" className="text-[10px]">{visibleMyBots.length}</Badge>
            {pendingBots.length > 0 && (
              <button
                onClick={() => { pendingBots.forEach((b) => dismissBot(b.id)); toast.info(`Cleared ${pendingBots.length} pending`); }}
                className="ml-auto text-xs font-data text-arena-elements-textTertiary hover:text-crimson-400 transition-colors"
              >
                Clear pending ({pendingBots.length})
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleMyBots.map((bot) => {
              const matchingProv = awaitingSecretsForBot.get(bot.vaultAddress.toLowerCase());
              // Configure button: prefer provision-backed target, fall back to bot identifiers
              const configureHandler = matchingProv
                ? () => setSecretsTarget({
                    sandboxId: matchingProv.sandboxId,
                    callId: matchingProv.callId ?? bot.callId,
                    serviceId: matchingProv.serviceId ?? bot.serviceId,
                    provisionId: matchingProv.id,
                  })
                : bot.status === 'needs_config'
                  ? () => setSecretsTarget({
                      sandboxId: bot.sandboxId,
                      callId: bot.callId,
                      serviceId: bot.serviceId,
                    })
                  : undefined;
              return (
                <HomeBotCard
                  key={bot.id}
                  bot={bot}
                  onConfigure={configureHandler}
                  onDismiss={() => { dismissBot(bot.id); toast.info('Dismissed'); }}
                />
              );
            })}
          </div>
        </section>
      ) : !hasContent ? (
        <Card>
          <CardContent className="py-16 text-center space-y-4">
            <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mx-auto opacity-30" />
            <p className="text-base font-display font-medium text-arena-elements-textPrimary">
              No services or bots yet
            </p>
            <p className="text-sm text-arena-elements-textSecondary max-w-sm mx-auto">
              Deploy an autonomous trading agent to get started.
            </p>
            <Button asChild className="mt-2">
              <Link to="/provision">Deploy your first agent</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Secrets configuration modal */}
      <SecretsModal
        target={secretsTarget}
        onClose={() => setSecretsTarget(null)}
      />
    </div>
  );
}

// ── Stat Tile ──────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  prefix,
  suffix,
  format,
  valueColor,
  className,
}: {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  format?: (v: number) => string;
  valueColor?: string;
  className?: string;
}) {
  const display = format ? format(value) : String(value);

  return (
    <div className={`glass-card rounded-lg px-4 py-3 ${className ?? ''}`}>
      <p className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
        {label}
      </p>
      <p className={`text-lg font-data font-bold ${valueColor ?? 'text-arena-elements-textPrimary'}`}>
        {prefix}{display}{suffix}
      </p>
    </div>
  );
}
