import { useState, useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";
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
import type { BotOperatorKind, BotVerificationState } from "~/lib/types/bot";
import {
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePaneSize,
  usePersistentWorkspaceLayout,
} from "~/components/arena/WorkspaceResizeControls";

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

interface ChatWorkspaceLayout {
  sidebarWidth: number;
}

const CHAT_WORKSPACE_LAYOUT_KEY = "arena:chat-workspace-layout";
const DEFAULT_CHAT_WORKSPACE_LAYOUT: ChatWorkspaceLayout = {
  sidebarWidth: 272,
};

function normalizeChatWorkspaceLayout(value: Partial<ChatWorkspaceLayout>): ChatWorkspaceLayout {
  return {
    sidebarWidth: clampNumber(
      Number(value.sidebarWidth) || DEFAULT_CHAT_WORKSPACE_LAYOUT.sidebarWidth,
      220,
      380,
    ),
  };
}

function getRequestedSessionId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const value = params.get("session") ?? params.get("qaSession");
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

function ChatEmptyState({
  botId,
  canCommand,
  isAuthenticating,
  onAuthenticate,
}: {
  botId: string;
  canCommand: boolean;
  isAuthenticating: boolean;
  onAuthenticate: () => void;
}) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center">
      <section
        className="w-full max-w-[640px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-6 py-8 shadow-[var(--arena-terminal-shadow-lg)]"
        aria-label="No chat sessions yet"
      >
        <span
          className="i-ph:chat-circle-dots mx-auto flex h-10 w-10 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-xl text-[var(--arena-terminal-accent)]"
          aria-hidden="true"
        />
        <h3 className="mt-4 font-display text-xl font-semibold text-[var(--arena-terminal-text)]">
          No chat sessions yet
        </h3>
        <p className="mx-auto mt-2 max-w-md text-pretty font-data text-sm leading-6 text-[var(--arena-terminal-text-muted)]">
          Autonomous execution traces live in Runs. Chat will show owner-directed conversation history when this agent has one.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {canCommand && (
            <button
              type="button"
              onClick={onAuthenticate}
              disabled={isAuthenticating}
              className="inline-flex h-9 items-center justify-center gap-2 bg-[var(--arena-terminal-accent)] px-3 font-display text-sm font-semibold text-[#06100e] transition-colors hover:bg-[color-mix(in_srgb,var(--arena-terminal-accent)_82%,var(--arena-terminal-text))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] disabled:opacity-60"
            >
              <span className="i-ph:wallet text-base" aria-hidden="true" />
              {isAuthenticating ? "Connecting…" : "Owner Sign In"}
            </button>
          )}
          <a
            href={`/arena/bot/${encodeURIComponent(botId)}/runs`}
            className="inline-flex h-9 items-center justify-center gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 font-display text-sm font-semibold text-[var(--arena-terminal-text-secondary)] transition-colors hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
          >
            <span className="i-ph:list-checks text-base" aria-hidden="true" />
            Open Runs
          </a>
        </div>
      </section>
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
  width,
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
  width: number;
  canWrite: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onCreate: () => void;
  onToggleCollapsed: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const sidebarStyle = !stacked
    ? {
        width: collapsed ? 56 : width,
        flexBasis: collapsed ? 56 : width,
      } as CSSProperties
    : undefined;

  return (
    <aside
      style={sidebarStyle}
      className={
        stacked
          ? "flex w-full shrink-0 flex-col overflow-hidden border-b border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40"
          : "flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40 transition-[width,flex-basis] duration-200"
      }
    >
      <div className={`flex items-center border-b border-arena-elements-dividerColor/50 ${collapsed ? "justify-center px-2 py-3" : "justify-between px-4 py-3"}`}>
        {!collapsed && (
          <div className="min-w-0">
            <span className="block truncate text-sm font-display font-semibold text-arena-elements-textPrimary">
              Conversations
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

  const primarySessionId = `trading-${botId}`;
  const [activeSessionId, setActiveSessionId] = useState(
    () => getRequestedSessionId() ?? primarySessionId,
  );
  const [isAborting, setIsAborting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isStackedLayout, setIsStackedLayout] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.innerWidth < (immersive ? 860 : 1100),
  );
  const [sessionSidebarCollapsed, setSessionSidebarCollapsed] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    CHAT_WORKSPACE_LAYOUT_KEY,
    DEFAULT_CHAT_WORKSPACE_LAYOUT,
    normalizeChatWorkspaceLayout,
  );
  const chatCacheKey = `${baseApiUrl}::${botId}`;

  const sessionToken = canWrite ? token : null;
  const sessionsQuery = useSessions(apiUrl, sessionToken);
  const sessions = useMemo(() => normalizeSessionList(sessionsQuery.data), [sessionsQuery.data]);
  const sessionsLoading = Boolean(
    (sessionsQuery as { isLoading?: boolean; isFetching?: boolean }).isLoading ||
      (sessionsQuery as { isLoading?: boolean; isFetching?: boolean }).isFetching,
  );
  const deleteMutation = useDeleteSession(apiUrl, sessionToken);
  const renameMutation = useRenameSession(apiUrl, sessionToken);
  const createMutation = useCreateSession(apiUrl, sessionToken);
  const hasKnownActiveSession = sessions.some(
    (session) => session.id === activeSessionId,
  );
  const streamSessionId = !canWrite
    ? (hasKnownActiveSession
      ? activeSessionId
      : sessions[0]?.id ?? null)
    : hasKnownActiveSession
      ? activeSessionId
      : activeSessionId === primarySessionId
        ? (sessions[0]?.id ?? null)
        : activeSessionId || sessions[0]?.id || null;
  const readOnlyHistoryPath = !canWrite && streamSessionId
    ? `/session/sessions/${encodeURIComponent(streamSessionId)}/messages?limit=200`
    : undefined;

  useEffect(() => {
    const requestedSessionId = getRequestedSessionId();
    if (!requestedSessionId || requestedSessionId === activeSessionId) {
      return;
    }
    setActiveSessionId(requestedSessionId);
  }, [activeSessionId]);

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
  const showSessionSidebar =
    sessionItems.length > 1 || (immersive && canWrite);
  const sidebarActiveSessionId = activeSessionId;
  const sidebarPrimarySessionId = primarySessionId;
  const handleSidebarSelect = useCallback(
    (id: string) => {
      setActiveSessionId(id);
    },
    [],
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
  const startSidebarResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    beginWorkspaceResize(event, {
      cursor: "col-resize",
      onMove: (moveEvent) => {
        const maxWidth = Math.min(380, Math.max(280, rect.width * 0.34));
        const rawWidth = moveEvent.clientX - rect.left;
        if (shouldCollapsePaneSize(rawWidth)) {
          setSessionSidebarCollapsed(true);
          return;
        }
        const nextWidth = clampNumber(rawWidth, 220, maxWidth);
        setSessionSidebarCollapsed(false);
        setLayout((current) => ({ ...current, sidebarWidth: nextWidth }));
      },
    });
  };
  const showEmptyChatState =
    !canWrite &&
    !sessionsLoading &&
    sessions.length === 0 &&
    stream.messages.length === 0;

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
        ref={workspaceRef}
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
            width={layout.sidebarWidth}
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
        {showSessionSidebar && !isStackedLayout && (
          <WorkspaceResizeHandle
            orientation="vertical"
            className="w-2"
            ariaLabel="Resize chat history"
            title="Drag to resize chat history"
            onPointerDown={startSidebarResize}
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

          <div className="arena-chat-surface min-h-0 flex-1 bg-[#081013]">
            {showEmptyChatState ? (
              <ChatEmptyState
                botId={botId}
                canCommand={canCommand}
                isAuthenticating={isAuthenticating}
                onAuthenticate={authenticate}
              />
            ) : (
            <div className="h-full min-h-0 min-w-0">
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
            )}
          </div>

          {(canWrite || (canCommand && !showEmptyChatState)) && (
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
