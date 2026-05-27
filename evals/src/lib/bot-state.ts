/**
 * Eval-side read helpers for scoring bot outcomes.
 *
 * Scope is deliberately narrow: the eval needs to see what a running bot
 * actually did (account state, recent fills, open orders) to compute a
 * judge verdict. It does NOT need to act on the bot's behalf — the
 * deployed agent calls the trading-http-api routes directly via bash +
 * curl + its own tool surface. So this is a READ-only state reader, not
 * a Venue/client abstraction.
 *
 * Today: Hyperliquid perp shape (matches the test fleet). Add a reader
 * per venue family as new bot types come online — each is ~30 LoC of
 * shape mapping, no shared interface burden.
 */

const DEFAULT_TIMEOUT_MS = 15_000

export class TradingApiClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: { baseUrl: string; botToken: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.botToken
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async get<T>(path: string): Promise<T> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${this.token}` },
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${text}`)
      return JSON.parse(text) as T
    } finally {
      clearTimeout(t)
    }
  }
}

export interface Position {
  symbol: string
  side: 'long' | 'short' | 'flat'
  size: string
  entry_price: string
  unrealized_pnl_usd: string
  margin_used_usd: string
  leverage: number
}

export interface OpenOrder {
  order_id: string
  symbol: string
  side: 'buy' | 'sell'
  size: string
  limit_price: string
  placed_at: number
}

export interface Fill {
  fill_id: string
  symbol: string
  side: 'buy' | 'sell'
  size: string
  price_usd: string
  timestamp: number
  tx_hash?: string
}

/** All the state an eval needs to score a Hyperliquid-perp bot's run. */
export interface BotStateSnapshot {
  equity_usd: string
  margin_used_usd: string
  withdrawable_usd: string
  positions: Position[]
  open_orders: OpenOrder[]
  recent_fills: Fill[]
}

/** Read HL-perp account + recent trades in one round-trip and normalise.
 *  Wire shapes preserved as strings (no f64 round-trip through Decimal). */
export async function readHyperliquidBotState(
  client: TradingApiClient,
  opts: { fillsLimit?: number } = {},
): Promise<BotStateSnapshot> {
  const [acct, trades] = await Promise.all([
    client.get<HlAccountInfo>('/hyperliquid/account'),
    client.get<TradeListResponse>(`/trades?limit=${opts.fillsLimit ?? 50}`),
  ])
  return {
    equity_usd: acct.account_value,
    margin_used_usd: acct.total_margin_used,
    withdrawable_usd: acct.withdrawable,
    positions: acct.positions.map((p) => ({
      symbol: p.asset,
      side: Number(p.size) > 0 ? 'long' : Number(p.size) < 0 ? 'short' : 'flat',
      size: p.size,
      entry_price: p.entry_price,
      unrealized_pnl_usd: p.unrealized_pnl,
      margin_used_usd: p.margin_used,
      leverage: p.leverage,
    })),
    open_orders: acct.open_orders.map((o) => ({
      order_id: String(o.oid),
      symbol: o.coin,
      side: o.side.toUpperCase() === 'A' ? 'sell' : 'buy',
      size: o.sz,
      limit_price: o.limit_px,
      placed_at: o.timestamp,
    })),
    recent_fills: trades.trades.map((t) => ({
      fill_id: t.id,
      symbol: t.token_in === 'USDC' ? t.token_out : t.token_in,
      side: t.action.toLowerCase().includes('sell') ? 'sell' : 'buy',
      size: t.filled_amount ?? t.amount_in,
      price_usd: t.filled_price_usd ?? '0',
      timestamp: Math.floor(Date.parse(t.timestamp) / 1000) || 0,
      ...(t.tx_hash ? { tx_hash: t.tx_hash } : {}),
    })),
  }
}

interface HlAccountInfo {
  account_value: string
  total_margin_used: string
  withdrawable: string
  positions: Array<{
    asset: string
    size: string
    entry_price: string
    unrealized_pnl: string
    leverage: number
    margin_used: string
  }>
  open_orders: Array<{ coin: string; limit_px: string; oid: number; side: string; sz: string; timestamp: number }>
}

interface TradeListResponse {
  trades: Array<{
    id: string
    timestamp: string
    action: string
    token_in: string
    token_out: string
    amount_in: string
    tx_hash: string
    filled_price_usd?: string
    filled_amount?: string
  }>
  total: number
}
