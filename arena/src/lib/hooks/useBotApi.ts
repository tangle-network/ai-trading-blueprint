import { useQuery } from '@tanstack/react-query';
import type { Trade } from '~/lib/types/trade';
import type { Portfolio } from '~/lib/types/portfolio';
import { getApiUrlForBot } from '~/lib/config/botRegistry';
import { mockTrades } from '~/lib/mock/trades';
import { mockPortfolios } from '~/lib/mock/portfolio';

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
    validatorScore: t.validation?.aggregate_score,
    validatorReasoning: t.validation?.responses?.[0]?.reasoning,
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
        // Fallback to mock
        return mockTrades.filter(t => t.botId === botId);
      }
      const data = await fetchBotApi<ApiTrade[]>(apiUrl, `/trades?limit=${limit}`);
      return data.map(t => mapApiTrade(t, botName));
    },
    staleTime: 30_000,
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
        return mockPortfolios[botId] ?? null;
      }
      const data = await fetchBotApi<ApiPortfolioState>(apiUrl, '/portfolio/state');
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
      return fetchBotApi<ApiMetricsSnapshot[]>(apiUrl, `/metrics/history?from=${from}&to=${to}&limit=100`);
    },
    staleTime: 60_000,
    enabled: !!apiUrl,
  });
}

/**
 * Fetch all recent trades across all configured bot APIs.
 * For the live ticker on the landing page.
 */
export function useRecentTrades(limit = 20) {
  return useQuery<Trade[]>({
    queryKey: ['recent-trades', limit],
    queryFn: async () => {
      // For now, return mock trades sorted by timestamp
      // When bot APIs are configured, this would aggregate across all bots
      return [...mockTrades]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    },
    staleTime: 15_000,
  });
}
