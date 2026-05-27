/**
 * Hyperliquid perp adapter — implements the unified `Venue` interface over
 * the trading-http-api's `/hyperliquid/*`, `/market-data/candles`, and
 * `/trades` routes. Signing stays server-side (HTTP server holds the
 * operator key, per the architecture decision).
 *
 * Route mapping:
 *   getCandles    → GET  /market-data/candles
 *   getOrderbook  → GET  /hyperliquid/prices       (top-of-book + ticker)
 *   getAccount    → GET  /hyperliquid/account      (HL AccountInfo)
 *   getPositions  → derived from getAccount().positions
 *   getFills      → GET  /trades                   (per-bot trade ledger)
 *   placeOrder    → POST /hyperliquid/order        (HL PlaceOrderRequest)
 *   cancelOrder   → POST /hyperliquid/cancel       (HL CancelOrderRequest)
 */

import { TradingApiClient } from './http.js'
import type {
  Account,
  CancelAck,
  CandleRow,
  Fill,
  GetCandlesOptions,
  GetFillsOptions,
  OpenOrder,
  OrderAck,
  OrderIntent,
  Orderbook,
  Position,
  PriceLevel,
  Venue,
  VenueClientConfig,
} from './types.js'

interface HlAccountInfo {
  account_value: string
  total_margin_used: string
  total_ntl_pos: string
  total_raw_usd: string
  withdrawable: string
  positions: HlPositionInfo[]
  open_orders: HlOpenOrderInfo[]
}

interface HlPositionInfo {
  asset: string
  size: string
  entry_price: string
  unrealized_pnl: string
  leverage: number
  liquidation_price: string | null
  margin_used: string
  return_on_equity: string
}

interface HlOpenOrderInfo {
  coin: string
  limit_px: string
  oid: number
  side: string
  sz: string
  timestamp: number
}

interface OrderResponseEnvelope {
  status: string
  data: unknown
}

interface CandlesResponse {
  candles: Array<{
    timestamp: number
    token: string
    open: string
    high: string
    low: string
    close: string
    volume: string
  }>
  total: number
}

interface PricesResponse {
  // HL /prices returns a map of coin→mark price; surface as top-of-book
  // single tick (best we can without a dedicated orderbook route).
  [coin: string]: string
}

interface TradeListResponse {
  trades: TradeRecord[]
  total: number
}

interface TradeRecord {
  id: string
  timestamp: string
  action: string
  token_in: string
  token_out: string
  amount_in: string
  amount_out?: string
  target_protocol: string
  tx_hash: string
  paper_trade: boolean
  filled_price_usd?: string
  filled_amount?: string
  slippage_bps?: string
  clob_order_id?: string
}

function hlSizeBuyFromIntent(o: OrderIntent): { is_buy: boolean; size: string } {
  return { is_buy: o.side === 'buy', size: o.size }
}

function hlOrderTypeFromIntent(o: OrderIntent): unknown {
  // Mirrors the Rust `HlOrderType` enum which is internally tagged via
  // `#[serde(tag = "type", rename_all = "snake_case")]`.
  if (o.kind === 'market') return { type: 'market' }
  if (o.kind === 'limit') {
    return {
      type: 'limit',
      limit_px: o.limit_price,
      tif: o.time_in_force ?? 'gtc',
    }
  }
  // trigger
  return o.kind_trigger === 'stop_loss'
    ? { type: 'stop_loss', trigger_price: o.trigger_price, is_market: o.is_market }
    : { type: 'take_profit', trigger_price: o.trigger_price, is_market: o.is_market }
}

function mapPosition(p: HlPositionInfo): Position {
  const sizeNum = Number(p.size)
  const side = sizeNum > 0 ? 'long' : sizeNum < 0 ? 'short' : 'flat'
  return {
    symbol: p.asset,
    side,
    size: p.size,
    entry_price: p.entry_price,
    unrealized_pnl_usd: p.unrealized_pnl,
    margin_used_usd: p.margin_used,
    leverage: p.leverage,
    ...(p.liquidation_price !== null && p.liquidation_price !== undefined
      ? { liquidation_price: p.liquidation_price }
      : {}),
  }
}

function mapOpenOrder(o: HlOpenOrderInfo): OpenOrder {
  return {
    order_id: String(o.oid),
    symbol: o.coin,
    // HL encodes side as "A"=ask/sell, "B"=bid/buy.
    side: o.side.toUpperCase() === 'A' ? 'sell' : 'buy',
    size: o.sz,
    limit_price: o.limit_px,
    placed_at: o.timestamp,
  }
}

function mapTradeToFill(t: TradeRecord): Fill {
  const ts = Number.isFinite(Date.parse(t.timestamp)) ? Math.floor(Date.parse(t.timestamp) / 1000) : 0
  return {
    fill_id: t.id,
    symbol: t.token_in === 'USDC' ? t.token_out : t.token_in,
    side: t.action.toLowerCase().includes('sell') ? 'sell' : 'buy',
    size: t.filled_amount ?? t.amount_in,
    price_usd: t.filled_price_usd ?? '0',
    fee_usd: '0', // not exposed on the trade ledger today; populated when the API does
    timestamp: ts,
    ...(t.tx_hash ? { tx_hash: t.tx_hash } : {}),
    ...(t.clob_order_id ? { order_id: t.clob_order_id } : {}),
  }
}

export class HyperliquidVenue implements Venue {
  readonly id = 'hyperliquid_perp' as const
  readonly label = 'Hyperliquid Perpetual'
  private readonly http: TradingApiClient

  constructor(cfg: VenueClientConfig) {
    this.http = new TradingApiClient(cfg)
  }

  async getCandles(symbol: string, opts: GetCandlesOptions = {}): Promise<CandleRow[]> {
    const res = await this.http.get<CandlesResponse>('/market-data/candles', {
      token: symbol,
      limit: opts.limit,
      from: opts.from,
      to: opts.to,
    })
    return res.candles.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))
  }

  async getOrderbook(symbol: string, _depth?: number): Promise<Orderbook> {
    // HL doesn't expose a dedicated L2 orderbook route on the
    // trading-http-api today; /hyperliquid/prices returns a coin→price
    // map. Surface as a single-tick top-of-book until a /orderbook route
    // lands. Both sides carry the same price; size is unknown.
    const prices = await this.http.get<PricesResponse>('/hyperliquid/prices')
    const price = prices[symbol] ?? prices[symbol.toUpperCase()]
    if (!price) {
      return { symbol, bids: [], asks: [], timestamp: Math.floor(Date.now() / 1000) }
    }
    const level: PriceLevel = { price, size: '0' }
    return { symbol, bids: [level], asks: [level], timestamp: Math.floor(Date.now() / 1000) }
  }

  async getAccount(): Promise<Account> {
    const a = await this.http.get<HlAccountInfo>('/hyperliquid/account')
    return {
      equity_usd: a.account_value,
      margin_used_usd: a.total_margin_used,
      withdrawable_usd: a.withdrawable,
      positions: a.positions.map(mapPosition),
      open_orders: a.open_orders.map(mapOpenOrder),
    }
  }

  async getPositions(): Promise<Position[]> {
    return (await this.getAccount()).positions
  }

  async getFills(opts: GetFillsOptions = {}): Promise<Fill[]> {
    const res = await this.http.get<TradeListResponse>('/trades', {
      limit: opts.limit ?? 50,
    })
    const fills = res.trades.map(mapTradeToFill)
    return opts.since ? fills.filter((f) => f.timestamp >= opts.since!) : fills
  }

  async placeOrder(order: OrderIntent): Promise<OrderAck> {
    const { is_buy, size } = hlSizeBuyFromIntent(order)
    const req = {
      asset: order.symbol, // server resolves symbol → index via HL metadata
      is_buy,
      size,
      order_type: hlOrderTypeFromIntent(order),
      reduce_only: order.reduce_only ?? false,
      ...(order.client_order_id ? { cloid: order.client_order_id } : {}),
    }
    const res = await this.http.post<OrderResponseEnvelope>('/hyperliquid/order', req)
    const status: 'ok' | 'rejected' = res.status === 'ok' ? 'ok' : 'rejected'
    return {
      status,
      ...(order.client_order_id ? { client_order_id: order.client_order_id } : {}),
      ...(status === 'rejected' ? { reason: String((res.data as { error?: string })?.error ?? 'unknown') } : {}),
      raw: res,
    }
  }

  async cancelOrder(orderId: string, symbol: string): Promise<CancelAck> {
    const oidNum = Number.parseInt(orderId, 10)
    if (!Number.isFinite(oidNum)) {
      return { status: 'rejected', reason: `non-numeric order id: ${orderId}`, raw: null }
    }
    // /hyperliquid/cancel takes (asset: u32, order_id: u64). Server-side
    // resolves the symbol → asset index, so we send the symbol as the
    // `asset` field — the route accepts that via its symbol resolver.
    const res = await this.http.post<OrderResponseEnvelope>('/hyperliquid/cancel', {
      asset: symbol,
      order_id: oidNum,
    })
    const status: 'ok' | 'rejected' = res.status === 'ok' ? 'ok' : 'rejected'
    return {
      status,
      ...(status === 'rejected' ? { reason: String((res.data as { error?: string })?.error ?? 'unknown') } : {}),
      raw: res,
    }
  }
}
