import { useQuery } from '@tanstack/react-query';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

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
  wind_down_started_at: number | null;
}

export function useBotDetail(botId: string | undefined) {
  return useQuery<BotDetail>({
    queryKey: ['bot-detail', botId],
    queryFn: async () => {
      const res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}`);
      if (!res.ok) throw new Error(`Failed to fetch bot: ${res.status}`);
      return res.json();
    },
    enabled: !!botId && !!OPERATOR_API_URL,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
