import { useEffect, useState, useMemo, useCallback, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import type { MetaFunction } from 'react-router';
import { useAccount } from 'wagmi';
import { parseAbiItem } from 'viem';
import { Badge, StaggerContainer, StaggerItem } from '@tangle-network/blueprint-ui/components';
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
import { ArenaHeaderLink, ArenaPageHeader, type ArenaPageMetric } from '~/components/arena/ArenaPageHeader';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import {
  doesProvisionLikelyReferToBot,
  partitionProvisionsForBots,
} from '~/lib/utils/botProvisionReconciliation';
import { isBotInWalletWorkspace } from '~/lib/utils/botAccess';
import {
  ALL_TRADING_OPERATOR_API_URLS,
  getOperatorApiUrlForBlueprint,
  HAS_TRADING_OPERATOR_API,
} from '~/lib/operator/meta';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePanePercent,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';

interface DashboardWorkspaceLayout {
  servicesPercent: number;
  servicesCollapsed: boolean;
}

const DASHBOARD_WORKSPACE_LAYOUT_KEY = 'arena:dashboard-workspace-layout';
const DEFAULT_DASHBOARD_WORKSPACE_LAYOUT: DashboardWorkspaceLayout = {
  servicesPercent: 34,
  servicesCollapsed: false,
};

function normalizeDashboardWorkspaceLayout(value: Partial<DashboardWorkspaceLayout>): DashboardWorkspaceLayout {
  return {
    servicesPercent: clampNumber(
      Number(value.servicesPercent) || DEFAULT_DASHBOARD_WORKSPACE_LAYOUT.servicesPercent,
      22,
      58,
    ),
    servicesCollapsed: value.servicesCollapsed === true,
  };
}

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
  { title: 'My Agents — Tangle Trading' },
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
  const dashboardWorkspaceRef = useRef<HTMLDivElement>(null);
  const [dashboardLayout, setDashboardLayout] = usePersistentWorkspaceLayout(
    DASHBOARD_WORKSPACE_LAYOUT_KEY,
    DEFAULT_DASHBOARD_WORKSPACE_LAYOUT,
    normalizeDashboardWorkspaceLayout,
  );

  // Derived data
  // Main dashboard bots are strict-authoritative only.
  const myBots = useMemo(() => {
    return authoritativeBots.filter((b) => {
      if (b.status === 'archived') return false;
      return isBotInWalletWorkspace(b, {
        walletAddress: userAddress,
        services,
        provisions: myProvisions,
      });
    });
  }, [authoritativeBots, myProvisions, services, userAddress]);
  const visibleMyBots = myBots;

  // Bots grouped by service
  const myBotsByService = useMemo(() => {
    const map = new Map<number, typeof visibleMyBots>();
    for (const bot of visibleMyBots) {
      const list = map.get(bot.serviceId) ?? [];
      list.push(bot);
      map.set(bot.serviceId, list);
    }
    return map;
  }, [visibleMyBots]);

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
      <ConnectWalletPanel
        title="Connect owner wallet"
        description="Connect to load owner services, vaults, secrets, and operator agents."
        bullets={[
          'Owned service instances',
          'Operator-managed agents',
          'Vault and secret status',
        ]}
      />
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────
  if (isLoading && services.length === 0 && visibleMyBots.length === 0) {
    return (
      <div className="arena-trace-terminal min-h-full bg-[#081013] text-[#f6fefd]">
        <div className="flex w-full flex-col">
          <ArenaPageHeader
            title="My Agents"
            metrics={[
              { label: 'Services', value: 'Sync' },
              { label: 'Agents', value: 'Sync' },
              { label: 'Operator', value: 'Auth' },
            ]}
            controls={<DashboardHeaderControls />}
          />
          <section className="overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
            <div className="border-b border-[var(--arena-terminal-border)] px-3 py-2 font-data text-[11px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
              Loading owner workspace
            </div>
            <div className="grid gap-3 p-3 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-36 animate-pulse border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]" />
              ))}
            </div>
          </section>
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
  const dashboardMetrics: ArenaPageMetric[] = [
    { label: 'Services', value: String(services.length) },
    { label: 'Active Agents', value: operatorDataIncomplete ? '-' : String(activeBots.length) },
    {
      label: 'NAV',
      value: operatorDataIncomplete
        ? '-'
        : totalTvl >= 1000
          ? `$${(totalTvl / 1000).toFixed(1)}K`
          : `$${totalTvl.toFixed(0)}`,
    },
    { label: 'Trades', value: operatorDataIncomplete ? '-' : String(totalTrades) },
    {
      label: 'Validator',
      value: operatorDataIncomplete
        ? '-'
        : scoredBots.length > 0
          ? String(avgRiskScore)
      : '-',
    },
  ];
  const servicesSection = services.length > 0 ? (
    <section className="flex min-h-0 flex-col overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--arena-terminal-border)] px-3 py-2">
        <h2 className="text-sm font-data uppercase tracking-wider text-[var(--arena-terminal-text-secondary)]">
          Services
        </h2>
        <Badge variant="secondary" className="text-[10px]">{services.length}</Badge>
        <WorkspaceControlButton
          label={dashboardLayout.servicesCollapsed ? 'Restore services' : 'Minimize services'}
          icon={dashboardLayout.servicesCollapsed ? 'i-ph:arrows-out-line-vertical' : 'i-ph:minus-bold'}
          className="ml-auto"
          onClick={() => setDashboardLayout((current) => ({
            ...current,
            servicesCollapsed: !current.servicesCollapsed,
          }))}
        />
      </div>
      <div className="min-h-0 overflow-auto p-3 [scrollbar-gutter:stable]">
        <StaggerContainer>
          <div className="space-y-2">
            {services.map((svc) => (
              <StaggerItem key={svc.serviceId}>
                <ServiceCard
                  service={svc}
                  bots={myBotsByService.get(svc.serviceId) ?? []}
                  lockedBotCount={lockedBotsByService.get(svc.serviceId) ?? 0}
                />
              </StaggerItem>
            ))}
          </div>
        </StaggerContainer>
      </div>
    </section>
  ) : null;
  const myAgentsSection = hasBotSection ? (
    <section className="flex min-h-0 flex-col overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--arena-terminal-border)] px-3 py-2">
        <h2 className="text-sm font-data uppercase tracking-wider text-[var(--arena-terminal-text-secondary)]">
          My Agents
        </h2>
        <Badge variant="secondary" className="text-[10px]">{knownBotCount}</Badge>
        {hasLockedBots && (
          <span className="text-xs font-data text-[var(--arena-terminal-text-muted)]">
            {lockedOperatorProvisions.length} require operator auth
          </span>
        )}
      </div>
      {visibleMyBots.length > 0 ? (
        <div className="min-h-0 overflow-auto p-3 [scrollbar-gutter:stable]">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
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
        </div>
      ) : (
        <div className="p-3">
          <OperatorAccessCard
            apiUrls={ALL_TRADING_OPERATOR_API_URLS}
            title="Operator authentication required"
            description={`Authenticate to load ${lockedOperatorProvisions.length} operator-managed agent${lockedOperatorProvisions.length === 1 ? '' : 's'} on this dashboard.`}
          />
        </div>
      )}
    </section>
  ) : null;
  const emptySection = !hasContent ? (
    <section className="grid gap-3 overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-3 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[5px] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]">
            <span className="i-ph:robot text-xl" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-display text-lg font-semibold text-[var(--arena-terminal-text)]">
              No services or agents yet
            </h2>
            <p className="mt-1 text-sm text-[var(--arena-terminal-text-muted)]">
              Start with a paper agent, then activate the runtime once the mandate is ready for operator-managed execution.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <ArenaHeaderLink to="/provision" icon="i-ph:rocket-launch" variant="primary">
            Activate Agent
          </ArenaHeaderLink>
          <ArenaHeaderLink to="/create" icon="i-ph:chat-circle-dots">
            New Agent
          </ArenaHeaderLink>
        </div>
      </div>
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
        {[
          ['01', 'Service owner', 'wallet'],
          ['02', 'Risk envelope', 'required'],
          ['03', 'Secrets', 'operator'],
          ['04', 'Workspace', 'agent'],
        ].map(([index, label, value]) => (
          <div key={index} className="grid grid-cols-[2rem_minmax(0,1fr)_5.5rem] border-b border-[var(--arena-terminal-border)] px-3 py-2.5 last:border-b-0">
            <span className="font-data text-xs text-[var(--arena-terminal-accent)]">{index}</span>
            <span className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{label}</span>
            <span className="truncate text-right font-data text-xs uppercase text-[var(--arena-terminal-text-muted)]">{value}</span>
          </div>
        ))}
      </div>
    </section>
  ) : null;
  const hasDashboardSplit = Boolean(servicesSection && myAgentsSection);
  const dashboardWorkspaceStyle = dashboardLayout.servicesCollapsed
    ? {
        gridTemplateRows: '44px 8px minmax(0,1fr)',
      }
    : {
        gridTemplateRows: `minmax(140px, ${dashboardLayout.servicesPercent}fr) 8px minmax(260px, ${100 - dashboardLayout.servicesPercent}fr)`,
      };
  const startDashboardWorkspaceResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = dashboardWorkspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setDashboardLayout((current) => ({ ...current, servicesCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'row-resize',
      onMove: (moveEvent) => {
        const rawPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
        if (shouldCollapsePanePercent(rawPercent)) {
          setDashboardLayout((current) => ({
            ...current,
            servicesCollapsed: true,
          }));
          return;
        }
        const nextPercent = clampNumber(rawPercent, 22, 58);
        setDashboardLayout((current) => ({
          ...current,
          servicesPercent: nextPercent,
          servicesCollapsed: false,
        }));
      },
    });
  };

  // ── Main content ───────────────────────────────────────────────────────
  return (
    <div className="arena-trace-terminal min-h-full bg-[#081013] text-[#f6fefd] lg:h-full lg:overflow-hidden">
      <div className="flex w-full flex-col lg:h-full lg:min-h-0">
        <ArenaPageHeader
          title="My Agents"
          metrics={dashboardMetrics}
          metricsClassName="grid-cols-3 min-[980px]:grid-cols-5 min-[1180px]:w-[31rem] min-[1180px]:shrink-0"
          titleWidthClassName="min-[1180px]:w-44"
          controls={<DashboardHeaderControls />}
        />

        <OperatorSessionBanner />

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

      {hasDashboardSplit ? (
        <div
          ref={dashboardWorkspaceRef}
          className="grid min-h-0 flex-1 gap-0 overflow-hidden"
          style={dashboardWorkspaceStyle as CSSProperties}
          aria-label="Owner workspace"
        >
          {dashboardLayout.servicesCollapsed ? (
            <WorkspaceCollapsedPane
              label="Services"
              icon="i-ph:stack"
              className="row-start-1"
              onClick={() => setDashboardLayout((current) => ({ ...current, servicesCollapsed: false }))}
            />
          ) : (
            <div className="row-start-1 min-h-0 overflow-hidden">
              {servicesSection}
            </div>
          )}
          <WorkspaceResizeHandle
            orientation="horizontal"
            className="row-start-2"
            ariaLabel="Resize services and agents"
            title="Drag to resize services and agents"
            onPointerDown={startDashboardWorkspaceResize}
          />
          <div className="row-start-3 min-h-0 overflow-hidden">
            {myAgentsSection}
          </div>
        </div>
      ) : (
        <>
          {servicesSection}
          {myAgentsSection ?? emptySection}
        </>
      )}

      {/* Secrets configuration modal */}
      <SecretsModal
        target={secretsTarget}
        onClose={() => setSecretsTarget(null)}
      />
      </div>
    </div>
  );
}

function DashboardHeaderControls() {
  return (
    <>
      <ArenaHeaderLink to="/create" icon="i-ph:chat-circle-dots">
        New Agent
      </ArenaHeaderLink>
      <ArenaHeaderLink to="/provision" icon="i-ph:rocket-launch" variant="primary">
        Activate
      </ArenaHeaderLink>
    </>
  );
}
