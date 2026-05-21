import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { AgentBranding } from "@tangle-network/sandbox-ui/types";
import { AuthBanner } from "~/components/bot-detail/AuthBanner";
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

interface RunsTabProps {
  botId: string;
  botName: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
}

type RunStatus = "running" | "completed" | "failed" | "interrupted";
type WorkflowKind = "trading" | "research" | "conversation" | "unknown";

interface BotRun {
  runId: string;
  workflowId: number;
  workflowKind: WorkflowKind;
  status: RunStatus;
  startedAt: number;
  completedAt: number | null;
  sessionId: string | null;
  transcriptAvailable: boolean;
  traceId: string | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  result: string | null;
  error: string | null;
}

interface BotRunsResponse {
  runs: BotRun[];
  nextCursor: string | null;
}

interface RunItem {
  id: string;
  title: string;
  subtitle: string;
  status: RunStatus;
}

const RUNS_BRANDING: AgentBranding = {
  label: "Autonomous Run",
  accentClass: "text-amber-800 dark:text-amber-300",
  bgClass: "bg-amber-500/8",
  containerBgClass: "bg-arena-elements-background-depth-2/30",
  borderClass: "border-amber-500/20",
  iconClass: "i-ph:robot",
  textClass: "text-amber-800 dark:text-amber-300",
};

function extractRunsErrorMessage(error: unknown): string | null {
  if (!error) return null;

  const raw = error instanceof Error ? error.message : String(error);
  if (!raw) return null;

  if (/HTTP 404/i.test(raw)) {
    return "Stored transcript could not be reloaded. Showing the saved run summary instead.";
  }

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRunStatus(value: unknown): RunStatus {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "interrupted":
      return value;
    default:
      return "failed";
  }
}

function parseWorkflowKind(value: unknown): WorkflowKind {
  switch (value) {
    case "trading":
    case "research":
    case "conversation":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function parseRunsResponse(payload: unknown): BotRunsResponse {
  const root = asRecord(payload);
  const rawRuns = Array.isArray(root?.runs) ? root.runs : [];

  return {
    runs: rawRuns
      .map((entry) => {
        const run = asRecord(entry);
        const runId = asString(run?.run_id);
        const workflowId = asNumber(run?.workflow_id);
        const startedAt = asNumber(run?.started_at);
        if (!runId || workflowId == null || startedAt == null) {
          return null;
        }

        return {
          runId,
          workflowId,
          workflowKind: parseWorkflowKind(run?.workflow_kind),
          status: parseRunStatus(run?.status),
          startedAt,
          completedAt: asNumber(run?.completed_at),
          sessionId: asString(run?.session_id),
          transcriptAvailable: Boolean(run?.transcript_available),
          traceId: asString(run?.trace_id),
          durationMs: asNumber(run?.duration_ms) ?? 0,
          inputTokens: asNumber(run?.input_tokens) ?? 0,
          outputTokens: asNumber(run?.output_tokens) ?? 0,
          result: asString(run?.result),
          error: asString(run?.error),
        } satisfies BotRun;
      })
      .filter((run): run is BotRun => run !== null),
    nextCursor: asString(root?.next_cursor),
  };
}

function formatRunTimestamp(timestampSeconds: number): string {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return "Unknown time";
  }

  return new Date(timestampSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "n/a";
  }

  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }

  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainderSeconds}s`;
}

function getWorkflowKindLabel(kind: WorkflowKind): string {
  switch (kind) {
    case "trading":
      return "Trading Run";
    case "research":
      return "Research Run";
    case "conversation":
      return "Conversation Run";
    default:
      return "Autonomous Run";
  }
}

function getWorkflowKindDescription(kind: WorkflowKind): string {
  switch (kind) {
    case "trading":
      return "Main autonomous trading cycle";
    case "research":
      return "Longer-horizon market research cycle";
    case "conversation":
      return "Internal autonomous conversation cycle";
    default:
      return "Autonomous execution";
  }
}

function getStatusBadgeClass(status: RunStatus): string {
  switch (status) {
    case "running":
      return "border-amber-500/20 bg-amber-500/8 text-amber-700 dark:text-amber-300";
    case "completed":
      return "border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
    case "interrupted":
      return "border-slate-500/20 bg-slate-500/8 text-slate-700 dark:text-slate-300";
    case "failed":
    default:
      return "border-crimson-500/20 bg-crimson-500/8 text-crimson-600 dark:text-crimson-300";
  }
}

function getStatusLabel(status: RunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
    default:
      return "Failed";
  }
}

function getRunTitle(run: BotRun): string {
  return getWorkflowKindLabel(run.workflowKind);
}

function getRunSubtitle(run: BotRun): string {
  return `${formatRunTimestamp(run.startedAt)} • ${getStatusLabel(run.status)}`;
}

function deriveTranscriptSessionId(botId: string, run: BotRun): string | null {
  if (!Number.isFinite(run.startedAt) || run.startedAt <= 0) {
    return null;
  }

  switch (run.workflowKind) {
    case "trading":
      return `fast-${botId}-${run.startedAt}`;
    case "research":
      return `research-${botId}-${run.startedAt}`;
    case "conversation":
      return `convo-${botId}-${run.startedAt}`;
    default:
      return null;
  }
}

function resolveTranscriptSessionId(botId: string, run: BotRun | null): string {
  if (!run?.transcriptAvailable) {
    return "";
  }

  if (run.sessionId) {
    return run.sessionId;
  }

  return deriveTranscriptSessionId(botId, run) ?? "";
}

function RunsStatus({ status }: { status: "idle" | "running" | "error" }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2 w-2 rounded-full ${
          status === "running"
            ? "bg-amber-400 animate-pulse"
            : status === "error"
              ? "bg-crimson-400"
              : "bg-emerald-700 dark:bg-emerald-400"
        }`}
      />
      <span className="text-xs font-data text-arena-elements-textSecondary">
        {status === "running"
          ? "A bot run is in progress..."
          : status === "error"
            ? "Run transcript error"
            : "Idle"}
      </span>
    </div>
  );
}

function RunsBanner({
  run,
  isStreaming,
  error,
}: {
  run: BotRun | null;
  isStreaming: boolean;
  error: string | null;
}) {
  if (!run) {
    return null;
  }

  if (error && !isStreaming) {
    const transcriptReloadOnly =
      run.status === "completed" || run.status === "interrupted";

    return (
      <div
        className={
          transcriptReloadOnly
            ? "border-b border-amber-500/15 bg-amber-500/5 px-3 py-2"
            : "border-b border-crimson-500/20 bg-crimson-500/5 px-3 py-2"
        }
      >
        <div className="flex items-center gap-2">
          <span
            className={
              transcriptReloadOnly
                ? "rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                : "rounded-full bg-crimson-500/10 px-2 py-0.5 text-[11px] font-medium text-crimson-600 dark:text-crimson-300"
            }
          >
            {transcriptReloadOnly ? "History" : "Failed"}
          </span>
          <span
            className={
              transcriptReloadOnly
                ? "truncate text-xs text-amber-800 dark:text-amber-200"
                : "truncate text-xs text-crimson-600/90 dark:text-crimson-300/90"
            }
          >
            {error}
          </span>
        </div>
      </div>
    );
  }

  if (run.status === "running") {
    return (
      <div className="border-b border-amber-500/15 bg-amber-500/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            Live
          </span>
          <span className="text-xs text-arena-elements-textSecondary">
            {run.transcriptAvailable
              ? "This autonomous run is updating in real time. The transcript is read only."
              : "This run is active. Details will update here even if no transcript session is attached."}
          </span>
        </div>
      </div>
    );
  }

  return null;
}

function RunsSidebar({
  runs,
  activeRunId,
  stacked,
  hasOlderRuns,
  isLoadingOlderRuns,
  onSelect,
  onLoadOlder,
}: {
  runs: RunItem[];
  activeRunId: string;
  stacked: boolean;
  hasOlderRuns: boolean;
  isLoadingOlderRuns: boolean;
  onSelect: (id: string) => void;
  onLoadOlder: () => void;
}) {
  return (
    <aside
      className={
        stacked
          ? "flex w-full shrink-0 flex-col overflow-hidden border-b border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40"
          : "flex min-h-0 w-[320px] basis-[320px] shrink-0 flex-col overflow-hidden border-r border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40"
      }
    >
      <div className="border-b border-arena-elements-dividerColor/50 px-3 py-2.5">
        <span className="text-xs font-display font-semibold uppercase tracking-wider text-arena-elements-textSecondary">
          Runs
        </span>
      </div>

      <div
        className={
          stacked
            ? "max-h-56 overflow-y-auto py-1"
            : "min-h-0 flex-1 overflow-y-auto py-1"
        }
      >
        {runs.length === 0 ? (
          <div className="px-3 py-3 text-[11px] font-data text-arena-elements-textTertiary">
            No autonomous runs yet
          </div>
        ) : (
          <>
            {runs.map((run) => {
              const isActive = run.id === activeRunId;
              return (
                <button
                  key={run.id}
                  className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                    isActive
                      ? "bg-arena-elements-item-backgroundActive"
                      : "hover:bg-arena-elements-item-backgroundHover"
                  }`}
                  onClick={() => onSelect(run.id)}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      run.status === "running"
                        ? "bg-amber-400"
                        : run.status === "completed"
                          ? "bg-emerald-500"
                          : run.status === "interrupted"
                            ? "bg-slate-500"
                            : "bg-crimson-500"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-display font-medium text-arena-elements-textPrimary">
                      {run.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <div className="truncate text-[11px] font-data text-arena-elements-textTertiary">
                        {run.subtitle}
                      </div>
                      <span
                        className={`rounded-full border px-1.5 py-0.5 text-[10px] font-data ${getStatusBadgeClass(run.status)}`}
                      >
                        {getStatusLabel(run.status)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
            {hasOlderRuns ? (
              <div className="border-t border-arena-elements-dividerColor/40 px-3 py-2">
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/35 px-2 py-1.5 text-[11px] font-data text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={onLoadOlder}
                  disabled={isLoadingOlderRuns}
                >
                  <span
                    className={
                      isLoadingOlderRuns
                        ? "i-ph:arrow-clockwise animate-spin text-sm"
                        : "i-ph:clock-counter-clockwise text-sm"
                    }
                  />
                  {isLoadingOlderRuns ? "Loading..." : "Load older"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/20 p-3">
      <div className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
        {label}
      </div>
      <div className="mt-1 text-sm font-data text-arena-elements-textPrimary">
        {value}
      </div>
    </div>
  );
}

function RunDetailPanel({ run }: { run: BotRun }) {
  const failureTitle =
    run.status === "failed" && !run.transcriptAvailable
      ? "Run failed before a transcript was available"
      : run.status === "interrupted"
        ? "Run was interrupted before it fully completed"
        : "Transcript unavailable";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-arena-elements-dividerColor/50 px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
            <span className="i-ph:robot text-lg" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-display font-semibold text-arena-elements-textPrimary">
                {failureTitle}
              </h3>
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-data ${getStatusBadgeClass(run.status)}`}
              >
                {getStatusLabel(run.status)}
              </span>
            </div>
            <p className="mt-1 text-sm text-arena-elements-textSecondary">
              {getWorkflowKindDescription(run.workflowKind)} started{" "}
              {formatRunTimestamp(run.startedAt)}.
            </p>
          </div>
        </div>
      </div>

      <div className="overflow-y-auto px-4 py-4">
        {(run.error || run.result) && (
          <div className="mb-4 rounded-xl border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/20 p-4">
            <div className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
              {run.error ? "Error" : "Result"}
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-arena-elements-textPrimary">
              {run.error ?? run.result}
            </pre>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <RunMetric
            label="Workflow"
            value={getWorkflowKindLabel(run.workflowKind)}
          />
          <RunMetric
            label="Started"
            value={formatRunTimestamp(run.startedAt)}
          />
          <RunMetric
            label="Completed"
            value={
              run.completedAt
                ? formatRunTimestamp(run.completedAt)
                : "Still running"
            }
          />
          <RunMetric label="Duration" value={formatDuration(run.durationMs)} />
          <RunMetric label="Input Tokens" value={run.inputTokens.toString()} />
          <RunMetric
            label="Output Tokens"
            value={run.outputTokens.toString()}
          />
          <RunMetric label="Trace ID" value={run.traceId ?? "n/a"} />
          <RunMetric label="Run ID" value={run.runId} />
          <RunMetric
            label="Transcript"
            value={run.transcriptAvailable ? "Available" : "Not captured"}
          />
        </div>
      </div>
    </div>
  );
}

export function RunsTab({
  botId,
  botName,
  operatorApiUrl,
  operatorKind,
  verificationState,
}: RunsTabProps) {
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
    error: authError,
  } = useOperatorAuth(baseApiUrl);

  const [activeRunId, setActiveRunId] = useState("");
  const [isStackedLayout, setIsStackedLayout] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 1100,
  );
  const runsCacheKey = `${baseApiUrl}::${botId}::runs`;

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

  const runsQuery = useInfiniteQuery({
    queryKey: ["bot-runs", apiUrl, token, botId],
    enabled: isAuthenticated && !!apiUrl && !!token,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const cursor =
        typeof pageParam === "string" && pageParam.length > 0
          ? pageParam
          : null;
      const response = await fetch(
        `${apiUrl}/runs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          (await response.text()) || `Failed to load runs: ${response.status}`,
        );
      }

      return parseRunsResponse(await response.json());
    },
    getNextPageParam: (lastPage: BotRunsResponse) =>
      lastPage.nextCursor ?? undefined,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const payload = query.state.data as
        | { pages?: BotRunsResponse[] }
        | undefined;
      return payload?.pages?.some((page) =>
        page.runs.some((run) => run.status === "running"),
      )
        ? 5_000
        : false;
    },
  });

  const runs = useMemo(() => {
    const seen = new Set<string>();
    return (
      runsQuery.data?.pages.flatMap((page) =>
        page.runs.filter((run) => {
          if (seen.has(run.runId)) {
            return false;
          }
          seen.add(run.runId);
          return true;
        }),
      ) ?? []
    );
  }, [runsQuery.data]);

  useEffect(() => {
    if (runs.length === 0) {
      if (activeRunId) {
        setActiveRunId("");
      }
      return;
    }

    if (!activeRunId || !runs.some((run) => run.runId === activeRunId)) {
      setActiveRunId(runs[0]!.runId);
    }
  }, [activeRunId, runs]);

  const activeRun =
    runs.find((run) => run.runId === activeRunId) ?? runs[0] ?? null;
  const transcriptSessionId = resolveTranscriptSessionId(botId, activeRun);

  const stream = useBotSessionStream({
    apiUrl,
    token,
    sessionId: transcriptSessionId,
    enabled: isAuthenticated && !!apiUrl && !!transcriptSessionId,
    cacheKey: runsCacheKey,
  });

  const runItems: RunItem[] = useMemo(
    () =>
      runs.map((run) => ({
        id: run.runId,
        title: getRunTitle(run),
        subtitle: getRunSubtitle(run),
        status: run.status,
      })),
    [runs],
  );

  const runsErrorMessage = extractRunsErrorMessage(
    runsQuery.error instanceof Error ? runsQuery.error.message : null,
  );
  const streamErrorMessage = activeRun?.transcriptAvailable
    ? extractRunsErrorMessage(stream.error)
    : null;
  const headerTitle = activeRun ? getRunTitle(activeRun) : "Autonomous Run";
  const headerSubtitle = activeRun
    ? `${getWorkflowKindDescription(activeRun.workflowKind)} • ${formatRunTimestamp(activeRun.startedAt)}`
    : "Read-only execution history";
  const runStatus =
    activeRun?.status === "running"
      ? "running"
      : streamErrorMessage
        ? "error"
        : "idle";

  if (operatorMeta && !operatorMeta.features.chat) {
    return <UnsupportedFeatureCard feature="Runs" />;
  }

  if (!apiUrl) {
    return (
      <div className="glass-card rounded-xl py-16 text-center text-arena-elements-textSecondary">
        <div className="i-ph:robot mx-auto mb-3 text-3xl text-arena-elements-textTertiary" />
        Runs are not ready yet for this operator.
      </div>
    );
  }

  if (verificationState === "unverified") {
    return (
      <OperatorAccessCard
        title="Runs unavailable"
        description="Run history stays disabled until this bot has been freshly verified against the operator."
        apiUrl={baseApiUrl}
      />
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthBanner
        onAuth={authenticate}
        isAuthenticating={isAuthenticating}
        error={authError}
      />
    );
  }

  if (runsQuery.isLoading) {
    return (
      <div className="glass-card rounded-xl py-16 text-center text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise mx-auto mb-3 animate-spin text-3xl text-arena-elements-textTertiary" />
        Loading autonomous runs...
      </div>
    );
  }

  if (runsQuery.error) {
    return (
      <div className="glass-card rounded-xl py-16 text-center text-arena-elements-textSecondary">
        <div className="i-ph:warning-circle mx-auto mb-3 text-3xl text-crimson-500" />
        <p className="text-sm text-crimson-600 dark:text-crimson-300">
          {runsErrorMessage ?? "Failed to load autonomous runs."}
        </p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="glass-card rounded-xl border border-arena-elements-dividerColor p-6 text-center sm:p-8">
        <div className="i-ph:robot mx-auto mb-3 text-3xl text-amber-500" />
        <h3 className="mb-2 text-lg font-display font-semibold text-arena-elements-textPrimary">
          No runs yet
        </h3>
        <p className="mx-auto max-w-xl text-sm text-arena-elements-textSecondary">
          Autonomous activity will appear here once {botName} starts gathering
          data, reasoning through a cycle, and making decisions on its own.
        </p>
      </div>
    );
  }

  return (
    <div
      data-sandbox-ui="true"
      data-sandbox-theme="vault"
      className="arena-chat-shell glass-card overflow-hidden rounded-xl"
      style={{ minHeight: "560px" }}
    >
      <div
        className={`flex h-[min(640px,68vh)] min-h-[560px] min-w-0 ${isStackedLayout ? "flex-col" : "flex-row"}`}
      >
        <RunsSidebar
          runs={runItems}
          activeRunId={activeRun?.runId ?? ""}
          stacked={isStackedLayout}
          hasOlderRuns={runsQuery.hasNextPage}
          isLoadingOlderRuns={runsQuery.isFetchingNextPage}
          onSelect={setActiveRunId}
          onLoadOlder={() => {
            void runsQuery.fetchNextPage();
          }}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/25 px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="i-ph:robot text-sm text-amber-700 dark:text-amber-300" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-display font-medium text-arena-elements-textPrimary">
                  {headerTitle}
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="truncate text-[11px] font-data text-arena-elements-textTertiary">
                    {headerSubtitle}
                  </div>
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[10px] font-data ${getStatusBadgeClass(activeRun?.status ?? "failed")}`}
                  >
                    {getStatusLabel(activeRun?.status ?? "failed")}
                  </span>
                </div>
              </div>
            </div>
            <span className="hidden rounded-full border border-amber-500/15 bg-amber-500/8 px-2 py-1 text-[11px] font-data text-amber-700 dark:text-amber-300 sm:inline-flex">
              Operator relay
            </span>
          </div>

          <RunsBanner
            run={activeRun}
            isStreaming={stream.isStreaming}
            error={streamErrorMessage}
          />

          <div className="border-b border-amber-500/15 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            This view shows autonomous bot activity only. Use the Chat tab for
            manual conversations with the bot.
          </div>

          <div className="min-h-0 flex-1 bg-arena-elements-background-depth-1/15">
            {activeRun?.transcriptAvailable &&
            transcriptSessionId &&
            !streamErrorMessage ? (
              <ChatTranscript
                messages={stream.messages}
                partMap={stream.partMap}
                isStreaming={stream.isStreaming}
                branding={RUNS_BRANDING}
                placeholder="This transcript is read only"
              />
            ) : activeRun ? (
              <RunDetailPanel run={activeRun} />
            ) : null}
          </div>

          <div className="border-t border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/20 px-3 py-2">
            <RunsStatus status={runStatus} />
          </div>
        </div>
      </div>
    </div>
  );
}
