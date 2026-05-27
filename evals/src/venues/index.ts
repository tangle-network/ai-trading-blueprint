/**
 * Venue registry — the unified per-venue surface every agentic loop calls
 * through. New venues drop in by implementing the `Venue` interface in
 * `./types.ts` and registering here.
 *
 * Current shipped adapters:
 *   - HyperliquidVenue (HL perp)
 *
 * Planned: DriftVenue (Drift perp), AerodromeVenue (Base AMM),
 * PolymarketVenue (CLOB binary). Each adds a single file; the unified
 * interface stays unchanged.
 */

export { HyperliquidVenue } from './hyperliquid.js'
export { TradingApiClient, TradingApiHttpError } from './http.js'
export type {
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
  Side,
  TimeInForce,
  Venue,
  VenueClientConfig,
  VenueId,
} from './types.js'
