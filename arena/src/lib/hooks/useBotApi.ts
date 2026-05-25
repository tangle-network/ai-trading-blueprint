import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PredictionTradeMetadata,
  Trade,
  TradeExecutionDetails,
  TradeExecutionStatus,
  TradeSimulation,
  TradeValidation,
  ValidatorResponseDetail,
} from '~/lib/types/trade';
import { protocolToVenue } from '~/lib/types/trade';
import type { Portfolio } from '~/lib/types/portfolio';
import { mapApiPortfolioState, type RawPortfolioState } from '~/lib/portfolio';
import { parseTradeDisplayAmount, resolveAssetDisplay, type TokenMetadata } from '~/lib/tradeTokenMetadata';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import { useOperatorAuth } from './useOperatorAuth';
import { operatorJsonWithAuth } from '~/lib/operator/fetch';
import type { BotOperatorKind } from '~/lib/types/bot';

interface ApiTrade {
  id: string;
  bot_id: string;
  timestamp: string;
  action: 'buy' | 'sell';
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  target_protocol: string;
  tx_hash?: string;
  block_number?: number;
  gas_used?: string;
  paper_trade: boolean;
  execution_status?: TradeExecutionStatus;
  clob_order_id?: string;
  validation?: {
    approved: boolean;
    aggregate_score: number;
    intent_hash: string;
    responses: Array<{
      validator: string;
      score: number;
      reasoning: string;
      signature: string;
      chain_id?: number;
      verifying_contract?: string;
      validated_at?: string;
    }>;
    simulation?: {
      success: boolean;
      gas_used: number;
      risk_score: number;
      warnings: string[];
      output_amount: string;
    };
  };
  status?: string;
  amount_out?: string;
  entry_price_usd?: string;
  notional_usd?: string;
  requested_price_usd?: string;
  filled_price_usd?: string;
  filled_amount?: string;
  slippage_bps?: string;
  execution_reason?: string;
  prediction_metadata?: {
    condition_id?: string;
    token_id?: string;
    market_question?: string;
    outcome_label?: string;
    outcome_index?: number;
    market_slug?: string;
  };
  valuation_status?: 'priced' | 'value_only' | 'unpriced';
  decision_source?: string;
  runner_signal?: unknown;
  agent_reasoning?: string;
  harness_version?: number;
  candidate_hash?: string;
  revision_id?: string;
}

type TradeStatusInput = {
  paper_trade: boolean;
  tx_hash?: string;
  validation?: {
    approved: boolean;
    simulation?: {
      success: boolean;
    };
  };
};

type TradeAmountOutInput = {
  min_amount_out: string;
  amount_out?: string;
  validation?: {
    simulation?: {
      output_amount: string;
    };
  };
};

interface ApiTradeListResponse {
  trades: ApiTrade[];
}

interface ApiMetricsSnapshot {
  timestamp: string;
  bot_id: string;
  account_value_usd: number;
  unrealized_pnl: number;
  realized_pnl: number;
  high_water_mark: number;
  drawdown_pct: number;
  positions_count: number;
  trade_count: number;
}

interface ApiMetricsHistoryResponse {
  snapshots: ApiMetricsSnapshot[];
}

interface ApiBotMetricsSummary {
  portfolio_value_usd: number;
  total_pnl: number;
  trade_count: number;
}

export type RevisionRunMode =
  | 'live'
  | 'canary'
  | 'paper'
  | 'shadow'
  | 'backtest'
  | 'research';

export interface RevisionArenaEntry {
  revision_id: string;
  display_name: string;
  source: string;
  status: string;
  run_mode: RevisionRunMode;
  can_execute_live: boolean;
  parent_revision_id?: string | null;
  run_id?: string | null;
  created_at?: string | null;
  user_intent: string;
  patch_sha256?: string | null;
  files_changed: string[];
  tests: string[];
  promotion_approved?: boolean | null;
  promotion_blockers: string[];
  rejection?: {
    revision_id?: string;
    reason?: string;
    rejected_at?: string;
  } | null;
  paper_evidence?: {
    trades?: number;
    total_return_pct?: number;
    max_drawdown_pct?: number;
    candidate_hash?: string | null;
    revision_id?: string | null;
  } | null;
}

export interface RevisionModeCapability {
  mode: RevisionRunMode;
  can_touch_funds: boolean;
  description: string;
}

export interface RevisionArena {
  bot_id: string;
  invariant: string;
  active_revision_id: string;
  live_revision_id?: string | null;
  revisions: RevisionArenaEntry[];
  modes: RevisionModeCapability[];
}

async function fetchOperatorBotApi<T>(
  apiUrl: string,
  auth: Pick<ReturnType<typeof useOperatorAuth>, 'getCachedToken' | 'getToken'>,
  path: string,
): Promise<T> {
  return operatorJsonWithAuth<T>(apiUrl, path, auth);
}

function mapApiSimulation(trade: ApiTrade): TradeSimulation | undefined {
  const simulation = trade.validation?.simulation;
  if (!simulation) return undefined;

  return {
    success: simulation.success,
    gasUsed: simulation.gas_used,
    riskScore: simulation.risk_score,
    warnings: simulation.warnings,
    outputAmount: simulation.output_amount,
  };
}

function mapApiValidation(trade: ApiTrade): TradeValidation | undefined {
  const validation = trade.validation;
  if (!validation) return undefined;

  return {
    approved: validation.approved,
    aggregateScore: validation.aggregate_score,
    intentHash: validation.intent_hash,
    responses: validation.responses.map((response): ValidatorResponseDetail => ({
      validator: response.validator,
      score: response.score,
      reasoning: response.reasoning,
      signature: response.signature,
      chainId: response.chain_id,
      verifyingContract: response.verifying_contract,
      validatedAt: response.validated_at,
    })),
    simulation: mapApiSimulation(trade),
  };
}

function parseTradeAmount(value: string | undefined): number {
  return Number(value ?? 0);
}

export function getTradeStatus(trade: TradeStatusInput): Trade['status'] {
  if (trade.validation?.approved === false) return 'rejected';
  if (trade.paper_trade && trade.validation?.simulation?.success === false) return 'failed';
  if (trade.paper_trade) return 'paper';
  if (trade.tx_hash) return 'executed';
  return 'pending';
}

export function deriveTradeAmountOut(trade: TradeAmountOutInput): number {
  return parseTradeAmount(
    trade.amount_out ?? trade.validation?.simulation?.output_amount ?? trade.min_amount_out,
  );
}

function getTradePriceUsd(trade: ApiTrade): number | null {
  if (trade.valuation_status !== 'priced') return null;
  const priceUsd = parseTradeAmount(trade.entry_price_usd);
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

function mapExecutionDetails(trade: ApiTrade): TradeExecutionDetails | undefined {
  if (
    !trade.execution_status &&
    !trade.clob_order_id &&
    !trade.requested_price_usd &&
    !trade.filled_price_usd &&
    !trade.filled_amount &&
    !trade.slippage_bps &&
    !trade.execution_reason
  ) {
    return undefined;
  }

  return {
    status: trade.execution_status ?? (trade.paper_trade ? 'paper' : 'confirmed'),
    clobOrderId: trade.clob_order_id,
    requestedPriceUsd: trade.requested_price_usd != null
      ? parseTradeAmount(trade.requested_price_usd)
      : null,
    filledPriceUsd: trade.filled_price_usd != null
      ? parseTradeAmount(trade.filled_price_usd)
      : null,
    filledAmount: trade.filled_amount != null
      ? parseTradeAmount(trade.filled_amount)
      : null,
    slippageBps: trade.slippage_bps != null
      ? parseTradeAmount(trade.slippage_bps)
      : null,
    reason: trade.execution_reason,
  };
}

function mapPredictionMetadata(trade: ApiTrade): PredictionTradeMetadata | undefined {
  const metadata = trade.prediction_metadata;
  if (!metadata) return undefined;

  if (
    !metadata.condition_id &&
    !metadata.token_id &&
    !metadata.market_question &&
    !metadata.outcome_label &&
    metadata.outcome_index == null &&
    !metadata.market_slug
  ) {
    return undefined;
  }

  return {
    conditionId: metadata.condition_id,
    tokenId: metadata.token_id,
    marketQuestion: metadata.market_question,
    outcomeLabel: metadata.outcome_label,
    outcomeIndex: metadata.outcome_index,
    marketSlug: metadata.market_slug,
  };
}

export function mapApiTrade(
  trade: ApiTrade,
  botName: string,
  fallbackChainId?: number,
  assetMetadata: TokenMetadata[] = [],
): Trade {
  const validation = mapApiValidation(trade);
  const execution = mapExecutionDetails(trade);
  const predictionMetadata = mapPredictionMetadata(trade);
  const amountOut = deriveTradeAmountOut(trade);
  const chainId = trade.validation?.responses?.[0]?.chain_id ?? fallbackChainId;
  const assetIn = resolveAssetDisplay(trade.token_in, chainId, assetMetadata);
  const assetOut = resolveAssetDisplay(trade.token_out, chainId, assetMetadata);

  return {
    id: trade.id,
    botId: trade.bot_id,
    botName,
    action: trade.action,
    assetIn,
    assetOut,
    tokenIn: assetIn.symbol,
    tokenOut: assetOut.symbol,
    rawTokenIn: trade.token_in,
    rawTokenOut: trade.token_out,
    amountIn: parseTradeDisplayAmount(trade.amount_in, trade.token_in, chainId, assetMetadata),
    amountOut,
    priceUsd: getTradePriceUsd(trade),
    timestamp: new Date(trade.timestamp).getTime(),
    status: getTradeStatus(trade),
    txHash: trade.tx_hash,
    paperTrade: trade.paper_trade,
    targetProtocol: trade.target_protocol || undefined,
    venue: protocolToVenue(trade.target_protocol, trade.paper_trade),
    chainId,
    blockNumber: trade.block_number,
    gasUsed: trade.gas_used,
    validatorScore: trade.validation?.aggregate_score,
    validatorReasoning: trade.validation?.responses?.[0]?.reasoning,
    validation,
    execution,
    predictionMetadata,
    decisionSource: trade.decision_source,
    strategyModuleId: extractStrategyModuleId(trade.runner_signal),
    revisionId: trade.revision_id,
    candidateHash: trade.candidate_hash,
    agentReasoning: trade.agent_reasoning,
    runnerSignal: trade.runner_signal,
    harnessVersion: trade.harness_version,
  };
}

function extractStrategyModuleId(signal: unknown): string | undefined {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return undefined;
  const record = signal as Record<string, unknown>;
  const value = record.strategy_module_id ?? record.strategy_id ?? record.id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeTrades(data: ApiTrade[] | ApiTradeListResponse): ApiTrade[] {
  return Array.isArray(data) ? data : data.trades;
}

function normalizeMetrics(data: ApiMetricsSnapshot[] | ApiMetricsHistoryResponse): ApiMetricsSnapshot[] {
  const snapshots = Array.isArray(data) ? data : data.snapshots;
  return snapshots.map((snapshot) => ({
    ...snapshot,
    account_value_usd: Number(snapshot.account_value_usd),
    unrealized_pnl: Number(snapshot.unrealized_pnl),
    realized_pnl: Number(snapshot.realized_pnl),
    high_water_mark: Number(snapshot.high_water_mark),
    drawdown_pct: Number(snapshot.drawdown_pct),
    positions_count: Number(snapshot.positions_count),
    trade_count: Number(snapshot.trade_count),
  }));
}

interface BotApiQueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  chainId?: number;
  assetMetadata?: TokenMetadata[];
}

export function useBotTrades(
  botId: string,
  botName: string = '',
  limit = 50,
  options: BotApiQueryOptions = {},
) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;

  return useQuery<Trade[]>({
    queryKey: ['bot-trades', apiUrl, botId, limit, deploymentKind, options.chainId, options.assetMetadata, auth.authCacheKey],
    queryFn: async () => {
      const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/trades')}?limit=${limit}`;
      const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(apiUrl, auth, path);
      return normalizeTrades(data).map((t) => mapApiTrade(t, botName, options.chainId, options.assetMetadata));
    },
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && !!auth.getCachedToken(),
  });
}

export function useBotRecentValidations(
  botId: string,
  botName: string = '',
  options: BotApiQueryOptions = {},
) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;

  return useQuery<Trade[]>({
    queryKey: ['bot-recent-validations', apiUrl, botId, deploymentKind, options.chainId, options.assetMetadata, auth.authCacheKey],
    queryFn: async () => {
      const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/trades')}?limit=5`;
      const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(apiUrl, auth, path);
      return normalizeTrades(data).map((t) => mapApiTrade(t, botName, options.chainId, options.assetMetadata));
    },
    refetchInterval: options.refetchInterval ?? 5_000,
    staleTime: 3_000,
    refetchOnMount: 'always',
    retry: 1,
    retryDelay: 3_000,
    enabled: enabled && !!apiUrl && !!auth.getCachedToken(),
  });
}

export function useBotPortfolio(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;

  return useQuery<Portfolio | null>({
    queryKey: ['bot-portfolio', apiUrl, botId, deploymentKind, options.chainId, options.assetMetadata, auth.authCacheKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/portfolio/state');
      const data = await fetchOperatorBotApi<RawPortfolioState>(apiUrl, auth, path);
      return mapApiPortfolioState(data, botId, options.chainId, options.assetMetadata);
    },
    staleTime: 10_000,
    gcTime: 60_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && !!auth.getCachedToken(),
  });
}

export function useBotMetrics(botId: string, days = 30, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;

  return useQuery<ApiMetricsSnapshot[]>({
    queryKey: ['bot-metrics', apiUrl, botId, days, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const from = new Date(Date.now() - days * 86400000).toISOString();
      const to = new Date().toISOString();
      const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/metrics/history')}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`;
      const data = await fetchOperatorBotApi<ApiMetricsSnapshot[] | ApiMetricsHistoryResponse>(apiUrl, auth, path);
      return normalizeMetrics(data);
    },
    staleTime: 15_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && !!auth.getCachedToken(),
  });
}

export function useBotMetricsSummary(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;

  return useQuery<ApiBotMetricsSummary>({
    queryKey: ['bot-metrics-summary', apiUrl, botId, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/metrics');
      return fetchOperatorBotApi<ApiBotMetricsSummary>(apiUrl, auth, path);
    },
    staleTime: 15_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && !!auth.getCachedToken(),
  });
}

export function useRevisionArena(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;

  return useQuery<RevisionArena>({
    queryKey: ['revision-arena', apiUrl, botId, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        '/evolution/revision-arena',
      );
      return fetchOperatorBotApi<RevisionArena>(apiUrl, auth, path);
    },
    staleTime: 10_000,
    refetchOnMount: 'always',
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && !!auth.getCachedToken(),
  });
}

export function useRevisionDecision(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (decision: {
      revisionId: string;
      action: 'approve' | 'reject';
      reason?: string;
      confirmLive?: boolean;
    }) => {
      const path = buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        '/evolution/revision-arena/decision',
      );
      return operatorJsonWithAuth<unknown>(apiUrl, path, auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision_id: decision.revisionId,
          action: decision.action,
          reason: decision.reason,
          confirm_live: decision.confirmLive ?? (decision.action === 'approve'),
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['revision-arena', apiUrl, botId, deploymentKind, auth.authCacheKey],
      });
    },
  });
}
