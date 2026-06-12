import { useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import {
  parseRunsResponse,
  type BotRun,
  type BotRunsResponse,
} from '~/lib/botRuns';
import type { BotOperatorKind } from '~/lib/types/bot';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
  useOperatorMeta,
} from '~/lib/operator/meta';
import { useOperatorAuth } from './useOperatorAuth';

interface UseBotRunsOptions {
  botId: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  enabled?: boolean;
  limit?: number;
}

export function isBotRunsAuthError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return /HTTP (401|403)/i.test(raw) || /unauthorized|forbidden/i.test(raw);
}

export function useBotRuns({
  botId,
  operatorApiUrl,
  operatorKind,
  enabled = true,
  limit = 100,
}: UseBotRunsOptions) {
  const baseApiUrl = operatorApiUrl ?? '';
  const { data: operatorMeta } = useOperatorMeta(baseApiUrl);
  const deploymentKind = operatorKind == null && operatorMeta
    ? operatorMeta.deployment_kind
    : getDeploymentKindForOperatorKind(operatorKind);
  const needsAuth = deploymentKind !== 'fleet';
  const apiUrl = operatorMeta && baseApiUrl && botId
    ? `${baseApiUrl}${buildBotScopedPathForDeploymentKind(deploymentKind, botId)}`
    : '';
  const { token, isAuthenticated } = useOperatorAuth(baseApiUrl);
  const authKey = token ?? 'anonymous';

  const runsQuery = useInfiniteQuery({
    queryKey: ['bot-runs', apiUrl, authKey],
    enabled: enabled && !!apiUrl,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const cursor =
        typeof pageParam === 'string' && pageParam.length > 0
          ? pageParam
          : null;
      const response = await fetch(
        `${apiUrl}/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        {
          headers: needsAuth && token ? { Authorization: `Bearer ${token}` } : {},
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${body || 'Failed to load runs'}`,
        );
      }

      return parseRunsResponse(await response.json());
    },
    getNextPageParam: (lastPage: BotRunsResponse) =>
      lastPage.nextCursor ?? undefined,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const payload = query.state.data as
        | InfiniteData<BotRunsResponse>
        | undefined;
      return payload?.pages?.some((page) =>
        page.runs.some((run) => run.status === 'running'),
      )
        ? 5_000
        : false;
    },
  });

  const runs = useMemo<BotRun[]>(() => {
    const seen = new Set<string>();
    return (
      runsQuery.data?.pages.flatMap((page) =>
        page.runs.filter((run) => {
          if (seen.has(run.runId)) {
            return false;
          }
          seen.add(run.runId);
          return true;
        }),
      ) ?? []
    );
  }, [runsQuery.data]);

  return {
    apiUrl,
    authKey,
    isAuthenticated,
    needsAuth,
    operatorMeta,
    runs,
    runsQuery,
    token,
  };
}
