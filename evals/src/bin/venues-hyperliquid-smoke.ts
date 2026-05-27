#!/usr/bin/env node
/**
 * Smoke test for `HyperliquidVenue` — boots a stub trading-http-api on a
 * random localhost port, returns canned responses with the exact wire
 * shape the real Rust routes emit, exercises every Venue method, and
 * asserts the parsed shapes. Run via:
 *
 *   npx tsx evals/src/bin/venues-hyperliquid-smoke.ts
 *
 * No external network. No Hyperliquid credentials. Proves the adapter's
 * shape mapping against the canonical route payloads documented in
 * `trading-http-api/src/routes/hyperliquid.rs` and
 * `trading-runtime/src/hyperliquid.rs`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { HyperliquidVenue } from '../venues/index.js'

const BOT_TOKEN = 'smoke-token'

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void

const routes: Record<string, RouteHandler> = {
  'GET /market-data/candles': (_req, res) => {
    json(res, 200, {
      candles: [
        { timestamp: 1700000000, token: 'BTC', open: '67000.0', high: '67500.5', low: '66800.0', close: '67300.25', volume: '12345.6789' },
        { timestamp: 1700003600, token: 'BTC', open: '67300.25', high: '67450.0', low: '67100.0', close: '67200.0', volume: '9876.54' },
      ],
      total: 2,
    })
  },
  'GET /hyperliquid/account': (_req, res) => {
    json(res, 200, {
      account_value: '10250.50',
      total_margin_used: '850.25',
      total_ntl_pos: '8500.0',
      total_raw_usd: '1400.0',
      withdrawable: '9400.25',
      positions: [
        {
          asset: 'BTC',
          size: '0.1',
          entry_price: '67100.0',
          unrealized_pnl: '20.25',
          leverage: 10,
          liquidation_price: '60300.0',
          margin_used: '671.0',
          return_on_equity: '3.02',
        },
        {
          asset: 'ETH',
          size: '-1.5',
          entry_price: '3400.0',
          unrealized_pnl: '-12.5',
          leverage: 5,
          liquidation_price: '3950.0',
          margin_used: '1020.0',
          return_on_equity: '-1.22',
        },
      ],
      open_orders: [
        { coin: 'BTC', limit_px: '66500.0', oid: 12345, side: 'B', sz: '0.05', timestamp: 1700000500 },
        { coin: 'ETH', limit_px: '3450.0', oid: 67890, side: 'A', sz: '0.5', timestamp: 1700000700 },
      ],
    })
  },
  'GET /hyperliquid/prices': (_req, res) => {
    json(res, 200, { BTC: '67300.25', ETH: '3400.0' })
  },
  'GET /trades': (_req, res) => {
    json(res, 200, {
      trades: [
        {
          id: 'trade-1',
          timestamp: '2024-01-01T00:00:00Z',
          action: 'buy',
          token_in: 'USDC',
          token_out: 'BTC',
          amount_in: '6710.0',
          amount_out: '0.1',
          target_protocol: 'hyperliquid_perp',
          tx_hash: '0xabc123',
          paper_trade: false,
          filled_price_usd: '67100.0',
          filled_amount: '0.1',
          slippage_bps: '5',
        },
      ],
      total: 1,
    })
  },
  'POST /hyperliquid/order': (_req, res) => {
    json(res, 200, { status: 'ok', data: { oid: 99999, status: 'resting' } })
  },
  'POST /hyperliquid/cancel': (_req, res) => {
    json(res, 200, { status: 'ok', data: { status: 'success' } })
  },
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function main(): Promise<void> {
  const server = createServer(async (req, res) => {
    const auth = req.headers['authorization']
    if (auth !== `Bearer ${BOT_TOKEN}`) {
      return json(res, 401, { error: 'unauthorized' })
    }
    const pathOnly = (req.url ?? '').split('?')[0] ?? ''
    const key = `${req.method} ${pathOnly}`
    const handler = routes[key]
    if (!handler) return json(res, 404, { error: `no stub for ${key}` })
    const body = req.method === 'POST' ? await readBody(req) : undefined
    handler(req, res, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (typeof addr !== 'object' || !addr) throw new Error('server address missing')
  const baseUrl = `http://127.0.0.1:${addr.port}`

  const venue = new HyperliquidVenue({ baseUrl, botToken: BOT_TOKEN })
  const assertions: Array<[string, () => void | Promise<void>]> = []

  assertions.push([
    'getCandles parses string Decimals + timestamp',
    async () => {
      const candles = await venue.getCandles('BTC', { limit: 2 })
      expectEq(candles.length, 2, 'candle count')
      expectEq(candles[0]!.timestamp, 1700000000, 'first ts')
      expectEq(candles[0]!.close, '67300.25', 'first close')
      expectEq(candles[1]!.open, '67300.25', 'second open')
    },
  ])
  assertions.push([
    'getAccount maps HL AccountInfo → unified Account',
    async () => {
      const acct = await venue.getAccount()
      expectEq(acct.equity_usd, '10250.50', 'equity')
      expectEq(acct.withdrawable_usd, '9400.25', 'withdrawable')
      expectEq(acct.positions.length, 2, 'position count')
      expectEq(acct.positions[0]!.side, 'long', 'long detection on +size')
      expectEq(acct.positions[1]!.side, 'short', 'short detection on -size')
      expectEq(acct.positions[0]!.leverage, 10, 'leverage passthrough')
      expectEq(acct.positions[0]!.liquidation_price, '60300.0', 'liq price passthrough')
      expectEq(acct.open_orders.length, 2, 'open order count')
      expectEq(acct.open_orders[0]!.side, 'buy', 'HL "B" → buy')
      expectEq(acct.open_orders[1]!.side, 'sell', 'HL "A" → sell')
      expectEq(acct.open_orders[0]!.order_id, '12345', 'order_id is string')
    },
  ])
  assertions.push([
    'getPositions is a thin derivation of getAccount.positions',
    async () => {
      const positions = await venue.getPositions()
      expectEq(positions.length, 2, 'position count')
      expectEq(positions[0]!.symbol, 'BTC', 'symbol passthrough')
    },
  ])
  assertions.push([
    'getOrderbook surfaces top-of-book from /hyperliquid/prices',
    async () => {
      const ob = await venue.getOrderbook('BTC')
      expectEq(ob.symbol, 'BTC', 'symbol echo')
      expectEq(ob.bids.length, 1, 'one bid level (single-tick stub)')
      expectEq(ob.bids[0]!.price, '67300.25', 'bid price')
      expectEq(ob.asks[0]!.price, '67300.25', 'ask price')
    },
  ])
  assertions.push([
    'getFills maps TradeRecord[] → Fill[]',
    async () => {
      const fills = await venue.getFills({ limit: 10 })
      expectEq(fills.length, 1, 'fill count')
      expectEq(fills[0]!.symbol, 'BTC', 'symbol resolved from token_out (USDC in side)')
      expectEq(fills[0]!.side, 'buy', 'side parsed from action')
      expectEq(fills[0]!.size, '0.1', 'size from filled_amount')
      expectEq(fills[0]!.price_usd, '67100.0', 'price from filled_price_usd')
      expectEq(fills[0]!.tx_hash, '0xabc123', 'tx_hash passthrough')
    },
  ])
  assertions.push([
    'placeOrder (market) routes to /hyperliquid/order',
    async () => {
      const ack = await venue.placeOrder({ kind: 'market', symbol: 'BTC', side: 'buy', size: '0.01' })
      expectEq(ack.status, 'ok', 'ok status')
    },
  ])
  assertions.push([
    'placeOrder (limit GTC) routes the right order_type',
    async () => {
      const ack = await venue.placeOrder({
        kind: 'limit',
        symbol: 'ETH',
        side: 'sell',
        size: '0.5',
        limit_price: '3500.0',
        time_in_force: 'gtc',
        client_order_id: 'cloid-1',
      })
      expectEq(ack.status, 'ok', 'ok status')
      expectEq(ack.client_order_id, 'cloid-1', 'cloid echoed back')
    },
  ])
  assertions.push([
    'cancelOrder routes to /hyperliquid/cancel',
    async () => {
      const ack = await venue.cancelOrder('12345', 'BTC')
      expectEq(ack.status, 'ok', 'ok status')
    },
  ])
  assertions.push([
    'cancelOrder rejects non-numeric ids without an HTTP call',
    async () => {
      const ack = await venue.cancelOrder('not-a-number', 'BTC')
      expectEq(ack.status, 'rejected', 'rejected before HTTP')
    },
  ])

  let passed = 0
  let failed = 0
  for (const [name, fn] of assertions) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (e) {
      failed += 1
      console.log(`  ✗ ${name}`)
      console.log(`     ${(e as Error).message}`)
    }
  }
  server.close()

  console.log(`\n${passed}/${assertions.length} assertions passed`)
  if (failed > 0) process.exit(1)
}

function expectEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

await main()
