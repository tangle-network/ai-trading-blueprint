import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { useStore } from "@nanostores/react";
import { useQueryClient } from "@tanstack/react-query";
import { useBots } from "~/lib/hooks/useBots";
import {
  AnimatedPage,
  Button,
  Tabs,
  TabsContent,
} from "@tangle-network/blueprint-ui/components";
import { selectedChainIdStore } from "@tangle-network/blueprint-ui";
import {
  BotHeader,
  type BotHeaderNavItem,
} from "~/components/bot-detail/BotHeader";
import { PerformanceTab } from "~/components/bot-detail/PerformanceTab";
import { PositionsTab } from "~/components/bot-detail/PositionsTab";
import { TradeHistoryTab } from "~/components/bot-detail/TradeHistoryTab";
import {
  ReasoningTab,
  usePendingValidationCount,
} from "~/components/bot-detail/ReasoningTab";
import { ChatTab } from "~/components/bot-detail/ChatTab";
import { RunsTab } from "~/components/bot-detail/RunsTab";
import { RevisionArenaTab } from "~/components/bot-detail/RevisionArenaTab";
import { ControlsTab } from "~/components/bot-detail/ControlsTab";
import { SecretsTab } from "~/components/bot-detail/SecretsTab";
import { EnvelopeTab } from "~/components/bot-detail/EnvelopeTab";
import { TerminalTab } from "~/components/bot-detail/TerminalTab";
import { HyperliquidVaultTab } from "~/components/bot-detail/HyperliquidVaultTab";
import {
  SecretsModal,
  type SecretsTarget,
} from "~/components/home/SecretsModal";
import { ErrorBoundary } from "~/components/ErrorBoundary";
import { EnvelopeNeededBanner } from "~/components/bot-detail/EnvelopeNeededBanner";
import { TradingRiskDisclosure } from "~/components/bot-detail/shared/DataAccessNotices";
import { useAccount } from "wagmi";
import { useBotDetail } from "~/lib/hooks/useBotDetail";
import { useOperatorAuth } from "~/lib/hooks/useOperatorAuth";
import { useRouteOperatorAutoAuth } from "~/lib/hooks/useRouteOperatorAutoAuth";
import { useOperatorSyncScope } from "~/lib/hooks/useOperatorSyncScope";
import {
  INSTANCE_OPERATOR_API_URL,
  OPERATOR_API_URL,
  getOperatorApiUrlForBlueprint,
  getOperatorKindForBlueprint,
  useOperatorMeta,
} from "~/lib/operator/meta";
import { isLiveBotStatus } from "~/lib/format";
import {
  provisionsForOwner,
  type TrackedProvision,
} from "~/lib/stores/provisions";
import type { Bot } from "~/lib/types/bot";
import {
  buildOperatorDetailFallbackBot,
  buildInstanceFallbackBot,
  findMatchingInstanceRouteProvision,
} from "~/lib/utils/instanceBotRoute";
import { resolveBotDisplayName } from "~/lib/utils/botNames";
import { getBotStrategyChainId } from "~/lib/utils/botStrategy";
import { tokenMetadataFromStrategyConfig } from "~/lib/assetUniverse";
import { networks } from "~/lib/contracts/chains";

export const meta: MetaFunction = () => [{ title: "Bot — AI Trading Arena" }];

const VALID_BOT_TABS = [
  "performance",
  "positions",
  "trades",
  "reasoning",
  "runs",
  "arena",
  "chat",
  "terminal",
  "vault",
  "secrets",
  "envelope",
  "controls",
] as const;
type BotTabValue = (typeof VALID_BOT_TABS)[number];

function isBotTabValue(value: string | null | undefined): value is BotTabValue {
  return !!value && (VALID_BOT_TABS as readonly string[]).includes(value);
}

export default function BotDetailPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab: BotTabValue = isBotTabValue(tabParam)
    ? tabParam
    : "performance";
  const [activeTab, setActiveTab] = useState<BotTabValue>(initialTab);

  // Keep tab state in sync with `?tab=` so navigations (e.g. post-provision
  // redirect to the Envelope tab) work and tab clicks are shareable.
  useEffect(() => {
    if (isBotTabValue(tabParam) && tabParam !== activeTab) {
      setActiveTab(tabParam);
    }
  }, [tabParam, activeTab]);

  const handleTabChange = useCallback(
    (next: string) => {
      if (!isBotTabValue(next)) return;
      setActiveTab(next);
      setSearchParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          if (next === "performance") {
            updated.delete("tab");
          } else {
            updated.set("tab", next);
          }
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const { address, isConnected } = useAccount();
  const { bots, isLoading } = useBots();
  const queryClient = useQueryClient();
  const [secretsTarget, setSecretsTarget] = useState<SecretsTarget | null>(
    null,
  );
  const myProvisions = useStore(
    provisionsForOwner(address),
  ) as TrackedProvision[];

  const matchingProvision = useMemo(() => {
    return findMatchingInstanceRouteProvision(myProvisions, id);
  }, [id, myProvisions]);

  const fallbackOperatorKind = matchingProvision?.blueprintType
    ? getOperatorKindForBlueprint(matchingProvision.blueprintType)
    : matchingProvision
      ? "instance"
      : null;
  const fallbackOperatorApiUrl = matchingProvision?.blueprintType
    ? getOperatorApiUrlForBlueprint(matchingProvision.blueprintType)
    : matchingProvision
      ? INSTANCE_OPERATOR_API_URL
      : null;
  const fallbackLookupId = matchingProvision?.botId ?? id;
  const fallbackAuth = useOperatorAuth(fallbackOperatorApiUrl ?? "");

  // Match by ID, sandbox ID, or vault address (handles various link formats)
  const storeBot =
    bots.find((b) => b.id === id) ??
    bots.find((b) => id && b.sandboxId === id) ??
    bots.find((b) => id && b.vaultAddress.toLowerCase() === id.toLowerCase());
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
    routeKey: `bot-detail:${id ?? "unknown"}`,
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
    "cloud",
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
      operatorKind: "cloud",
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
    : "";
  const botAssetMetadata = useMemo(
    () => tokenMetadataFromStrategyConfig(bot?.strategyConfig),
    [bot?.strategyConfig],
  );

  useEffect(() => {
    if (!bot) return;
    const targetChainId = getBotStrategyChainId(bot);
    if (!targetChainId || !networks[targetChainId]) return;
    if (selectedChainIdStore.get() !== targetChainId) {
      selectedChainIdStore.set(targetChainId);
    }
  }, [bot]);

  const { data: operatorMeta } = useOperatorMeta(
    bot?.operatorApiUrl ?? routeOperatorApiUrl,
  );
  const detailApiUrl = bot?.operatorApiUrl ?? routeOperatorApiUrl;
  const isHyperliquidPerpBot = bot?.strategyType === "hyperliquid_perp";

  useEffect(() => {
    if (!bot?.id || !detailApiUrl) return;

    queryClient.invalidateQueries({
      queryKey: ["bot-detail", detailApiUrl, bot.id],
    });
    queryClient.invalidateQueries({
      queryKey: ["bot-portfolio", detailApiUrl, bot.id],
    });
    queryClient.invalidateQueries({
      queryKey: ["bot-trades", detailApiUrl, bot.id],
    });
    queryClient.invalidateQueries({
      queryKey: ["bot-metrics", detailApiUrl, bot.id],
    });
    queryClient.invalidateQueries({
      queryKey: ["bot-metrics-summary", detailApiUrl, bot.id],
    });
  }, [bot?.id, detailApiUrl, queryClient]);

  // Must call hooks before early returns (React rules of hooks)
  const botIsLive = bot ? isLiveBotStatus(bot.status) : false;
  const pendingValidationCount = usePendingValidationCount(
    bot?.id ?? "",
    displayBotName,
    botIsLive,
    bot?.chainId,
    bot?.operatorApiUrl,
    bot?.operatorKind,
  );
  const botNavItems = useMemo<BotHeaderNavItem[]>(() => {
    const items: BotHeaderNavItem[] = [
      { value: "performance", label: "Performance", icon: "i-ph:chart-line-up" },
      { value: "positions", label: "Positions", icon: "i-ph:wallet" },
      { value: "trades", label: "Trades", icon: "i-ph:swap" },
    ];

    if (operatorMeta?.features.chat) {
      items.push(
        { value: "runs", label: "Runs", icon: "i-ph:list-checks" },
        { value: "chat", label: "Chat", icon: "i-ph:chat-circle-dots" },
      );
    }

    items.push({
      value: "reasoning",
      label: "Validation",
      icon: "i-ph:shield-check",
      badge: pendingValidationCount > 0
        ? <span className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" />
        : undefined,
    });
    items.push({ value: "arena", label: "Revision", icon: "i-ph:git-branch" });

    if (isHyperliquidPerpBot) {
      items.push({ value: "vault", label: "Vault", icon: "i-ph:bank" });
    }

    items.push(
      { value: "envelope", label: "Envelope", icon: "i-ph:signature" },
      { value: "controls", label: "Controls", icon: "i-ph:sliders-horizontal" },
    );

    if (operatorMeta?.features.terminal) {
      items.push({ value: "terminal", label: "Terminal", icon: "i-ph:terminal-window" });
    }

    items.push({ value: "secrets", label: "Secrets", icon: "i-ph:key" });

    return items;
  }, [
    isHyperliquidPerpBot,
    operatorMeta?.features.chat,
    operatorMeta?.features.terminal,
    pendingValidationCount,
  ]);

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
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 text-center">
        <div className="glass-card rounded-xl p-12 max-w-md mx-auto">
          <div className="i-ph:arrow-clockwise text-4xl text-arena-elements-textTertiary mb-4 mx-auto animate-spin" />
          <p className="text-arena-elements-textSecondary text-sm">
            Loading bot data...
          </p>
        </div>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 text-center">
        <div className="glass-card rounded-xl p-12 max-w-md mx-auto">
          <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mb-4 mx-auto" />
          <h1 className="font-display text-2xl font-bold mb-3">
            Bot Not Found
          </h1>
          <p className="text-arena-elements-textSecondary mb-6 text-sm">
            The bot with ID "{id}" does not exist.
          </p>
          <Button asChild variant="outline">
            <Link to="/arena">Back to Arena</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <AnimatedPage>
      <div className="mx-auto max-w-[1800px] px-4 pb-8 sm:px-6 lg:px-8">
        <BotHeader
          bot={bot}
          activeTab={activeTab}
          navItems={botNavItems}
          onTabChange={handleTabChange}
        />

        <EnvelopeNeededBanner
          bot={bot}
          onSignEnvelope={() => handleTabChange("envelope")}
        />

        <TradingRiskDisclosure />

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsContent value="performance" className="mt-0">
            <PerformanceTab bot={bot} isLive={botIsLive} />
          </TabsContent>

          <TabsContent value="positions" className="mt-0">
            <PositionsTab
              botId={bot.id}
              status={bot.status}
              chainId={bot.chainId}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
              assetMetadata={botAssetMetadata}
            />
          </TabsContent>

          <TabsContent value="trades" className="mt-0">
            <TradeHistoryTab
              botId={bot.id}
              botName={displayBotName}
              isLive={botIsLive}
              chainId={bot.chainId}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
              assetMetadata={botAssetMetadata}
            />
          </TabsContent>

          <TabsContent value="reasoning" className="mt-0">
            <ReasoningTab
              botId={bot.id}
              botName={displayBotName}
              isLive={botIsLive}
              chainId={bot.chainId}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
              assetMetadata={botAssetMetadata}
            />
          </TabsContent>

          {operatorMeta?.features.chat && (
            <TabsContent value="runs" className="mt-0">
              <ErrorBoundary>
                <RunsTab
                  botId={bot.id}
                  botName={displayBotName}
                  operatorApiUrl={bot.operatorApiUrl}
                  operatorKind={bot.operatorKind}
                  verificationState={bot.verificationState}
                />
              </ErrorBoundary>
            </TabsContent>
          )}

          <TabsContent value="arena" className="mt-0">
            <ErrorBoundary>
              <RevisionArenaTab
                botId={bot.id}
                operatorApiUrl={bot.operatorApiUrl}
                operatorKind={bot.operatorKind}
                verificationState={bot.verificationState}
              />
            </ErrorBoundary>
          </TabsContent>

          {operatorMeta?.features.chat && (
            <TabsContent value="chat" className="mt-0">
              <ErrorBoundary>
                <ChatTab
                  botId={bot.id}
                  botName={displayBotName}
                  operatorAddress={bot.operatorAddress}
                  operatorApiUrl={bot.operatorApiUrl}
                  operatorKind={bot.operatorKind}
                  verificationState={bot.verificationState}
                  requiresSecrets={
                    bot.status === "needs_config" ||
                    bot.secretsConfigured === false
                  }
                  onConfigureSecrets={
                    bot.status === "needs_config" ||
                    bot.secretsConfigured === false
                      ? () =>
                          setSecretsTarget({
                            apiUrl: bot.operatorApiUrl ?? undefined,
                            botId: bot.id,
                            sandboxId: bot.sandboxId,
                            callId: bot.callId,
                            serviceId: bot.serviceId,
                          })
                      : undefined
                  }
                />
              </ErrorBoundary>
            </TabsContent>
          )}

          {operatorMeta?.features.terminal && (
            <TabsContent value="terminal" className="mt-0">
              <ErrorBoundary>
                <TerminalTab
                  botId={bot.id}
                  botName={displayBotName}
                  operatorApiUrl={bot.operatorApiUrl}
                  operatorKind={bot.operatorKind}
                  verificationState={bot.verificationState}
                />
              </ErrorBoundary>
            </TabsContent>
          )}

          {isHyperliquidPerpBot && (
            <TabsContent value="vault" className="mt-0">
              <ErrorBoundary>
                <HyperliquidVaultTab bot={bot} />
              </ErrorBoundary>
            </TabsContent>
          )}

          <TabsContent value="secrets" className="mt-0">
            <ErrorBoundary>
              <SecretsTab bot={bot} />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="envelope" className="mt-0">
            <ErrorBoundary>
              <EnvelopeTab bot={bot} />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="controls" className="mt-0">
            <ControlsTab
              bot={bot}
              onConfigureSecrets={
                bot.status === "needs_config" || bot.secretsConfigured === false
                  ? () =>
                      setSecretsTarget({
                        apiUrl: bot.operatorApiUrl ?? undefined,
                        botId: bot.id,
                        sandboxId: bot.sandboxId,
                        callId: bot.callId,
                        serviceId: bot.serviceId,
                      })
                  : undefined
              }
            />
          </TabsContent>
        </Tabs>

        <SecretsModal
          target={secretsTarget}
          onClose={() => setSecretsTarget(null)}
        />
      </div>
    </AnimatedPage>
  );
}
