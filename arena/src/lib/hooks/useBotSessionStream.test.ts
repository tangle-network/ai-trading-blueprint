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
});
