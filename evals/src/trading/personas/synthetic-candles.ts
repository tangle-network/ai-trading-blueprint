/**
 * Deterministic synthetic candle/funding generators for the persona-eval
 * suite — ports of the eight closures previously in
 * `trading-runtime/src/evals/agent_personas.rs`.
 *
 * Each generator yields a wire-shape `Candle[]` the new
 * `walk_forward_backtest` Rust CLI consumes inline (no venue fetch).
 * Same regime semantics the Rust suite expressed; preserved verbatim so
 * the 11 scenarios produce identical promotion verdicts post-migration.
 */

import type { Candle, FundingSnapshot } from '../harness-types.js'

const HOUR_SECONDS = 3_600

function dec(n: number): string {
  // Match Rust `Decimal::try_from(f64)` which preserves f64's full
  // ~17-significant-digit precision. `toString()` emits the shortest
  // representation that round-trips to the same f64 — both Rust's
  // `Decimal::from_str` and TS round-trip identically through this.
  return n.toString()
}

function candle(token: string, idx: number, close: number, range: number): Candle {
  const open = close * (1 - range / 3)
  return {
    timestamp: idx * HOUR_SECONDS,
    token,
    open: dec(open),
    high: dec(close * (1 + range)),
    low: dec(close * (1 - range)),
    close: dec(close),
    volume: dec(1_000_000 + idx * 1000),
  }
}

function botPatternCandle(token: string, idx: number, close: number, range: number, cycle: number): Candle {
  const c = candle(token, idx, close, range)
  const burst = cycle >= 8 && cycle < 18 ? 3_000_000 : 750_000
  c.volume = dec(burst + idx * 500)
  return c
}

export function trendCandles(token: string, n: number, start: number, drift: number, wave: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const t = i
    const shock = Math.sin(t / 9) * wave + (i % 47 === 0 ? wave * 1.8 : 0)
    const close = start * Math.pow(1 + drift, t) * (1 + shock)
    out.push(candle(token, i, close, 0.009))
  }
  return out
}

export function meanReversionCandles(
  token: string,
  n: number,
  center: number,
  amplitude: number,
  noise: number,
): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const t = i
    const close = center + amplitude * Math.sin(t / 8) + center * noise * Math.cos(t / 3)
    out.push(candle(token, i, Math.max(close, 0.01), 0.006))
  }
  return out
}

export function dislocationCandles(token: string, n: number, start: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const t = i
    const dislocation = i >= 45 && i < 80 ? 0.045 * (1 - (i - 45) / 35) : 0
    const close = start * Math.pow(1.0008, t) * (1 + dislocation + 0.01 * Math.sin(t / 5))
    out.push(candle(token, i, close, 0.012))
  }
  return out
}

export function crowdedBreakoutCandles(token: string, n: number, center: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const cycle = i % 32
    let botChase = 0
    if (cycle >= 7 && cycle < 11) botChase = 0.09 * ((cycle - 7) / 4)
    else if (cycle >= 11 && cycle < 20) botChase = 0.09 * (1 - (cycle - 11) / 9)
    const passiveFade = 0.035 * Math.sin(cycle / 5)
    const close = Math.min(0.95, Math.max(0.05, center + passiveFade + botChase))
    out.push(botPatternCandle(token, i, close, 0.01, cycle))
  }
  return out
}

export function stopCascadeCandles(token: string, n: number, start: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const cycle = i % 52
    const slowDrift = start * Math.pow(1.0002, i)
    let cascade = 0
    if (cycle >= 16 && cycle < 23) cascade = -0.075 * ((cycle - 16) / 7)
    else if (cycle >= 23 && cycle < 36) cascade = -0.075 * (1 - (cycle - 23) / 13)
    const close = slowDrift * (1 + cascade + 0.012 * Math.sin(cycle / 4))
    out.push(botPatternCandle(token, i, close, 0.018, cycle))
  }
  return out
}

export function ammRebalancerCandles(token: string, n: number, center: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const cycle = i % 40
    let inventoryShock = 0
    if (cycle >= 10 && cycle < 15) inventoryShock = 0.045
    else if (cycle >= 15 && cycle < 28) inventoryShock = 0.045 * (1 - (cycle - 15) / 13)
    const rebalancerOscillation = 0.018 * Math.sin(cycle / 3.5)
    const close = center * (1 + inventoryShock + rebalancerOscillation)
    out.push(botPatternCandle(token, i, close, 0.014, cycle))
  }
  return out
}

export function alphaDecayCandles(token: string, n: number, center: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const cycle = i % 36
    const crowding = i / n
    const earlyMomentum = 0.055 * (1 - crowding) * Math.max(0, Math.sin(cycle / 6))
    const lateFade = 0.05 * crowding * Math.sin(cycle / 5)
    const close = Math.min(0.95, Math.max(0.05, center + earlyMomentum - lateFade))
    out.push(botPatternCandle(token, i, close, 0.012, cycle))
  }
  return out
}

export function counterpartyRotationCandles(token: string, n: number, center: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const cycle = i % 44
    const phase = i / n
    const momentumPopulation = phase < 0.55 ? 0.025 * Math.max(0, Math.sin(cycle / 8)) : 0
    const rebalancerPopulation = phase >= 0.45 ? 0.032 * Math.sin(cycle / 4) : 0
    const close = center * (1 + momentumPopulation + rebalancerPopulation)
    out.push(botPatternCandle(token, i, close, 0.015, cycle))
  }
  return out
}

export function fundingWave(token: string, n: number, maxRate: number): FundingSnapshot[] {
  const out: FundingSnapshot[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: i * HOUR_SECONDS,
      token,
      rate: dec(maxRate * Math.sin(i / 12)),
    })
  }
  return out
}
