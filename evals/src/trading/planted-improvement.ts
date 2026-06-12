/**
 * Planted-improvement recovery eval — does the self-improvement loop
 * actually FIND and PROMOTE a known-better config, or does it only ever
 * block? (Production audit 2026-06: 385 candidates → 384 blocked /
 * 0 promotions in 17h. Every existing eval tested the gate in the
 * "blocks bad candidates" direction; nothing asserted it passes good
 * ones. This eval is that missing direction.)
 *
 * Construction:
 *   - Synthetic mean-reverting candle regime (reuses the persona suite's
 *     `meanReversionCandles` generator) planted into the harness-backtest
 *     CLI's candle cache, so the whole loop runs offline + deterministic
 *     per harness (no venue fetch).
 *   - A deliberately mis-parameterized baseline: RSI(14) `below 5` —
 *     RSI never dips under 5 on this oscillation in the backtest engine
 *     (0 trades on all three planted bots), so the baseline sits on the
 *     harnessFitness −10 insufficient-trades floor.
 *   - A planted optimum INSIDE the mutator's search space: the same rule
 *     at `below 20` buys deep in each trough (probed composites ≈ +0.7
 *     to +2.1 vs the baseline's −10; thresholds near 15 score even
 *     higher, ≈ +7 to +8 — the loop may find those too). Reachable via
 *     `rsi_threshold` steps (clamped jitter ±8 within [5, 45]: 5→≤13→≤21
 *     in two steps) or a single `add_rule` mutation (new RSI rules spawn
 *     at threshold 20–40). NOTE: thresholds ≥25 are NOT better — they
 *     buy too early in the descent and stop out — so the plant is a real
 *     optimum region, not "any change wins".
 *   - The planted optimum is VERIFIED against the walk-forward CLI
 *     (`evaluateScenario`, the live promotion primitive) before the loop
 *     runs — if the plant itself doesn't beat the baseline in-engine,
 *     the eval aborts instead of asserting a fiction.
 *
 * Assertions (bin):
 *   - promotion_count >= 1 across R runs (gate decision === 'ship')
 *   - every promoted winner beats the baseline on the held-out bot
 *   - recovery_rate (runs-that-promoted / total) is reported so
 *     flakiness is a number, not an anecdote.
 *
 * REUSES the production machinery end-to-end: `runHarnessSelfImprovement`
 * (substrate runImprovementLoop + evolutionaryDriver + harnessMutator +
 * harnessJudge + defaultProductionGate) — no parallel loop implementation.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CampaignResult } from '@tangle-network/agent-eval/campaign'
import { isoStamp, resolveRepo } from '../lib/repo.js'
import { runHarnessSelfImprovement } from './harness-self-improve.js'
import type { BotScenario } from './harness-self-improve.js'
import type { BacktestArtifact, BotContext, Candle, HarnessConfig } from './harness-types.js'
import type { TradingEvalScenario } from './personas/scenarios.js'
import { meanReversionCandles } from './personas/synthetic-candles.js'
import { evaluateScenario } from './personas/walk-forward.js'

/** Bars per synthetic bot. 720 hourly bars ≈ 30 days; the oscillation
 *  period (2π·8 ≈ 50 bars) fits ~14 full cycles, enough trades to clear
 *  the fitness judge's 5-trade floor with room to spare. */
export const PLANTED_CANDLES_LIMIT = 720

/** Three holdout bots, NOT one: `defaultProductionGate` requires
 *  `minProductiveRuns` (default 3) paired holdout observations before it
 *  will read the bootstrap CI — with a single holdout scenario × 1 rep the
 *  gate always HOLDs with `few_runs` regardless of how good the winner is
 *  (found the hard way: first run of this eval was 0/3 promotions purely
 *  from this). */
export const PLANTED_HOLDOUT_BOT_IDS = ['synth-holdout-a', 'synth-holdout-b', 'synth-holdout-c']

interface PlantedBotSpec {
  bot: BotContext
  center: number
  /** Absolute sine amplitude (same regime, different price scale per bot —
   *  RSI is scale-invariant so the planted optimum transfers across bots). */
  amplitude: number
  noise: number
}

/** Two TRAIN bots drive the search; three HOLDOUT bots gate the winner.
 *  Same mean-reverting regime, different price scales, so the holdout is
 *  a genuine out-of-bot sample rather than a copy of the train series. */
const PLANTED_BOTS: PlantedBotSpec[] = [
  {
    bot: { id: 'synth-train-a', source: 'hyperliquid', symbol: 'SYNTH-TRAIN-A', fee_protocol: 'hyperliquid_perp', venue_label: 'synthetic' },
    center: 100,
    amplitude: 12,
    noise: 0.01,
  },
  {
    bot: { id: 'synth-train-b', source: 'hyperliquid', symbol: 'SYNTH-TRAIN-B', fee_protocol: 'hyperliquid_perp', venue_label: 'synthetic' },
    center: 250,
    amplitude: 35,
    noise: 0.012,
  },
  {
    bot: { id: 'synth-holdout-a', source: 'hyperliquid', symbol: 'SYNTH-HOLDOUT-A', fee_protocol: 'hyperliquid_perp', venue_label: 'synthetic' },
    center: 40,
    amplitude: 4.4,
    noise: 0.008,
  },
  {
    bot: { id: 'synth-holdout-b', source: 'hyperliquid', symbol: 'SYNTH-HOLDOUT-B', fee_protocol: 'hyperliquid_perp', venue_label: 'synthetic' },
    center: 1800,
    amplitude: 210,
    noise: 0.011,
  },
  {
    bot: { id: 'synth-holdout-c', source: 'hyperliquid', symbol: 'SYNTH-HOLDOUT-C', fee_protocol: 'hyperliquid_perp', venue_label: 'synthetic' },
    center: 6.5,
    amplitude: 0.75,
    noise: 0.009,
  },
]

/** Deliberately mis-parameterized: RSI(14) below 5 on this oscillation
 *  never fires in the backtest engine → 0 trades → the harnessFitness −10
 *  floor (verified by probe on all three planted bots). Structurally
 *  identical to the planted optimum, so the gap is purely the one
 *  parameter the mutator is expected to recover. */
export const MISPARAMETERIZED_BASELINE: HarnessConfig = {
  version: 1,
  entry_rules: [
    { signal: { type: 'rsi', period: 14 }, condition: { type: 'below', threshold: 5 }, weight: 1.0, tokens: [] },
  ],
  exit_rules: [
    { type: 'stop_loss', pct: 5 },
    { type: 'take_profit', pct: 10 },
  ],
  filters: [],
  position_sizing: { method: 'fixed_fraction', fraction: 0.1 },
  entry_threshold: 0.3,
  max_positions: 5,
}

/** The known-better config inside the mutator's search space: `below 20`
 *  is inside the rsi_threshold clamp [5, 45] (two ±8 jitter steps from the
 *  baseline's 5) and at the edge of add_rule's spawn range [20, 40].
 *  Walk-forward-verified better than the baseline before every run
 *  (verifyPlantedOptimum): test return ≈ +3.4% vs +1.0%, sharpe Δ ≈ +0.9.
 *  Higher thresholds (≥25) FAIL the economics gate — early entries ride
 *  the descent into the 5% stop — which is what makes this a planted
 *  optimum rather than a freebie. */
export const PLANTED_OPTIMUM: HarnessConfig = {
  ...MISPARAMETERIZED_BASELINE,
  version: 2,
  entry_rules: [
    { signal: { type: 'rsi', period: 14 }, condition: { type: 'below', threshold: 20 }, weight: 1.0, tokens: [] },
  ],
}

function plantedCandles(spec: PlantedBotSpec): Candle[] {
  return meanReversionCandles(spec.bot.symbol, PLANTED_CANDLES_LIMIT, spec.center, spec.amplitude, spec.noise)
}

/** Write the synthetic series into the harness-backtest CLI's candle cache.
 *  Cache key format must match `cache_file_path` in
 *  trading-runtime/examples/harness_backtest.rs:
 *  `{source}-{symbol with [:/ ]→_}-1h-{limit}.json`. A cache hit with
 *  >= limit rows short-circuits the venue fetch entirely. */
export function plantCandleCache(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true })
  for (const spec of PLANTED_BOTS) {
    const safeSymbol = spec.bot.symbol.replace(/[:/ ]/g, '_')
    const file = join(cacheDir, `${spec.bot.source}-${safeSymbol}-1h-${PLANTED_CANDLES_LIMIT}.json`)
    writeFileSync(file, JSON.stringify(plantedCandles(spec)))
  }
}

// ─── Pre-flight: prove the plant is real before asserting recovery ──────

export interface PlantedVerification {
  promotion_recommended: boolean
  economics_gate_passed: boolean
  test_candidate_return_pct: number
  test_candidate_sharpe: number
  test_trade_count: number
  gates: string[]
}

function plantedScenario(): TradingEvalScenario {
  const train = PLANTED_BOTS[0]!
  return {
    id: 'planted_mean_reversion_recovery',
    split: 'dev',
    objective: 'Verify the planted optimum beats the mis-parameterized baseline on the synthetic regime.',
    market_regime: 'planted_mean_reversion',
    persona: {
      id: 'planted-recovery-verifier',
      role: 'Planted-improvement verifier',
      venues: ['hyperliquid'],
      chains: ['hyperliquid'],
      execution_mode: 'backtest_then_paper_or_shadow',
      // Generous mandate: this scenario verifies the ECONOMIC gap exists,
      // not that the optimum satisfies a tight production mandate.
      max_position_pct: 100,
      max_drawdown_pct: 60,
      min_trades: 3,
      max_trades: 10_000,
      must_use_real_backtest: true,
    },
    baseline: { harness: MISPARAMETERIZED_BASELINE, taker_fee_bps: 5, slippage_bps: 10, gas_cost_usd: 0 },
    candidate: { harness: PLANTED_OPTIMUM, taker_fee_bps: 5, slippage_bps: 10, gas_cost_usd: 0 },
    candles: plantedCandles(train),
    funding: [],
  }
}

/** Run the walk-forward CLI (the live promotion primitive) on
 *  baseline-vs-planted-optimum. Throws when the plant is NOT actually
 *  better — the recovery assertion would be meaningless. */
export function verifyPlantedOptimum(): PlantedVerification {
  const result = evaluateScenario(plantedScenario())
  const economicsGate = result.deterministic_gates.find((g) => g.includes('economics:candidate-beats-baseline'))
  const verification: PlantedVerification = {
    promotion_recommended: result.promotion_recommended,
    economics_gate_passed: economicsGate?.startsWith('PASS') ?? false,
    test_candidate_return_pct: result.test_candidate_return_pct,
    test_candidate_sharpe: result.test_candidate_sharpe,
    test_trade_count: result.test_trade_count,
    gates: result.deterministic_gates,
  }
  if (!verification.economics_gate_passed || verification.test_trade_count <= 0) {
    throw new Error(
      `planted optimum failed walk-forward verification — the plant is not a real improvement; ` +
        `fix the regime/config before asserting recovery. Gates:\n${result.deterministic_gates.join('\n')}`,
    )
  }
  return verification
}

// ─── The recovery loop itself ────────────────────────────────────────────

export interface PlantedRecoveryRunResult {
  run: number
  gate_decision: string
  /** The gate's own reasons — surfaced so a blocked run is diagnosable from
   *  the report (e.g. `few_runs`, red-team, regression guard) instead of an
   *  opaque "no-ship". */
  gate_reasons: string[]
  promoted: boolean
  baseline_holdout_mean: number
  winner_holdout_mean: number
  winner_beats_baseline_on_holdout: boolean
  /** promoted AND beats baseline on holdout — the full recovery claim. */
  recovered: boolean
  winner_rsi_below_thresholds: number[]
  winner_surface_hash: string | undefined
}

export interface PlantedRecoveryReport {
  verification: PlantedVerification
  total_runs: number
  promotion_count: number
  recovered_count: number
  /** runs-that-recovered / total — the flakiness-visible headline metric. */
  recovery_rate: number
  runs: PlantedRecoveryRunResult[]
}

export interface PlantedRecoveryOptions {
  /** Independent loop repetitions for the recovery-rate denominator. Default 3. */
  runs?: number
  populationSize?: number
  maxGenerations?: number
  deltaThreshold?: number
  reps?: number
  seed?: number
  runDirBase?: string
  cacheDir?: string
}

function meanHoldoutComposite(campaign: CampaignResult<BacktestArtifact, BotScenario>): number {
  const means = Object.values(campaign.aggregates.byScenario).map((s) => s.meanComposite)
  if (means.length === 0) return Number.NEGATIVE_INFINITY
  return means.reduce((a, b) => a + b, 0) / means.length
}

function rsiBelowThresholds(surface: unknown): number[] {
  if (typeof surface !== 'string' || surface.trim().length === 0) return []
  try {
    const harness = JSON.parse(surface) as HarnessConfig
    return harness.entry_rules
      .filter((r) => r.signal.type === 'rsi' && r.condition.type === 'below')
      .map((r) => (r.condition as { type: 'below'; threshold: number }).threshold)
  } catch {
    return []
  }
}

export async function runPlantedImprovementRecovery(
  opts: PlantedRecoveryOptions = {},
): Promise<PlantedRecoveryReport> {
  const totalRuns = opts.runs ?? 3
  const runDirBase = opts.runDirBase ?? resolveRepo(`.evolve/eval-runs/planted-improvement-${isoStamp()}`)
  const cacheDir = opts.cacheDir ?? join(runDirBase, 'candle-cache')

  // Plant the regime ONCE — the series is deterministic, every run and every
  // cell reads the same cache files (no network, no venue drift).
  plantCandleCache(cacheDir)
  const verification = verifyPlantedOptimum()

  const runs: PlantedRecoveryRunResult[] = []
  for (let i = 0; i < totalRuns; i += 1) {
    const result = await runHarnessSelfImprovement({
      bots: PLANTED_BOTS.map((s) => s.bot),
      holdoutBotIds: PLANTED_HOLDOUT_BOT_IDS,
      baselineHarness: MISPARAMETERIZED_BASELINE,
      candlesLimit: PLANTED_CANDLES_LIMIT,
      cacheDir,
      populationSize: opts.populationSize ?? 12,
      maxGenerations: opts.maxGenerations ?? 5,
      deltaThreshold: opts.deltaThreshold ?? 0.05,
      reps: opts.reps ?? 1,
      runDir: join(runDirBase, `run-${i}`),
      ...(opts.seed !== undefined ? { seed: opts.seed + i } : {}),
    })

    const gate =
      typeof result.gateResult === 'object' && result.gateResult !== null
        ? (result.gateResult as { decision?: unknown; reasons?: unknown })
        : {}
    const decision = 'decision' in gate ? String(gate.decision) : 'unknown'
    const gateReasons = Array.isArray(gate.reasons) ? gate.reasons.map(String) : []
    const promoted = decision === 'ship'
    const baselineMean = meanHoldoutComposite(result.baselineOnHoldout)
    const winnerMean = meanHoldoutComposite(result.winnerOnHoldout)
    const beats = winnerMean > baselineMean
    runs.push({
      run: i,
      gate_decision: decision,
      gate_reasons: gateReasons,
      promoted,
      baseline_holdout_mean: baselineMean,
      winner_holdout_mean: winnerMean,
      winner_beats_baseline_on_holdout: beats,
      recovered: promoted && beats,
      winner_rsi_below_thresholds: rsiBelowThresholds(result.winnerSurface),
      winner_surface_hash: typeof result.winnerSurfaceHash === 'string' ? result.winnerSurfaceHash : undefined,
    })
  }

  const promotionCount = runs.filter((r) => r.promoted).length
  const recoveredCount = runs.filter((r) => r.recovered).length
  return {
    verification,
    total_runs: totalRuns,
    promotion_count: promotionCount,
    recovered_count: recoveredCount,
    recovery_rate: totalRuns === 0 ? 0 : recoveredCount / totalRuns,
    runs,
  }
}
