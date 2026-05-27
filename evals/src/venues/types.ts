/**
 * Unified venue adapter interface — the 7 truly venue-specific verbs every
 * supported exchange/protocol exposes. Each adapter wraps the
 * trading-http-api routes the deployed bot already hits; signing stays
 * server-side. Same shape across HL perp, Drift perp, Aerodrome AMM,
 * Polymarket CLOB — venue-specific adapters translate per-venue payloads
 * into this shared surface.
 *
 * Non-venue verbs (`backtest`, `read_traces`, `set_strategy`,
 * `write_strategy_file`, `delegate.research/code/analyze`, `ask_user`)
 * live elsewhere and are not part of this interface.
 *
 * Decimals are strings (preserving the wire shape Rust's `rust_decimal`
 * produces — no f64 round-trip loss on any size or price field).
 */

export type VenueId = 'hyperliquid_perp' | 'drift_perp' | 'aerodrome_amm' | 'polymarket_clob'

export type Side = 'buy' | 'sell'
export type TimeInForce = 'gtc' | 'ioc' | 'alo'

export type OrderIntent =
  | { kind: 'market'; symbol: string; side: Side; size: string; reduce_only?: boolean; client_order_id?: string }
  | {
      kind: 'limit'
      symbol: string
      side: Side
      size: string
      limit_price: string
      time_in_force?: TimeInForce
      reduce_only?: boolean
      client_order_id?: string
    }
  | {
      kind: 'trigger'
      symbol: string
      side: Side
      size: string
      trigger_price: string
      is_market: boolean
      kind_trigger: 'stop_loss' | 'take_profit'
      reduce_only?: boolean
      client_order_id?: string
    }

export interface OrderAck {
  /** Server-side order id (where the venue assigned one). */
  order_id?: string
  /** Optional client-supplied idempotency key, echoed back if provided. */
  client_order_id?: string
  status: 'ok' | 'rejected'
  /** Free-form rejection reason when `status === 'rejected'`. */
  reason?: string
  /** Raw response from the trading-http-api route (kept for debugging,
   *  never load-bearing in eval scoring). */
  raw: unknown
}

export interface CancelAck {
  status: 'ok' | 'rejected'
  reason?: string
  raw: unknown
}

export interface Position {
  symbol: string
  side: 'long' | 'short' | 'flat'
  size: string
  entry_price: string
  unrealized_pnl_usd: string
  margin_used_usd: string
  leverage?: number
  liquidation_price?: string
}

export interface OpenOrder {
  order_id: string
  symbol: string
  side: Side
  size: string
  limit_price: string
  placed_at: number
}

export interface Account {
  equity_usd: string
  margin_used_usd: string
  withdrawable_usd: string
  positions: Position[]
  open_orders: OpenOrder[]
}

export interface Fill {
  fill_id: string
  symbol: string
  side: Side
  size: string
  price_usd: string
  fee_usd: string
  timestamp: number
  tx_hash?: string
  /** Order this fill closes (where the venue exposes order-fill linkage). */
  order_id?: string
}

export interface PriceLevel {
  price: string
  size: string
}

export interface Orderbook {
  symbol: string
  bids: PriceLevel[]
  asks: PriceLevel[]
  timestamp: number
}

export interface CandleRow {
  timestamp: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

export interface GetCandlesOptions {
  interval?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
  limit?: number
  from?: number
  to?: number
}

export interface GetFillsOptions {
  since?: number
  limit?: number
}

/** The shared venue-specific surface. Every adapter implements this; the
 *  agent's tool surface composes these via a venue registry. */
export interface Venue {
  readonly id: VenueId
  /** Stable display name for traces + the user UI. */
  readonly label: string

  getCandles(symbol: string, opts?: GetCandlesOptions): Promise<CandleRow[]>
  getOrderbook(symbol: string, depth?: number): Promise<Orderbook>
  getAccount(): Promise<Account>
  getPositions(): Promise<Position[]>
  getFills(opts?: GetFillsOptions): Promise<Fill[]>

  placeOrder(order: OrderIntent): Promise<OrderAck>
  cancelOrder(orderId: string, symbol: string): Promise<CancelAck>
}

/** Shared client config every adapter accepts. */
export interface VenueClientConfig {
  /** Base URL of the trading-http-api (e.g., `http://127.0.0.1:8780`).
   *  Signing happens server-side; the client never holds keys. */
  baseUrl: string
  /** Bot bearer token resolved by the trading-http-api auth middleware. */
  botToken: string
  /** Per-request timeout, default 15s. */
  timeoutMs?: number
  /** Optional fetch impl override (test injection); defaults to global fetch. */
  fetchImpl?: typeof fetch
}
