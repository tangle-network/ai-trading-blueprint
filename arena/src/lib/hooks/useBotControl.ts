import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOperatorAuth } from './useOperatorAuth';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import { readOperatorError } from '~/lib/operator/errors';
import { dispatchBotsRefresh } from '~/lib/events/bots';
import type { BotOperatorKind } from '~/lib/types/bot';

export type AgentHarness = 'opencode' | 'claude-code' | 'codex';

export interface AgentRuntimeModel {
  provider?: string | null;
  name?: string | null;
  base_url?: string | null;
  api_key_set: boolean;
}

export interface AgentRuntimeState {
  agent_harness: AgentHarness | string;
  model: AgentRuntimeModel;
}

export interface AgentRuntimeUpdate {
  agent_harness?: string;
  model_provider?: string;
  model_name?: string;
  model_base_url?: string;
  model_api_key?: string;
}

async function apiCall(
  apiUrl: string,
  path: string,
  method: string,
  token: string,
  body?: unknown,
) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw await readOperatorError(res);
  }
  return res.json();
}

export function useBotControl(
  botId: string,
  operatorApiUrl?: string | null,
  operatorKind?: BotOperatorKind,
) {
  const apiUrl = operatorApiUrl ?? '';
  const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
  const { token, authenticate, isAuthenticated } = useOperatorAuth(apiUrl);
  const queryClient = useQueryClient();

  const ensureToken = async (): Promise<string> => {
    if (token) return token;
    const newToken = await authenticate();
    if (!newToken) throw new Error('Authentication required');
    return newToken;
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['bot-detail', apiUrl, botId] });
    queryClient.invalidateQueries({ queryKey: ['bot-agent-runtime', apiUrl, botId] });
    queryClient.invalidateQueries({ queryKey: ['bot-metrics', apiUrl, botId] });
    queryClient.invalidateQueries({ queryKey: ['bot-trades', apiUrl, botId] });
    queryClient.invalidateQueries({ queryKey: ['bot-trade-page', apiUrl, botId] });
    queryClient.invalidateQueries({ queryKey: ['bot-recent-validations', apiUrl, botId] });
    queryClient.invalidateQueries({ queryKey: ['bot-portfolio', apiUrl, botId] });
    queryClient.invalidateQueries({ queryKey: ['bot-enrichment', apiUrl, botId] });
    dispatchBotsRefresh();
  };

  const onMutationError = (action: string) => (err: Error) => {
    toast.error(`${action} failed: ${err.message.slice(0, 120)}`);
  };

  const startBot = useMutation({
    mutationFn: async () => {
      const t = await ensureToken();
      return apiCall(apiUrl, buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/start'), 'POST', t);
    },
    onSuccess: invalidate,
    onError: onMutationError('Start bot'),
  });

  const stopBot = useMutation({
    mutationFn: async () => {
      const t = await ensureToken();
      return apiCall(apiUrl, buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/stop'), 'POST', t);
    },
    onSuccess: invalidate,
    onError: onMutationError('Stop bot'),
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const t = await ensureToken();
      return apiCall(apiUrl, buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/run-now'), 'POST', t);
    },
    onSuccess: invalidate,
    onError: onMutationError('Run now'),
  });

  const agentRuntime = useQuery({
    queryKey: ['bot-agent-runtime', apiUrl, botId, deploymentKind, token ?? 'anonymous'],
    enabled: !!apiUrl && !!botId && !!token,
    staleTime: 10_000,
    queryFn: async () => {
      const t = await ensureToken();
      return apiCall(
        apiUrl,
        buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/agent-runtime'),
        'GET',
        t,
      ) as Promise<AgentRuntimeState>;
    },
  });

  const updateConfig = useMutation({
    mutationFn: async (params: {
      strategyConfigJson?: string;
      riskParamsJson?: string;
      tradingLoopCron?: string;
    }) => {
      const t = await ensureToken();
      return apiCall(apiUrl, buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/config'), 'PATCH', t, {
        strategy_config_json: params.strategyConfigJson,
        risk_params_json: params.riskParamsJson,
        trading_loop_cron: params.tradingLoopCron,
      });
    },
    onSuccess: invalidate,
    onError: onMutationError('Update config'),
  });

  const updateAgentRuntime = useMutation({
    mutationFn: async (params: AgentRuntimeUpdate) => {
      const t = await ensureToken();
      return apiCall(
        apiUrl,
        buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/agent-runtime'),
        'PATCH',
        t,
        params,
      ) as Promise<AgentRuntimeState>;
    },
    onSuccess: invalidate,
    onError: onMutationError('Update runtime'),
  });

  return {
    startBot,
    stopBot,
    runNow,
    agentRuntime,
    updateConfig,
    updateAgentRuntime,
    isAuthenticated,
    authenticate,
  };
}
