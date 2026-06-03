import { useState, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useSessions,
  useCreateSession,
  useDeleteSession,
  useRenameSession,
} from "@tangle-network/sandbox-ui/hooks";
import type { AgentBranding, Session } from "@tangle-network/sandbox-ui/types";
import { Button } from "@tangle-network/blueprint-ui/components";
import { ChatTranscript } from "~/components/bot-detail/chat/ChatTranscript";
import { useBotSessionStream } from "~/lib/hooks/useBotSessionStream";
import { useOperatorAuth } from "~/lib/hooks/useOperatorAuth";
import { normalizeSessionList } from "~/lib/sandboxSessions";
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
  useOperatorMeta,
} from "~/lib/operator/meta";
import {
  OperatorAccessCard,
  UnsupportedFeatureCard,
} from "~/components/operator/OperatorAccessCard";
import {
  buildRunReplayHistoryPath,
  buildRunReplaySessionId,
  chooseDefaultRun,
  formatDuration,
  formatRunTimestamp,
  getWorkflowKindLabel,
  hasReplayableRunTrace,
  parseRunsResponse,
} from "~/lib/botRuns";
import { buildDecisionItemsFromRuns } from "~/lib/decisionFeed";
import type { BotOperatorKind, BotVerificationState } from "~/lib/types/bot";
import { DecisionActivityStrip } from "./shared/DecisionActivityStrip";
import { DecisionInspector } from "./shared/DecisionInspector";
import { RunsTab } from "./RunsTab";

interface ChatTabProps {
  botId: string;
  botName: string;
  operatorAddress: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
  requiresSecrets?: boolean;
  onConfigureSecrets?: () => void;
  immersive?: boolean;
  canCommand?: boolean;
}

function extractChatErrorMessage(error: unknown): string | null {
  if (!error) return null;

  const raw = error instanceof Error ? error.message : String(error);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        message?: string;
      };
      message?: string;
    };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}

const TRADING_BRANDING: AgentBranding = {
  label: "Trading Agent",
  accentClass: "text-violet-700 dark:text-violet-300",
  bgClass: "bg-violet-500/8",
  containerBgClass: "bg-arena-elements-background-depth-2/30",
  borderClass: "border-violet-500/20",
  iconClass: "i-ph:chart-line-up",
  textClass: "text-violet-700 dark:text-violet-300",
};

function AgentStatus({
  status,
  onAbort,
  isAborting,
}: {
  status: "idle" | "running" | "error";
  onAbort: () => void;
  isAborting: boolean;
}) {
  void onAbort;
  void isAborting;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-2 h-2 rounded-full ${
          status === "running"
            ? "bg-amber-400 animate-pulse"
            : status === "error"
              ? "bg-crimson-400"
              : "bg-emerald-700 dark:bg-emerald-400"
        }`}
      />
      <span className="text-xs font-data text-arena-elements-textSecondary">
        {status === "running"
          ? "Agent working…"
          : status === "error"
            ? "Agent error"
            : "Agent idle"}
      </span>
    </div>
  );
}

function ChatRunBanner({
  isStreaming,
  error,
  onAbort,
  isAborting,
}: {
  isStreaming: boolean;
  error: string | null;
  onAbort: () => void;
  isAborting: boolean;
}) {
  if (!isStreaming && !error) {
    return null;
  }

  if (error && !isStreaming) {
    return (
      <div className="px-3 py-2 border-b border-crimson-500/20 bg-crimson-500/5">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-crimson-500/10 px-2 py-0.5 text-[11px] font-medium text-crimson-600 dark:text-crimson-300">
            Failed
          </span>
          <span className="text-xs text-crimson-600/90 dark:text-crimson-300/90 truncate">
            {error}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-emerald-500/15 bg-emerald-500/5">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          Running
        </span>
        <span className="text-xs text-arena-elements-textSecondary">
          The trading agent is working through your request.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onAbort}
          disabled={isAborting}
          className="ml-auto text-xs h-6 px-2"
        >
          <span className="i-ph:stop-circle text-sm mr-1" />
          {isAborting ? "Stopping…" : "Stop"}
        </Button>
      </div>
    </div>
  );
}

interface SessionItem {
  id: string;
  title: string;
  subtitle: string;
  rawTitle: string;
}

function normalizeSessionTitle(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function buildAutoSessionTitle(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function shouldAutoTitleSession(
  session: Session | null | undefined,
  messageCount: number,
): boolean {
  if (!session || messageCount > 0) {
    return false;
  }

  return normalizeSessionTitle(session.title).trim() === "New Chat";
}

function truncateMiddle(value: string, start = 16, end = 8): string {
  if (value.length <= start + end + 1) {
    return value;
  }

  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function getSessionDisplayTitle(
  session: SessionItem,
  index: number,
  primarySessionId: string,
): string {
  if (session.id === primarySessionId) {
    return "Main Chat";
  }

  const cleaned = normalizeSessionTitle(session.rawTitle).trim();
  if (cleaned && cleaned !== session.id) {
    return cleaned;
  }

  return `Session ${index + 1}`;
}

function SessionWorkspaceSidebar({
  sessions,
  activeSessionId,
  primarySessionId,
  isStreaming,
  stacked,
  compactStacked,
  collapsed,
  canWrite,
  onSelect,
  onDelete,
  onRename,
  onCreate,
  onToggleCollapsed,
}: {
  sessions: SessionItem[];
  activeSessionId: string;
  primarySessionId: string;
  isStreaming: boolean;
  stacked: boolean;
  compactStacked: boolean;
  collapsed: boolean;
  canWrite: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onCreate: () => void;
  onToggleCollapsed: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  return (
    <aside
      className={
        stacked
          ? "flex w-full shrink-0 flex-col overflow-hidden border-b border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40"
          : `flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40 transition-[width,flex-basis] duration-200 ${collapsed ? "w-14 basis-14" : "w-[260px] basis-[260px]"}`
      }
    >
      <div className={`flex items-center border-b border-arena-elements-dividerColor/50 ${collapsed ? "justify-center px-2 py-3" : "justify-between px-4 py-3"}`}>
        {!collapsed && (
          <div className="min-w-0">
            <span className="block truncate text-sm font-display font-semibold text-arena-elements-textPrimary">
              History
            </span>
            <span className="block truncate font-data text-xs text-arena-elements-textTertiary">
              {sessions.length.toLocaleString()} {sessions.length === 1 ? "session" : "sessions"}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1">
          {canWrite && !collapsed && (
          <button
            type="button"
            onClick={onCreate}
            className="flex items-center justify-center w-8 h-8 rounded-md text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 hover:bg-arena-elements-item-backgroundHover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
            title="New chat"
            aria-label="New chat"
          >
            <span className="i-ph:plus text-base" />
          </button>
          )}
          {!stacked && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="flex h-8 w-8 items-center justify-center rounded-md text-arena-elements-textTertiary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
              title={collapsed ? "Expand sessions" : "Collapse sessions"}
              aria-label={collapsed ? "Expand sessions" : "Collapse sessions"}
            >
              <span className={collapsed ? "i-ph:caret-right-bold text-base" : "i-ph:caret-left-bold text-base"} />
            </button>
          )}
        </div>
      </div>

      <div
        className={
          stacked
            ? `${compactStacked ? "max-h-36" : "max-h-56"} overflow-y-auto overflow-x-hidden py-1`
            : "min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1"
        }
      >
        {sessions.map((session, index) => {
          const displayTitle = getSessionDisplayTitle(
            session,
            index,
            primarySessionId,
          );
          const isActive = session.id === activeSessionId;
          const isPrimary = session.id === primarySessionId;
          const showStreamingDot = isActive && isStreaming;

          if (collapsed) {
            return (
              <button
                key={session.id}
                type="button"
                title={displayTitle}
                aria-pressed={isActive}
                className={`mx-1.5 my-1 flex h-10 w-10 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                  isActive
                    ? "bg-arena-elements-item-backgroundActive text-violet-700 dark:text-violet-300"
                    : "text-arena-elements-textTertiary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary"
                }`}
                onClick={() => onSelect(session.id)}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    showStreamingDot
                      ? "bg-emerald-400 animate-pulse"
                      : isActive
                        ? "bg-violet-500"
                        : "bg-arena-elements-textTertiary/40"
                  }`}
                />
              </button>
            );
          }

          return (
            <div
              key={session.id}
              className={`group grid min-w-0 grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 overflow-hidden px-4 py-2.5 transition-colors ${
                isActive
                  ? "bg-arena-elements-item-backgroundActive"
                  : "hover:bg-arena-elements-item-backgroundHover"
              }`}
            >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isActive
                      ? showStreamingDot
                        ? "bg-emerald-400 animate-pulse"
                        : "bg-violet-500"
                      : "bg-arena-elements-textTertiary/35"
                  }`}
                />
                <div className="min-w-0">
                  {editingId === session.id ? (
                    <input
                      className="w-full border-b border-arena-elements-borderColor bg-transparent text-sm font-display text-arena-elements-textPrimary focus-visible:border-violet-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/35"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          onRename(session.id, editTitle);
                          setEditingId(null);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => {
                        onRename(session.id, editTitle);
                        setEditingId(null);
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 w-full rounded-md text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                      onClick={() => onSelect(session.id)}
                    >
                      <div className="truncate text-[15px] font-display font-semibold text-arena-elements-textPrimary">
                        {displayTitle}
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5">
                        <div className="min-w-0 truncate text-xs font-data text-arena-elements-textTertiary">
                          {session.subtitle}
                        </div>
                        {showStreamingDot && (
                          <span className="shrink-0 font-data text-[11px] text-emerald-700 dark:text-emerald-300">
                            Live
                          </span>
                        )}
                      </div>
                    </button>
                  )}
                </div>

              {canWrite && !isPrimary && editingId !== session.id && (
                <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(session.id);
                      setEditTitle(displayTitle);
                    }}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-arena-elements-textTertiary hover:text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                    title="Rename"
                    aria-label={`Rename ${displayTitle}`}
                  >
                    <span className="i-ph:pencil-simple text-sm" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(session.id)}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-arena-elements-textTertiary hover:text-crimson-400 hover:bg-crimson-500/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                    title="Delete"
                    aria-label={`Delete ${displayTitle}`}
                  >
                    <span className="i-ph:x text-sm" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export function ChatTab({
  botId,
  botName,
  operatorAddress,
  operatorApiUrl,
  operatorKind,
  verificationState,
  requiresSecrets = false,
  onConfigureSecrets,
  immersive = false,
  canCommand = false,
}: ChatTabProps) {
  const baseApiUrl = operatorApiUrl ?? "";
  const { data: operatorMeta } = useOperatorMeta(baseApiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
  const apiUrl =
    operatorMeta && baseApiUrl
      ? `${baseApiUrl}${buildBotScopedPathForDeploymentKind(deploymentKind, botId)}`
      : "";
  const {
    token,
    isAuthenticated,
    isAuthenticating,
    authenticate,
  } = useOperatorAuth(baseApiUrl);
  const canWrite = canCommand && isAuthenticated && Boolean(token);
  const showPublicRunTelemetry = !canCommand;

  const primarySessionId = `trading-${botId}`;
  const [activeSessionId, setActiveSessionId] = useState(
    () => primarySessionId,
  );
  const [isAborting, setIsAborting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isStackedLayout, setIsStackedLayout] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.innerWidth < (immersive ? 860 : 1100),
  );
  const [sessionSidebarCollapsed, setSessionSidebarCollapsed] = useState(false);
  const chatCacheKey = `${baseApiUrl}::${botId}`;

  const sessionToken = canWrite ? token : null;
  const { data: rawSessions } = useSessions(apiUrl, sessionToken);
  const sessions = useMemo(() => normalizeSessionList(rawSessions), [rawSessions]);
  const deleteMutation = useDeleteSession(apiUrl, sessionToken);
  const renameMutation = useRenameSession(apiUrl, sessionToken);
  const createMutation = useCreateSession(apiUrl, sessionToken);
  const publicRunsQuery = useQuery({
    queryKey: ["bot-chat-public-runs", apiUrl, botId],
    enabled: !!apiUrl && !canWrite && !showPublicRunTelemetry,
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/runs?limit=25`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return parseRunsResponse(await response.json());
    },
    staleTime: 5_000,
  });
  const [selectedPublicRunId, setSelectedPublicRunId] = useState("");
  const publicReplayRuns = useMemo(() => {
    if (canWrite || showPublicRunTelemetry) return null;
    return publicRunsQuery.data?.runs.filter((run) => hasReplayableRunTrace(run)) ?? [];
  }, [canWrite, publicRunsQuery.data, showPublicRunTelemetry]);
  const publicRuns = !canWrite && !showPublicRunTelemetry ? (publicRunsQuery.data?.runs ?? []) : [];
  const publicReplayRun = useMemo(() => {
    if (!publicReplayRuns) return null;
    return (
      publicReplayRuns.find((run) => run.runId === selectedPublicRunId) ??
      chooseDefaultRun(publicReplayRuns)
    );
  }, [publicReplayRuns, selectedPublicRunId]);
  const decisionItems = useMemo(
    () => (publicReplayRuns ? buildDecisionItemsFromRuns(publicReplayRuns) : []),
    [publicReplayRuns],
  );
  const selectedDecisionItem =
    decisionItems.find((item) => item.sourceId === publicReplayRun?.runId) ??
    decisionItems[0];
  const hasKnownActiveSession = sessions.some(
    (session) => session.id === activeSessionId,
  );
  const publicReplaySessionId = buildRunReplaySessionId(publicReplayRun);
  const streamSessionId = showPublicRunTelemetry
    ? null
    : !canWrite
    ? (publicReplaySessionId || primarySessionId)
    : hasKnownActiveSession
      ? activeSessionId
      : activeSessionId === primarySessionId
        ? (sessions[0]?.id ?? null)
        : activeSessionId || sessions[0]?.id || null;
  const readOnlyHistoryPath = !canWrite && !showPublicRunTelemetry && streamSessionId
    ? (buildRunReplayHistoryPath(publicReplayRun) ??
      `/session/sessions/${encodeURIComponent(streamSessionId)}/messages?limit=200`)
    : undefined;

  useEffect(() => {
    if (hasKnownActiveSession || sessions.length === 0) return;
    if (activeSessionId === primarySessionId && sessions[0]?.id) {
      setActiveSessionId(sessions[0].id);
    }
  }, [activeSessionId, hasKnownActiveSession, primarySessionId, sessions]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(
      immersive ? "(max-width: 859px)" : "(max-width: 1099px)",
    );
    const syncLayout = () => setIsStackedLayout(mediaQuery.matches);

    syncLayout();
    mediaQuery.addEventListener("change", syncLayout);
    return () => {
      mediaQuery.removeEventListener("change", syncLayout);
    };
  }, [immersive]);

  const stream = useBotSessionStream({
    apiUrl,
    token: sessionToken,
    sessionId: streamSessionId ?? "",
    enabled:
      !!apiUrl &&
      !!streamSessionId &&
      (canWrite || Boolean(readOnlyHistoryPath)),
    cacheKey: chatCacheKey,
    historyPath: readOnlyHistoryPath,
    streamEnabled: canWrite,
  });
  const rawChatErrorMessage = extractChatErrorMessage(sendError ?? stream.error);
  const chatErrorMessage =
    !canWrite && rawChatErrorMessage && /HTTP (401|403)/i.test(rawChatErrorMessage)
      ? null
      : rawChatErrorMessage;
  const activeSession =
    sessions.find((session) => session.id === streamSessionId) ?? null;

  const agentStatus = stream.isStreaming
    ? "running"
    : chatErrorMessage
      ? "error"
      : "idle";
  const chatBranding = useMemo<AgentBranding>(
    () => ({
      ...TRADING_BRANDING,
      label: botName || TRADING_BRANDING.label,
    }),
    [botName],
  );

  const createSession = useCallback(
    async (title: string): Promise<Session> => {
      setSendError(null);
      const session = await createMutation.mutateAsync(title);
      setActiveSessionId(session.id);
      return session;
    },
    [createMutation],
  );

  const renameSessionTitle = useCallback(
    async (sessionId: string, title: string): Promise<void> => {
      const nextTitle = normalizeSessionTitle(title).trim();
      if (!nextTitle) {
        return;
      }

      try {
        await renameMutation.mutateAsync({ sessionId, title: nextTitle });
      } catch (error) {
        console.warn("Failed to auto-rename chat session", {
          sessionId,
          error,
        });
      }
    },
    [renameMutation],
  );

  const sendToSession = useCallback(
    async (sessionId: string, text: string): Promise<void> => {
      if (!token || !apiUrl) {
        throw new Error("Chat is not authenticated");
      }

      const response = await fetch(
        `${apiUrl}/session/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ parts: [{ type: "text", text }] }),
        },
      );

      if (!response.ok) {
        throw new Error(
          (await response.text()) ||
            `Failed to send message: ${response.status}`,
        );
      }
    },
    [apiUrl, token],
  );

  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;

      setSendError(null);

      try {
        if (streamSessionId) {
          const targetSession =
            sessions.find((session) => session.id === streamSessionId) ??
            activeSession;
          if (shouldAutoTitleSession(targetSession, stream.messages.length)) {
            await renameSessionTitle(
              streamSessionId,
              buildAutoSessionTitle(trimmed),
            );
          }
          await stream.send(trimmed);
          return;
        }

        const created = await createSession("New Chat");
        await renameSessionTitle(created.id, buildAutoSessionTitle(trimmed));
        await sendToSession(created.id, trimmed);
      } catch (error) {
        setSendError(
          error instanceof Error ? error.message : "Failed to send message",
        );
      }
    },
    [
      activeSession,
      createSession,
      renameSessionTitle,
      sendToSession,
      sessions,
      stream,
      streamSessionId,
    ],
  );

  const handleAbort = useCallback(async () => {
    setIsAborting(true);
    await stream.abort();
    setIsAborting(false);
  }, [stream]);

  const sessionItems: SessionItem[] = useMemo(
    () => {
      if (!canWrite && publicReplayRuns && publicReplayRuns.length > 0) {
        return publicReplayRuns.map((run) => ({
          id: run.runId,
          title: getWorkflowKindLabel(run.workflowKind),
          rawTitle: getWorkflowKindLabel(run.workflowKind),
          subtitle: `${formatRunTimestamp(run.startedAt)} · ${formatDuration(run.durationMs)}`,
        }));
      }

      return sessions.length > 0
        ? sessions.map((session: Session) => ({
            id: session.id,
            title: normalizeSessionTitle(session.title),
            rawTitle: normalizeSessionTitle(session.title),
            subtitle: truncateMiddle(session.id, 18, 8),
          }))
        : [
            {
              id: primarySessionId,
              title: "Main Chat",
              rawTitle: "Main Chat",
              subtitle: "Start a new conversation",
            },
          ];
    },
    [canWrite, primarySessionId, publicReplayRuns, sessions],
  );
  const hasPublicRunSessions =
    !canWrite && Boolean(publicReplayRuns && publicReplayRuns.length > 0);
  const showSessionSidebar =
    hasPublicRunSessions || sessionItems.length > 1 || (immersive && canWrite);
  const showDecisionActivityStrip = decisionItems.length > 0 && !showSessionSidebar;
  const showDecisionInspector = decisionItems.length > 0;
  const sidebarActiveSessionId =
    hasPublicRunSessions && publicReplayRun
      ? publicReplayRun.runId
      : activeSessionId;
  const sidebarPrimarySessionId = hasPublicRunSessions ? "" : primarySessionId;
  const handleSidebarSelect = useCallback(
    (id: string) => {
      if (
        !canWrite &&
        publicReplayRuns?.some((run) => run.runId === id)
      ) {
        setSelectedPublicRunId(id);
        return;
      }

      setActiveSessionId(id);
    },
    [canWrite, publicReplayRuns],
  );
  const chatHeaderTitle = activeSession
    ? getSessionDisplayTitle(
        {
          id: activeSession.id,
          title: normalizeSessionTitle(activeSession.title),
          rawTitle: normalizeSessionTitle(activeSession.title),
          subtitle: activeSession.id,
        },
        sessions.findIndex((session) => session.id === activeSession.id),
        primarySessionId,
      )
    : botName || "Agent Chat";
  const displayChatHeaderTitle = chatHeaderTitle === "Main Chat"
    ? botName || chatHeaderTitle
    : chatHeaderTitle;

  void operatorAddress;

  if (operatorMeta && !operatorMeta.features.chat) {
    return <UnsupportedFeatureCard feature="Chat" />;
  }

  if (!apiUrl) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:chat-slash text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        Chat is not ready yet for this operator.
      </div>
    );
  }

  if (verificationState === "unverified") {
    return (
      <OperatorAccessCard
        title="Chat unavailable"
        description="Chat stays disabled until this bot has been freshly verified against the operator."
        apiUrl={baseApiUrl}
      />
    );
  }

  if (requiresSecrets && canWrite) {
    return (
      <div className="glass-card rounded-xl border border-arena-elements-dividerColor p-6 sm:p-8 text-center">
        <div className="i-ph:key text-3xl mb-3 mx-auto text-amber-400" />
        <h3 className="text-lg font-display font-semibold text-arena-elements-textPrimary mb-2">
          Configure API keys first
        </h3>
        <p className="text-sm text-arena-elements-textSecondary max-w-xl mx-auto">
          This bot&apos;s sidecar is provisioned, but chat stays unavailable
          until the bot has an AI provider key.
        </p>
        {onConfigureSecrets && (
          <Button className="mt-4" onClick={onConfigureSecrets}>
            Configure API Keys
          </Button>
        )}
      </div>
    );
  }

  if (showPublicRunTelemetry) {
    return (
      <RunsTab
        botId={botId}
        botName={botName}
        operatorApiUrl={operatorApiUrl}
        operatorKind={operatorKind}
        verificationState={verificationState}
        immersive={immersive}
        surface="chat"
      />
    );
  }

  if (
    !canWrite &&
    !publicRunsQuery.isLoading &&
    publicRuns.length > 0 &&
    (!publicReplayRuns || publicReplayRuns.length === 0)
  ) {
    return (
      <RunsTab
        botId={botId}
        botName={botName}
        operatorApiUrl={operatorApiUrl}
        operatorKind={operatorKind}
        verificationState={verificationState}
        immersive={immersive}
        surface="chat"
      />
    );
  }

  return (
    <div
      data-sandbox-ui="true"
      data-sandbox-theme="vault"
      className={immersive
        ? "arena-chat-shell arena-trace-terminal h-full overflow-hidden bg-[#081013] text-[#f6fefd]"
        : "arena-chat-shell arena-trace-terminal glass-card rounded-xl overflow-hidden bg-[#081013] text-[#f6fefd]"}
      style={immersive
        ? { height: "100%", minHeight: 0 }
        : {
            height: "calc(100vh - var(--header-height) - 12rem)",
            minHeight: "720px",
          }}
    >
      <div
        className={`flex h-full min-h-0 min-w-0 ${isStackedLayout ? "flex-col" : "flex-row"}`}
      >
        {showSessionSidebar && (
          <SessionWorkspaceSidebar
            sessions={sessionItems}
            activeSessionId={sidebarActiveSessionId}
            primarySessionId={sidebarPrimarySessionId}
            isStreaming={stream.isStreaming}
            stacked={isStackedLayout}
            compactStacked={immersive}
            collapsed={!isStackedLayout && sessionSidebarCollapsed}
            onSelect={handleSidebarSelect}
            onDelete={(id) => {
              if (!canWrite) return;
              if (confirm("Delete this session?")) {
                deleteMutation.mutate(id);
                if (id === activeSessionId) setActiveSessionId(primarySessionId);
              }
            }}
            onRename={(id, title) =>
              canWrite ? renameMutation.mutate({ sessionId: id, title }) : undefined
            }
            onCreate={() => {
              if (!canWrite) return;
              void createSession("New Chat");
            }}
            onToggleCollapsed={() => setSessionSidebarCollapsed((collapsed) => !collapsed)}
            canWrite={canWrite}
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!immersive && (
            <div className="flex items-center gap-3 border-b border-[#273035] bg-[#0b1418] px-5 py-3">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="i-ph:chat-circle-dots text-base text-violet-700 dark:text-violet-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-display font-medium text-arena-elements-textPrimary">
                    {displayChatHeaderTitle}
                  </div>
                  {activeSession && (
                    <div className="truncate text-base font-data text-arena-elements-textTertiary">
                      {truncateMiddle(activeSession.id, 20, 8)}
                    </div>
                  )}
                </div>
              </div>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => {
                    void createSession("New Chat");
                  }}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/50 px-3 text-sm font-display font-medium text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                >
                  <span className="i-ph:plus text-base" aria-hidden="true" />
                  <span className="hidden sm:inline">New Chat</span>
                </button>
              )}
            </div>
          )}

          <ChatRunBanner
            isStreaming={stream.isStreaming}
            error={chatErrorMessage}
            onAbort={handleAbort}
            isAborting={isAborting}
          />

          {showDecisionActivityStrip && (
            <DecisionActivityStrip
              items={decisionItems}
              selectedId={selectedDecisionItem?.id}
              onSelect={(item) => setSelectedPublicRunId(item.sourceId)}
              variant="terminal"
            />
          )}

          <div
            className={`arena-trace-surface min-h-0 flex-1 bg-[#081013] ${
              !showDecisionInspector
                ? ""
                : isStackedLayout
                  ? "flex flex-col"
                  : "grid grid-cols-[minmax(0,1fr)_360px]"
            }`}
          >
            {showDecisionInspector && isStackedLayout && (
              <DecisionInspector
                item={selectedDecisionItem}
                variant="terminal"
                className="max-h-80 border-b border-[#273035]"
              />
            )}
            <div className={showDecisionInspector && isStackedLayout ? "min-h-0 min-w-0 flex-1" : "min-h-0 min-w-0"}>
              <ChatTranscript
                messages={stream.messages}
                partMap={stream.partMap}
                isStreaming={stream.isStreaming}
                onSend={canWrite ? handleSend : undefined}
                branding={chatBranding}
                variant="terminal"
                placeholder={
                  stream.isStreaming
                    ? "Agent is working…"
                    : `Ask ${botName} anything…`
                }
              />
            </div>
            {showDecisionInspector && !isStackedLayout && (
              <DecisionInspector
                item={selectedDecisionItem}
                variant="terminal"
                className="border-l border-[#273035]"
              />
            )}
          </div>

          {(canWrite || canCommand) && (
          <div className="flex items-center gap-3 border-t border-[#273035] bg-[#0b1418] px-4 py-3">
            {canWrite ? (
              <AgentStatus
                status={agentStatus}
                onAbort={handleAbort}
                isAborting={isAborting}
              />
            ) : null}
            {canCommand && !canWrite && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-8"
                onClick={authenticate}
                disabled={isAuthenticating}
              >
                {isAuthenticating ? "Connecting…" : "Owner Sign In"}
              </Button>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
