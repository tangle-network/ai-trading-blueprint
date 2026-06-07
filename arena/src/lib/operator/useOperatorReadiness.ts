import { useQuery } from '@tanstack/react-query';
import { normalizeEndpoint } from './registration';
import type { OperatorMeta } from './meta';

/**
 * Live readiness check for an operator's advertised endpoint. Polls `/health`
 * and `/api/meta` so the operator sees their node answer (green) and their own
 * `request_access` policy reflected back — the honest mirror of what requesters
 * will see in the directory.
 *
 * Failure is actionable, not a stack trace: we classify the most common reasons
 * a freshly-deployed node won't answer (offline, blocked by CORS/network, or
 * answering but without the policy block) so the screen can say what to fix.
 */
export type OperatorReadinessState = 'idle' | 'checking' | 'online' | 'offline';

export interface OperatorReadiness {
  state: OperatorReadinessState;
  /** Parsed `/api/meta` payload when the node answered it. */
  meta?: OperatorMeta;
  /** Human-actionable reason the node isn't green, when offline. */
  reason?: string;
  /** Raw transport/HTTP detail for the "Advanced" disclosure. */
  detail?: string;
  isFetching: boolean;
  refetch: () => void;
}

interface ReadinessProbe {
  meta: OperatorMeta;
}

async function probeOperator(endpoint: string): Promise<ReadinessProbe> {
  const base = normalizeEndpoint(endpoint);

  // Health first: cheapest signal that the process is up and reachable.
  const health = await fetchWithTimeout(`${base}/health`);
  if (!health.ok) {
    throw new ReadinessError(
      `Operator API answered ${health.status} on /health.`,
      `HTTP ${health.status} from ${base}/health`,
    );
  }

  const metaRes = await fetchWithTimeout(`${base}/api/meta`);
  if (!metaRes.ok) {
    throw new ReadinessError(
      `Node is up but /api/meta returned ${metaRes.status}.`,
      `HTTP ${metaRes.status} from ${base}/api/meta`,
    );
  }
  const meta = (await metaRes.json()) as OperatorMeta;
  return { meta };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new ReadinessError(
      'Could not reach the endpoint. Check the URL is public and the operator API port is open.',
      error instanceof Error ? error.message : 'Network error',
    );
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

class ReadinessError extends Error {
  detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'ReadinessError';
    this.detail = detail;
  }
}

export function useOperatorReadiness(endpoint: string | undefined): OperatorReadiness {
  const normalized = endpoint ? normalizeEndpoint(endpoint) : '';
  const enabled = normalized.length > 0;

  const query = useQuery<ReadinessProbe, ReadinessError>({
    queryKey: ['operator-readiness', normalized],
    queryFn: () => probeOperator(normalized),
    enabled,
    // Poll while the panel is open so the dot flips to green the moment the node
    // comes up — operators typically run this right after `docker compose up`.
    refetchInterval: 10_000,
    retry: false,
    staleTime: 0,
  });

  if (!enabled) {
    return { state: 'idle', isFetching: false, refetch: () => query.refetch() };
  }

  if (query.data) {
    return {
      state: 'online',
      meta: query.data.meta,
      isFetching: query.isFetching,
      refetch: () => query.refetch(),
    };
  }

  if (query.isError) {
    return {
      state: 'offline',
      reason: query.error?.message ?? 'Operator did not respond.',
      detail: query.error?.detail,
      isFetching: query.isFetching,
      refetch: () => query.refetch(),
    };
  }

  return {
    state: 'checking',
    isFetching: query.isFetching,
    refetch: () => query.refetch(),
  };
}
