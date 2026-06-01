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
