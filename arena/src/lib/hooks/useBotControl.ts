import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOperatorAuth } from './useOperatorAuth';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

async function apiCall(
  path: string,
  method: string,
  token: string,
  body?: unknown,
) {
  const res = await fetch(`${OPERATOR_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function useBotControl(botId: string) {
  const { token, authenticate, isAuthenticated } = useOperatorAuth(OPERATOR_API_URL);
  const queryClient = useQueryClient();

  const ensureToken = async (): Promise<string> => {
    if (token) return token;
    const newToken = await authenticate();
    if (!newToken) throw new Error('Authentication required');
    return newToken;
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['bots'] });
    queryClient.invalidateQueries({ queryKey: ['bot-detail', botId] });
  };

  const startBot = useMutation({
    mutationFn: async () => {
      const t = await ensureToken();
      return apiCall(`/api/bots/${botId}/start`, 'POST', t);
    },
    onSuccess: invalidate,
  });

  const stopBot = useMutation({
    mutationFn: async () => {
      const t = await ensureToken();
      return apiCall(`/api/bots/${botId}/stop`, 'POST', t);
    },
    onSuccess: invalidate,
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const t = await ensureToken();
      return apiCall(`/api/bots/${botId}/run-now`, 'POST', t);
    },
    onSuccess: invalidate,
  });

  const updateConfig = useMutation({
    mutationFn: async (params: {
      strategyConfigJson?: string;
      riskParamsJson?: string;
    }) => {
      const t = await ensureToken();
      return apiCall(`/api/bots/${botId}/config`, 'PATCH', t, {
        strategy_config_json: params.strategyConfigJson,
        risk_params_json: params.riskParamsJson,
      });
    },
    onSuccess: invalidate,
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
