import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOperatorAuth } from './useOperatorAuth';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import { readOperatorError } from '~/lib/operator/errors';
import { dispatchBotsRefresh } from '~/lib/events/bots';
import type { BotOperatorKind } from '~/lib/types/bot';

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

  const updateConfig = useMutation({
    mutationFn: async (params: {
      strategyConfigJson?: string;
      riskParamsJson?: string;
    }) => {
      const t = await ensureToken();
      return apiCall(apiUrl, buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/config'), 'PATCH', t, {
        strategy_config_json: params.strategyConfigJson,
        risk_params_json: params.riskParamsJson,
      });
    },
    onSuccess: invalidate,
    onError: onMutationError('Update config'),
  });

  return {
    startBot,
    stopBot,
    runNow,
    updateConfig,
    isAuthenticated,
    authenticate,
  };
}
