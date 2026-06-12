import { useCallback, useEffect, useRef, useState } from "react";
import type { BotRun } from "~/lib/botRuns";

/**
 * Continuation mode reported by the operator for a run follow-up turn.
 * "resumed" — the turn went into the run's original agent session, so the
 * agent keeps its own conversation context. "context_seeded" — the run kept
 * no live session (deterministic ticks, legacy rows); the operator opened a
 * follow-up session whose first turn is seeded with the saved run record.
 */
export type RunContinuationMode = "resumed" | "context_seeded";

export type RunConversationPhase =
  | "idle"
  | "sending"
  | "waiting"
  | "stalled"
  | "rejected";

export interface RunConversationState {
  phase: RunConversationPhase;
  /** Human-readable rejection/stall detail; null outside those phases. */
  detail: string | null;
  mode: RunContinuationMode | null;
}

interface UseRunConversationOptions {
  apiUrl: string;
  token: string | null;
  run: BotRun | null;
  /** Re-pulls the transcript so the follow-up turns become visible. */
  refetchTranscript: () => Promise<void>;
  /** Total transcript messages currently loaded (server view). */
  messageCount: number;
  /** Role of the final transcript message; reply lands as "assistant". */
  lastMessageRole: string | null;
}

interface UseRunConversationResult {
  state: RunConversationState;
  send: (text: string) => Promise<void>;
  /** Predicted continuation mode for the active run (server still decides). */
  predictedMode: RunContinuationMode | null;
}

const IDLE_STATE: RunConversationState = {
  phase: "idle",
  detail: null,
  mode: null,
};

const REPLY_POLL_INTERVAL_MS = 4_000;
const REPLY_WAIT_BUDGET_MS = 180_000;

export function describeRunRejection(status: number, body: string): string {
  if (status === 401) {
    return "Connect the creator wallet to talk to this agent.";
  }
  if (status === 403) {
    return "This wallet is not permitted to talk to this agent. Connect the creator wallet to continue the conversation.";
  }
  if (status === 404 || status === 405) {
    return "This operator does not support continuing saved runs yet.";
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return `The operator rejected the message (HTTP ${status}).`;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? parsed.message ?? trimmed;
  } catch {
    return trimmed;
  }
}

export function predictRunContinuationMode(
  run: BotRun | null,
): RunContinuationMode | null {
  if (!run) return null;
  return run.sessionId ? "resumed" : "context_seeded";
}

/**
 * Sends owner follow-up turns into a saved run's conversation and waits for
 * the agent's reply to land in the transcript. The composer stays available
 * to every viewer — the operator enforces access (401 unauthenticated, 403
 * non-permitted) and this hook surfaces those rejections verbatim.
 *
 * Reply detection is ordering-based and clock-skew free: the operator
 * appends the follow-up user turn synchronously on accept, so the reply has
 * arrived once the transcript has grown past its at-send size AND ends with
 * an assistant message.
 */
export function useRunConversation({
  apiUrl,
  token,
  run,
  refetchTranscript,
  messageCount,
  lastMessageRole,
}: UseRunConversationOptions): UseRunConversationResult {
  const [state, setState] = useState<RunConversationState>(IDLE_STATE);
  const baselineCountRef = useRef(0);
  const waitDeadlineRef = useRef(0);
  const transcriptRef = useRef({ messageCount, lastMessageRole });
  transcriptRef.current = { messageCount, lastMessageRole };

  const runId = run?.runId ?? null;

  useEffect(() => {
    // Selecting another run abandons the in-flight wait state for the old one.
    setState(IDLE_STATE);
  }, [runId]);

  useEffect(() => {
    if (state.phase !== "waiting") {
      return undefined;
    }

    const replyArrived = () =>
      transcriptRef.current.messageCount > baselineCountRef.current &&
      transcriptRef.current.lastMessageRole === "assistant";

    if (replyArrived()) {
      setState((current) => ({ ...current, phase: "idle", detail: null }));
      return undefined;
    }

    const interval = setInterval(() => {
      if (replyArrived()) {
        setState((current) => ({ ...current, phase: "idle", detail: null }));
        return;
      }
      if (Date.now() > waitDeadlineRef.current) {
        setState((current) => ({
          ...current,
          phase: "stalled",
          detail:
            "The agent has not replied yet. Its answer will be appended to this run's transcript when the turn completes.",
        }));
        return;
      }
      void refetchTranscript();
    }, REPLY_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [lastMessageRole, messageCount, refetchTranscript, state.phase]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !runId || !apiUrl) {
        return;
      }

      baselineCountRef.current = transcriptRef.current.messageCount;
      setState({ phase: "sending", detail: null, mode: null });

      let response: Response;
      try {
        response = await fetch(
          `${apiUrl}/runs/${encodeURIComponent(runId)}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ message: trimmed }),
          },
        );
      } catch (error) {
        setState({
          phase: "rejected",
          detail:
            error instanceof Error
              ? error.message
              : "Failed to reach the operator.",
          mode: null,
        });
        return;
      }

      if (!response.ok) {
        setState({
          phase: "rejected",
          detail: describeRunRejection(response.status, await response.text()),
          mode: null,
        });
        return;
      }

      let mode: RunContinuationMode =
        predictRunContinuationMode(run) ?? "context_seeded";
      try {
        const payload = (await response.json()) as { mode?: unknown };
        if (payload.mode === "resumed" || payload.mode === "context_seeded") {
          mode = payload.mode;
        }
      } catch {
        // Accepted without a parseable body; keep the predicted mode.
      }

      waitDeadlineRef.current = Date.now() + REPLY_WAIT_BUDGET_MS;
      setState({ phase: "waiting", detail: null, mode });
      void refetchTranscript();
    },
    [apiUrl, refetchTranscript, run, runId, token],
  );

  return {
    state,
    send,
    predictedMode: predictRunContinuationMode(run),
  };
}
