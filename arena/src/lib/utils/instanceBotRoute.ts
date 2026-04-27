import { zeroAddress } from 'viem';
import type { TrackedProvision } from '~/lib/stores/provisions';
import type { Bot, BotLifecycleStatus, BotOperatorKind, BotStatus, StrategyType } from '~/lib/types/bot';
import type { BotDetail } from '~/lib/hooks/useBotDetail';

export function findMatchingInstanceRouteProvision(
  provisions: TrackedProvision[],
  id: string | undefined,
): TrackedProvision | undefined {
  if (!id) return undefined;
  return provisions.find((provision) =>
    provision.id.startsWith('instance-')
    && (
      provision.botId === id
      || provision.sandboxId === id
      || (provision.serviceId != null && String(provision.serviceId) === id)
    ));
}

export function mapLifecycleStatusToBotStatus(
  lifecycleStatus: BotLifecycleStatus,
  tradingActive: boolean,
): BotStatus {
  switch (lifecycleStatus) {
    case 'awaiting_secrets':
      return 'needs_config';
    case 'active':
      return tradingActive ? 'active' : 'paused';
    case 'winding_down':
      return 'winding_down';
    case 'archived':
      return 'archived';
    case 'stopped':
      return 'stopped';
    case 'unknown':
    default:
      return 'unknown';
  }
}

interface BuildInstanceFallbackBotOptions {
  routeId: string;
  provision: TrackedProvision;
  detail?: BotDetail;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
}

export function buildInstanceFallbackBot({
  routeId,
  provision,
  detail,
  operatorApiUrl,
  operatorKind,
}: BuildInstanceFallbackBotOptions): Bot {
  const lifecycleStatus = detail?.lifecycle_status
    ?? (provision.phase === 'awaiting_secrets'
      ? 'awaiting_secrets'
      : provision.phase === 'active'
        ? 'active'
        : 'unknown');
  const tradingActive = detail?.trading_active ?? provision.phase === 'active';

  return {
    id: detail?.id ?? provision.botId ?? routeId,
    serviceId: detail?.service_id ?? provision.serviceId ?? 0,
    name: provision.name || 'Instance Agent',
    operatorAddress: detail?.operator_address ?? provision.operators[0] ?? zeroAddress,
    vaultAddress: detail?.vault_address ?? provision.vaultAddress ?? zeroAddress,
    strategyType: (detail?.strategy_type ?? provision.strategyType ?? 'dex') as StrategyType,
    status: mapLifecycleStatusToBotStatus(lifecycleStatus, tradingActive),
    createdAt: detail?.created_at ?? provision.createdAt ?? Date.now(),
    chainId: detail?.chain_id ?? provision.chainId,
    pnlPercent: 0,
    pnlAbsolute: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    tvl: 0,
    avgValidatorScore: 0,
    sparklineData: [],
    sandboxId: detail?.sandbox_id ?? provision.sandboxId ?? routeId,
    sandboxState: detail?.sandbox_state ?? null,
    lifecycleStatus,
    archived: detail?.archived ?? lifecycleStatus === 'archived',
    controlAvailable: detail?.control_available ?? lifecycleStatus !== 'archived',
    tradingActive,
    workflowId: detail?.workflow_id ?? provision.workflowId,
    maxLifetimeDays: detail?.max_lifetime_days,
    windDownStartedAt: detail?.wind_down_started_at ?? undefined,
    secretsConfigured: detail?.secrets_configured ?? provision.phase === 'active',
    submitterAddress: detail?.submitter_address ?? provision.owner,
    strategyConfig: detail?.strategy_config ?? undefined,
    riskParams: detail?.risk_params ?? undefined,
    paperTrade: detail?.paper_trade ?? false,
    callId: detail?.call_id ?? provision.callId,
    source: 'operator',
    verificationState: 'authoritative',
    operatorKind: operatorKind ?? null,
    operatorApiUrl: operatorApiUrl ?? null,
    lastVerifiedAt: detail ? Date.now() : null,
    isUnverified: false,
  };
}
