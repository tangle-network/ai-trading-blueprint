export type RunStatus = "running" | "completed" | "failed" | "interrupted";
export type WorkflowKind = "trading" | "research" | "conversation" | "observatory" | "unknown";
export type RunLoopMode = "deterministic" | "agentic";
export type RunLoopFilter = "agentic" | "deterministic" | "all";
export type IntelligenceUsageGranularity = "day" | "hour";

export interface BotRun {
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
  /** Optional fields newer operators report; null on older operators. */
  model: string | null;
  provider: string | null;
  costUsd: number | null;
  loopMode: RunLoopMode | null;
  harness: string | null;
}

export interface IntelligenceUsageBreakdown {
  id: string;
  label: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costKnownRunCount: number;
}

export interface IntelligenceUsageBucket extends IntelligenceUsageBreakdown {
  startedAt: number;
}

export interface IntelligenceUsageSummary {
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costKnownRunCount: number;
  windowStart: number | null;
  windowEnd: number | null;
  byWorkflow: IntelligenceUsageBreakdown[];
  byModel: IntelligenceUsageBreakdown[];
  timeline: IntelligenceUsageBucket[];
}

export interface BotRunsResponse {
  runs: BotRun[];
  nextCursor: string | null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
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
    case "observatory":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function parseLoopMode(value: unknown): RunLoopMode | null {
  return value === "deterministic" || value === "agentic" ? value : null;
}

export function parseRunsResponse(payload: unknown): BotRunsResponse {
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
          model: asString(run?.model),
          provider: asString(run?.provider),
          costUsd: asNumber(run?.cost_usd),
          loopMode: parseLoopMode(run?.loop_mode),
          harness: asString(run?.harness),
        } satisfies BotRun;
      })
      .filter((run): run is BotRun => run !== null),
    nextCursor: asString(root?.next_cursor),
  };
}

export function formatRunTimestamp(timestampSeconds: number): string {
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

export function formatDuration(durationMs: number): string {
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

export function getWorkflowKindLabel(kind: WorkflowKind): string {
  switch (kind) {
    case "trading":
      return "Trading Trace";
    case "research":
      return "Research Trace";
    case "conversation":
      return "Conversation Trace";
    case "observatory":
      return "Observatory Trace";
    default:
      return "Autonomous Trace";
  }
}

export function getWorkflowKindDescription(kind: WorkflowKind): string {
  switch (kind) {
    case "trading":
      return "Main autonomous trading cycle";
    case "research":
      return "Longer-horizon market research cycle";
    case "conversation":
      return "Internal autonomous conversation cycle";
    case "observatory":
      return "Reflection and improvement cycle";
    default:
      return "Autonomous execution";
  }
}

export function getStatusLabel(status: RunStatus): string {
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

function isInformativeRun(run: BotRun): boolean {
  const result = run.result?.trim();
  return Boolean(run.error || (result && result !== "No messages."));
}

export function chooseDefaultRun(runs: BotRun[]): BotRun | null {
  return (
    runs.find((run) => run.status === "running")
    ?? runs.find((run) => run.workflowKind === "trading" && isInformativeRun(run))
    ?? runs.find(isInformativeRun)
    ?? runs[0]
    ?? null
  );
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

export function resolveTranscriptSessionId(botId: string, run: BotRun | null): string {
  if (!run) {
    return "";
  }

  const canReplaySavedRun = Boolean(run.sessionId && (run.result || run.error));
  if (run.sessionId && (run.transcriptAvailable || canReplaySavedRun)) {
    return run.sessionId;
  }

  if (run.transcriptAvailable) {
    return deriveTranscriptSessionId(botId, run) ?? "";
  }

  return "";
}

export function hasReplayableRunTrace(run: BotRun | null): boolean {
  return Boolean(run && (run.transcriptAvailable || run.result || run.error));
}

export function buildRunReplaySessionId(run: BotRun | null): string {
  return run ? `run-replay-${run.runId}` : "";
}

export function buildRunReplayHistoryPath(run: BotRun | null): string | undefined {
  return run ? `/runs/${encodeURIComponent(run.runId)}/messages?limit=200` : undefined;
}

export function runMatchesLoopFilter(run: BotRun, filter: RunLoopFilter): boolean {
  // Strict on named filters: runs without loop_mode only appear under "all".
  // Callers hide the filter UI entirely when no loaded run carries loop_mode,
  // so old-operator histories are never filtered away.
  return filter === "all" || run.loopMode === filter;
}

export function formatRunCostUsd(costUsd: number | null): string | null {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd < 0) {
    return null;
  }
  if (costUsd === 0) return "$0";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

export function formatTokenTotal(total: number): string {
  if (total <= 0) return "tokens n/a";
  if (total >= 1_000) return `${(total / 1_000).toFixed(total >= 10_000 ? 0 : 1)}k tok`;
  return `${total} tok`;
}

function isUsageBearingRun(run: BotRun): boolean {
  return (
    run.loopMode === "agentic" ||
    run.inputTokens > 0 ||
    run.outputTokens > 0 ||
    run.costUsd != null
  );
}

function workflowUsageLabel(kind: WorkflowKind): string {
  switch (kind) {
    case "trading":
      return "Trading";
    case "research":
      return "Research";
    case "conversation":
      return "Chats";
    case "observatory":
      return "Observatory";
    default:
      return "Other";
  }
}

function modelUsageLabel(run: BotRun): string {
  if (run.provider && run.model) return `${run.provider}/${run.model}`;
  if (run.model) return run.model;
  if (run.provider) return `${run.provider}/unknown`;
  if (run.harness) return `${run.harness}/unknown`;
  return "Model n/a";
}

function addUsage(
  bucket: IntelligenceUsageBreakdown,
  run: BotRun,
): IntelligenceUsageBreakdown {
  const costKnown = run.costUsd != null && Number.isFinite(run.costUsd);
  return {
    ...bucket,
    runCount: bucket.runCount + 1,
    inputTokens: bucket.inputTokens + run.inputTokens,
    outputTokens: bucket.outputTokens + run.outputTokens,
    totalTokens: bucket.totalTokens + run.inputTokens + run.outputTokens,
    costUsd: costKnown
      ? (bucket.costUsd ?? 0) + (run.costUsd ?? 0)
      : bucket.costUsd,
    costKnownRunCount: bucket.costKnownRunCount + (costKnown ? 1 : 0),
  };
}

function emptyUsageBreakdown(id: string, label: string): IntelligenceUsageBreakdown {
  return {
    id,
    label,
    runCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: null,
    costKnownRunCount: 0,
  };
}

const DAY_BUCKET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const HOUR_BUCKET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function usageBucketStartMs(timestampSeconds: number, granularity: IntelligenceUsageGranularity): number {
  const date = new Date(timestampSeconds * 1000);
  if (granularity === "hour") {
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    );
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function usageBucketLabel(startMs: number, granularity: IntelligenceUsageGranularity): string {
  const date = new Date(startMs);
  return granularity === "hour"
    ? `${HOUR_BUCKET_FORMATTER.format(date)} UTC`
    : DAY_BUCKET_FORMATTER.format(date);
}

function sortUsageBreakdowns(
  left: IntelligenceUsageBreakdown,
  right: IntelligenceUsageBreakdown,
): number {
  return (
    (right.costUsd ?? -1) - (left.costUsd ?? -1) ||
    right.totalTokens - left.totalTokens ||
    right.runCount - left.runCount ||
    left.label.localeCompare(right.label)
  );
}

export function summarizeIntelligenceUsage(
  runs: BotRun[],
  granularity: IntelligenceUsageGranularity,
): IntelligenceUsageSummary {
  let runCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  let costKnownRunCount = 0;
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  const byWorkflow = new Map<string, IntelligenceUsageBreakdown>();
  const byModel = new Map<string, IntelligenceUsageBreakdown>();
  const timeline = new Map<string, IntelligenceUsageBucket>();

  for (const run of runs) {
    if (!isUsageBearingRun(run)) continue;

    const costKnown = run.costUsd != null && Number.isFinite(run.costUsd);
    runCount += 1;
    inputTokens += run.inputTokens;
    outputTokens += run.outputTokens;
    if (costKnown) {
      totalCost += run.costUsd ?? 0;
      costKnownRunCount += 1;
    }
    windowStart = windowStart == null ? run.startedAt : Math.min(windowStart, run.startedAt);
    windowEnd = windowEnd == null ? run.startedAt : Math.max(windowEnd, run.completedAt ?? run.startedAt);

    const workflowId = run.workflowKind;
    byWorkflow.set(
      workflowId,
      addUsage(
        byWorkflow.get(workflowId) ?? emptyUsageBreakdown(workflowId, workflowUsageLabel(run.workflowKind)),
        run,
      ),
    );

    const modelLabel = modelUsageLabel(run);
    byModel.set(
      modelLabel,
      addUsage(byModel.get(modelLabel) ?? emptyUsageBreakdown(modelLabel, modelLabel), run),
    );

    const bucketStartMs = usageBucketStartMs(run.startedAt, granularity);
    const bucketId = String(bucketStartMs);
    const existingBucket = timeline.get(bucketId);
    const nextBucket = addUsage(
      existingBucket ?? {
        ...emptyUsageBreakdown(bucketId, usageBucketLabel(bucketStartMs, granularity)),
        startedAt: Math.floor(bucketStartMs / 1000),
      },
      run,
    ) as IntelligenceUsageBucket;
    timeline.set(bucketId, nextBucket);
  }

  return {
    runCount,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: costKnownRunCount > 0 ? totalCost : null,
    costKnownRunCount,
    windowStart,
    windowEnd,
    byWorkflow: Array.from(byWorkflow.values()).sort(sortUsageBreakdowns),
    byModel: Array.from(byModel.values()).sort(sortUsageBreakdowns),
    timeline: Array.from(timeline.values()).sort((a, b) => a.startedAt - b.startedAt),
  };
}
