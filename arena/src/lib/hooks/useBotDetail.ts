import { useQuery } from '@tanstack/react-query';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import { useOperatorAuth } from './useOperatorAuth';
import type { BotOperatorKind, ValidationTrust } from '~/lib/types/bot';
import { operatorJsonWithAuth } from '~/lib/operator/fetch';
import { normalizeOptionalWorkflowId } from '~/lib/utils/workflowId';

export interface BotDetail {
  id: string;
  name?: string | null;
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
  workflow_id: string | null;
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
  /**
   * Optional — present when the operator API exposes the bot's validation trust
   * mode. Absent for older operator builds; UI treats absent as `per_trade`.
   */
  validation_trust?: ValidationTrust;
}

type RawBotDetail = Omit<BotDetail, 'workflow_id'> & {
  workflow_id: string | number | null;
};

export function useBotDetail(
  botId: string | undefined,
  operatorApiUrl?: string | null,
  operatorKind?: BotOperatorKind,
) {
  const apiUrl = operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);

  return useQuery<BotDetail>({
    queryKey: ['bot-detail', apiUrl, botId, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId);
      const detail = await operatorJsonWithAuth<RawBotDetail>(apiUrl, path, auth);
      return {
        ...detail,
        workflow_id: normalizeOptionalWorkflowId(detail.workflow_id),
      };
    },
    enabled: !!botId && !!apiUrl && !!auth.getCachedToken(),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
