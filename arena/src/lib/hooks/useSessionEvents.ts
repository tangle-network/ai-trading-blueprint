import { useEffect, useRef, useState, useCallback } from 'react';

export interface SessionEvent {
  type: string;
  properties: Record<string, unknown>;
}

interface UseSessionEventsResult {
  connected: boolean;
  error: string | null;
}

/**
 * Subscribe to SSE events from the session proxy.
 *
 * Uses `fetch` + ReadableStream instead of EventSource since we need
 * to pass an Authorization header.
 */
export function useSessionEvents(
  apiUrl: string,
  token: string | null,
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
): UseSessionEventsResult {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(async () => {
    if (!token || !sessionId) return;

    // Clean up previous connection
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const url = `${apiUrl}/session/events?sessionId=${encodeURIComponent(sessionId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connection failed: ${res.status}`);
      }

      setConnected(true);
      setError(null);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames (double newline separated)
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (!frame.trim()) continue;

          let eventType = 'message';
          const dataLines: string[] = [];

          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (dataLines.length > 0) {
            const data = dataLines.join('\n');
            try {
              const parsed = JSON.parse(data);
              onEventRef.current({
                type: eventType,
                properties: parsed,
              });
            } catch {
              onEventRef.current({
                type: eventType,
                properties: { raw: data },
              });
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'SSE connection error';
      setError(msg);
      setConnected(false);

      // Auto-reconnect after 3 seconds
      if (!controller.signal.aborted) {
        setTimeout(() => connect(), 3000);
      }
    }
  }, [apiUrl, token, sessionId]);

  useEffect(() => {
    connect();
    return () => {
      abortRef.current?.abort();
      setConnected(false);
    };
  }, [connect]);

  return { connected, error };
}
