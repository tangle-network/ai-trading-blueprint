import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReasoningPart,
  SessionMessage as SandboxSessionMessage,
  SessionPart,
  TextPart,
  ToolPart,
} from "@tangle-network/sandbox-ui/types";

export type AppSessionMessage = SandboxSessionMessage & {
  runId?: string;
  success?: boolean | null;
  error?: string | null;
};

interface CachedSessionState {
  messages: AppSessionMessage[];
  partMap: Record<string, SessionPart[]>;
  nextInsertionIndex: number;
}

interface UseBotSessionStreamOptions {
  apiUrl: string;
  token: string | null;
  sessionId: string;
  enabled?: boolean;
  cacheKey?: string;
  historyPath?: string;
  streamEnabled?: boolean;
}

interface UseBotSessionStreamResult {
  messages: AppSessionMessage[];
  partMap: Record<string, SessionPart[]>;
  isStreaming: boolean;
  /** True while the SSE stream is open. */
  connected: boolean;
  /** True while a reconnect is scheduled/in flight after a drop. */
  isReconnecting: boolean;
  /** Reconnect attempt count; resets to 0 on a healthy connection. */
  attempt: number;
  /** Whole seconds until the next reconnect attempt (0 when not waiting). */
  retryInSeconds: number;
  error: string | null;
  refetch: () => Promise<void>;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
}

interface StreamEvent {
  type: string;
  data: unknown;
}

const EMPTY_STATE: CachedSessionState = {
  messages: [],
  partMap: {},
  nextInsertionIndex: 0,
};

/**
 * Reconnect backoff: 1s, 2s, 4s, … doubling per attempt, capped at 30s, with
 * full jitter applied to the scheduled delay so a fleet of clients doesn't
 * reconnect in lockstep (thundering herd) after a sidecar restart. The attempt
 * counter resets to 0 once a connection is healthy again.
 */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/** Deterministic (un-jittered) backoff ceiling for a given attempt index. */
function reconnectBaseDelayMs(attempt: number): number {
  const exponential = RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
  return Math.min(exponential, RECONNECT_MAX_DELAY_MS);
}

/** Full-jitter delay: a random point in [base/2, base]. */
function reconnectDelayWithJitter(attempt: number): number {
  const base = reconnectBaseDelayMs(attempt);
  return base / 2 + Math.random() * (base / 2);
}

const CACHE_PREFIX = "arena.bot_chat.";

function getCacheStorageKey(cacheKey: string, sessionId: string): string {
  return `${CACHE_PREFIX}${cacheKey}::${sessionId}`;
}

function sanitizeCachedMessage(
  entry: unknown,
  fallbackIndex: number,
): AppSessionMessage | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const raw = entry as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : null;
  const role =
    raw.role === "user" || raw.role === "assistant" || raw.role === "system"
      ? raw.role
      : null;

  if (!id || !role) {
    return null;
  }

  const rawTime =
    raw.time && typeof raw.time === "object"
      ? (raw.time as Record<string, unknown>)
      : {};
  const created = normalizeTimestamp(rawTime.created ?? raw.timestamp);
  const updated =
    typeof rawTime.updated === "number" ? rawTime.updated : undefined;
  const completed =
    typeof rawTime.completed === "number" ? rawTime.completed : undefined;
  const insertionIndex =
    typeof raw._insertionIndex === "number"
      ? raw._insertionIndex
      : fallbackIndex;

  return {
    id,
    role,
    ...(typeof raw.sessionID === "string" ? { sessionID: raw.sessionID } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(raw.success === null || typeof raw.success === "boolean"
      ? { success: raw.success }
      : {}),
    ...(raw.error === null || typeof raw.error === "string"
      ? { error: raw.error }
      : {}),
    time: {
      created,
      ...(updated != null ? { updated } : {}),
      ...(completed != null ? { completed } : {}),
    },
    _insertionIndex: insertionIndex,
  };
}

function sanitizeCachedPart(part: unknown): SessionPart | null {
  if (!part || typeof part !== "object") {
    return null;
  }

  return mapSessionPart(part as Record<string, unknown>);
}

function sanitizeCachedState(
  candidate: CachedSessionState | null,
): CachedSessionState | null {
  if (!candidate) {
    return null;
  }

  const nextMessages: AppSessionMessage[] = [];
  const nextPartMap: Record<string, SessionPart[]> = {};
  let nextInsertionIndex = 0;

  for (const entry of candidate.messages) {
    const message = sanitizeCachedMessage(entry, nextInsertionIndex);
    if (!message) {
      continue;
    }

    const rawParts = Array.isArray(candidate.partMap[message.id])
      ? candidate.partMap[message.id]
      : [];
    const parts = rawParts
      .map((part) => sanitizeCachedPart(part))
      .filter((part): part is SessionPart => part !== null);

    nextMessages.push(message);
    nextPartMap[message.id] = parts;
    nextInsertionIndex = Math.max(
      nextInsertionIndex,
      (message._insertionIndex ?? 0) + 1,
    );
  }

  return {
    messages: nextMessages,
    partMap: nextPartMap,
    nextInsertionIndex: Math.max(
      nextInsertionIndex,
      candidate.nextInsertionIndex || 0,
    ),
  };
}

function readCachedState(
  cacheKey: string | undefined,
  sessionId: string,
): CachedSessionState | null {
  if (!cacheKey || typeof window === "undefined" || !window.sessionStorage) {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(
      getCacheStorageKey(cacheKey, sessionId),
    );
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedSessionState>;
    if (
      !Array.isArray(parsed.messages) ||
      !parsed.partMap ||
      typeof parsed.nextInsertionIndex !== "number"
    ) {
      return null;
    }

    return sanitizeCachedState({
      messages: parsed.messages as AppSessionMessage[],
      partMap: parsed.partMap as Record<string, SessionPart[]>,
      nextInsertionIndex: parsed.nextInsertionIndex,
    });
  } catch {
    return null;
  }
}

function writeCachedState(
  cacheKey: string | undefined,
  sessionId: string,
  state: CachedSessionState,
) {
  if (!cacheKey || typeof window === "undefined" || !window.sessionStorage) {
    return;
  }

  try {
    window.sessionStorage.setItem(
      getCacheStorageKey(cacheKey, sessionId),
      JSON.stringify(state),
    );
  } catch {
    // Best-effort cache only.
  }
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textPartsFromContent(
  content: unknown,
  attachments?: unknown,
): TextPart[] {
  const attachmentNames = Array.isArray(attachments)
    ? attachments
        .map((attachment) => asRecord(attachment))
        .filter(
          (attachment): attachment is Record<string, unknown> =>
            attachment !== undefined,
        )
        .map((attachment) => asString(attachment.name))
        .filter((name): name is string => Boolean(name))
    : [];
  const attachmentText =
    attachmentNames.length > 0
      ? `\n\nAttachments:\n${attachmentNames.map((name) => `- ${name}`).join("\n")}`
      : "";
  const text = `${asString(content) ?? ""}${attachmentText}`.trim();

  return text ? [{ type: "text", text }] : [];
}

function extractNormalizedParts(
  rawEntry: Record<string, unknown>,
): SessionPart[] {
  const info = asRecord(rawEntry.info);
  const rawParts = Array.isArray(rawEntry.parts)
    ? rawEntry.parts
    : Array.isArray(info?.parts)
      ? info.parts
      : [];
  const parts = rawParts
    .map((part) => mapSessionPart(asRecord(part) ?? {}))
    .filter((part): part is SessionPart => part !== null);

  if (parts.length > 0) {
    return parts;
  }

  const content =
    asString(rawEntry.content) ??
    asString(info?.content) ??
    asString(rawEntry.text) ??
    asString(info?.text);
  const attachments = rawEntry.attachments ?? info?.attachments;

  return textPartsFromContent(content, attachments);
}

function makeOptimisticMessageId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `optimistic-${crypto.randomUUID()}`;
  }

  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function movePartMapEntry(
  partMap: Record<string, SessionPart[]>,
  fromId: string,
  toId: string,
): Record<string, SessionPart[]> {
  if (fromId === toId || !(fromId in partMap)) {
    return partMap;
  }

  const nextPartMap = { ...partMap };
  nextPartMap[toId] = nextPartMap[fromId] ?? [];
  delete nextPartMap[fromId];
  return nextPartMap;
}

function mapToolState(
  state: Record<string, unknown> | undefined,
): ToolPart["state"] {
  const status =
    state?.status === "failed"
      ? "error"
      : (state?.status as ToolPart["state"]["status"] | undefined);

  return {
    status: status ?? "running",
    input: state?.input,
    output: state?.output,
    error: typeof state?.error === "string" ? state.error : undefined,
    metadata: state?.metadata as Record<string, unknown> | undefined,
    time: state?.time as ToolPart["state"]["time"] | undefined,
  };
}

function mapSessionPart(rawPart: Record<string, unknown>): SessionPart | null {
  const type = typeof rawPart.type === "string" ? rawPart.type : "";

  if (type === "tool") {
    return {
      type: "tool",
      id: typeof rawPart.id === "string" ? rawPart.id : `tool-${Date.now()}`,
      tool: typeof rawPart.tool === "string" ? rawPart.tool : "unknown",
      state: mapToolState(rawPart.state as Record<string, unknown> | undefined),
    } satisfies ToolPart;
  }

  if (type === "reasoning") {
    return {
      type: "reasoning",
      ...(typeof rawPart.id === "string" ? { id: rawPart.id } : {}),
      text:
        typeof rawPart.text === "string"
          ? rawPart.text
          : typeof rawPart.content === "string"
            ? rawPart.content
            : "",
      time: rawPart.time as ReasoningPart["time"] | undefined,
    } satisfies ReasoningPart;
  }

  if (type === "text") {
    return {
      type: "text",
      text:
        typeof rawPart.text === "string"
          ? rawPart.text
          : typeof rawPart.content === "string"
            ? rawPart.content
            : "",
      ...(typeof rawPart.id === "string" ? { id: rawPart.id } : {}),
    } satisfies TextPart;
  }

  return null;
}

function mapHistoryEntry(
  rawEntry: Record<string, unknown>,
  insertionIndex: number,
): { message: AppSessionMessage; parts: SessionPart[] } | null {
  const info =
    (rawEntry.info as Record<string, unknown> | undefined) ?? rawEntry;
  const id = typeof info.id === "string" ? info.id : null;
  const role = typeof info.role === "string" ? info.role : null;

  if (!id || !role) {
    return null;
  }

  const time = (info.time as Record<string, unknown> | undefined) ?? {};
  const createdAt =
    typeof time.created === "number"
      ? time.created
      : normalizeTimestamp(info.timestamp);
  const completedAt =
    typeof time.completed === "number" ? time.completed : undefined;
  const parts = extractNormalizedParts(rawEntry);

  return {
    message: {
      id,
      role: role as AppSessionMessage["role"],
      ...(typeof info.runID === "string" ? { runId: info.runID } : {}),
      ...(typeof info.run_id === "string" ? { runId: info.run_id } : {}),
      ...(Object.prototype.hasOwnProperty.call(info, "success")
        ? {
            success: typeof info.success === "boolean" ? info.success : null,
          }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(info, "error")
        ? {
            error: typeof info.error === "string" ? info.error : null,
          }
        : {}),
      time: {
        created: createdAt,
        ...(completedAt ? { completed: completedAt } : {}),
      },
      _insertionIndex: insertionIndex,
    },
    parts,
  };
}

function parseEventFrame(frame: string): StreamEvent | null {
  let eventType = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");
  try {
    return {
      type: eventType,
      data: JSON.parse(rawData),
    };
  } catch {
    return {
      type: eventType,
      data: rawData,
    };
  }
}

async function readErrorText(response: Response): Promise<string> {
  const text = await response.text();
  return text || `${response.status} ${response.statusText}`;
}

export function useBotSessionStream({
  apiUrl,
  token,
  sessionId,
  enabled = true,
  cacheKey,
  historyPath,
  streamEnabled = true,
}: UseBotSessionStreamOptions): UseBotSessionStreamResult {
  const [messages, setMessages] = useState<AppSessionMessage[]>([]);
  const [partMap, setPartMap] = useState<Record<string, SessionPart[]>>({});
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retryInSeconds, setRetryInSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<CachedSessionState>(EMPTY_STATE);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);

  const applyState = useCallback(
    (
      updater: (current: CachedSessionState) => CachedSessionState,
      nextSessionId: string = sessionId,
    ) => {
      const next = updater(stateRef.current);
      stateRef.current = next;
      setMessages(next.messages);
      setPartMap(next.partMap);
      writeCachedState(cacheKey, nextSessionId, next);
    },
    [cacheKey, sessionId],
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (retryCountdownRef.current) {
      clearInterval(retryCountdownRef.current);
      retryCountdownRef.current = null;
    }
    setIsReconnecting(false);
    setRetryInSeconds(0);
  }, []);

  /**
   * Reset the backoff after a healthy connection so the next drop starts from
   * the 1s base again instead of inheriting the previous attempt's delay.
   */
  const resetReconnectBackoff = useCallback(() => {
    attemptRef.current = 0;
    setAttempt(0);
    setIsReconnecting(false);
    setRetryInSeconds(0);
    if (retryCountdownRef.current) {
      clearInterval(retryCountdownRef.current);
      retryCountdownRef.current = null;
    }
  }, []);

  const loadCachedSnapshot = useCallback(() => {
    const cached = readCachedState(cacheKey, sessionId) ?? EMPTY_STATE;
    stateRef.current = cached;
    setMessages(cached.messages);
    setPartMap(cached.partMap);
    setIsStreaming(false);
    setConnected(false);
    setError(null);
    resetReconnectBackoff();
    activeAssistantMessageIdRef.current = null;
  }, [cacheKey, resetReconnectBackoff, sessionId]);

  const refetch = useCallback(async () => {
    if (!apiUrl || !sessionId || (!token && !historyPath)) {
      return;
    }

    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    try {
      const headers: HeadersInit = token
        ? { Authorization: `Bearer ${token}` }
        : {};
      const path =
        historyPath ??
        `/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`;
      const response = await fetch(
        `${apiUrl}${path}`,
        {
          headers,
          credentials: token ? "include" : "omit",
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload = (await response.json()) as unknown;
      const entries = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { messages?: unknown[] }).messages)
          ? (payload as { messages: unknown[] }).messages
          : [];

      let nextInsertionIndex = 0;
      const nextMessages: AppSessionMessage[] = [];
      const nextPartMap: Record<string, SessionPart[]> = {};

      for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
          continue;
        }

        const mapped = mapHistoryEntry(
          entry as Record<string, unknown>,
          nextInsertionIndex,
        );
        if (!mapped) {
          continue;
        }

        nextMessages.push(mapped.message);
        nextPartMap[mapped.message.id] = mapped.parts;
        nextInsertionIndex += 1;
      }

      applyState(() => ({
        messages: nextMessages,
        partMap: nextPartMap,
        nextInsertionIndex,
      }));
      setError(null);
    } catch (historyError) {
      if (controller.signal.aborted) {
        return;
      }

      setError(
        historyError instanceof Error
          ? historyError.message
          : "Failed to load session history",
      );
    }
  }, [apiUrl, applyState, historyPath, sessionId, token]);

  const applyMessageUpdate = useCallback(
    (payload: Record<string, unknown>) => {
      const info =
        (payload.info as Record<string, unknown> | undefined) ?? payload;
      const id = typeof info.id === "string" ? info.id : "";
      const explicitRole = typeof info.role === "string" ? info.role : null;

      if (!id) {
        return;
      }

      const existingMessage = stateRef.current.messages.find(
        (message) => message.id === id,
      );
      const role = explicitRole ?? existingMessage?.role ?? null;
      if (!role) {
        return;
      }

      const time = (info.time as Record<string, unknown> | undefined) ?? {};
      const createdAt =
        typeof time.created === "number"
          ? time.created
          : normalizeTimestamp(info.timestamp);
      const completedAt =
        typeof time.completed === "number" ? time.completed : undefined;
      const success = Object.prototype.hasOwnProperty.call(info, "success")
        ? typeof info.success === "boolean"
          ? info.success
          : null
        : undefined;
      const errorText = Object.prototype.hasOwnProperty.call(info, "error")
        ? typeof info.error === "string"
          ? info.error
          : null
        : undefined;

      applyState((current) => {
        const existingIndex = current.messages.findIndex(
          (message) => message.id === id,
        );
        const insertionIndex =
          existingIndex >= 0
            ? (current.messages[existingIndex]?._insertionIndex ??
              existingIndex)
            : current.nextInsertionIndex;
        const nextMessage: AppSessionMessage = {
          id,
          role: role as AppSessionMessage["role"],
          ...(typeof info.runID === "string" ? { runId: info.runID } : {}),
          ...(typeof info.run_id === "string" ? { runId: info.run_id } : {}),
          ...(success !== undefined ? { success } : {}),
          ...(errorText !== undefined ? { error: errorText } : {}),
          time: {
            created: createdAt,
            ...(completedAt ? { completed: completedAt } : {}),
          },
          _insertionIndex: insertionIndex,
        };

        const nextMessages = [...current.messages];
        if (existingIndex >= 0) {
          nextMessages[existingIndex] = {
            ...nextMessages[existingIndex],
            ...nextMessage,
            time: nextMessage.time,
          };
        } else {
          nextMessages.push(nextMessage);
        }

        return {
          messages: nextMessages,
          partMap: current.partMap,
          nextInsertionIndex:
            existingIndex >= 0
              ? current.nextInsertionIndex
              : current.nextInsertionIndex + 1,
        };
      });

      if (role === "assistant") {
        activeAssistantMessageIdRef.current = id;
        setIsStreaming(true);
        if (success !== false && !errorText) {
          setError(null);
        }
      }
    },
    [applyState],
  );

  const applyMessagePartUpdate = useCallback(
    (payload: Record<string, unknown>) => {
      const partPayload =
        (payload.part as Record<string, unknown> | undefined) ?? payload;
      const messageId =
        typeof partPayload.messageID === "string"
          ? partPayload.messageID
          : typeof payload.messageID === "string"
            ? payload.messageID
            : "";

      if (!messageId) {
        return;
      }

      const part = mapSessionPart(partPayload);
      if (!part) {
        return;
      }

      applyState((current) => {
        const existingParts = current.partMap[messageId] ?? [];
        const nextParts = [...existingParts];
        let replaceIndex = -1;
        const partId =
          typeof partPayload.id === "string" ? partPayload.id : undefined;

        if (partId) {
          replaceIndex = nextParts.findIndex((entry) => {
            if (!("id" in entry)) {
              return false;
            }
            return (entry as { id?: string }).id === partId;
          });
        } else if (part.type === "tool") {
          replaceIndex = nextParts.findIndex(
            (entry) =>
              entry.type === "tool" && (entry as ToolPart).id === part.id,
          );
        } else if (part.type === "text") {
          replaceIndex = nextParts.findIndex((entry) => entry.type === "text");
        } else if (part.type === "reasoning") {
          replaceIndex = nextParts.findIndex(
            (entry) => entry.type === "reasoning",
          );
        }

        if (replaceIndex >= 0) {
          nextParts[replaceIndex] = part;
        } else {
          nextParts.push(part);
        }

        return {
          messages: current.messages,
          partMap: {
            ...current.partMap,
            [messageId]: nextParts,
          },
          nextInsertionIndex: current.nextInsertionIndex,
        };
      });

      setIsStreaming(true);
    },
    [applyState],
  );

  const handleEvent = useCallback(
    (event: StreamEvent) => {
      if (!event.data || typeof event.data !== "object") {
        if (event.type === "session.idle") {
          setIsStreaming(false);
          activeAssistantMessageIdRef.current = null;
          void refetch();
        }
        return;
      }

      const payload = event.data as Record<string, unknown>;
      const details =
        (payload.properties as Record<string, unknown> | undefined) ?? payload;

      if (event.type === "message.updated") {
        applyMessageUpdate(details);
        return;
      }

      if (event.type === "message.part.updated") {
        applyMessagePartUpdate(details);
        return;
      }

      if (event.type === "session.idle") {
        setIsStreaming(false);
        activeAssistantMessageIdRef.current = null;
        return;
      }

      if (event.type === "session.error") {
        const message =
          typeof details.error === "string"
            ? details.error
            : typeof details.message === "string"
              ? details.message
              : "Agent error";
        setError(message);
        setIsStreaming(false);
        activeAssistantMessageIdRef.current = null;
        return;
      }

      if (event.type === "assistant_message" || event.type === "user_message") {
        const mapped = mapHistoryEntry(
          details,
          stateRef.current.nextInsertionIndex,
        );
        if (!mapped) {
          return;
        }

        if (
          mapped.message.role === "assistant" &&
          mapped.message.success !== false &&
          !mapped.message.error
        ) {
          setError(null);
        }

        applyState((current) => {
          const existingIndex = current.messages.findIndex(
            (message) => message.id === mapped.message.id,
          );
          if (existingIndex >= 0) {
            const nextMessages = [...current.messages];
            nextMessages[existingIndex] = {
              ...nextMessages[existingIndex],
              ...mapped.message,
              time: mapped.message.time,
            };

            return {
              messages: nextMessages,
              partMap: {
                ...current.partMap,
                [mapped.message.id]: mapped.parts,
              },
              nextInsertionIndex: current.nextInsertionIndex,
            };
          }

          return {
            messages: [...current.messages, mapped.message],
            partMap: {
              ...current.partMap,
              [mapped.message.id]: mapped.parts,
            },
            nextInsertionIndex: current.nextInsertionIndex + 1,
          };
        });
      }
    },
    [applyMessagePartUpdate, applyMessageUpdate, applyState, refetch],
  );

  // Forward ref so `scheduleReconnect` can call the latest `connectStream`
  // without a declaration cycle.
  const connectStreamRef = useRef<() => void>(() => {});

  /**
   * Schedule the next reconnect using exponential backoff with full jitter.
   * Increments the attempt counter and drives a 1s `retryInSeconds` countdown
   * for the UI. A no-op if the stream is intentionally disabled.
   */
  const scheduleReconnect = useCallback(() => {
    if (!enabled || !streamEnabled) {
      return;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (retryCountdownRef.current) {
      clearInterval(retryCountdownRef.current);
      retryCountdownRef.current = null;
    }

    const currentAttempt = attemptRef.current;
    const delayMs = reconnectDelayWithJitter(currentAttempt);
    attemptRef.current = currentAttempt + 1;
    setAttempt(currentAttempt + 1);
    setIsReconnecting(true);

    let remaining = Math.max(1, Math.ceil(delayMs / 1_000));
    setRetryInSeconds(remaining);
    retryCountdownRef.current = setInterval(() => {
      remaining -= 1;
      setRetryInSeconds(Math.max(0, remaining));
      if (remaining <= 0 && retryCountdownRef.current) {
        clearInterval(retryCountdownRef.current);
        retryCountdownRef.current = null;
      }
    }, 1_000);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectStreamRef.current();
    }, delayMs);
  }, [enabled, streamEnabled]);

  const connectStream = useCallback(async () => {
    if (!enabled || !streamEnabled || !apiUrl || !token || !sessionId) {
      return;
    }

    clearReconnectTimer();
    streamAbortRef.current?.abort();

    const controller = new AbortController();
    streamAbortRef.current = controller;

    try {
      const response = await fetch(
        `${apiUrl}/session/events?sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          credentials: "include",
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("Chat stream is unavailable");
      }

      // Healthy open: surface connected and reset the backoff so the next drop
      // starts from the 1s base.
      setConnected(true);
      resetReconnectBackoff();
      setError((current) => {
        if (current && stateRef.current.messages.length > 0) {
          return null;
        }
        return current;
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const parsed = parseEventFrame(frame);
            if (parsed) {
              // A delivered frame proves the connection is healthy; keep the
              // backoff reset so a later drop restarts from the base delay.
              resetReconnectBackoff();
              handleEvent(parsed);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!controller.signal.aborted) {
        setConnected(false);
        scheduleReconnect();
      }
    } catch (streamError) {
      if (controller.signal.aborted) {
        return;
      }

      setConnected(false);
      if (stateRef.current.messages.length === 0) {
        setError(
          streamError instanceof Error
            ? streamError.message
            : "SSE connection error",
        );
      }
      scheduleReconnect();
    }
  }, [
    apiUrl,
    clearReconnectTimer,
    enabled,
    handleEvent,
    resetReconnectBackoff,
    scheduleReconnect,
    sessionId,
    streamEnabled,
    token,
  ]);

  useEffect(() => {
    connectStreamRef.current = () => {
      void connectStream();
    };
  }, [connectStream]);

  const send = useCallback(
    async (text: string) => {
      if (!token || !apiUrl || !sessionId) {
        throw new Error("Chat is not authenticated");
      }

      const optimisticMessageId = makeOptimisticMessageId();
      const createdAt = Date.now();

      applyState((current) => ({
        messages: [
          ...current.messages,
          {
            id: optimisticMessageId,
            role: "user",
            time: { created: createdAt },
            _insertionIndex: current.nextInsertionIndex,
          },
        ],
        partMap: {
          ...current.partMap,
          [optimisticMessageId]: [{ type: "text", text }],
        },
        nextInsertionIndex: current.nextInsertionIndex + 1,
      }));

      const response = await fetch(
        `${apiUrl}/session/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          credentials: "include",
          body: JSON.stringify({ parts: [{ type: "text", text }] }),
        },
      );

      if (!response.ok) {
        applyState((current) => ({
          messages: current.messages.filter(
            (message) => message.id !== optimisticMessageId,
          ),
          partMap: Object.fromEntries(
            Object.entries(current.partMap).filter(
              ([messageId]) => messageId !== optimisticMessageId,
            ),
          ),
          nextInsertionIndex: current.nextInsertionIndex,
        }));
        throw new Error(await readErrorText(response));
      }

      try {
        const payload = (await response.json()) as {
          userMessageId?: unknown;
          info?: Record<string, unknown>;
        };

        if (typeof payload.userMessageId === "string") {
          const serverUserMessageId = payload.userMessageId;
          applyState((current) => {
            const optimisticIndex = current.messages.findIndex(
              (message) => message.id === optimisticMessageId,
            );
            if (optimisticIndex < 0) {
              return current;
            }

            const nextMessages = [...current.messages];
            nextMessages[optimisticIndex] = {
              ...nextMessages[optimisticIndex],
              id: serverUserMessageId,
            };

            return {
              messages: nextMessages,
              partMap: movePartMapEntry(
                current.partMap,
                optimisticMessageId,
                serverUserMessageId,
              ),
              nextInsertionIndex: current.nextInsertionIndex,
            };
          });
        }

        if (payload.info && typeof payload.info === "object") {
          applyMessageUpdate(payload);
        }
      } catch {
        // Some sidecar versions return minimal or non-JSON payloads here.
      }

      setError(null);
      setIsStreaming(true);
    },
    [apiUrl, applyMessageUpdate, applyState, sessionId, token],
  );

  const abort = useCallback(async () => {
    if (!token || !apiUrl || !sessionId) {
      return;
    }

    const response = await fetch(
      `${apiUrl}/session/sessions/${encodeURIComponent(sessionId)}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        credentials: "include",
      },
    );

    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
  }, [apiUrl, sessionId, token]);

  useEffect(() => {
    loadCachedSnapshot();
  }, [loadCachedSnapshot]);

  useEffect(() => {
    if (!enabled || !apiUrl || !sessionId || (!token && !historyPath)) {
      streamAbortRef.current?.abort();
      historyAbortRef.current?.abort();
      clearReconnectTimer();
      setConnected(false);
      setIsStreaming(false);
      return;
    }

    void refetch();
    if (streamEnabled && token) {
      void connectStream();
    }

    return () => {
      streamAbortRef.current?.abort();
      historyAbortRef.current?.abort();
      clearReconnectTimer();
      setConnected(false);
    };
  }, [
    apiUrl,
    clearReconnectTimer,
    connectStream,
    enabled,
    historyPath,
    refetch,
    sessionId,
    streamEnabled,
    token,
  ]);

  return {
    messages,
    partMap,
    isStreaming,
    connected,
    isReconnecting,
    attempt,
    retryInSeconds,
    error,
    refetch,
    send,
    abort,
  };
}
