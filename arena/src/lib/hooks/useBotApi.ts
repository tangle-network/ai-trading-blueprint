import { useQuery } from '@tanstack/react-query';
import type { Trade, TradeSimulation, TradeValidation, ValidatorResponseDetail } from '~/lib/types/trade';
import { protocolToVenue } from '~/lib/types/trade';
import type { Portfolio } from '~/lib/types/portfolio';
import { buildBotScopedPath, OPERATOR_API_URL, useOperatorMeta } from '~/lib/operator/meta';
import { useOperatorAuth } from './useOperatorAuth';

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
}

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

interface ApiPortfolioState {
  positions: Array<{
    token: string;
    symbol?: string;
    amount: number | string;
    value_usd?: number;
    entry_price: number | string;
    current_price: number | string;
    pnl_percent?: number;
    weight?: number;
    unrealized_pnl?: string;
    protocol?: string;
  }>;
  total_value_usd: number | string;
  cash_balance?: number | string;
  unrealized_pnl?: string;
  realized_pnl?: string;
}

async function fetchOperatorBotApi<T>(
  token: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${OPERATOR_API_URL}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`Bot API error: ${res.status} ${res.statusText}`);
  return res.json();
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

function getTradeStatus(trade: ApiTrade): Trade['status'] {
  if (trade.paper_trade) return 'paper';
  if (trade.validation?.approved === false) return 'rejected';
  if (trade.tx_hash) return 'executed';
  return 'pending';
}

function mapApiTrade(trade: ApiTrade, botName: string): Trade {
  const validation = mapApiValidation(trade);

  return {
    id: trade.id,
    botId: trade.bot_id,
    botName,
    action: trade.action,
    tokenIn: trade.token_in,
    tokenOut: trade.token_out,
    amountIn: Number(trade.amount_in),
    amountOut: Number(trade.min_amount_out),
    priceUsd: 0,
    timestamp: new Date(trade.timestamp).getTime(),
    status: getTradeStatus(trade),
    txHash: trade.tx_hash,
    paperTrade: trade.paper_trade,
    targetProtocol: trade.target_protocol || undefined,
    venue: protocolToVenue(trade.target_protocol, trade.paper_trade),
    chainId: trade.validation?.responses?.[0]?.chain_id,
    validatorScore: trade.validation?.aggregate_score,
    validatorReasoning: trade.validation?.responses?.[0]?.reasoning,
    validation,
  };
}

function calculatePnlPercent(currentPrice: number, entryPrice: number): number {
  if (entryPrice <= 0) return 0;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

function calculateWeight(valueUsd: number, totalValueUsd: number): number {
  if (totalValueUsd <= 0) return 0;
  return (valueUsd / totalValueUsd) * 100;
}

function mapApiPortfolio(p: ApiPortfolioState, botId: string): Portfolio {
  const totalValueUsd = Number(p.total_value_usd ?? 0);
  const cashBalance = Number(p.cash_balance ?? 0);
  return {
    botId,
    totalValueUsd,
    cashBalance,
    positions: p.positions.map((pos) => {
      const amount = Number(pos.amount);
      const entryPrice = Number(pos.entry_price);
      const currentPrice = Number(pos.current_price);
      const valueUsd = pos.value_usd != null ? Number(pos.value_usd) : amount * currentPrice;
      const pnlPercent = pos.pnl_percent != null
        ? Number(pos.pnl_percent)
        : calculatePnlPercent(currentPrice, entryPrice);
      const weight = pos.weight != null
        ? Number(pos.weight)
        : calculateWeight(valueUsd, totalValueUsd);

      return {
        token: pos.token,
        symbol: pos.symbol ?? pos.token,
        amount,
        valueUsd,
        entryPrice,
        currentPrice,
        pnlPercent,
        weight,
      };
    }),
  };
}

function normalizeTrades(data: ApiTrade[] | ApiTradeListResponse): ApiTrade[] {
  return Array.isArray(data) ? data : data.trades;
}

function normalizeMetrics(data: ApiMetricsSnapshot[] | ApiMetricsHistoryResponse): ApiMetricsSnapshot[] {
  return Array.isArray(data) ? data : data.snapshots;
}

interface BotApiQueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
}

export function useBotTrades(
  botId: string,
  botName: string = '',
  limit = 50,
  options: BotApiQueryOptions = {},
) {
  const { data: meta } = useOperatorMeta();
  const auth = useOperatorAuth(OPERATOR_API_URL);
  const enabled = options.enabled ?? true;

  return useQuery<Trade[]>({
    queryKey: ['bot-trades', botId, limit, meta?.deployment_kind, auth.token],
    queryFn: async () => {
      if (!meta || !auth.token) return [];
      const path = `${buildBotScopedPath(meta, botId, '/trades')}?limit=${limit}`;
      const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(auth.token, path);
      return normalizeTrades(data).map((t) => mapApiTrade(t, botName));
    },
    staleTime: 30_000,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!meta && !!auth.token,
  });
}

export function useBotRecentValidations(
  botId: string,
  botName: string = '',
  options: BotApiQueryOptions = {},
) {
  const { data: meta } = useOperatorMeta();
  const auth = useOperatorAuth(OPERATOR_API_URL);
  const enabled = options.enabled ?? true;

  return useQuery<Trade[]>({
    queryKey: ['bot-recent-validations', botId, meta?.deployment_kind, auth.token],
    queryFn: async () => {
      if (!meta || !auth.token) return [];
      const path = `${buildBotScopedPath(meta, botId, '/trades')}?limit=5`;
      const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(auth.token, path);
      return normalizeTrades(data).map((t) => mapApiTrade(t, botName));
    },
    refetchInterval: options.refetchInterval ?? 5_000,
    staleTime: 3_000,
    retry: 1,
    retryDelay: 3_000,
    enabled: enabled && !!meta && !!auth.token,
  });
}

export function useBotPortfolio(botId: string, options: BotApiQueryOptions = {}) {
  const { data: meta } = useOperatorMeta();
  const auth = useOperatorAuth(OPERATOR_API_URL);
  const enabled = options.enabled ?? true;

  return useQuery<Portfolio | null>({
    queryKey: ['bot-portfolio', botId, meta?.deployment_kind, auth.token],
    queryFn: async () => {
      if (!meta || !auth.token) return null;
      const path = buildBotScopedPath(meta, botId, '/portfolio/state');
      const data = await fetchOperatorBotApi<ApiPortfolioState>(auth.token, path);
      return mapApiPortfolio(data, botId);
    },
    staleTime: 30_000,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!meta && !!auth.token,
  });
}

export function useBotMetrics(botId: string, days = 30, options: BotApiQueryOptions = {}) {
  const { data: meta } = useOperatorMeta();
  const auth = useOperatorAuth(OPERATOR_API_URL);
  const enabled = options.enabled ?? true;

  return useQuery<ApiMetricsSnapshot[]>({
    queryKey: ['bot-metrics', botId, days, meta?.deployment_kind, auth.token],
    queryFn: async () => {
      if (!meta || !auth.token) return [];
      const from = new Date(Date.now() - days * 86400000).toISOString();
      const to = new Date().toISOString();
      const path = `${buildBotScopedPath(meta, botId, '/metrics/history')}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`;
      const data = await fetchOperatorBotApi<ApiMetricsSnapshot[] | ApiMetricsHistoryResponse>(auth.token, path);
      return normalizeMetrics(data);
    },
    staleTime: 60_000,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!meta && !!auth.token,
  });
}
