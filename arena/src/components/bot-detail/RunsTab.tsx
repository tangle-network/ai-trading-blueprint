import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { AgentBranding, SessionPart } from "@tangle-network/sandbox-ui/types";
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
import {
  buildRunReplayHistoryPath,
  buildRunReplaySessionId,
  chooseDefaultRun,
  formatDuration,
  formatRunTimestamp,
  getStatusBadgeClass,
  getStatusLabel,
  getWorkflowKindDescription,
  getWorkflowKindLabel,
  hasReplayableRunTrace,
  parseRunsResponse,
  resolveTranscriptSessionId,
  type BotRun,
  type BotRunsResponse,
  type RunStatus,
} from "~/lib/botRuns";
import {
  buildDecisionItemsFromRuns,
  buildRunResultSections,
  getRunSignalLabel,
  parseRunResultJson,
  type DecisionFeedItem,
} from "~/lib/decisionFeed";
import type { BotOperatorKind, BotVerificationState } from "~/lib/types/bot";
import { UnverifiedDataNotice } from "./shared/DataAccessNotices";
import { DecisionActivityStrip } from "./shared/DecisionActivityStrip";
import { DecisionInspector } from "./shared/DecisionInspector";
import { TerminalEmptyState } from "./shared/WorkspacePrimitives";

interface RunsTabProps {
  botId: string;
  botName: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
  immersive?: boolean;
  surface?: "runs" | "chat";
}

interface RunItem {
  id: string;
  title: string;
  subtitle: string;
  status: RunStatus;
  durationLabel: string;
  tokenLabel: string;
  signalLabel: string;
}

interface RunsSummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
}

const RUNS_BRANDING: AgentBranding = {
  label: "Autonomous Trace",
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

function isRunsAuthError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return /HTTP (401|403)/i.test(raw) || /unauthorized|forbidden/i.test(raw);
}

function getRunTitle(run: BotRun): string {
  return getWorkflowKindLabel(run.workflowKind);
}

function getRunSubtitle(run: BotRun): string {
  return formatRunTimestamp(run.startedAt);
}

function getRunTokenLabel(run: BotRun): string {
  const total = run.inputTokens + run.outputTokens;
  if (total <= 0) return "tokens n/a";
  if (total >= 1_000) return `${(total / 1_000).toFixed(total >= 10_000 ? 0 : 1)}k tok`;
  return `${total} tok`;
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
  summary,
  activeRunId,
  surfaceLabel,
  emptyLabel,
  ariaLabel,
  stacked,
  compactStacked,
  collapsed,
  hasOlderRuns,
  isLoadingOlderRuns,
  onSelect,
  onLoadOlder,
  onToggleCollapsed,
}: {
  runs: RunItem[];
  summary: RunsSummary;
  activeRunId: string;
  surfaceLabel: string;
  emptyLabel: string;
  ariaLabel: string;
  stacked: boolean;
  compactStacked: boolean;
  collapsed: boolean;
  hasOlderRuns: boolean;
  isLoadingOlderRuns: boolean;
  onSelect: (id: string) => void;
  onLoadOlder: () => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      className={
        stacked
          ? "flex w-full shrink-0 flex-col overflow-hidden border-b border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40"
          : `flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/40 transition-[width,flex-basis] duration-200 ${collapsed ? "w-14 basis-14" : "w-[236px] basis-[236px]"}`
      }
    >
      <div className={`border-b border-arena-elements-dividerColor/50 ${collapsed ? "px-2 py-3" : "px-3 py-2.5"}`}>
        <div className={`flex items-center gap-3 ${collapsed ? "justify-center" : "justify-between"}`}>
          {!collapsed && (
            <div className="min-w-0">
              <span className="block truncate text-sm font-display font-semibold text-arena-elements-textPrimary">
                {surfaceLabel} history
              </span>
              <span className="block truncate font-data text-xs text-arena-elements-textTertiary">
                {summary.total.toLocaleString()} {summary.total === 1 ? "entry" : "entries"}
              </span>
            </div>
          )}
          {!stacked && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="flex h-8 w-8 items-center justify-center rounded-md text-arena-elements-textTertiary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
              title={collapsed ? `Expand ${surfaceLabel.toLowerCase()}` : `Collapse ${surfaceLabel.toLowerCase()}`}
              aria-label={collapsed ? `Expand ${surfaceLabel.toLowerCase()}` : `Collapse ${surfaceLabel.toLowerCase()}`}
            >
              <span className={collapsed ? "i-ph:caret-right-bold text-base" : "i-ph:caret-left-bold text-base"} />
            </button>
          )}
        </div>
        {!collapsed && summary.total > 0 && (
          <div className="mt-2 flex min-w-0 items-center gap-2 font-data text-[11px] text-arena-elements-textTertiary">
            <span className="truncate"><b className="font-semibold text-arena-elements-textPrimary">{summary.running}</b> live</span>
            <span aria-hidden="true">/</span>
            <span className="truncate"><b className="font-semibold text-arena-elements-textPrimary">{summary.completed}</b> done</span>
            <span aria-hidden="true">/</span>
            <span className="truncate"><b className="font-semibold text-arena-elements-textPrimary">{summary.failed}</b> fail</span>
          </div>
        )}
      </div>

      <div
        className={
          stacked
            ? `${compactStacked ? "max-h-40" : "max-h-72"} overflow-y-auto py-1`
            : "min-h-0 flex-1 overflow-y-auto py-1"
        }
        tabIndex={0}
        aria-label={ariaLabel}
      >
        {runs.length === 0 ? (
          <div className={`${collapsed ? "px-2 text-center" : "px-4"} py-4 text-sm font-data text-arena-elements-textTertiary`}>
            {emptyLabel}
          </div>
        ) : (
          <>
            {runs.map((run) => {
              const isActive = run.id === activeRunId;
              if (collapsed) {
                return (
                  <button
                    key={run.id}
                    type="button"
                    title={`${run.title} · ${run.signalLabel}`}
                    aria-pressed={isActive}
                    className={`mx-1.5 my-1 flex h-10 w-10 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 ${
                      isActive
                        ? "bg-arena-elements-item-backgroundActive"
                        : "hover:bg-arena-elements-item-backgroundHover"
                    }`}
                    onClick={() => onSelect(run.id)}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        run.status === "running"
                          ? "bg-amber-400 animate-pulse"
                          : run.status === "completed"
                            ? "bg-emerald-500"
                            : run.status === "interrupted"
                              ? "bg-slate-500"
                              : "bg-crimson-500"
                      }`}
                    />
                  </button>
                );
              }
              return (
                <button
                  key={run.id}
                  aria-pressed={isActive}
                    className={`group grid w-full grid-cols-[10px_minmax(0,1fr)] gap-2.5 border-l-2 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 ${
                    isActive
                      ? "border-amber-500 bg-arena-elements-item-backgroundActive"
                      : "border-transparent hover:bg-arena-elements-item-backgroundHover"
                  }`}
                  onClick={() => onSelect(run.id)}
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
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
                    <div className="grid min-w-0 gap-1">
                      <div className="truncate text-[15px] font-display font-semibold text-arena-elements-textPrimary">
                        {run.title}
                      </div>
                    </div>
                    <div className="mt-0.5 truncate text-xs font-data text-arena-elements-textTertiary">
                      {run.subtitle}
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 font-data text-[11px] text-arena-elements-textTertiary">
                      <span className={run.status === "running" ? "text-amber-400" : run.status === "completed" ? "text-emerald-400" : run.status === "interrupted" ? "text-slate-400" : "text-crimson-400"}>
                        {getStatusLabel(run.status)}
                      </span>
                      <span aria-hidden="true">/</span>
                      <span className="truncate">
                        {run.signalLabel}
                      </span>
                      <span aria-hidden="true">/</span>
                      <span className="shrink-0">
                        {run.durationLabel}
                      </span>
                      <span aria-hidden="true">/</span>
                      <span className="shrink-0">
                        {run.tokenLabel}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
            {hasOlderRuns && !collapsed ? (
              <div className="border-t border-arena-elements-dividerColor/40 px-3 py-2">
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/35 px-3 py-2 text-sm font-data text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 disabled:cursor-not-allowed disabled:opacity-60"
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
                  {isLoadingOlderRuns ? "Loading…" : "Load Older"}
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
      <div className="text-sm font-data font-medium text-arena-elements-textSecondary">
        {label}
      </div>
      <div className="mt-1 break-words text-base font-data text-arena-elements-textPrimary">
        {value}
      </div>
    </div>
  );
}

function RunMetricPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-arena-elements-dividerColor/55 bg-arena-elements-background-depth-2/45 px-2.5 py-1 font-data text-xs text-arena-elements-textSecondary">
      <span className="text-arena-elements-textTertiary">{label}</span>
      <span className="text-arena-elements-textPrimary">{value}</span>
    </span>
  );
}

function countToolParts(partMap: Record<string, SessionPart[]>): number {
  const toolIds = new Set<string>();
  for (const parts of Object.values(partMap ?? {})) {
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type !== "tool") continue;
      const id = typeof part.id === "string" ? part.id : `${part.tool}:${toolIds.size}`;
      toolIds.add(id);
    }
  }
  return toolIds.size;
}

function TraceCockpitMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[5px] border border-[#273035] bg-[#081013] px-2.5 py-2">
      <div className="truncate font-data text-[10px] font-semibold uppercase tracking-[0.12em] text-[#697371]">
        {label}
      </div>
      <div className="mt-0.5 truncate font-data text-base font-bold text-[#f6fefd]" title={value}>
        {value}
      </div>
    </div>
  );
}

function TraceCockpit({
  run,
  decisionItem,
  toolCount,
}: {
  run: BotRun;
  decisionItem?: DecisionFeedItem;
  toolCount: number;
}) {
  const traceLabel = run.traceId ?? run.runId;
  const thesis = decisionItem?.reason || decisionItem?.title || "Run evidence captured.";
  const statusLabel = getStatusLabel(run.status);
  const signalLabel = getRunSignalLabel(run);
  const workflowLabel = getWorkflowKindLabel(run.workflowKind);
  const instrumentLabel =
    decisionItem?.instrumentLabel && decisionItem.instrumentLabel !== "n/a"
      ? decisionItem.instrumentLabel
      : workflowLabel;
  const hasActionSignal = signalLabel !== statusLabel.toUpperCase();
  const hasInstrumentContext = instrumentLabel !== "Trace" && instrumentLabel !== workflowLabel;
  const primaryLabel = hasActionSignal
    ? signalLabel
    : hasInstrumentContext
      ? instrumentLabel
      : "Run summary";
  const secondaryContextParts = [
    hasActionSignal && hasInstrumentContext ? instrumentLabel : null,
    decisionItem?.notionalLabel ?? null,
  ].filter(Boolean);
  const contextLabel = secondaryContextParts.length > 0
    ? secondaryContextParts.join(" / ")
    : "Evidence replay";
  const toolLabel = toolCount > 0
    ? `${toolCount.toLocaleString()} ${toolCount === 1 ? "tool" : "tools"}`
    : "n/a";

  return (
    <section className="shrink-0 border-b border-[#273035] bg-[#0b1418] px-3 py-2.5" aria-label="Selected run summary">
      <div className="grid min-w-0 gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(330px,0.5fr)]">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={`shrink-0 rounded-[5px] border px-2 py-1 font-data text-[11px] font-bold uppercase tracking-[0.12em] ${getStatusBadgeClass(run.status)}`}
            >
              {statusLabel}
            </span>
            <span className="truncate font-display text-lg font-semibold text-[#f6fefd]">
              {primaryLabel}
            </span>
            <span className="truncate font-data text-xs text-[#949e9c]">
              {formatRunTimestamp(run.startedAt)}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 font-data text-sm font-semibold text-[#50d2c1]" title={traceLabel}>
            <span className="truncate">{contextLabel}</span>
          </div>
          <p className="mt-1 truncate text-[15px] leading-6 text-[#d2dad7]" title={thesis}>
            {thesis}
          </p>
          <span className="sr-only">{traceLabel}</span>
        </div>
        <div className="grid min-w-0 grid-cols-3 gap-2">
          <TraceCockpitMetric label="Time" value={formatDuration(run.durationMs)} />
          <TraceCockpitMetric label="Tokens" value={getRunTokenLabel(run)} />
          <TraceCockpitMetric label="Tools" value={toolLabel} />
        </div>
      </div>
    </section>
  );
}

function RunResultSummary({ result }: { result: string }) {
  const parsed = useMemo(() => parseRunResultJson(result), [result]);
  const sections = useMemo(
    () => (parsed ? buildRunResultSections(parsed) : []),
    [parsed],
  );

  if (!parsed || sections.length === 0) {
    return (
      <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-arena-elements-textPrimary">
        {result}
      </pre>
    );
  }

  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      {sections.map((section) => (
        <section
          key={section.title}
          className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/25 p-3"
        >
          <h4 className="text-xs font-display font-semibold text-arena-elements-textPrimary">
            {section.title}
          </h4>
          <dl className="mt-2 space-y-1.5">
            {section.items.map((item) => (
              <div key={`${section.title}-${item.label}`} className="grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)]">
                <dt className="text-[12px] font-data font-medium text-arena-elements-textSecondary">
                  {item.label}
                </dt>
                <dd className="break-words text-sm font-data text-arena-elements-textPrimary">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function getNoTranscriptRunTitle(run: BotRun): string {
  if (run.error) {
    return run.status === "interrupted"
      ? "Run interrupted"
      : "Run failed before details were captured";
  }

  if (run.result) {
    switch (run.workflowKind) {
      case "trading":
        return "Trading run details";
      case "research":
        return "Research run details";
      case "conversation":
        return "Conversation run details";
      default:
        return "Run details";
    }
  }

  return "Run details unavailable";
}

function RunDetailPanel({ run }: { run: BotRun }) {
  const title = getNoTranscriptRunTitle(run);

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
                {title}
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

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        tabIndex={0}
        aria-label="Run details"
      >
        {(run.error || run.result) && (
          <div className="mb-4 rounded-xl border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/20 p-4">
            <div className="text-[12px] font-data font-medium text-arena-elements-textSecondary">
              {run.error ? "Error" : "Result"}
            </div>
            {run.error ? (
              <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-arena-elements-textPrimary">
                {run.error}
              </pre>
            ) : run.result ? (
              <RunResultSummary result={run.result} />
            ) : null}
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
            value={
              run.transcriptAvailable
                ? "Full transcript"
                : run.result || run.error
                  ? "Structured replay"
                  : "Not captured"
            }
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
  immersive = false,
  surface = "runs",
}: RunsTabProps) {
  const baseApiUrl = operatorApiUrl ?? "";
  const { data: operatorMeta } = useOperatorMeta(baseApiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
  const needsAuth = deploymentKind !== "fleet";
  const apiUrl =
    operatorMeta && baseApiUrl
      ? `${baseApiUrl}${buildBotScopedPathForDeploymentKind(deploymentKind, botId)}`
      : "";
  const {
    token,
    isAuthenticated,
  } = useOperatorAuth(baseApiUrl);

  const [activeRunId, setActiveRunId] = useState("");
  const [isStackedLayout, setIsStackedLayout] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.innerWidth < (immersive ? 860 : 1100),
  );
  const [runsSidebarCollapsed, setRunsSidebarCollapsed] = useState(false);
  const runsCacheKey = `${baseApiUrl}::${botId}::runs`;
  const authKey = token ?? "anonymous";

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

  const runsQuery = useInfiniteQuery({
    queryKey: ["bot-runs", apiUrl, authKey, botId],
    enabled: !!apiUrl,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const cursor =
        typeof pageParam === "string" && pageParam.length > 0
          ? pageParam
          : null;
      const response = await fetch(
        `${apiUrl}/runs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        {
          headers: needsAuth && token ? { Authorization: `Bearer ${token}` } : {},
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${body || "Failed to load runs"}`,
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
      setActiveRunId(chooseDefaultRun(runs)?.runId ?? "");
    }
  }, [activeRunId, runs]);

  const activeRun =
    runs.find((run) => run.runId === activeRunId) ?? chooseDefaultRun(runs);
  const rawTranscriptSessionId = resolveTranscriptSessionId(botId, activeRun);
  const canStreamTranscript = Boolean(
    rawTranscriptSessionId && isAuthenticated && token,
  );
  const canReplayRunTrace = hasReplayableRunTrace(activeRun);
  const replaySessionId = buildRunReplaySessionId(activeRun);
  const transcriptSessionId = canStreamTranscript
    ? rawTranscriptSessionId
    : replaySessionId;
  const replayHistoryPath =
    !canStreamTranscript && activeRun
      ? buildRunReplayHistoryPath(activeRun)
      : undefined;

  const stream = useBotSessionStream({
    apiUrl,
    token,
    sessionId: transcriptSessionId,
    enabled: !!apiUrl && Boolean(activeRun) && (canStreamTranscript || canReplayRunTrace),
    cacheKey: runsCacheKey,
    historyPath: replayHistoryPath,
    streamEnabled: canStreamTranscript,
  });

  const runItems: RunItem[] = useMemo(
    () =>
      runs.map((run) => ({
        id: run.runId,
        title: getRunTitle(run),
        subtitle: getRunSubtitle(run),
        status: run.status,
        durationLabel: formatDuration(run.durationMs),
        tokenLabel: getRunTokenLabel(run),
        signalLabel: getRunSignalLabel(run),
      })),
    [runs],
  );
  const decisionItems = useMemo(
    () => buildDecisionItemsFromRuns(runs),
    [runs],
  );
  const runSummary = useMemo<RunsSummary>(() => ({
    total: runs.length,
    running: runs.filter((run) => run.status === "running").length,
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "interrupted").length,
  }), [runs]);
  const showRunsSidebar =
    immersive || runs.length > 1 || Boolean(runsQuery.hasNextPage);
  const showDecisionActivityStrip = decisionItems.length > 0 && !showRunsSidebar;
  const showDecisionInspector = decisionItems.length > 0;
  const surfaceCopy = surface === "chat"
    ? {
        label: "Chat",
        ariaLabel: "Public chat traces",
        emptyLabel: "No chat traces yet",
      }
    : {
        label: "Runs",
        ariaLabel: "Autonomous runs",
        emptyLabel: "No autonomous runs yet",
      };

  const runsErrorMessage = extractRunsErrorMessage(
    runsQuery.error instanceof Error ? runsQuery.error.message : null,
  );
  const streamErrorMessage = activeRun?.transcriptAvailable
    && canStreamTranscript
    ? extractRunsErrorMessage(stream.error)
    : null;
  const traceReplayFailed = canReplayRunTrace && !canStreamTranscript && Boolean(stream.error);
  const hasVisibleReplayMessages = stream.isStreaming || stream.messages.length > 0;
  const shouldShowTraceReplay =
    (canStreamTranscript || canReplayRunTrace) &&
    (canStreamTranscript || activeRun?.transcriptAvailable || hasVisibleReplayMessages) &&
    !traceReplayFailed &&
    !streamErrorMessage;
  const selectedDecisionId = activeRun ? `run:${activeRun.runId}` : undefined;
  const selectedDecisionItem =
    decisionItems.find((item) => item.id === selectedDecisionId) ?? decisionItems[0];
  const runsBranding = useMemo<AgentBranding>(
    () => ({
      ...RUNS_BRANDING,
      label: botName || RUNS_BRANDING.label,
    }),
    [botName],
  );
  const headerTitle = activeRun ? getRunTitle(activeRun) : "Autonomous Trace";
  const headerSubtitle = activeRun
    ? `${getWorkflowKindDescription(activeRun.workflowKind)} • ${formatRunTimestamp(activeRun.startedAt)}`
    : "Execution history";
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

  if (runsQuery.isLoading) {
    return (
      <div className="space-y-4">
        {verificationState === "unverified" && (
          <UnverifiedDataNotice subject="autonomous run history" />
        )}
          <div className="glass-card rounded-xl py-16 text-center text-arena-elements-textSecondary">
            <div className="i-ph:arrow-clockwise mx-auto mb-3 animate-spin text-3xl text-arena-elements-textTertiary" />
          Loading autonomous runs…
        </div>
      </div>
    );
  }

  if (runsQuery.error) {
    if (!isAuthenticated && isRunsAuthError(runsQuery.error)) {
      return (
        <OperatorAccessCard
          title="Run history owner-only"
          description="This operator does not expose public run summaries for this agent. Sign with the owner wallet to read the full run history."
          apiUrl={baseApiUrl}
        />
      );
    }

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
      <div className={immersive ? "h-full min-h-0" : "space-y-4"}>
        {verificationState === "unverified" && (
          <UnverifiedDataNotice subject="autonomous run history" />
        )}
        <TerminalEmptyState
          title="No runs yet"
          description={`Autonomous runs will appear here once ${botName} starts gathering data, reasoning through a cycle, and making decisions.`}
          icon="i-ph:robot"
          className={immersive ? "h-full min-h-[360px]" : "min-h-[360px]"}
        />
      </div>
    );
  }

  return (
    <div className={immersive ? "h-full min-h-0" : "space-y-4"}>
      {verificationState === "unverified" && (
        <UnverifiedDataNotice subject="autonomous run history" />
      )}

      <div
        data-sandbox-ui="true"
        data-sandbox-theme="vault"
        className={immersive
          ? "arena-chat-shell arena-trace-terminal h-full overflow-hidden bg-[#081013] text-[#f6fefd]"
          : "arena-chat-shell arena-trace-terminal glass-card overflow-hidden rounded-xl bg-[#081013] text-[#f6fefd]"}
        style={
          immersive
            ? { height: "100%", minHeight: 0 }
            : { minHeight: "760px" }
        }
      >
        <div
          className={`flex min-w-0 ${immersive ? "h-full min-h-0" : "h-[min(1040px,calc(100vh-8rem))] min-h-[760px]"} ${isStackedLayout ? "flex-col" : "flex-row"}`}
        >
          {showRunsSidebar && (
            <RunsSidebar
              runs={runItems}
              summary={runSummary}
              activeRunId={activeRun?.runId ?? ""}
              surfaceLabel={surfaceCopy.label}
              emptyLabel={surfaceCopy.emptyLabel}
              ariaLabel={surfaceCopy.ariaLabel}
              stacked={isStackedLayout}
              compactStacked={immersive}
              collapsed={!isStackedLayout && runsSidebarCollapsed}
              hasOlderRuns={runsQuery.hasNextPage}
              isLoadingOlderRuns={runsQuery.isFetchingNextPage}
              onSelect={setActiveRunId}
              onLoadOlder={() => {
                void runsQuery.fetchNextPage();
              }}
              onToggleCollapsed={() => setRunsSidebarCollapsed((collapsed) => !collapsed)}
            />
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!immersive && (
              <div className="flex items-center gap-3 border-b border-[#273035] bg-[#0b1418] px-4 py-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="i-ph:robot text-base text-amber-700 dark:text-amber-300" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-display font-medium text-arena-elements-textPrimary">
                      {headerTitle}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-data text-arena-elements-textTertiary">
                        {headerSubtitle}
                      </div>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-data ${getStatusBadgeClass(activeRun?.status ?? "failed")}`}
                      >
                        {getStatusLabel(activeRun?.status ?? "failed")}
                      </span>
                    </div>
                    {activeRun && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <RunMetricPill label="Signal" value={getRunSignalLabel(activeRun)} />
                        <RunMetricPill label="Cycle" value={activeRun.runId} />
                        <RunMetricPill label="Duration" value={formatDuration(activeRun.durationMs)} />
                        <RunMetricPill label="Tokens" value={getRunTokenLabel(activeRun)} />
                        <RunMetricPill label="Trace" value={activeRun.traceId ? "captured" : "summary"} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <RunsBanner
              run={activeRun}
              isStreaming={stream.isStreaming}
              error={streamErrorMessage}
            />

            {immersive && activeRun && (
              <TraceCockpit
                run={activeRun}
                decisionItem={selectedDecisionItem}
                toolCount={countToolParts(stream.partMap)}
              />
            )}

            {showDecisionActivityStrip && (
              <DecisionActivityStrip
                items={decisionItems}
                selectedId={selectedDecisionItem?.id}
                onSelect={(item) => setActiveRunId(item.sourceId)}
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
                {shouldShowTraceReplay ? (
                  <ChatTranscript
                    messages={stream.messages}
                    partMap={stream.partMap}
                    isStreaming={stream.isStreaming}
                    branding={runsBranding}
                    placeholder="This run is read only"
                    variant="terminal"
                  />
                ) : activeRun ? (
                  <RunDetailPanel run={activeRun} />
                ) : null}
              </div>
              {showDecisionInspector && !isStackedLayout && (
                <DecisionInspector
                  item={selectedDecisionItem}
                  variant="terminal"
                  className="border-l border-[#273035]"
                />
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
