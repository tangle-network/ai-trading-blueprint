// Tests for the eval-side walk-forward lookahead guard (G2).
//
// Run with:  npx tsx --test evals/src/lib/lookahead_validator.test.ts
//
// Regressions these defend:
//  - a window that appends a candle at/after the decision cursor HARD-fails
//    (LookaheadAssertionError), so the walk-forward eval cannot reward fictional
//    future-peeking edge
//  - a strictly-historical window passes and reports the right counts
//  - untimestamped candles never false-positive
//  - the lifecycle runner's own window check (assertWalkForwardWindow) catches a
//    future candle smuggled past the last close

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertStrictlyHistorical,
  checkLookahead,
  candleOpenMs,
  normalizeEpochMs,
  LookaheadAssertionError,
  type CandleLike,
} from './lookahead_validator.js'
import { assertWalkForwardWindow, latestCandleOpenMs } from '../trading/lifecycle-runner.js'

const HOUR = 3_600_000

function windowEndingAt(endMs: number, count: number) {
  const candles: Array<{ timestamp: number; close: string }> = []
  for (let i = count - 1; i >= 0; i -= 1) {
    candles.push({ timestamp: (endMs - i * HOUR) / 1000, close: '100' })
  }
  return candles
}

test('checkLookahead passes a strictly-historical window', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = windowEndingAt(now - HOUR, 40)
  const result = checkLookahead(candles, now)
  assert.equal(result.ok, true)
  assert.equal(result.violations.length, 0)
  assert.equal(result.candlesChecked, 40)
  assert.equal(result.candlesWithTimestamp, 40)
})

test('checkLookahead flags a candle at/after the decision time', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = windowEndingAt(now - HOUR, 40)
  candles.push({ timestamp: now / 1000, close: '999' }) // opens exactly at decision
  const result = checkLookahead(candles, now)
  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0]?.candleIndex, candles.length - 1)
  assert.equal(result.violations[0]?.candleOpenMs, now)
})

test('assertStrictlyHistorical throws LookaheadAssertionError on a future candle', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = windowEndingAt(now - HOUR, 10)
  candles.push({ timestamp: (now + HOUR) / 1000, close: '999' })
  assert.throws(
    () => assertStrictlyHistorical(candles, now, 'unit'),
    (err: unknown) => {
      assert.ok(err instanceof LookaheadAssertionError)
      assert.equal(err.check.violations.length, 1)
      assert.match(err.message, /unit lookahead/)
      return true
    },
  )
})

test('untimestamped candles never count as lookahead', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z')
  const candles: CandleLike[] = [{}, {}]
  const result = checkLookahead(candles, now)
  assert.equal(result.ok, true)
  assert.equal(result.candlesWithTimestamp, 0)
})

test('normalizeEpochMs scales seconds, keeps ms, rejects junk', () => {
  assert.equal(normalizeEpochMs(1_700_000_000), 1_700_000_000_000)
  assert.equal(normalizeEpochMs(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(normalizeEpochMs('not-a-number'), null)
  assert.equal(normalizeEpochMs(0), null)
})

test('candleOpenMs reads positional arrays and aliased keys', () => {
  assert.equal(candleOpenMs([1_700_000_000, 1, 2, 3, 4]), 1_700_000_000_000)
  assert.equal(candleOpenMs({ open_time: 1_700_000_000 }), 1_700_000_000_000)
})

test('latestCandleOpenMs reports the most recent candle open', () => {
  const lastOpen = Date.parse('2026-05-30T11:00:00.000Z')
  const candles = windowEndingAt(lastOpen, 5)
  assert.equal(latestCandleOpenMs(candles), lastOpen)
  assert.equal(latestCandleOpenMs([{}]), null)
})

test('assertWalkForwardWindow accepts a window strictly before the cursor', () => {
  const cursor = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = windowEndingAt(cursor - HOUR, 24) // last open is one hour before cursor
  assert.doesNotThrow(() => assertWalkForwardWindow(candles, cursor, 'historical'))
})

test('assertWalkForwardWindow rejects a candle dated at/after the decision cursor', () => {
  const cursor = Date.parse('2026-05-30T12:00:00.000Z')
  const candles = windowEndingAt(cursor - HOUR, 24)
  // Smuggle in a future bucket that opens an hour AFTER the eval's cursor — a
  // candle that could not exist when the eval decided.
  candles.push({ timestamp: (cursor + HOUR) / 1000, close: '999' })
  assert.throws(() => assertWalkForwardWindow(candles, cursor, 'smuggled'), LookaheadAssertionError)
})
