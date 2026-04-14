import { useCallback, useEffect, useRef, useState } from 'react';

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface UseOperatorTerminalSessionOptions {
  apiUrl: string;
  resourcePath: string;
  token: string;
  initialCwd?: string;
  terminalSize: TerminalSize | null;
  onOutput: (data: string) => void;
}

export interface UseOperatorTerminalSessionReturn {
  isConnected: boolean;
  error: string | null;
  sessionId: string | null;
  sendInput: (data: string) => Promise<void>;
  reconnect: () => void;
  newSession: () => void;
}

interface TerminalSessionResponse {
  session_id?: string;
  sessionId?: string;
}

interface TerminalSessionListResponse {
  sessions?: Array<{ session_id?: string; sessionId?: string; title?: string }>;
}

interface OperatorApiErrorBody {
  error?: string | { message?: string };
  message?: string;
  code?: string;
  retry_after_ms?: number;
}

interface TerminalStreamEvent {
  type?: string;
  properties?: {
    text?: string;
  };
}

const KEEP_ALIVE_MESSAGE = 'keep-alive';
const TERMINAL_UNSUPPORTED_ERROR_CODE = 'TERMINAL_UNSUPPORTED';
const RETRY_DELAY_MS = 3000;

class OperatorApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;

  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'OperatorApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseOperatorApiErrorMessage(body: OperatorApiErrorBody | null, text: string, fallbackMessage: string): string {
  if (typeof body?.error === 'string' && body.error.trim()) {
    return body.error;
  }
  if (typeof body?.error === 'object' && typeof body.error?.message === 'string' && body.error.message.trim()) {
    return body.error.message;
  }
  if (typeof body?.message === 'string' && body.message.trim()) {
    return body.message;
  }
  if (text.trim()) {
    return text;
  }
  return fallbackMessage;
}

async function parseOperatorApiError(response: Response, fallbackMessage: string): Promise<OperatorApiError> {
  const text = await response.text();
  let body: OperatorApiErrorBody | null = null;

  if (text) {
    try {
      body = JSON.parse(text) as OperatorApiErrorBody;
    } catch {
      body = null;
    }
  }

  return new OperatorApiError(
    response.status,
    parseOperatorApiErrorMessage(body, text, fallbackMessage),
    body?.code,
    body?.retry_after_ms,
  );
}

function isTerminalUnsupportedError(error: unknown): boolean {
  return error instanceof OperatorApiError && error.code === TERMINAL_UNSUPPORTED_ERROR_CODE;
}

function shouldRetryTerminalError(error: unknown): boolean {
  return !isTerminalUnsupportedError(error);
}

function parseStreamOutput(eventType: string, rawMessage: string): string | null {
  if (!rawMessage || rawMessage === KEEP_ALIVE_MESSAGE) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawMessage) as TerminalStreamEvent;
    const resolvedType = parsed.type ?? eventType;
    if (
      (resolvedType === 'data.stdout' || resolvedType === 'data.stderr')
      && typeof parsed.properties?.text === 'string'
    ) {
      return parsed.properties.text;
    }
    return null;
  } catch {
    return rawMessage;
  }
}

function parseSseFrames(chunk: string): string[] {
  const messages: string[] = [];
  let eventType = 'message';
  let eventData: string[] = [];

  const flushEvent = () => {
    if (eventData.length === 0) {
      return;
    }
    const parsed = parseStreamOutput(eventType, eventData.join('\n'));
    if (parsed) {
      messages.push(parsed);
    }
    eventData = [];
    eventType = 'message';
  };

  for (const line of chunk.split('\n')) {
    if (!line.trim()) {
      flushEvent();
      continue;
    }

    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      eventData.push(line.slice(5).trimStart());
    }
  }

  flushEvent();
  return messages;
}

function resizeSignature(sessionId: string, terminalSize: TerminalSize): string {
  return `${sessionId}:${terminalSize.cols}x${terminalSize.rows}`;
}

export function useOperatorTerminalSession({
  apiUrl,
  resourcePath,
  token,
  initialCwd = '',
  terminalSize,
  onOutput,
}: UseOperatorTerminalSessionOptions): UseOperatorTerminalSessionReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);
  const hasStartedRef = useRef(false);
  const onOutputRef = useRef(onOutput);
  const lastResizeRef = useRef<string | null>(null);
  const resolvedInitialCwd = initialCwd.trim();

  onOutputRef.current = onOutput;

  const terminalSessionBaseUrl = `${apiUrl}${resourcePath}/live/terminal/sessions`;

  const emitOutput = useCallback((data: string) => {
    if (!data || data === KEEP_ALIVE_MESSAGE) return;
    onOutputRef.current(data);
  }, []);

  const cleanupStream = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    sessionIdRef.current = null;
    lastResizeRef.current = null;
    setSessionId(null);
    setIsConnected(false);
  }, []);

  const connectToStream = useCallback(async (targetSessionId: string) => {
    sessionIdRef.current = targetSessionId;
    if (mountedRef.current) {
      setSessionId(targetSessionId);
    }

    const controller = new AbortController();
    streamAbortRef.current = controller;

    const streamRes = await fetch(
      `${terminalSessionBaseUrl}/${encodeURIComponent(targetSessionId)}/stream`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );

    if (!streamRes.ok) {
      throw await parseOperatorApiError(streamRes, `Terminal stream failed: ${streamRes.status}`);
    }

    if (!streamRes.body) {
      throw new Error('Terminal stream is unavailable');
    }

    if (mountedRef.current) {
      setIsConnected(true);
      setError(null);
    }

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (!frame.trim()) continue;
        for (const message of parseSseFrames(frame)) {
          emitOutput(message);
        }
      }
    }
  }, [emitOutput, terminalSessionBaseUrl, token]);

  const createSession = useCallback(async (): Promise<string> => {
    if (!terminalSize) {
      throw new Error('Terminal size is unavailable');
    }

    const payload: Record<string, number | string> = {
      cols: terminalSize.cols,
      rows: terminalSize.rows,
    };
    if (resolvedInitialCwd) {
      payload.cwd = resolvedInitialCwd;
    }

    const createRes = await fetch(terminalSessionBaseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!createRes.ok) {
      throw await parseOperatorApiError(
        createRes,
        `Failed to create terminal session: ${createRes.status}`,
      );
    }

    const body = await createRes.json() as TerminalSessionResponse;
    const id = body.session_id ?? body.sessionId;
    if (!id) {
      throw new Error('Missing terminal session id');
    }

    lastResizeRef.current = resizeSignature(id, terminalSize);
    return id;
  }, [resolvedInitialCwd, terminalSessionBaseUrl, terminalSize, token]);

  const resizeSession = useCallback(async (targetSessionId: string, nextSize: TerminalSize) => {
    const resizeRes = await fetch(
      `${terminalSessionBaseUrl}/${encodeURIComponent(targetSessionId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(nextSize),
      },
    );

    if (!resizeRes.ok) {
      throw await parseOperatorApiError(resizeRes, `Terminal resize failed: ${resizeRes.status}`);
    }
  }, [terminalSessionBaseUrl, token]);

  const resolveAndConnect = useCallback(async () => {
    if (!terminalSize) {
      return;
    }

    cleanupStream();
    setError(null);

    try {
      try {
        const listRes = await fetch(terminalSessionBaseUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!listRes.ok) {
          throw await parseOperatorApiError(listRes, `Failed to list terminal sessions: ${listRes.status}`);
        }

        const body = await listRes.json() as TerminalSessionListResponse;
        const sessions = body.sessions ?? [];
        const last = sessions[sessions.length - 1];
        const existingId = last?.session_id ?? last?.sessionId;

        if (existingId) {
          try {
            await connectToStream(existingId);
            return;
          } catch (streamErr) {
            if ((streamErr as Error).name === 'AbortError' || !mountedRef.current) {
              return;
            }
            if (isTerminalUnsupportedError(streamErr)) {
              throw streamErr;
            }

            fetch(`${terminalSessionBaseUrl}/${encodeURIComponent(existingId)}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            }).catch(() => {});
          }
        }
      } catch (err) {
        if (isTerminalUnsupportedError(err)) {
          throw err;
        }
      }

      if (!mountedRef.current) return;

      const newId = await createSession();
      if (!mountedRef.current) return;
      await connectToStream(newId);
    } catch (err) {
      if ((err as Error).name === 'AbortError' || !mountedRef.current) return;

      setIsConnected(false);
      setError(err instanceof Error ? err.message : 'Terminal connection failed');
      if (shouldRetryTerminalError(err)) {
        retryTimerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void resolveAndConnect();
          }
        }, RETRY_DELAY_MS);
      }
    }
  }, [cleanupStream, connectToStream, createSession, terminalSessionBaseUrl, terminalSize, token]);

  const forceNewSession = useCallback(async () => {
    if (!terminalSize) {
      return;
    }

    cleanupStream();
    setError(null);

    try {
      const newId = await createSession();
      if (!mountedRef.current) return;
      await connectToStream(newId);
    } catch (err) {
      if ((err as Error).name === 'AbortError' || !mountedRef.current) return;

      setIsConnected(false);
      setError(err instanceof Error ? err.message : 'Terminal connection failed');
      if (shouldRetryTerminalError(err)) {
        retryTimerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void forceNewSession();
          }
        }, RETRY_DELAY_MS);
      }
    }
  }, [cleanupStream, connectToStream, createSession, terminalSize]);

  const sendInput = useCallback(async (data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      throw new Error('Terminal session is not connected');
    }

    const inputRes = await fetch(
      `${terminalSessionBaseUrl}/${encodeURIComponent(sid)}/input`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data }),
      },
    );

    if (!inputRes.ok) {
      throw await parseOperatorApiError(inputRes, `Terminal input failed: ${inputRes.status}`);
    }
  }, [terminalSessionBaseUrl, token]);

  useEffect(() => {
    mountedRef.current = true;
    if (!hasStartedRef.current && terminalSize) {
      hasStartedRef.current = true;
      void resolveAndConnect();
    }

    return () => {
      mountedRef.current = false;
      cleanupStream();
    };
  }, [cleanupStream, resolveAndConnect, terminalSize]);

  useEffect(() => {
    if (!isConnected || !terminalSize) {
      return;
    }

    const sid = sessionIdRef.current;
    if (!sid) {
      return;
    }

    const signature = resizeSignature(sid, terminalSize);
    if (lastResizeRef.current === signature) {
      return;
    }

    let cancelled = false;
    void resizeSession(sid, terminalSize)
      .then(() => {
        if (!cancelled) {
          lastResizeRef.current = signature;
        }
      })
      .catch((err) => {
        if (cancelled || (err as Error).name === 'AbortError' || !mountedRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Terminal resize failed');
      });

    return () => {
      cancelled = true;
    };
  }, [isConnected, resizeSession, terminalSize]);

  return {
    isConnected,
    error,
    sessionId,
    sendInput,
    reconnect: () => {
      void resolveAndConnect();
    },
    newSession: () => {
      void forceNewSession();
    },
  };
}
