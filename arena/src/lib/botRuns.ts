export type RunStatus = "running" | "completed" | "failed" | "interrupted";
export type WorkflowKind = "trading" | "research" | "conversation" | "unknown";

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
    case "unknown":
      return value;
    default:
      return "unknown";
  }
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
