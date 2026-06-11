// Tests for the Slice C tick guards: the fetchCandles lookahead assertion
// (tick_common.js) and the structured insufficient-coverage finding
// (tick_coverage.js).
//
// Run with:  node --test tick_guards.test.cjs
//
// The tool `.js` files are CommonJS but the repo root declares
// `"type": "module"`, so a plain `require('./tick_common.js')` is misclassified
// as ESM locally (in the sandbox they run as CJS because /home/agent/tools has
// no package.json). We therefore compile each tool's source as CommonJS through
// the Module API so the test exercises the EXACT shipped source, independent of
// the root module type.
//
// Regressions these defend:
//  - a future-peeking candle window must HARD-fail (lookahead), not slip through
//  - a just-closed historical window must pass
//  - an untimestamped feed must not false-positive as lookahead
//  - a sparse-data skip must emit a structured { finding:'insufficient_coverage' }
//    instead of a bare silent skip

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

function loadCjs(file) {
  const filename = path.join(__dirname, file)
  const source = fs.readFileSync(filename, 'utf8')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod._compile(source, filename)
  return mod.exports
}

const {
  assertNoLookahead,
  candleOpenMs,
  LookaheadViolationError,
  spotPriceFromPortfolio,
  resolveUsdPrice,
  isPaperShowcaseMode,
  paperCycleWeight,
} = loadCjs('tick_common.js')
const { coverageFinding, insufficientCoverage, recordCoverageFinding } = loadCjs('tick_coverage.js')

const HOUR = 3_600_000

function windowEndingAt(endMs, count) {
  // `count` hourly candles whose LAST candle opens at endMs.
  const candles = []
  for (let i = count - 1; i >= 0; i -= 1) {
    candles.push({ timestamp: (endMs - i * HOUR) / 1000, close: 100 + i })
  }
  return candles
}

test('assertNoLookahead passes a strictly-historical window', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = windowEndingAt(now - HOUR, 40) // last candle opened an hour ago
  assert.doesNotThrow(() => assertNoLookahead(candles, now))
})

test('assertNoLookahead throws on a candle opening at/after the decision time', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = windowEndingAt(now - HOUR, 40)
  // Smuggle in a future candle that opens one hour AFTER the decision.
  candles.push({ timestamp: (now + HOUR) / 1000, close: 999 })
  assert.throws(
    () => assertNoLookahead(candles, now),
    (err) => {
      assert.ok(err instanceof LookaheadViolationError)
      assert.equal(err.code, 'lookahead_violation')
      assert.equal(err.detail.candle_index, candles.length - 1)
      assert.equal(err.detail.candle_open_ms, now + HOUR)
      return true
    },
  )
})

test('assertNoLookahead rejects a candle opening exactly at the decision time', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = [{ timestamp: now / 1000, close: 1 }]
  assert.throws(() => assertNoLookahead(candles, now), LookaheadViolationError)
})

test('assertNoLookahead ignores untimestamped candles (cannot prove lookahead)', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = [{ close: 1 }, { close: 2 }, { close: 3 }]
  assert.doesNotThrow(() => assertNoLookahead(candles, now))
})

test('candleOpenMs normalizes seconds and ms and positional arrays', () => {
  assert.equal(candleOpenMs({ timestamp: 1_700_000_000 }), 1_700_000_000_000)
  assert.equal(candleOpenMs({ timestamp: 1_700_000_000_000 }), 1_700_000_000_000)
  assert.equal(candleOpenMs([1_700_000_000, 1, 2, 3, 4]), 1_700_000_000_000)
  assert.equal(candleOpenMs({ close: 5 }), null)
})

test('spotPriceFromPortfolio derives paper prices from spot amount and value', () => {
  const token = '0x4200000000000000000000000000000000000006'
  const portfolio = {
    positions: [
      {
        token,
        amount: 2,
        value_usd: 4000,
        position_type: 'spot',
      },
    ],
  }
  assert.equal(spotPriceFromPortfolio(portfolio, token), 2000)
})

test('resolveUsdPrice fills missing market-data prices from portfolio value', async () => {
  const token = '0x4200000000000000000000000000000000000006'
  const prices = new Map()
  const portfolio = {
    positions: [
      {
        token,
        amount: 4,
        value_usd: 8000,
        position_type: 'spot',
      },
    ],
  }
  const api = {
    apiCall: async () => {
      throw new Error('candles should not be fetched when portfolio price exists')
    },
  }
  assert.equal(await resolveUsdPrice(api, portfolio, token, prices), 2000)
  assert.equal(prices.get(token.toLowerCase()), 2000)
})

test('paperCycleWeight is inert outside paper showcase mode', () => {
  const ctx = {
    runStartedAt: '2026-06-01T09:40:00.000Z',
    config: { bot_id: 'bot-a', strategy_config: { paper_trade: true } },
    harness: { aggressive_paper_mode: false },
  }
  assert.equal(isPaperShowcaseMode(ctx.config, ctx.harness), false)
  assert.equal(paperCycleWeight(ctx, { values: [0.2, 0.8] }, 0.5, [0.2, 0.8], 'mm'), 0.5)
})

test('paperCycleWeight rotates paper-only targets on the tick cadence', () => {
  const base = {
    config: { bot_id: 'bot-a', strategy_config: { paper_trade: true } },
    harness: { aggressive_paper_mode: true },
  }
  assert.equal(isPaperShowcaseMode(base.config, base.harness), true)
  const first = paperCycleWeight(
    { ...base, runStartedAt: '2026-06-01T09:40:00.000Z' },
    { values: [0.2, 0.8], period_secs: 300 },
    0.5,
    [0.2, 0.8],
    'mm',
  )
  const second = paperCycleWeight(
    { ...base, runStartedAt: '2026-06-01T09:45:00.000Z' },
    { values: [0.2, 0.8], period_secs: 300 },
    0.5,
    [0.2, 0.8],
    'mm',
  )
  assert.ok([0.2, 0.8].includes(first))
  assert.ok([0.2, 0.8].includes(second))
  assert.notEqual(first, second)
})

test('coverageFinding has the stable machine-checkable shape', () => {
  const f = coverageFinding({ have: 12, need: 30, metric: 'candles', asset: '0xabc' })
  assert.deepEqual(f, {
    finding: 'insufficient_coverage',
    have: 12,
    need: 30,
    metric: 'candles',
    asset: '0xabc',
  })
})

test('coverageFinding coerces bad counts to 0', () => {
  const f = coverageFinding({ have: undefined, need: NaN })
  assert.equal(f.have, 0)
  assert.equal(f.need, 0)
})

test('insufficientCoverage returns a structured skip, not a bare skip', () => {
  const out = insufficientCoverage({
    family: 'mm',
    asset: '0xweth',
    have: 12,
    need: 30,
    metric: 'candles',
    reason: 'insufficient-candles',
    checkedState: { foo: 1 },
    metrics: { iteration: 7 },
    runStartedAt: '2026-05-30T11:59:00.000Z',
  })
  assert.equal(out.decision.action, 'skip')
  assert.equal(out.decision.reason, 'insufficient-candles')
  // The finding rides on the decision AND the log entry (entryExtra), so the
  // eval can tell a blind skip from a deliberate hold.
  assert.equal(out.decision.coverage.finding, 'insufficient_coverage')
  assert.equal(out.decision.coverage.have, 12)
  assert.equal(out.decision.coverage.need, 30)
  assert.equal(out.entryExtra.coverage.finding, 'insufficient_coverage')
  assert.deepEqual(out.metrics, { iteration: 7 })
})

test('recordCoverageFinding never throws even when the log dir is unwritable', () => {
  // /home/agent/logs does not exist in CI; the write must be swallowed and the
  // structured finding still returned.
  const f = recordCoverageFinding({ family: 'dex', have: 5, need: 30, metric: 'candles' })
  assert.equal(f.finding, 'insufficient_coverage')
  assert.equal(f.have, 5)
})

test('evaluateExitRules enforces the backtest ExitRule schema live', () => {
  const t = loadCjs('tick_common.js')
  const hourMs = 60 * 60 * 1000

  assert.deepEqual(
    t.evaluateExitRules({
      rules: [{ type: 'stop_loss', pct: 5 }],
      entryPrice: 100,
      currentPrice: 94,
      closes: [],
      entryTimestampMs: Date.now() - 2 * hourMs,
    }),
    { exit: true, reason: 'stop-loss-5pct' },
  )
  assert.equal(
    t.evaluateExitRules({
      rules: [{ type: 'stop_loss', pct: 5 }],
      entryPrice: 100,
      currentPrice: 96,
      closes: [],
    }).exit,
    false,
  )
  assert.deepEqual(
    t.evaluateExitRules({
      rules: [{ type: 'take_profit', pct: 3 }],
      entryPrice: 100,
      currentPrice: 103.5,
      closes: [],
    }),
    { exit: true, reason: 'take-profit-3pct' },
  )
  assert.deepEqual(
    t.evaluateExitRules({
      rules: [{ type: 'time_limit', max_candles: 24 }],
      entryPrice: 100,
      currentPrice: 100,
      closes: [],
      entryTimestampMs: Date.now() - 25 * hourMs,
    }),
    { exit: true, reason: 'time-limit-exit' },
  )
  assert.deepEqual(
    t.evaluateExitRules({
      rules: [{ type: 'trailing_stop', activation_pct: 2, trail_pct: 1 }],
      entryPrice: 100,
      currentPrice: 103,
      closes: Array(10).fill(105),
      entryTimestampMs: Date.now() - 10 * hourMs,
    }),
    { exit: true, reason: 'trailing-stop-exit' },
  )
  // Without an entry anchor, price-based rules must not fire blind.
  assert.equal(
    t.evaluateExitRules({
      rules: [{ type: 'stop_loss', pct: 5 }],
      entryPrice: null,
      currentPrice: 50,
      closes: [],
    }).exit,
    false,
  )
})

test('mandateMaxDrawdownPct resolves harness, explicit config, then launch-ticket text', () => {
  const t = loadCjs('tick_common.js')
  const ticketOnly = { strategy_config: { launch_ticket: { risk: '4% max drawdown' } } }
  assert.equal(t.mandateMaxDrawdownPct(ticketOnly, {}, 10), 4)
  assert.equal(t.mandateMaxDrawdownPct(ticketOnly, { risk: { max_drawdown_pct: 6 } }, 10), 6)
  assert.equal(
    t.mandateMaxDrawdownPct({ strategy_config: { max_drawdown_pct: 3 } }, {}, 10),
    3,
  )
  assert.equal(t.mandateMaxDrawdownPct({}, {}, 10), 10)
})

test('buildSwapIntent persists the entry signal as runner_signal metadata', () => {
  const t = loadCjs('tick_common.js')
  const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
  const weth = '0x4200000000000000000000000000000000000006'
  const intent = t.buildSwapIntent({
    config: { bot_id: 'bot-x' },
    strategyId: 'dex-bot-x',
    tokenIn: usdc,
    tokenOut: weth,
    amountInUnits: 1_000_000n,
    prices: new Map([
      [usdc, 1],
      [weth, 2000],
    ]),
    slippageBps: 100,
    protocol: 'uniswap_v3',
    metadata: { signal: 'ema-trend-entry', signals: { rsi_14: 40 } },
  })
  assert.equal(intent.metadata.runner_signal, 'ema-trend-entry')
})

test('circuitBreakerTripped honors the server should_break field', async () => {
  const t = loadCjs('tick_common.js')
  const api = (payload) => ({ checkCircuitBreaker: async () => ({ data: payload }) })
  assert.equal(await t.circuitBreakerTripped(api({ should_break: true, current_drawdown_pct: '9.1' }), 4), true)
  assert.equal(await t.circuitBreakerTripped(api({ should_break: false, current_drawdown_pct: '1.2' }), 4), false)
  // Fail-open on transport errors is intentional (a dead metrics endpoint
  // must not halt trading) — but a present should_break must win.
  const broken = { checkCircuitBreaker: async () => { throw new Error('down') } }
  assert.equal(await t.circuitBreakerTripped(broken, 4), false)
})
