import { useQuery } from '@tanstack/react-query';
import type { Trade, TradeSimulation, TradeValidation, ValidatorResponseDetail } from '~/lib/types/trade';
import { protocolToVenue } from '~/lib/types/trade';
import type { Portfolio } from '~/lib/types/portfolio';
import { mapApiPortfolioState, type RawPortfolioState } from '~/lib/portfolio';
import { getTradeTokenDisplaySymbol, parseTradeDisplayAmount } from '~/lib/tradeTokenMetadata';
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
  valuation_status?: 'priced' | 'unpriced';
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

export function mapApiTrade(trade: ApiTrade, botName: string): Trade {
  const validation = mapApiValidation(trade);
  const amountOut = deriveTradeAmountOut(trade);
  const tokenIn = getTradeTokenDisplaySymbol(trade.token_in);
  const tokenOut = getTradeTokenDisplaySymbol(trade.token_out);

  return {
    id: trade.id,
    botId: trade.bot_id,
    botName,
    action: trade.action,
    tokenIn,
    tokenOut,
    rawTokenIn: trade.token_in,
    rawTokenOut: trade.token_out,
    amountIn: parseTradeDisplayAmount(trade.amount_in, trade.token_in),
    amountOut,
    priceUsd: getTradePriceUsd(trade),
    timestamp: new Date(trade.timestamp).getTime(),
    status: getTradeStatus(trade),
    txHash: trade.tx_hash,
    paperTrade: trade.paper_trade,
    targetProtocol: trade.target_protocol || undefined,
    venue: protocolToVenue(trade.target_protocol, trade.paper_trade),
    chainId: trade.validation?.responses?.[0]?.chain_id,
    blockNumber: trade.block_number,
    gasUsed: trade.gas_used,
    validatorScore: trade.validation?.aggregate_score,
    validatorReasoning: trade.validation?.responses?.[0]?.reasoning,
    validation,
  };
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
    queryKey: ['bot-trades', apiUrl, botId, limit, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/trades')}?limit=${limit}`;
      const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(apiUrl, auth, path);
      return normalizeTrades(data).map((t) => mapApiTrade(t, botName));
    },
    staleTime: 15_000,
    refetchOnMount: false,
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
    queryKey: ['bot-recent-validations', apiUrl, botId, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/trades')}?limit=5`;
      const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(apiUrl, auth, path);
      return normalizeTrades(data).map((t) => mapApiTrade(t, botName));
    },
    refetchInterval: options.refetchInterval ?? 5_000,
    staleTime: 3_000,
    refetchOnMount: false,
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
    queryKey: ['bot-portfolio', apiUrl, botId, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/portfolio/state');
      const data = await fetchOperatorBotApi<RawPortfolioState>(apiUrl, auth, path);
      return mapApiPortfolioState(data, botId);
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
