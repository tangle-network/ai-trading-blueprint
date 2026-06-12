import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBotSessionStream } from './useBotSessionStream';

describe('useBotSessionStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hydrates text parts from message content when history entries omit parts', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ([
        {
          info: {
            id: 'user-1',
            role: 'user',
            content: 'hello who are you',
            time: { created: 1 },
          },
        },
        {
          info: {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I can help with your bot.',
            time: { created: 2 },
          },
        },
      ]),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useBotSessionStream({
      apiUrl: 'http://localhost:9201',
      token: 'test-token',
      sessionId: 'session-1',
      enabled: false,
    }));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    expect(result.current.partMap['user-1']).toEqual([
      { type: 'text', text: 'hello who are you' },
    ]);
    expect(result.current.partMap['assistant-1']).toEqual([
      { type: 'text', text: 'I can help with your bot.' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches history when a sync event moves the transcript revision', async () => {
    let sse: ReadableStreamDefaultController<Uint8Array> | null = null;
    let historyCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session/events')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              sse = controller;
            },
          }),
        };
      }
      historyCalls += 1;
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useBotSessionStream({
      apiUrl: 'http://localhost:9201',
      token: 'test-token',
      sessionId: 'session-1',
    }));

    await waitFor(() => {
      expect(sse).not.toBeNull();
      expect(historyCalls).toBe(1);
    });

    const emitSync = (revision: string) => {
      sse?.enqueue(new TextEncoder().encode(
        `event: sync\ndata: {"sessionId":"session-1","revision":"${revision}","messageCount":0}\n\n`,
      ));
    };

    // First sync primes the revision cursor — history was already fetched.
    await act(async () => {
      emitSync('11');
    });
    expect(historyCalls).toBe(1);

    // A moved revision means the transcript changed server-side.
    await act(async () => {
      emitSync('22');
    });
    await waitFor(() => {
      expect(historyCalls).toBe(2);
    });

    // Same revision again is not a change.
    await act(async () => {
      emitSync('22');
    });
    expect(historyCalls).toBe(2);

    unmount();
  });

  it('reconnects silently through clean EOF cycles without repainting the chip', async () => {
    vi.useFakeTimers();
    try {
      let sseConnects = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/session/events')) {
          sseConnects += 1;
          // Legacy operator shape: one sync event, then the response ends.
          return {
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(
                  'event: sync\ndata: {"sessionId":"session-1","revision":"7","messageCount":0}\n\n',
                ));
                controller.close();
              },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result, unmount } = renderHook(() => useBotSessionStream({
        apiUrl: 'http://localhost:9201',
        token: 'test-token',
        sessionId: 'session-1',
      }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(sseConnects).toBe(1);
      expect(result.current.connected).toBe(true);

      // Several EOF/reconnect cycles: the chip never flips, the backoff grows
      // (flapping connections must not reset the attempt counter).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(sseConnects).toBeGreaterThan(1);
      expect(result.current.connected).toBe(true);
      expect(result.current.isReconnecting).toBe(false);
      expect(result.current.attempt).toBeGreaterThanOrEqual(1);

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a sustained outage once the error grace window elapses', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/session/events')) {
          throw new Error('connection refused');
        }
        return { ok: true, status: 200, json: async () => [] };
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result, unmount } = renderHook(() => useBotSessionStream({
        apiUrl: 'http://localhost:9201',
        token: 'test-token',
        sessionId: 'session-1',
      }));

      // Inside the grace window the failure stays silent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(result.current.isReconnecting).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(result.current.connected).toBe(false);
      expect(result.current.isReconnecting).toBe(true);

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
