import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useStore } from '@nanostores/react';
import { useAccount } from 'wagmi';
import { selectedChainIdStore } from '@tangle-network/blueprint-ui';
import { Button } from '@tangle-network/blueprint-ui/components';
import { useBots } from '~/lib/hooks/useBots';
import {
  AgentWorkspaceShell,
  type AgentWorkspaceNavItem,
  type AgentWorkspaceSection,
} from '~/components/bot-detail/AgentWorkspaceShell';
import type { OperationsPanel } from '~/components/bot-detail/OperationsWorkspace';
import { usePendingValidationCount } from '~/components/bot-detail/usePendingValidationCount';
import { SecretsModal, type SecretsTarget } from '~/components/home/SecretsModal';
import { ErrorBoundary } from '~/components/ErrorBoundary';
import { EnvelopeNeededBanner } from '~/components/bot-detail/EnvelopeNeededBanner';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { useRouteOperatorAutoAuth } from '~/lib/hooks/useRouteOperatorAutoAuth';
import { useOperatorSyncScope } from '~/lib/hooks/useOperatorSyncScope';
import {
  INSTANCE_OPERATOR_API_URL,
  OPERATOR_API_URL,
  getOperatorApiUrlForBlueprint,
  getOperatorKindForBlueprint,
  useOperatorMeta,
} from '~/lib/operator/meta';
import { isLiveBotStatus } from '~/lib/format';
import {
  provisionsForOwner,
  type TrackedProvision,
} from '~/lib/stores/provisions';
import type { Bot } from '~/lib/types/bot';
import {
  buildOperatorDetailFallbackBot,
  buildInstanceFallbackBot,
  findMatchingInstanceRouteProvision,
} from '~/lib/utils/instanceBotRoute';
import { resolveBotDisplayName } from '~/lib/utils/botNames';
import { getBotStrategyChainId } from '~/lib/utils/botStrategy';
import { tokenMetadataFromStrategyConfig } from '~/lib/assetUniverse';
import { networks } from '~/lib/contracts/chains';
import { isBotCommandableByWallet } from '~/lib/utils/botAccess';

export const meta: MetaFunction = () => [{ title: 'Agent | Tangle Trading' }];

const PerformanceTab = lazy(() =>
  import('~/components/bot-detail/PerformanceTab').then((module) => ({
    default: module.PerformanceTab,
  })));
const PortfolioWorkspace = lazy(() =>
  import('~/components/bot-detail/PortfolioWorkspace').then((module) => ({
    default: module.PortfolioWorkspace,
  })));
const RunsTab = lazy(() =>
  import('~/components/bot-detail/RunsTab').then((module) => ({
    default: module.RunsTab,
  })));
const ChatTab = lazy(() =>
  import('~/components/bot-detail/ChatTab').then((module) => ({
    default: module.ChatTab,
  })));
const OperationsWorkspace = lazy(() =>
  import('~/components/bot-detail/OperationsWorkspace').then((module) => ({
    default: module.OperationsWorkspace,
  })));

const WORKSPACE_SECTIONS: readonly AgentWorkspaceSection[] = [
  'performance',
  'portfolio',
  'runs',
  'chat',
  'operations',
];

interface AgentRouteState {
  agentBackHref?: string;
}

function isWorkspaceSection(value: string | null | undefined): value is AgentWorkspaceSection {
  return !!value && WORKSPACE_SECTIONS.includes(value as AgentWorkspaceSection);
}

function sectionFromPathname(pathname: string): AgentWorkspaceSection | null {
  const finalSegment = pathname.split('/').filter(Boolean).at(-1);
  return isWorkspaceSection(finalSegment) ? finalSegment : null;
}

function sectionFromLegacyTab(tab: string | null): AgentWorkspaceSection | null {
  switch (tab) {
    case 'performance':
      return 'performance';
    case 'positions':
    case 'trades':
      return 'portfolio';
    case 'runs':
      return 'runs';
    case 'chat':
      return 'chat';
    case 'reasoning':
    case 'arena':
    case 'terminal':
    case 'vault':
    case 'secrets':
    case 'envelope':
    case 'controls':
      return 'operations';
    default:
      return null;
  }
}

function operationPanelFromLegacyTab(tab: string | null): OperationsPanel | null {
  switch (tab) {
    case 'reasoning':
      return 'validation';
    case 'arena':
      return 'revisions';
    case 'terminal':
      return 'terminal';
    case 'vault':
      return 'vault';
    case 'secrets':
      return 'secrets';
    case 'envelope':
      return 'envelope';
    case 'controls':
      return 'controls';
    default:
      return null;
  }
}

function isOperationsPanel(value: string | null | undefined): value is OperationsPanel {
  return value === 'overview'
    || value === 'validation'
    || value === 'revisions'
    || value === 'controls'
    || value === 'envelope'
    || value === 'secrets'
    || value === 'vault'
    || value === 'terminal';
}

function buildSectionUrl(id: string, section: AgentWorkspaceSection, panel?: OperationsPanel | null): string {
  const path = `/arena/bot/${encodeURIComponent(id)}/${section}`;
  return section === 'operations' && panel ? `${path}?panel=${panel}` : path;
}

function readAgentBackHref(state: unknown, id: string): string | null {
  if (state == null || typeof state !== 'object') return null;
  const href = (state as AgentRouteState).agentBackHref;
  if (typeof href !== 'string') return null;
  const expectedPrefix = `/arena/bot/${encodeURIComponent(id)}/`;
  return href.startsWith(expectedPrefix) ? href : null;
}

function WorkspaceLoading() {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/42">
      <div className="text-center">
        <div className="i-ph:spinner-gap text-2xl text-arena-elements-textTertiary mx-auto animate-spin" />
        <div className="mt-3 font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
          Loading workspace
        </div>
      </div>
    </div>
  );
}

export default function BotDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const routeSection = sectionFromPathname(location.pathname);
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const legacyTab = searchParams.get('tab');
  const legacySection = sectionFromLegacyTab(legacyTab);
  const activeSection: AgentWorkspaceSection = routeSection ?? legacySection ?? 'performance';
  const panelParam = searchParams.get('panel');
  const requestedOperationsPanel = isOperationsPanel(panelParam)
    ? panelParam
    : operationPanelFromLegacyTab(legacyTab);
  const { address, isConnected } = useAccount();
  const { bots, isLoading } = useBots();
  const [secretsTarget, setSecretsTarget] = useState<SecretsTarget | null>(null);
  const myProvisions = useStore(
    provisionsForOwner(address),
  ) as TrackedProvision[];

  useEffect(() => {
    if (!id) return;
    if (legacySection) {
      navigate(buildSectionUrl(id, legacySection, requestedOperationsPanel), { replace: true });
      return;
    }
    if (!routeSection) {
      navigate(buildSectionUrl(id, 'performance'), { replace: true });
    }
  }, [id, legacySection, navigate, requestedOperationsPanel, routeSection]);

  const matchingProvision = useMemo(() => {
    return findMatchingInstanceRouteProvision(myProvisions, id);
  }, [id, myProvisions]);

  const fallbackOperatorKind = matchingProvision?.blueprintType
    ? getOperatorKindForBlueprint(matchingProvision.blueprintType)
    : matchingProvision
      ? 'instance'
      : null;
  const fallbackOperatorApiUrl = matchingProvision?.blueprintType
    ? getOperatorApiUrlForBlueprint(matchingProvision.blueprintType)
    : matchingProvision
      ? INSTANCE_OPERATOR_API_URL
      : null;
  const fallbackLookupId = matchingProvision?.botId ?? id;
  const fallbackAuth = useOperatorAuth(fallbackOperatorApiUrl ?? '');

  const storeBot =
    bots.find((bot) => bot.id === id) ??
    bots.find((bot) => id && bot.sandboxId === id) ??
    bots.find((bot) => id && bot.vaultAddress.toLowerCase() === id.toLowerCase());
  const scopedOperatorApiUrl =
    storeBot?.operatorApiUrl ?? fallbackOperatorApiUrl;
  const routeOperatorApiUrl = scopedOperatorApiUrl ?? OPERATOR_API_URL;
  const storeBotDetail = useBotDetail(
    storeBot?.id,
    storeBot?.operatorApiUrl ?? routeOperatorApiUrl,
    storeBot?.operatorKind,
  );

  useRouteOperatorAutoAuth({
    enabled: Boolean(routeOperatorApiUrl && isConnected && id),
    routeKey: `bot-detail:${id ?? 'unknown'}`,
    apiUrl: routeOperatorApiUrl,
  });
  useOperatorSyncScope(scopedOperatorApiUrl ? [scopedOperatorApiUrl] : []);

  const fallbackDetail = useBotDetail(
    !storeBot && fallbackOperatorApiUrl && fallbackOperatorKind
      ? (fallbackLookupId ?? undefined)
      : undefined,
    fallbackOperatorApiUrl,
    fallbackOperatorKind,
  );
  const routeDetailLookupEnabled = !storeBot && !matchingProvision && Boolean(id);
  const routeDetail = useBotDetail(
    routeDetailLookupEnabled ? id : undefined,
    routeOperatorApiUrl,
    'cloud',
  );

  const fallbackBot = useMemo<Bot | undefined>(() => {
    if (storeBot || !id || !matchingProvision) return undefined;
    return buildInstanceFallbackBot({
      routeId: id,
      provision: matchingProvision,
      detail: fallbackDetail.data,
      operatorApiUrl: fallbackOperatorApiUrl,
      operatorKind: fallbackOperatorKind,
    });
  }, [
    fallbackDetail.data,
    fallbackOperatorApiUrl,
    fallbackOperatorKind,
    id,
    matchingProvision,
    storeBot,
  ]);

  const routeFallbackBot = useMemo<Bot | undefined>(() => {
    if (!routeDetailLookupEnabled || !id) return undefined;
    return buildOperatorDetailFallbackBot({
      routeId: id,
      detail: routeDetail.data,
      operatorApiUrl: routeOperatorApiUrl,
      operatorKind: 'cloud',
    });
  }, [id, routeDetail.data, routeDetailLookupEnabled, routeOperatorApiUrl]);

  const bot = useMemo<Bot | undefined>(() => {
    if (!storeBot) return fallbackBot ?? routeFallbackBot;
    const detail = storeBotDetail.data;
    if (!detail) return storeBot;

    return {
      ...storeBot,
      name: resolveBotDisplayName({
        primaryName: detail.name || storeBot.name,
        strategyType: detail.strategy_type || storeBot.strategyType,
      }),
      strategyConfig: detail.strategy_config,
      riskParams: detail.risk_params,
      maxLifetimeDays: detail.max_lifetime_days,
      windDownStartedAt: detail.wind_down_started_at ?? undefined,
      workflowId: detail.workflow_id ?? storeBot.workflowId,
      validationTrust: detail.validation_trust ?? storeBot.validationTrust,
    };
  }, [fallbackBot, routeFallbackBot, storeBot, storeBotDetail.data]);

  const displayBotName = bot
    ? resolveBotDisplayName({
        fallbackName: bot.name,
        strategyType: bot.strategyType,
      })
    : '';
  const botAssetMetadata = useMemo(
    () => tokenMetadataFromStrategyConfig(bot?.strategyConfig),
    [bot?.strategyConfig],
  );

  const botTargetChainId = bot ? getBotStrategyChainId(bot) : null;

  useEffect(() => {
    if (!bot) return;
    if (!botTargetChainId || !networks[botTargetChainId]) return;
    if (selectedChainIdStore.get() !== botTargetChainId) {
      selectedChainIdStore.set(botTargetChainId);
    }
  }, [bot, botTargetChainId]);

  const { data: operatorMeta } = useOperatorMeta(
    bot?.operatorApiUrl ?? routeOperatorApiUrl,
  );
  const detailApiUrl = bot?.operatorApiUrl ?? routeOperatorApiUrl;
  const commandAuth = useOperatorAuth(detailApiUrl);
  const isHyperliquidPerpBot = bot?.strategyType === 'hyperliquid_perp';

  const botIsLive = bot ? isLiveBotStatus(bot.status) : false;
  const pendingValidationCount = usePendingValidationCount(
    bot?.id ?? '',
    displayBotName,
    botIsLive,
    bot?.chainId,
    bot?.operatorApiUrl,
    bot?.operatorKind,
  );
  const botNavItems = useMemo<AgentWorkspaceNavItem[]>(() => {
    const items: AgentWorkspaceNavItem[] = [
      { value: 'performance', label: 'Performance', icon: 'i-ph:chart-line-up' },
      { value: 'portfolio', label: 'Portfolio', icon: 'i-ph:wallet' },
    ];

    if (operatorMeta?.features.chat !== false) {
      items.push(
        { value: 'runs', label: 'Runs', icon: 'i-ph:list-checks' },
        { value: 'chat', label: 'Chat', icon: 'i-ph:chat-circle-dots' },
      );
    }

    items.push({
      value: 'operations',
      label: 'Operations',
      icon: 'i-ph:sliders-horizontal',
      badge: pendingValidationCount > 0
        ? <span className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" />
        : undefined,
    });

    return items;
  }, [operatorMeta?.features.chat, pendingValidationCount]);

  const isRouteFallbackLoading =
    !storeBot &&
    !fallbackBot &&
    (fallbackAuth.isAuthenticating ||
      fallbackDetail.isLoading ||
      fallbackDetail.isFetching ||
      (routeDetailLookupEnabled &&
        !routeDetail.isError &&
        (routeDetail.isLoading || routeDetail.isFetching)));

  if (!bot && (isLoading || isRouteFallbackLoading)) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
        <div className="glass-card rounded-none p-12 max-w-md">
          <div className="i-ph:arrow-clockwise text-4xl text-arena-elements-textTertiary mb-4 mx-auto animate-spin" />
          <p className="text-arena-elements-textSecondary text-sm">
            Loading agent data…
          </p>
        </div>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
        <div className="glass-card rounded-none p-12 max-w-md">
          <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mb-4 mx-auto" />
          <h1 className="font-display text-2xl font-bold mb-3">
            Agent Not Found
          </h1>
          <p className="text-arena-elements-textSecondary mb-6 text-sm">
            The agent with ID &quot;{id}&quot; does not exist.
          </p>
          <Button asChild variant="outline">
            <Link to="/">Back to Tangle</Link>
          </Button>
        </div>
      </div>
    );
  }

  const routeAgentId = id ?? bot.id;
  const currentAgentHref = `${location.pathname}${location.search}`;
  const directAgentBackHref = buildSectionUrl(routeAgentId, 'performance');
  const stateAgentBackHref = readAgentBackHref(location.state, routeAgentId);
  const focusMode = activeSection === 'runs' || activeSection === 'chat';
  const buildWorkspaceSectionHref = (section: AgentWorkspaceSection) =>
    buildSectionUrl(routeAgentId, section);
  const buildWorkspaceSectionState = (section: AgentWorkspaceSection): AgentRouteState | undefined => {
    if (section !== 'runs' && section !== 'chat') return undefined;
    return {
      agentBackHref: focusMode
        ? stateAgentBackHref ?? directAgentBackHref
        : currentAgentHref,
    };
  };

  const handleOperationsPanelChange = (panel: OperationsPanel) => {
    if (!id) return;
    navigate(buildSectionUrl(id, 'operations', panel));
  };

  const configureSecrets = () => {
    setSecretsTarget({
      apiUrl: bot.operatorApiUrl ?? undefined,
      botId: bot.id,
      sandboxId: bot.sandboxId,
      callId: bot.callId,
      serviceId: bot.serviceId,
    });
  };

  const needsSecrets =
    bot.status === 'needs_config' || bot.secretsConfigured === false;
  const hasChat = operatorMeta?.features.chat !== false;
  const hasTerminal = operatorMeta?.features.terminal === true;
  const canCommandBot = isBotCommandableByWallet(bot, address ?? commandAuth.accountAddress);

  const renderWorkspace = () => {
    switch (activeSection) {
      case 'performance':
        return <PerformanceTab bot={bot} isLive={botIsLive} canCommand={canCommandBot} />;
      case 'portfolio':
        return (
          <PortfolioWorkspace
            botId={bot.id}
            botName={displayBotName}
            status={bot.status}
            isLive={botIsLive}
            paperTrade={bot.paperTrade}
            chainId={bot.chainId}
            operatorApiUrl={bot.operatorApiUrl}
            operatorKind={bot.operatorKind}
            verificationState={bot.verificationState}
            assetMetadata={botAssetMetadata}
          />
        );
      case 'runs':
        return hasChat ? (
          <ErrorBoundary>
            <RunsTab
              botId={bot.id}
              botName={displayBotName}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
              immersive
            />
          </ErrorBoundary>
        ) : (
          <div className="glass-card rounded-none py-16 text-center text-arena-elements-textSecondary">
            Runs are unavailable for this operator.
          </div>
        );
      case 'chat':
        return hasChat ? (
          <ErrorBoundary>
            <ChatTab
              botId={bot.id}
              botName={displayBotName}
              operatorAddress={bot.operatorAddress}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
              requiresSecrets={needsSecrets}
              onConfigureSecrets={needsSecrets ? configureSecrets : undefined}
              immersive
              canCommand={canCommandBot}
            />
          </ErrorBoundary>
        ) : (
          <div className="glass-card rounded-none py-16 text-center text-arena-elements-textSecondary">
            Chat is unavailable for this operator.
          </div>
        );
      case 'operations':
        return (
          <OperationsWorkspace
            bot={bot}
            botName={displayBotName}
            isLive={botIsLive}
            initialPanel={requestedOperationsPanel}
            onPanelChange={handleOperationsPanelChange}
            hasTerminal={hasTerminal}
            isHyperliquidPerpBot={isHyperliquidPerpBot}
            assetMetadata={botAssetMetadata}
            onConfigureSecrets={needsSecrets ? configureSecrets : undefined}
            canCommand={canCommandBot}
          />
        );
    }
  };

  const workspace = (
    <Suspense fallback={<WorkspaceLoading />}>
      {renderWorkspace()}
    </Suspense>
  );

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <AgentWorkspaceShell
        bot={bot}
        displayName={displayBotName}
        activeSection={activeSection}
        navItems={botNavItems}
        buildSectionHref={buildWorkspaceSectionHref}
        buildSectionState={buildWorkspaceSectionState}
        backHref={focusMode ? stateAgentBackHref ?? directAgentBackHref : undefined}
        focusMode={focusMode}
      >
        {focusMode ? (
          workspace
        ) : (
          <div className="flex h-full min-h-0 flex-col gap-2">
            {canCommandBot && (
              <EnvelopeNeededBanner
                bot={bot}
                onSignEnvelope={() => {
                  if (!id) return;
                  navigate(buildSectionUrl(id, 'operations', 'envelope'));
                }}
              />
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {workspace}
            </div>
          </div>
        )}
      </AgentWorkspaceShell>

      <SecretsModal
        target={secretsTarget}
        onClose={() => setSecretsTarget(null)}
      />
    </div>
  );
}
