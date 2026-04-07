import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReasoningPart,
  SessionMessage as SandboxSessionMessage,
  SessionPart,
  TextPart,
  ToolPart,
} from '@tangle-network/sandbox-ui/types';

type AppSessionMessage = SandboxSessionMessage & {
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
}

interface UseBotSessionStreamResult {
  messages: AppSessionMessage[];
  partMap: Record<string, SessionPart[]>;
  isStreaming: boolean;
  connected: boolean;
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

const RECONNECT_DELAY_MS = 3_000;
const CACHE_PREFIX = 'arena.bot_chat.';

function getCacheStorageKey(cacheKey: string, sessionId: string): string {
  return `${CACHE_PREFIX}${cacheKey}::${sessionId}`;
}

function readCachedState(cacheKey: string | undefined, sessionId: string): CachedSessionState | null {
  if (!cacheKey || typeof window === 'undefined' || !window.sessionStorage) {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(getCacheStorageKey(cacheKey, sessionId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedSessionState>;
    if (!Array.isArray(parsed.messages) || !parsed.partMap || typeof parsed.nextInsertionIndex !== 'number') {
      return null;
    }

    return {
      messages: parsed.messages as AppSessionMessage[],
      partMap: parsed.partMap as Record<string, SessionPart[]>,
      nextInsertionIndex: parsed.nextInsertionIndex,
    };
  } catch {
    return null;
  }
}

function writeCachedState(cacheKey: string | undefined, sessionId: string, state: CachedSessionState) {
  if (!cacheKey || typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }

  try {
    window.sessionStorage.setItem(getCacheStorageKey(cacheKey, sessionId), JSON.stringify(state));
  } catch {
    // Best-effort cache only.
  }
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function mapToolState(state: Record<string, unknown> | undefined): ToolPart['state'] {
  const status = state?.status === 'failed'
    ? 'error'
    : (state?.status as ToolPart['state']['status'] | undefined);

  return {
    status: status ?? 'running',
    input: state?.input,
    output: state?.output,
    error: typeof state?.error === 'string' ? state.error : undefined,
    metadata: state?.metadata as Record<string, unknown> | undefined,
    time: state?.time as ToolPart['state']['time'] | undefined,
  };
}

function mapSessionPart(rawPart: Record<string, unknown>): SessionPart | null {
  const type = typeof rawPart.type === 'string' ? rawPart.type : '';

  if (type === 'tool') {
    return {
      type: 'tool',
      id: typeof rawPart.id === 'string' ? rawPart.id : `tool-${Date.now()}`,
      tool: typeof rawPart.tool === 'string' ? rawPart.tool : 'unknown',
      state: mapToolState(rawPart.state as Record<string, unknown> | undefined),
    } satisfies ToolPart;
  }

  if (type === 'reasoning') {
    return {
      type: 'reasoning',
      ...(typeof rawPart.id === 'string' ? { id: rawPart.id } : {}),
      text: typeof rawPart.text === 'string' ? rawPart.text : '',
      time: rawPart.time as ReasoningPart['time'] | undefined,
    } satisfies ReasoningPart;
  }

  if (type === 'text') {
    return {
      type: 'text',
      text: typeof rawPart.text === 'string' ? rawPart.text : '',
      ...(typeof rawPart.id === 'string' ? { id: rawPart.id } : {}),
    } satisfies TextPart;
  }

  return null;
}

function mapHistoryEntry(
  rawEntry: Record<string, unknown>,
  insertionIndex: number,
): { message: AppSessionMessage; parts: SessionPart[] } | null {
  const info = (rawEntry.info as Record<string, unknown> | undefined) ?? rawEntry;
  const id = typeof info.id === 'string' ? info.id : null;
  const role = typeof info.role === 'string' ? info.role : null;

  if (!id || !role) {
    return null;
  }

  const time = (info.time as Record<string, unknown> | undefined) ?? {};
  const createdAt = typeof time.created === 'number'
    ? time.created
    : normalizeTimestamp(info.timestamp);
  const completedAt = typeof time.completed === 'number' ? time.completed : undefined;
  const rawParts = Array.isArray(rawEntry.parts)
    ? rawEntry.parts as Array<Record<string, unknown>>
    : [];

  const parts = rawParts
    .map((part) => mapSessionPart(part))
    .filter((part): part is SessionPart => part !== null);

  return {
    message: {
      id,
      role: role as AppSessionMessage['role'],
      ...(typeof info.runID === 'string' ? { runId: info.runID } : {}),
      ...(typeof info.run_id === 'string' ? { runId: info.run_id } : {}),
      ...(Object.prototype.hasOwnProperty.call(info, 'success') ? {
        success: typeof info.success === 'boolean' ? info.success : null,
      } : {}),
      ...(Object.prototype.hasOwnProperty.call(info, 'error') ? {
        error: typeof info.error === 'string' ? info.error : null,
      } : {}),
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
  let eventType = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join('\n');
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
}: UseBotSessionStreamOptions): UseBotSessionStreamResult {
  const [messages, setMessages] = useState<AppSessionMessage[]>([]);
  const [partMap, setPartMap] = useState<Record<string, SessionPart[]>>({});
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<CachedSessionState>(EMPTY_STATE);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);

  const applyState = useCallback((
    updater: (current: CachedSessionState) => CachedSessionState,
    nextSessionId: string = sessionId,
  ) => {
    const next = updater(stateRef.current);
    stateRef.current = next;
    setMessages(next.messages);
    setPartMap(next.partMap);
    writeCachedState(cacheKey, nextSessionId, next);
  }, [cacheKey, sessionId]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
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
    activeAssistantMessageIdRef.current = null;
  }, [cacheKey, sessionId]);

  const refetch = useCallback(async () => {
    if (!apiUrl || !token || !sessionId) {
      return;
    }

    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    try {
      const response = await fetch(
        `${apiUrl}/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          credentials: 'include',
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload = await response.json() as unknown;
      const entries = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { messages?: unknown[] }).messages)
          ? (payload as { messages: unknown[] }).messages
          : [];

      let nextInsertionIndex = 0;
      const nextMessages: AppSessionMessage[] = [];
      const nextPartMap: Record<string, SessionPart[]> = {};

      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }

        const mapped = mapHistoryEntry(entry as Record<string, unknown>, nextInsertionIndex);
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
    } catch {
      if (controller.signal.aborted) {
        return;
      }
    }
  }, [apiUrl, applyState, sessionId, token]);

  const applyMessageUpdate = useCallback((payload: Record<string, unknown>) => {
    const info = (payload.info as Record<string, unknown> | undefined) ?? payload;
    const id = typeof info.id === 'string' ? info.id : '';
    const role = typeof info.role === 'string' ? info.role : 'assistant';

    if (!id) {
      return;
    }

    const time = (info.time as Record<string, unknown> | undefined) ?? {};
    const createdAt = typeof time.created === 'number'
      ? time.created
      : normalizeTimestamp(info.timestamp);
    const completedAt = typeof time.completed === 'number' ? time.completed : undefined;

    applyState((current) => {
      const existingIndex = current.messages.findIndex((message) => message.id === id);
      const insertionIndex = existingIndex >= 0
        ? current.messages[existingIndex]?._insertionIndex ?? existingIndex
        : current.nextInsertionIndex;
      const nextMessage: AppSessionMessage = {
        id,
        role: role as AppSessionMessage['role'],
        ...(typeof info.runID === 'string' ? { runId: info.runID } : {}),
        ...(typeof info.run_id === 'string' ? { runId: info.run_id } : {}),
        ...(Object.prototype.hasOwnProperty.call(info, 'success') ? {
          success: typeof info.success === 'boolean' ? info.success : null,
        } : {}),
        ...(Object.prototype.hasOwnProperty.call(info, 'error') ? {
          error: typeof info.error === 'string' ? info.error : null,
        } : {}),
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
        nextInsertionIndex: existingIndex >= 0 ? current.nextInsertionIndex : current.nextInsertionIndex + 1,
      };
    });

    if (role === 'assistant') {
      activeAssistantMessageIdRef.current = id;
      setIsStreaming(true);
    }
  }, [applyState]);

  const applyMessagePartUpdate = useCallback((payload: Record<string, unknown>) => {
    const partPayload = (payload.part as Record<string, unknown> | undefined) ?? payload;
    const messageId = typeof partPayload.messageID === 'string'
      ? partPayload.messageID
      : (typeof payload.messageID === 'string' ? payload.messageID : '');

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
      const partId = typeof partPayload.id === 'string' ? partPayload.id : undefined;

      if (partId) {
        replaceIndex = nextParts.findIndex((entry) => {
          if (!('id' in entry)) {
            return false;
          }
          return (entry as { id?: string }).id === partId;
        });
      } else if (part.type === 'tool') {
        replaceIndex = nextParts.findIndex(
          (entry) => entry.type === 'tool' && (entry as ToolPart).id === part.id,
        );
      } else if (part.type === 'text') {
        replaceIndex = nextParts.findIndex((entry) => entry.type === 'text');
      } else if (part.type === 'reasoning') {
        replaceIndex = nextParts.findIndex((entry) => entry.type === 'reasoning');
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
  }, [applyState]);

  const handleEvent = useCallback((event: StreamEvent) => {
    if (!event.data || typeof event.data !== 'object') {
      if (event.type === 'session.idle') {
        setIsStreaming(false);
        activeAssistantMessageIdRef.current = null;
        void refetch();
      }
      return;
    }

    const payload = event.data as Record<string, unknown>;
    const details = (payload.properties as Record<string, unknown> | undefined) ?? payload;

    if (event.type === 'message.updated') {
      applyMessageUpdate(details);
      return;
    }

    if (event.type === 'message.part.updated') {
      applyMessagePartUpdate(details);
      return;
    }

    if (event.type === 'session.idle') {
      setIsStreaming(false);
      activeAssistantMessageIdRef.current = null;
      void refetch();
      return;
    }

    if (event.type === 'session.error') {
      const message = typeof details.error === 'string'
        ? details.error
        : typeof details.message === 'string'
          ? details.message
          : 'Agent error';
      setError(message);
      setIsStreaming(false);
      activeAssistantMessageIdRef.current = null;
      return;
    }

    if (event.type === 'assistant_message' || event.type === 'user_message') {
      const mapped = mapHistoryEntry(details, stateRef.current.nextInsertionIndex);
      if (!mapped) {
        return;
      }

      applyState((current) => ({
        messages: [...current.messages, mapped.message],
        partMap: {
          ...current.partMap,
          [mapped.message.id]: mapped.parts,
        },
        nextInsertionIndex: current.nextInsertionIndex + 1,
      }));
    }
  }, [applyMessagePartUpdate, applyMessageUpdate, applyState, refetch]);

  const connectStream = useCallback(async () => {
    if (!enabled || !apiUrl || !token || !sessionId) {
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
          credentials: 'include',
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Chat stream is unavailable');
      }

      setConnected(true);
      setError((current) => {
        if (current && stateRef.current.messages.length > 0) {
          return null;
        }
        return current;
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const parsed = parseEventFrame(frame);
            if (parsed) {
              handleEvent(parsed);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!controller.signal.aborted) {
        setConnected(false);
        reconnectTimerRef.current = setTimeout(() => {
          void connectStream();
        }, RECONNECT_DELAY_MS);
      }
    } catch (streamError) {
      if (controller.signal.aborted) {
        return;
      }

      setConnected(false);
      if (stateRef.current.messages.length === 0) {
        setError(streamError instanceof Error ? streamError.message : 'SSE connection error');
      }
      reconnectTimerRef.current = setTimeout(() => {
        void connectStream();
      }, RECONNECT_DELAY_MS);
    }
  }, [apiUrl, clearReconnectTimer, enabled, handleEvent, sessionId, token]);

  const send = useCallback(async (text: string) => {
    if (!token || !apiUrl || !sessionId) {
      throw new Error('Chat is not authenticated');
    }

    const response = await fetch(`${apiUrl}/session/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'include',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });

    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }

    setError(null);
    setIsStreaming(true);
  }, [apiUrl, sessionId, token]);

  const abort = useCallback(async () => {
    if (!token || !apiUrl || !sessionId) {
      return;
    }

    const response = await fetch(`${apiUrl}/session/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
  }, [apiUrl, sessionId, token]);

  useEffect(() => {
    loadCachedSnapshot();
  }, [loadCachedSnapshot]);

  useEffect(() => {
    if (!enabled || !apiUrl || !token || !sessionId) {
      streamAbortRef.current?.abort();
      historyAbortRef.current?.abort();
      clearReconnectTimer();
      setConnected(false);
      setIsStreaming(false);
      return;
    }

    void refetch();
    void connectStream();

    return () => {
      streamAbortRef.current?.abort();
      historyAbortRef.current?.abort();
      clearReconnectTimer();
      setConnected(false);
    };
  }, [apiUrl, clearReconnectTimer, connectStream, enabled, refetch, sessionId, token]);

  return {
    messages,
    partMap,
    isStreaming,
    connected,
    error,
    refetch,
    send,
    abort,
  };
}
