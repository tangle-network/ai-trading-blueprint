import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { useStore } from "@nanostores/react";
import { useQueryClient } from "@tanstack/react-query";
import { useBots } from "~/lib/hooks/useBots";
import {
  AnimatedPage,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@tangle-network/blueprint-ui/components";
import { BotHeader } from "~/components/bot-detail/BotHeader";
import { PerformanceTab } from "~/components/bot-detail/PerformanceTab";
import { PositionsTab } from "~/components/bot-detail/PositionsTab";
import { TradeHistoryTab } from "~/components/bot-detail/TradeHistoryTab";
import {
  ReasoningTab,
  usePendingValidationCount,
} from "~/components/bot-detail/ReasoningTab";
import { ChatTab } from "~/components/bot-detail/ChatTab";
import { RunsTab } from "~/components/bot-detail/RunsTab";
import { ControlsTab } from "~/components/bot-detail/ControlsTab";
import { TerminalTab } from "~/components/bot-detail/TerminalTab";
import {
  SecretsModal,
  type SecretsTarget,
} from "~/components/home/SecretsModal";
import { ErrorBoundary } from "~/components/ErrorBoundary";
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

export const meta: MetaFunction = () => [{ title: "Bot — AI Trading Arena" }];

export default function BotDetailPage() {
  const { id } = useParams();
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
  const routeAuth = useOperatorAuth(routeOperatorApiUrl);
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
    };
  }, [fallbackBot, routeFallbackBot, storeBot, storeBotDetail.data]);
  const displayBotName = bot
    ? resolveBotDisplayName({
        fallbackName: bot.name,
        strategyType: bot.strategyType,
      })
    : "";
  const { data: operatorMeta } = useOperatorMeta(
    bot?.operatorApiUrl ?? routeOperatorApiUrl,
  );
  const detailApiUrl = bot?.operatorApiUrl ?? routeOperatorApiUrl;

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
  const routeAuthToken = routeAuth.getCachedToken();
  const pendingValidationCount = usePendingValidationCount(
    bot?.id ?? "",
    displayBotName,
    botIsLive,
    bot?.chainId,
    bot?.operatorApiUrl,
    bot?.operatorKind,
  );

  const isRouteFallbackLoading =
    !storeBot &&
    !fallbackBot &&
    (fallbackAuth.isAuthenticating ||
      fallbackDetail.isLoading ||
      fallbackDetail.isFetching ||
      (routeDetailLookupEnabled &&
        isConnected &&
        !routeAuth.error &&
        !routeDetail.isError &&
        (!routeAuthToken ||
          routeAuth.isAuthenticating ||
          routeDetail.isLoading ||
          routeDetail.isFetching)));

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
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <Link
          to="/arena"
          className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 mb-6 transition-colors duration-200 font-display font-medium"
        >
          <span className="text-xs">&larr;</span> Back to Arena
        </Link>

        <BotHeader bot={bot} />

        <Tabs defaultValue="performance">
          <TabsList>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="positions">Positions</TabsTrigger>
            <TabsTrigger value="trades">Trade History</TabsTrigger>
            <TabsTrigger value="reasoning" className="relative">
              Validation
              {pendingValidationCount > 0 && (
                <span className="ml-1.5 w-2 h-2 rounded-full bg-violet-500 animate-pulse inline-block" />
              )}
            </TabsTrigger>
            {operatorMeta?.features.chat && (
              <TabsTrigger value="runs">Runs</TabsTrigger>
            )}
            {operatorMeta?.features.chat && (
              <TabsTrigger value="chat">Chat</TabsTrigger>
            )}
            {operatorMeta?.features.terminal && (
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
            )}
            <TabsTrigger value="controls">Controls</TabsTrigger>
          </TabsList>

          <TabsContent value="performance" className="mt-6">
            <PerformanceTab bot={bot} isLive={botIsLive} />
          </TabsContent>

          <TabsContent value="positions" className="mt-6">
            <PositionsTab
              botId={bot.id}
              status={bot.status}
              chainId={bot.chainId}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
            />
          </TabsContent>

          <TabsContent value="trades" className="mt-6">
            <TradeHistoryTab
              botId={bot.id}
              botName={displayBotName}
              isLive={botIsLive}
              chainId={bot.chainId}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
            />
          </TabsContent>

          <TabsContent value="reasoning" className="mt-6">
            <ReasoningTab
              botId={bot.id}
              botName={displayBotName}
              isLive={botIsLive}
              chainId={bot.chainId}
              operatorApiUrl={bot.operatorApiUrl}
              operatorKind={bot.operatorKind}
              verificationState={bot.verificationState}
            />
          </TabsContent>

          {operatorMeta?.features.chat && (
            <TabsContent value="runs" className="mt-6">
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

          {operatorMeta?.features.chat && (
            <TabsContent value="chat" className="mt-6">
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
            <TabsContent value="terminal" className="mt-6">
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

          <TabsContent value="controls" className="mt-6">
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
