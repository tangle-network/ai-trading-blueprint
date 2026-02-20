/**
 * Multi-strategy bot ID resolution.
 *
 * Tries three lookup strategies in order of reliability:
 *   1. Direct bot ID verification
 *   2. On-chain call_id + service_id query
 *   3. Sandbox ID scan (legacy fallback)
 */
export async function resolveBotId(
  operatorApiUrl: string,
  opts: {
    botId?: string;
    callId?: number;
    serviceId?: number;
    sandboxId?: string;
  },
): Promise<{ botId: string } | { error: string }> {
  if (!operatorApiUrl) {
    return { error: 'Operator API URL not configured' };
  }

  // Strategy 1: verify known bot ID exists
  if (opts.botId) {
    try {
      const res = await fetch(`${operatorApiUrl}/api/bots/${opts.botId}`);
      if (res.ok) return { botId: opts.botId };
    } catch {
      // fall through
    }
  }

  // Strategy 2: lookup by on-chain call_id + service_id (most reliable)
  if (opts.callId != null && opts.serviceId != null) {
    try {
      const res = await fetch(
        `${operatorApiUrl}/api/bots?call_id=${opts.callId}&service_id=${opts.serviceId}`,
      );
      if (res.ok) {
        const data = await res.json();
        if (data.bots?.length > 0) {
          return { botId: data.bots[0].id as string };
        }
      }
    } catch {
      // fall through
    }
  }

  // Strategy 3: scan all bots by sandbox_id (legacy fallback)
  if (opts.sandboxId) {
    try {
      const res = await fetch(`${operatorApiUrl}/api/bots?limit=200`);
      if (res.ok) {
        const data = await res.json();
        const match = data.bots?.find(
          (b: { sandbox_id: string }) => b.sandbox_id === opts.sandboxId,
        );
        if (match) return { botId: match.id as string };
      }
    } catch {
      // fall through
    }
  }

  return { error: 'Bot not found on operator. It may still be registering.' };
}
