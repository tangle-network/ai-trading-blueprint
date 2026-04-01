import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBotId } from './resolveBotId';

describe('resolveBotId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends bearer auth when a token is provided', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveBotId('http://operator.test', {
      botId: 'bot-1',
      token: 'token-123',
    });

    expect(result).toEqual({ botId: 'bot-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://operator.test/api/bots/bot-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer token-123',
        }),
      }),
    );
  });

  it('reports auth_required on protected operator 401 responses', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveBotId('http://operator.test', {
      callId: 0,
      serviceId: 1,
    });

    expect(result).toEqual({
      error: 'Operator authentication required to load bot data.',
      code: 'auth_required',
    });
  });

  it('prefers provision metadata bot_id before service/call lookup', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'http://operator.test/api/provisions/7') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ metadata: { bot_id: 'bot-from-provision' } }),
        };
      }
      if (input === 'http://operator.test/api/bots/bot-from-provision') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'bot-from-provision',
            sandbox_id: 'sandbox-provision',
            sandbox_exists: true,
            call_id: 7,
            service_id: 1,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveBotId('http://operator.test', {
      callId: 7,
      serviceId: 1,
    });

    expect(result).toEqual({ botId: 'bot-from-provision' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://operator.test/api/provisions/7',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('skips a stale cached bot id and falls back to provision metadata', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'http://operator.test/api/bots/stale-bot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'stale-bot',
            sandbox_id: 'sandbox-stale',
            sandbox_exists: false,
            call_id: 7,
            service_id: 1,
          }),
        };
      }
      if (input === 'http://operator.test/api/provisions/7') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ metadata: { bot_id: 'fresh-bot' } }),
        };
      }
      if (input === 'http://operator.test/api/bots/fresh-bot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'fresh-bot',
            sandbox_id: 'sandbox-fresh',
            sandbox_exists: true,
            call_id: 7,
            service_id: 1,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveBotId('http://operator.test', {
      botId: 'stale-bot',
      callId: 7,
      serviceId: 1,
    });

    expect(result).toEqual({ botId: 'fresh-bot' });
  });

  it('ignores a cached bot id when its sandbox no longer matches the provision hints', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'http://operator.test/api/bots/wrong-bot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'wrong-bot',
            sandbox_id: 'sandbox-old',
            sandbox_exists: true,
            call_id: 7,
            service_id: 1,
          }),
        };
      }
      if (input === 'http://operator.test/api/provisions/7') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ metadata: { bot_id: 'fresh-bot' } }),
        };
      }
      if (input === 'http://operator.test/api/bots/fresh-bot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'fresh-bot',
            sandbox_id: 'sandbox-fresh',
            sandbox_exists: true,
            call_id: 7,
            service_id: 1,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveBotId('http://operator.test', {
      botId: 'wrong-bot',
      callId: 7,
      serviceId: 1,
      sandboxId: 'sandbox-fresh',
    });

    expect(result).toEqual({ botId: 'fresh-bot' });
  });

  it('surfaces backend conflict responses from service/call lookup', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'http://operator.test/api/provisions/7') {
        return {
          ok: false,
          status: 404,
          text: async () => 'missing',
        };
      }
      if (input === 'http://operator.test/api/bots?call_id=7&service_id=1') {
        return {
          ok: false,
          status: 409,
          text: async () => JSON.stringify({
            code: 'conflict',
            message: 'Multiple live bots found',
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveBotId('http://operator.test', {
      callId: 7,
      serviceId: 1,
    });

    expect(result).toEqual({
      error: 'Multiple live bots found',
      code: 'conflict',
    });
  });
});
