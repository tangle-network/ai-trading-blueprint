import { useQuery } from '@tanstack/react-query';
import type { Trade, TradeValidation, ValidatorResponseDetail } from '~/lib/types/trade';
import type { Portfolio } from '~/lib/types/portfolio';
import { getApiUrlForBot } from '~/lib/config/botRegistry';

// Types matching the Rust HTTP API response schemas

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
  };
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

interface ApiPortfolioState {
  positions: Array<{
    token: string;
    symbol: string;
    amount: number;
    value_usd: number;
    entry_price: number;
    current_price: number;
    pnl_percent: number;
    weight: number;
  }>;
  total_value_usd: number;
  cash_balance: number;
}

async function fetchBotApi<T>(apiUrl: string, path: string): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Bot API error: ${res.status} ${res.statusText}`);
  return res.json();
}

function mapApiTrade(t: ApiTrade, botName: string): Trade {
  const validation: TradeValidation | undefined = t.validation ? {
    approved: t.validation.approved,
    aggregateScore: t.validation.aggregate_score,
    intentHash: t.validation.intent_hash,
    responses: t.validation.responses.map((r): ValidatorResponseDetail => ({
      validator: r.validator,
      score: r.score,
      reasoning: r.reasoning,
      signature: r.signature,
      chainId: r.chain_id,
      verifyingContract: r.verifying_contract,
      validatedAt: r.validated_at,
    })),
  } : undefined;

  return {
    id: t.id,
    botId: t.bot_id,
    botName,
    action: t.action,
    tokenIn: t.token_in,
    tokenOut: t.token_out,
    amountIn: Number(t.amount_in),
    amountOut: Number(t.min_amount_out),
    priceUsd: 0, // Would need price oracle
    timestamp: new Date(t.timestamp).getTime(),
    status: t.paper_trade ? 'paper' : t.validation?.approved === false ? 'rejected' : t.tx_hash ? 'executed' : 'pending',
    txHash: t.tx_hash,
    paperTrade: t.paper_trade,
    validatorScore: t.validation?.aggregate_score,
    validatorReasoning: t.validation?.responses?.[0]?.reasoning,
    validation,
  };
}

function mapApiPortfolio(p: ApiPortfolioState, botId: string): Portfolio {
  return {
    botId,
    totalValueUsd: p.total_value_usd,
    cashBalance: p.cash_balance,
    positions: p.positions.map(pos => ({
      token: pos.token,
      symbol: pos.symbol,
      amount: pos.amount,
      valueUsd: pos.value_usd,
      entryPrice: pos.entry_price,
      currentPrice: pos.current_price,
      pnlPercent: pos.pnl_percent,
      weight: pos.weight,
    })),
  };
}

/**
 * Fetch trades for a bot. Uses real API when available, mock data as fallback.
 */
export function useBotTrades(botId: string, botName: string = '', limit = 50) {
  const apiUrl = getApiUrlForBot(botId);

  return useQuery<Trade[]>({
    queryKey: ['bot-trades', botId, limit],
    queryFn: async () => {
      if (!apiUrl) {
        return [];
      }
      const data = await fetchBotApi<ApiTrade[]>(apiUrl, `/api/bots/${botId}/trades?limit=${limit}`);
      return data.map(t => mapApiTrade(t, botName));
    },
    staleTime: 30_000,
  });
}

/**
 * Fetch recent trades with high-frequency polling for live validation visibility.
 * Returns the 5 most recent trades, polled every 5 seconds.
 */
export function useBotRecentValidations(botId: string, botName: string = '') {
  const apiUrl = getApiUrlForBot(botId);

  return useQuery<Trade[]>({
    queryKey: ['bot-recent-validations', botId],
    queryFn: async () => {
      if (!apiUrl) return [];
      const data = await fetchBotApi<ApiTrade[]>(apiUrl, `/api/bots/${botId}/trades?limit=5`);
      return data.map(t => mapApiTrade(t, botName));
    },
    refetchInterval: 5_000,
    staleTime: 3_000,
    enabled: !!apiUrl,
  });
}

/**
 * Fetch portfolio/positions for a bot.
 */
export function useBotPortfolio(botId: string) {
  const apiUrl = getApiUrlForBot(botId);

  return useQuery<Portfolio | null>({
    queryKey: ['bot-portfolio', botId],
    queryFn: async () => {
      if (!apiUrl) {
        return null;
      }
      const data = await fetchBotApi<ApiPortfolioState>(apiUrl, `/api/bots/${botId}/portfolio/state`);
      return mapApiPortfolio(data, botId);
    },
    staleTime: 30_000,
  });
}

/**
 * Fetch metrics history for sparkline / performance charts.
 */
export function useBotMetrics(botId: string, days = 30) {
  const apiUrl = getApiUrlForBot(botId);

  return useQuery<ApiMetricsSnapshot[]>({
    queryKey: ['bot-metrics', botId, days],
    queryFn: async () => {
      if (!apiUrl) return [];
      const from = new Date(Date.now() - days * 86400000).toISOString();
      const to = new Date().toISOString();
      return fetchBotApi<ApiMetricsSnapshot[]>(apiUrl, `/api/bots/${botId}/metrics/history?from=${from}&to=${to}&limit=100`);
    },
    staleTime: 60_000,
    enabled: !!apiUrl,
  });
}

