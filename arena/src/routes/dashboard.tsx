import { useEffect, useState, useMemo, useCallback, useRef, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useAccount } from 'wagmi';
import { parseAbiItem } from 'viem';
import { Badge, Button, Card, CardContent, Skeleton, StaggerContainer, StaggerItem } from '@tangle-network/blueprint-ui/components';
import { toast } from 'sonner';
import {
  provisionsForOwner,
  getProvisionStructuralFingerprint,
  updateProvision,
  removeProvision,
  type TrackedProvision,
} from '~/lib/stores/provisions';
import { publicClient } from '@tangle-network/blueprint-ui';
import { addresses } from '~/lib/contracts/addresses';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { useUserServices } from '~/lib/hooks/useUserServices';
import { ServiceCard } from '~/components/home/ServiceCard';
import { HomeBotCard } from '~/components/home/HomeBotCard';
import { ProvisionsBanner } from '~/components/home/ProvisionsBanner';
import { SecretsModal, type SecretsTarget } from '~/components/home/SecretsModal';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import {
  doesProvisionLikelyReferToBot,
  partitionProvisionsForBots,
} from '~/lib/utils/botProvisionReconciliation';
import { isBotOwnedByWallet } from '~/lib/utils/botAccess';
import {
  ALL_TRADING_OPERATOR_API_URLS,
  getOperatorApiUrlForBlueprint,
  HAS_TRADING_OPERATOR_API,
} from '~/lib/operator/meta';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';

/**
 * Subscribe to provisions but only re-render when structural fields change
 * (phase, serviceId, vaultAddress, callId, bot/sandbox identity, id count).
 * Ignores progressDetail/progressPhase updates that the watcher emits every few seconds.
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
      const fp = getProvisionStructuralFingerprint(next);
      if (fp !== fingerprintRef.current) {
        fingerprintRef.current = fp;
        snapshotRef.current = next;
      }
      return snapshotRef.current;
    },
  );
}

export const meta: MetaFunction = () => [
  { title: 'My Agents — AI Trading Arena' },
];

export default function HomePage() {
  const { address: userAddress, isConnected } = useAccount();

  useTradingRouteAutoAuth({
    enabled: isConnected && HAS_TRADING_OPERATOR_API,
    routeKey: 'dashboard',
  });

  // Data sources
  const { services, isLoading: servicesLoading } = useUserServices(userAddress);
  const { bots: rawBots, isLoading: botsLoading, operatorDataState } = useBots();
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setEnrichmentEnabled(true), 900);
    return () => window.clearTimeout(timer);
  }, []);
  const bots = useBotEnrichment(rawBots, { enabled: enrichmentEnabled });

  const myProvisions = useStableProvisions(userAddress);
  const authoritativeBots = useMemo(
    () => bots.filter((bot) => bot.source === 'operator'),
    [bots],
  );
  const { unresolved: unmatchedProvisions } = useMemo(
    () => partitionProvisionsForBots(myProvisions, authoritativeBots),
    [authoritativeBots, myProvisions],
  );
  const lockedOperatorProvisions = useMemo(
    () => unmatchedProvisions.filter((provision) => provision.phase !== 'failed' && !!provision.botId),
    [unmatchedProvisions],
  );
  const unresolvedProvisions = useMemo(
    () => unmatchedProvisions.filter((provision) => provision.phase === 'failed' || !provision.botId),
    [unmatchedProvisions],
  );
  const operatorDataIncomplete = operatorDataState !== 'ready' && lockedOperatorProvisions.length > 0;
  const lockedBotsByService = useMemo(() => {
    const map = new Map<number, number>();
    for (const provision of lockedOperatorProvisions) {
      if (provision.serviceId == null) continue;
      map.set(provision.serviceId, (map.get(provision.serviceId) ?? 0) + 1);
    }
    return map;
  }, [lockedOperatorProvisions]);

  // State
  const [secretsTarget, setSecretsTarget] = useState<SecretsTarget | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  // Derived data
  // Main dashboard bots are strict-authoritative only.
  const myBots = useMemo(() => {
    return authoritativeBots.filter((b) => {
      if (b.status === 'archived') return false;
      return isBotOwnedByWallet(b, {
        walletAddress: userAddress,
        services,
        provisions: myProvisions,
      });
    });
  }, [authoritativeBots, myProvisions, services, userAddress]);
  const visibleMyBots = myBots;

  // Bots grouped by service
  const botsByService = useMemo(() => {
    const map = new Map<number, typeof bots>();
    for (const bot of authoritativeBots) {
      if (bot.status === 'archived') continue;
      const list = map.get(bot.serviceId) ?? [];
      list.push(bot);
      map.set(bot.serviceId, list);
    }
    return map;
  }, [authoritativeBots]);

  // Provision groups
  const inProgressProvisions = unresolvedProvisions.filter((p) =>
    ['pending_confirmation', 'job_submitted', 'job_processing', 'awaiting_secrets'].includes(p.phase),
  );
  const currentConcreteBots = bots;
  const failedProvisions = useMemo(
    () => unresolvedProvisions.filter(
      (provision) =>
        provision.phase === 'failed'
        && !currentConcreteBots.some((bot) => doesProvisionLikelyReferToBot(provision, bot)),
    ),
    [currentConcreteBots, unresolvedProvisions],
  );

  // Aggregate stats (use visible bots for display)
  const activeBots = visibleMyBots.filter((b) => b.status === 'active');
  const totalTvl = visibleMyBots.reduce((sum, b) => sum + b.tvl, 0);
  const totalTrades = visibleMyBots.reduce((sum, b) => sum + b.totalTrades, 0);
  const scoredBots = visibleMyBots.filter((bot) => bot.avgValidatorScore > 0);
  const avgRiskScore = scoredBots.length > 0
    ? Math.round(scoredBots.reduce((sum, b) => sum + b.avgValidatorScore, 0) / scoredBots.length)
    : 0;
  const knownBotCount = visibleMyBots.length;

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
        <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">My Agents</h1>
        <p className="text-base text-arena-elements-textSecondary mb-8">
          Owned services, deployed agents, and setup status.
        </p>
        <Card>
          <CardContent className="py-16 text-center space-y-3">
            <div className="i-ph:wallet text-4xl text-arena-elements-textTertiary mx-auto opacity-40" />
            <p className="text-sm text-arena-elements-textSecondary">
              Connect your wallet to see your services and agents.
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
        <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">My Agents</h1>
        <p className="text-base text-arena-elements-textSecondary mb-8">
          Owned services, deployed agents, and setup status.
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

  const hasLockedBots = lockedOperatorProvisions.length > 0 && operatorDataState !== 'ready';
  const hasBotSection = visibleMyBots.length > 0 || hasLockedBots;
  const hasContent = services.length > 0
    || hasBotSection
    || inProgressProvisions.length > 0
    || failedProvisions.length > 0;

  // ── Main content ───────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      <OperatorSessionBanner />
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">My Agents</h1>
          <p className="text-sm text-arena-elements-textSecondary">
            Owned services, deployed agents, and setup status.
          </p>
        </div>
        <Button asChild>
          <Link to="/provision">
            <span className="i-ph:plus-bold text-xs mr-1.5" />
            Deploy
          </Link>
        </Button>
      </div>

      {/* ── Stats bar ───────────────────────────────────────────────────── */}
      {hasContent && (
        <div className="grid grid-cols-2 gap-3 mb-8 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Services" value={services.length} />
          <StatTile label="Active Agents" value={operatorDataIncomplete ? '—' : activeBots.length} />
          <StatTile
            label="Total NAV"
            value={operatorDataIncomplete ? '—' : totalTvl}
            prefix="$"
            format={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(0)}
          />
          <StatTile label="Trades" value={operatorDataIncomplete ? '—' : totalTrades} className="hidden lg:block" />
          <StatTile
            label="Avg Validator"
            value={operatorDataIncomplete
              ? '—'
              : scoredBots.length > 0
                ? avgRiskScore
                : '—'}
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
            apiUrl: getOperatorApiUrlForBlueprint(prov.blueprintType),
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
                    lockedBotCount={lockedBotsByService.get(svc.serviceId) ?? 0}
                  />
                </StaggerItem>
              ))}
            </div>
          </StaggerContainer>
        </section>
      )}

      {/* ── My agents ───────────────────────────────────────────────────── */}
      {hasBotSection ? (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
              My Agents
            </h2>
            <Badge variant="secondary" className="text-[10px]">{knownBotCount}</Badge>
            {hasLockedBots && (
              <span className="text-xs font-data text-arena-elements-textTertiary ml-1">
                {lockedOperatorProvisions.length} require operator auth
              </span>
            )}
          </div>
          {visibleMyBots.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleMyBots.map((bot) => {
                const configureHandler = (bot.status === 'needs_config' || bot.lifecycleStatus === 'awaiting_secrets')
                  ? () => setSecretsTarget({
                      apiUrl: bot.operatorApiUrl ?? undefined,
                      botId: bot.id,
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
                  />
                );
              })}
            </div>
          ) : (
            <OperatorAccessCard
              apiUrls={ALL_TRADING_OPERATOR_API_URLS}
              title="Operator authentication required"
              description={`Authenticate to load ${lockedOperatorProvisions.length} operator-managed agent${lockedOperatorProvisions.length === 1 ? '' : 's'} on this dashboard.`}
            />
          )}
        </section>
      ) : !hasContent ? (
        <Card>
          <CardContent className="py-16 text-center space-y-4">
            <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mx-auto opacity-30" />
            <p className="text-base font-display font-medium text-arena-elements-textPrimary">
              No services or agents yet
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
  value: number | string;
  prefix?: string;
  suffix?: string;
  format?: (v: number) => string;
  valueColor?: string;
  className?: string;
}) {
  const display = typeof value === 'number'
    ? (format ? format(value) : String(value))
    : value;

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
