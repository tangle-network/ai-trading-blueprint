import { useState, useCallback, useEffect, useMemo } from "react";
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
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
  useOperatorMeta,
} from "~/lib/operator/meta";
import {
  OperatorAccessCard,
  UnsupportedFeatureCard,
} from "~/components/operator/OperatorAccessCard";
import type { BotOperatorKind, BotVerificationState } from "~/lib/types/bot";

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
  canWrite,
  onSelect,
  onDelete,
  onRename,
  onCreate,
}: {
  sessions: SessionItem[];
  activeSessionId: string;
  primarySessionId: string;
  isStreaming: boolean;
  stacked: boolean;
  canWrite: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onCreate: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  return (
    <aside
      className={
        stacked
          ? "flex w-full shrink-0 flex-col overflow-hidden border-b border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40"
          : "flex min-h-0 w-[320px] basis-[320px] shrink-0 flex-col overflow-hidden border-r border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40"
      }
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-arena-elements-dividerColor/50">
        <span className="text-sm font-display font-semibold uppercase tracking-wider text-arena-elements-textSecondary">
          Sessions
        </span>
        {canWrite && (
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
      </div>

      <div
        className={
          stacked
            ? "max-h-56 overflow-y-auto py-1"
            : "min-h-0 flex-1 overflow-y-auto py-1"
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

          return (
            <div
              key={session.id}
              className={`group flex items-center gap-2 px-4 py-3 transition-colors ${
                isActive
                  ? "bg-arena-elements-item-backgroundActive"
                  : "hover:bg-arena-elements-item-backgroundHover"
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isActive
                      ? showStreamingDot
                        ? "bg-emerald-400 animate-pulse"
                        : "bg-violet-500"
                      : "bg-arena-elements-textTertiary/35"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  {editingId === session.id ? (
                    <input
                      className="w-full border-b border-arena-elements-borderColor bg-transparent text-sm font-display text-arena-elements-textPrimary outline-none"
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
                      className="min-w-0 w-full text-left cursor-pointer"
                      onClick={() => onSelect(session.id)}
                    >
                      <div className="truncate text-sm font-display font-medium text-arena-elements-textPrimary">
                        {displayTitle}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="truncate text-sm font-data text-arena-elements-textTertiary">
                          {session.subtitle}
                        </div>
                        {showStreamingDot && (
                          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-data text-emerald-700 dark:text-emerald-300">
                            Live
                          </span>
                        )}
                      </div>
                    </button>
                  )}
                </div>
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
  const canWrite = isAuthenticated && Boolean(token);

  const primarySessionId = `trading-${botId}`;
  const [activeSessionId, setActiveSessionId] = useState(
    () => primarySessionId,
  );
  const [isAborting, setIsAborting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isStackedLayout, setIsStackedLayout] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 1100,
  );
  const chatCacheKey = `${baseApiUrl}::${botId}`;

  const sessionToken = canWrite ? token : null;
  const { data: sessions = [] } = useSessions(apiUrl, sessionToken);
  const deleteMutation = useDeleteSession(apiUrl, sessionToken);
  const renameMutation = useRenameSession(apiUrl, sessionToken);
  const createMutation = useCreateSession(apiUrl, sessionToken);
  const hasKnownActiveSession = sessions.some(
    (session) => session.id === activeSessionId,
  );
  const streamSessionId = hasKnownActiveSession
    ? activeSessionId
    : activeSessionId === primarySessionId
      ? (sessions[0]?.id ?? (canWrite ? null : primarySessionId))
      : activeSessionId ||
        sessions[0]?.id ||
        (canWrite ? null : primarySessionId);
  const readOnlyHistoryPath = !canWrite && streamSessionId
    ? `/session/sessions/${encodeURIComponent(streamSessionId)}/messages?limit=200`
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

    const mediaQuery = window.matchMedia("(max-width: 1099px)");
    const syncLayout = () => setIsStackedLayout(mediaQuery.matches);

    syncLayout();
    mediaQuery.addEventListener("change", syncLayout);
    return () => {
      mediaQuery.removeEventListener("change", syncLayout);
    };
  }, []);

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
    () =>
      sessions.length > 0
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
          ],
    [primarySessionId, sessions],
  );

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

  return (
    <div
      data-sandbox-ui="true"
      data-sandbox-theme="vault"
      className="arena-chat-shell glass-card rounded-xl overflow-hidden"
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
        <SessionWorkspaceSidebar
          sessions={sessionItems}
          activeSessionId={activeSessionId}
          primarySessionId={primarySessionId}
          isStreaming={stream.isStreaming}
          stacked={isStackedLayout}
          onSelect={setActiveSessionId}
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
          canWrite={canWrite}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-arena-elements-dividerColor/50 px-5 py-3 bg-arena-elements-background-depth-1/25">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="i-ph:chat-circle-dots text-base text-violet-700 dark:text-violet-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-lg font-display font-medium text-arena-elements-textPrimary">
                  {activeSession
                    ? getSessionDisplayTitle(
                        {
                          id: activeSession.id,
                          title: normalizeSessionTitle(activeSession.title),
                          rawTitle: normalizeSessionTitle(activeSession.title),
                          subtitle: activeSession.id,
                        },
                        sessions.findIndex(
                          (session) => session.id === activeSession.id,
                        ),
                        primarySessionId,
                      )
                    : "Trading Agent"}
                </div>
                {activeSession && (
                  <div className="truncate text-base font-data text-arena-elements-textTertiary">
                    {truncateMiddle(activeSession.id, 20, 8)}
                  </div>
                )}
              </div>
            </div>
            {canWrite && (
              <span className="hidden rounded-full border border-violet-500/15 bg-violet-500/8 px-3 py-1.5 text-sm font-data text-violet-700 dark:text-violet-300 sm:inline-flex">
                Operator relay
              </span>
            )}
          </div>

          <ChatRunBanner
            isStreaming={stream.isStreaming}
            error={chatErrorMessage}
            onAbort={handleAbort}
            isAborting={isAborting}
          />

          <div className="flex-1 min-h-0 bg-arena-elements-background-depth-1/15">
            <ChatTranscript
              messages={stream.messages}
              partMap={stream.partMap}
              isStreaming={stream.isStreaming}
              onSend={canWrite ? handleSend : undefined}
              branding={TRADING_BRANDING}
              placeholder={
                stream.isStreaming
                  ? "Agent is working…"
                  : `Ask ${botName} anything…`
              }
            />
          </div>

          <div className="flex items-center gap-3 border-t border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/20 px-4 py-3">
            {canWrite ? (
              <AgentStatus
                status={agentStatus}
                onAbort={handleAbort}
                isAborting={isAborting}
              />
            ) : null}
            {!canWrite && (
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
        </div>
      </div>
    </div>
  );
}
