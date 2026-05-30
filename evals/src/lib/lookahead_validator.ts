// Walk-forward lookahead guard (G2, eval side).
//
// A tick deciding at time T may only consume candles that have already opened
// (timestamp strictly before T). A candle dated at/after T is the future leaking
// into the decision window — the model is peeking, and any backtest edge it
// shows is fictional. The JS harness enforces this at fetch time
// (tick_common.js `assertNoLookahead`); this module is the eval-side mirror so
// the walk-forward runner HARD-FAILS a persona turn whose fed window is not
// strictly historical, independent of whether the in-sandbox guard ran.

export interface CandleLike {
  // epoch seconds or ms; positional [t, o, h, l, c, v] arrays are also accepted.
  timestamp?: number | string
  open_time?: number | string
  openTime?: number | string
  time?: number | string
  t?: number | string
}

export interface LookaheadViolation {
  candleIndex: number
  candleOpenMs: number
  decisionMs: number
}

export interface LookaheadCheck {
  ok: boolean
  decisionMs: number
  candlesChecked: number
  candlesWithTimestamp: number
  violations: LookaheadViolation[]
}

// Normalize a raw timestamp to epoch-ms. Seconds (< 1e12) are scaled up.
// Returns null for missing/non-finite values (an untimestamped candle cannot be
// proven to be lookahead, so it is not counted as a violation).
export function normalizeEpochMs(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

export function candleOpenMs(candle: CandleLike | unknown[]): number | null {
  if (Array.isArray(candle)) return normalizeEpochMs(candle[0])
  const c = candle as CandleLike
  return normalizeEpochMs(c.timestamp ?? c.open_time ?? c.openTime ?? c.time ?? c.t)
}

// Inspect a candle window against a decision time. `decisionMs` is when the tick
// decides; every candle must open strictly before it.
export function checkLookahead(
  candles: ReadonlyArray<CandleLike | unknown[]>,
  decisionMs: number,
): LookaheadCheck {
  const violations: LookaheadViolation[] = []
  let withTimestamp = 0
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]
    if (candle === undefined) continue
    const openMs = candleOpenMs(candle)
    if (openMs === null) continue
    withTimestamp += 1
    if (openMs >= decisionMs) {
      violations.push({ candleIndex: i, candleOpenMs: openMs, decisionMs })
    }
  }
  return {
    ok: violations.length === 0,
    decisionMs,
    candlesChecked: candles.length,
    candlesWithTimestamp: withTimestamp,
    violations,
  }
}

// HARD assertion for the walk-forward runner: throw if the fed window contains a
// candle at/after the decision time. The thrown message names the first
// offending candle so the eval failure is actionable.
export function assertStrictlyHistorical(
  candles: ReadonlyArray<CandleLike | unknown[]>,
  decisionMs: number,
  label = 'tick',
): LookaheadCheck {
  const check = checkLookahead(candles, decisionMs)
  if (!check.ok) {
    const first = check.violations[0]
    const openIso = first ? new Date(first.candleOpenMs).toISOString() : 'unknown'
    const decisionIso = new Date(decisionMs).toISOString()
    throw new LookaheadAssertionError(
      `${label} lookahead: candle #${first?.candleIndex} opens ${openIso} >= decision ${decisionIso} (${check.violations.length} violation${check.violations.length === 1 ? '' : 's'})`,
      check,
    )
  }
  return check
}

export class LookaheadAssertionError extends Error {
  readonly check: LookaheadCheck
  constructor(message: string, check: LookaheadCheck) {
    super(message)
    this.name = 'LookaheadAssertionError'
    this.check = check
  }
}
