import { useQuery } from '@tanstack/react-query';
import { buildBotScopedPath, OPERATOR_API_URL, useOperatorMeta } from '~/lib/operator/meta';
import { useOperatorAuth } from './useOperatorAuth';

export interface BotDetail {
  id: string;
  operator_address: string;
  submitter_address: string;
  vault_address: string;
  strategy_type: string;
  strategy_config: Record<string, unknown>;
  risk_params: Record<string, unknown>;
  chain_id: number;
  trading_active: boolean;
  paper_trade: boolean;
  created_at: number;
  max_lifetime_days: number;
  trading_api_url: string;
  trading_api_token: string;
  sandbox_id: string;
  workflow_id: number | null;
  secrets_configured: boolean;
  sandbox_exists: boolean;
  sandbox_state: string | null;
  lifecycle_status: 'unknown' | 'awaiting_secrets' | 'active' | 'stopped' | 'winding_down' | 'archived';
  archived: boolean;
  control_available: boolean;
  wind_down_started_at: number | null;
  validator_service_ids: number[];
  validator_endpoints: string[];
  call_id: number;
  service_id: number;
}

export function useBotDetail(botId: string | undefined) {
  const { data: meta } = useOperatorMeta();
  const auth = useOperatorAuth(OPERATOR_API_URL);

  return useQuery<BotDetail>({
    queryKey: ['bot-detail', botId, meta?.deployment_kind, auth.token],
    queryFn: async () => {
      const path = buildBotScopedPath(meta, botId);
      const res = await fetch(`${OPERATOR_API_URL}${path}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
      });
      if (!res.ok) throw new Error(`Failed to fetch bot: ${res.status}`);
      return res.json();
    },
    enabled: !!botId && !!OPERATOR_API_URL && !!meta && !!auth.token,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
