/**
 * Multi-strategy bot ID resolution.
 *
 * Tries three lookup strategies in order of reliability:
 *   1. Direct bot ID verification
 *   2. Provision progress metadata by call_id
 *   3. On-chain call_id + service_id query
 *   4. Sandbox ID scan (legacy fallback)
 */
type ResolveBotIdCode =
  | 'auth_required'
  | 'not_found'
  | 'operator_unreachable'
  | 'stale_state'
  | 'conflict';

interface BotLookupRecord {
  id?: string;
  sandbox_id?: string;
  sandbox_exists?: boolean;
  call_id?: number;
  service_id?: number;
}

interface OperatorErrorBody {
  code?: string;
  message?: string;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function isUniqueCallId(callId: number | undefined): callId is number {
  return typeof callId === 'number' && Number.isFinite(callId) && callId > 0;
}

function botMatchesHints(
  bot: BotLookupRecord,
  opts: {
    sandboxId?: string;
    callId?: number;
    serviceId?: number;
  },
): boolean {
  if (opts.sandboxId && bot.sandbox_id && bot.sandbox_id !== opts.sandboxId) {
    return false;
  }
  if (isUniqueCallId(opts.callId) && typeof bot.call_id === 'number' && bot.call_id !== opts.callId) {
    return false;
  }
  if (
    opts.serviceId != null
    && typeof bot.service_id === 'number'
    && bot.service_id !== opts.serviceId
  ) {
    return false;
  }
  return true;
}

async function readOperatorError(
  res: Response,
): Promise<{ code: ResolveBotIdCode; error: string }> {
  const raw = await res.text();

  try {
    const body = raw ? JSON.parse(raw) as OperatorErrorBody : null;
    const code = body?.code === 'stale_state' || body?.code === 'conflict'
      ? body.code as ResolveBotIdCode
      : undefined;
    if (code) {
      return {
        code,
        error: body?.message || raw || `HTTP ${res.status}`,
      };
    }
  } catch {
    // Fall through to generic HTTP handling.
  }

  return {
    code: 'operator_unreachable',
    error: raw || `HTTP ${res.status}`,
  };
}

async function verifyBotCandidate(
  operatorApiUrl: string,
  botId: string,
  headers: Record<string, string>,
  opts: {
    sandboxId?: string;
    callId?: number;
    serviceId?: number;
  },
): Promise<
  | { kind: 'match'; botId: string }
  | { kind: 'mismatch' }
  | { kind: 'auth_required' }
  | { kind: 'stale_state'; error: string }
  | { kind: 'operator_unreachable' }
> {
  const candidateUrls = [
    `${operatorApiUrl}/api/bots/${botId}`,
    `${operatorApiUrl}/api/bot`,
  ];

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 401 || res.status === 403) {
        return { kind: 'auth_required' };
      }
      if (!res.ok) {
        continue;
      }

      const data = await res.json() as BotLookupRecord;
      if (typeof data?.id !== 'string' || data.id !== botId) {
        continue;
      }
      if (data.sandbox_exists === false) {
        return {
          kind: 'stale_state',
          error: `Bot ${botId} points to missing sandbox ${data.sandbox_id ?? 'unknown'}. Operator state is stale; reprovision the agent from the deploy step.`,
        };
      }
      if (!botMatchesHints(data, opts)) {
        return { kind: 'mismatch' };
      }
      return { kind: 'match', botId };
    } catch {
      // Try the next candidate URL first.
    }
  }

  return { kind: 'operator_unreachable' };
}

export async function resolveBotId(
  operatorApiUrl: string,
  opts: {
    botId?: string;
    callId?: number;
    serviceId?: number;
    sandboxId?: string;
    token?: string | null;
  },
): Promise<
  | { botId: string }
  | { error: string; code: ResolveBotIdCode }
> {
  if (!operatorApiUrl) {
    return { error: 'Operator API URL not configured', code: 'operator_unreachable' };
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  const authRequired = {
    error: 'Operator authentication required to load bot data.',
    code: 'auth_required' as const,
  };
  let staleError: string | null = null;
  const uniqueCallId = isUniqueCallId(opts.callId) ? opts.callId : undefined;

  // Strategy 1: verify known bot ID exists
  if (opts.botId) {
    const verified = await verifyBotCandidate(operatorApiUrl, opts.botId, headers, opts);
    if (verified.kind === 'match') return { botId: verified.botId };
    if (verified.kind === 'auth_required') return authRequired;
    if (verified.kind === 'stale_state') {
      staleError = verified.error;
    }
  }

  // Strategy 2: lookup by on-chain call_id + service_id (most reliable)
  if (uniqueCallId != null) {
    try {
      const res = await fetch(
        `${operatorApiUrl}/api/provisions/${uniqueCallId}`,
        { headers },
      );
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.metadata?.bot_id === 'string' && data.metadata.bot_id.length > 0) {
          const provisionHints = {
            callId: uniqueCallId,
            serviceId: opts.serviceId ?? numberFromUnknown(data?.metadata?.service_id),
          };
          const verified = await verifyBotCandidate(
            operatorApiUrl,
            data.metadata.bot_id as string,
            headers,
            provisionHints,
          );
          if (verified.kind === 'match') return { botId: verified.botId };
          if (verified.kind === 'auth_required') return authRequired;
          if (verified.kind === 'stale_state') {
            staleError = verified.error;
          }
        }
      }
      if (res.status === 401 || res.status === 403) return authRequired;
      if (res.status === 409) {
        return readOperatorError(res);
      }
    } catch {
      // fall through
    }
  }

  // Strategy 3: lookup by on-chain call_id + service_id
  if (uniqueCallId != null && opts.serviceId != null) {
    try {
      const params = new URLSearchParams({
        call_id: String(uniqueCallId),
        service_id: String(opts.serviceId),
      });
      const res = await fetch(
        `${operatorApiUrl}/api/bots?${params}`,
        { headers },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.bots?.length > 0) {
          const matchingBots = (data.bots as BotLookupRecord[])
            .filter((bot) => typeof bot.id === 'string' && botMatchesHints(bot, opts));
          if (matchingBots.length === 1) {
            return { botId: matchingBots[0].id as string };
          }
          if (matchingBots.length > 1) {
            return {
              error: 'Multiple matching bots found on operator. Open the intended bot from the dashboard.',
              code: 'conflict',
            };
          }
        }
      }
      if (res.status === 401 || res.status === 403) return authRequired;
      if (res.status === 409) {
        return readOperatorError(res);
      }
    } catch {
      // fall through
    }
  }

  // Strategy 4: scan all bots by sandbox_id (legacy fallback)
  if (opts.sandboxId) {
    try {
      const res = await fetch(`${operatorApiUrl}/api/bots?limit=200`, { headers });
      if (res.ok) {
        const data = await res.json();
        const match = data.bots?.find(
          (b: { sandbox_id: string; sandbox_exists?: boolean }) =>
            b.sandbox_id === opts.sandboxId && b.sandbox_exists !== false,
        );
        if (match) return { botId: match.id as string };
      }
      if (res.status === 401 || res.status === 403) return authRequired;
    } catch {
      // fall through
    }
  }

  if (staleError) {
    return {
      error: staleError,
      code: 'stale_state',
    };
  }

  return {
    error: 'Bot not found on operator. It may still be registering.',
    code: 'not_found',
  };
}
