/**
 * Trading-blueprint self-improvement — the ONE cycle, mirroring
 * `gtm-agent/eval/self-improve.ts`.
 *
 * Composes the agent-eval `campaign` substrate (`runCampaign` /
 * `runImprovementLoop` / `evolutionaryDriver` / `defaultProductionGate`)
 * with this repo's domain machinery:
 *   - scenarios    = one per bot (HL BTC/ETH/SOL/HYPE, Drift SOL/BTC,
 *                    Aerodrome ETH …). Each is a (source, symbol,
 *                    fee_protocol) tuple of native-venue OHLCV input.
 *   - surface      = `HarnessConfig` JSON (the strategy genome the
 *                    Rust `BacktestEngine` consumes)
 *   - dispatch     = spawn the Rust CLI `harness_backtest`, pipe the
 *                    HarnessConfig + scenario context on stdin, parse
 *                    the BacktestResult JSON on stdout
 *   - judge        = composite of Sharpe (bootstrap CI low) + OOS Sharpe
 *                    − drawdown − overfit gap + trade-count bonus, the
 *                    same fitness gate the production loop applies
 *   - mutator      = 12 mutation kinds over HarnessConfig (RSI / EMA
 *                    periods + thresholds, stops, weights, sizing,
 *                    add/drop rule, flip condition). Same kinds that
 *                    were validated as Rust before; lifted to TS so the
 *                    evolutionaryDriver can call into them.
 *
 * Two entry points, one engine:
 *   - `runHarnessEval`                 → measure-only campaign across bots
 *   - `runHarnessSelfImprovement`      → optimize the HarnessConfig over
 *                                        TRAIN bots, gate the winner on a
 *                                        HELD-OUT bot split.
 *
 * The substrate owns the loop, seeded reproducibility, bootstrap CIs,
 * `LabeledScenarioStore` capture, and the held-out gate. This file owns
 * scenarios + dispatch + judge + mutator. No bespoke generation loop.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CampaignResult,
  defaultProductionGate,
  evolutionaryDriver,
  type JudgeConfig,
  type LabeledScenarioStore,
  type MutableSurface,
  type Mutator,
  type RunImprovementLoopResult,
  runCampaign,
  runImprovementLoop,
  type Scenario,
} from '@tangle-network/agent-eval/campaign'
import { repoRoot, resolveRepo } from '../lib/repo.js'

// ── Scenario: one bot per cell ───────────────────────────────────────────────
export interface TradingBot {
  id: string
  source: 'hyperliquid' | 'binance' | 'coinbase' | 'drift' | 'polymarket' | 'geckoterminal'
  symbol: string
  fee_protocol: string
  venue_label: string
}

export interface BotScenario extends Scenario {
  bot: TradingBot
}

export const DEFAULT_BOTS: TradingBot[] = [
  { id: 'hl-btc',         source: 'hyperliquid',   symbol: 'BTC',      fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'hl-eth',         source: 'hyperliquid',   symbol: 'ETH',      fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'hl-sol',         source: 'hyperliquid',   symbol: 'SOL',      fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'hl-hype',        source: 'hyperliquid',   symbol: 'HYPE',     fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'drift-sol',      source: 'drift',         symbol: 'SOL',      fee_protocol: 'drift',            venue_label: 'drift' },
  { id: 'drift-btc',      source: 'drift',         symbol: 'BTC',      fee_protocol: 'drift',            venue_label: 'drift' },
  { id: 'aerodrome-eth',  source: 'geckoterminal', symbol: 'base:ETH', fee_protocol: 'aerodrome',        venue_label: 'aerodrome' },
]

// ── Artifact: what one (harness, bot) cell produces ──────────────────────────
export interface BacktestArtifact {
  sharpe: number
  sharpe_ci_lo: number | null
  sharpe_ci_hi: number | null
  sortino: number
  calmar: number
  max_drawdown_pct: number
  n_trades: number
  win_rate_pct: number
  total_return_pct: number
  total_fees_usd: number
  total_slippage_usd: number
  total_gas_usd: number
  candles_processed: number
  oos_sharpe_70_30: number
  oos_n_trades: number
  in_sample_sharpe: number
  is_oos_gap: number
}

// ── HarnessConfig TS surface — kept in sync with trading-runtime ─────────────
export interface HarnessConfig {
  version: number
  entry_rules: EntryRule[]
  exit_rules: ExitRule[]
  filters: unknown[]
  position_sizing: PositionSizing
  entry_threshold: number
  max_positions: number
}
export interface EntryRule {
  signal: SignalType
  condition: EntryCondition
  weight: number
  tokens: string[]
}
export type SignalType =
  | { type: 'rsi'; period: number }
  | { type: 'ema_cross'; short_period: number; long_period: number }
  | { type: 'sma_cross'; short_period: number; long_period: number }
  | { type: 'price_momentum'; lookback_candles: number }
  | { type: 'atr_breakout'; period: number; multiplier: number }
export type EntryCondition =
  | { type: 'below'; threshold: number }
  | { type: 'above'; threshold: number }
  | { type: 'cross_above' }
  | { type: 'cross_below' }
  | { type: 'positive' }
  | { type: 'negative' }
export type ExitRule =
  | { type: 'stop_loss'; pct: number }
  | { type: 'take_profit'; pct: number }
  | { type: 'trailing_stop'; activation_pct: number; trail_pct: number }
  | { type: 'time_limit'; max_candles: number }
export type PositionSizing =
  | { method: 'fixed_fraction'; fraction: number }
  | { method: 'fixed_amount_usd'; amount: number }
  | { method: 'kelly_fraction'; fraction: number }

// ── Baseline strategy (the surface every loop starts from) ──────────────────
export const BASELINE_HARNESS: HarnessConfig = {
  version: 1,
  entry_rules: [
    { signal: { type: 'rsi', period: 14 }, condition: { type: 'below', threshold: 30 }, weight: 0.5, tokens: [] },
    { signal: { type: 'ema_cross', short_period: 12, long_period: 26 }, condition: { type: 'cross_above' }, weight: 0.5, tokens: [] },
  ],
  exit_rules: [{ type: 'stop_loss', pct: 5 }, { type: 'take_profit', pct: 10 }],
  filters: [],
  position_sizing: { method: 'fixed_fraction', fraction: 0.1 },
  entry_threshold: 0.3,
  max_positions: 5,
}

// ── Dispatch: spawn the Rust CLI per cell ────────────────────────────────────
const HARNESS_BACKTEST_BIN = 'trading-runtime/target/release/examples/harness_backtest'
const DEFAULT_CANDLES_LIMIT = 4320

function ensureHarnessBinary(): string {
  const absBinary = resolveRepo(HARNESS_BACKTEST_BIN)
  if (existsSync(absBinary)) return absBinary
  const proc = spawnSync(
    'cargo',
    ['build', '-p', 'trading-runtime', '--example', 'harness_backtest', '--release'],
    { cwd: repoRoot, stdio: 'inherit' },
  )
  if (proc.status !== 0) {
    throw new Error(`harness_backtest build failed (status ${proc.status})`)
  }
  return absBinary
}

export function dispatchHarnessBacktest(
  harness: HarnessConfig,
  bot: TradingBot,
  options: { candlesLimit?: number; cacheDir: string },
): BacktestArtifact {
  const absBinary = ensureHarnessBinary()
  const request = {
    harness,
    source: bot.source,
    symbol: bot.symbol,
    fee_protocol: bot.fee_protocol,
    candles_limit: options.candlesLimit ?? DEFAULT_CANDLES_LIMIT,
    candles_cache_dir: options.cacheDir,
  }
  const proc = spawnSync(absBinary, [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const lastLine = (proc.stdout ?? '').trim().split('\n').pop() ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch (e) {
    throw new Error(
      `harness_backtest output parse failed for ${bot.id}: ${(e as Error).message}; stderr=${proc.stderr}`,
    )
  }
  if (typeof parsed === 'object' && parsed && 'error' in parsed) {
    throw new Error(`harness_backtest error for ${bot.id}: ${(parsed as { error: string }).error}`)
  }
  return parsed as BacktestArtifact
}

// ── Judge: composite fitness from a single cell's artifact ───────────────────
export function compositeScore(artifact: BacktestArtifact): {
  composite: number
  dimensions: Record<string, number>
  notes: string
} {
  if (artifact.n_trades < 5) {
    return {
      composite: -10,
      dimensions: { n_trades: artifact.n_trades },
      notes: `insufficient_trades(${artifact.n_trades}<5)`,
    }
  }
  const ciLow = Number.isFinite(artifact.sharpe_ci_lo) ? (artifact.sharpe_ci_lo ?? artifact.sharpe) : artifact.sharpe
  const overfitPenalty = Math.max(0, artifact.is_oos_gap)
  const tradeBonus = Math.min(artifact.n_trades, 30) / 30
  const composite =
    1.0 * ciLow +
    0.5 * artifact.oos_sharpe_70_30 -
    0.1 * artifact.max_drawdown_pct -
    0.4 * overfitPenalty +
    0.05 * tradeBonus
  return {
    composite,
    dimensions: {
      sharpe: artifact.sharpe,
      sharpe_ci_lo: ciLow,
      oos_sharpe: artifact.oos_sharpe_70_30,
      max_drawdown_pct: artifact.max_drawdown_pct,
      is_oos_gap: artifact.is_oos_gap,
      n_trades: artifact.n_trades,
      win_rate_pct: artifact.win_rate_pct,
      total_return_pct: artifact.total_return_pct,
    },
    notes: `sharpe=${artifact.sharpe.toFixed(2)} oos=${artifact.oos_sharpe_70_30.toFixed(2)} dd=${artifact.max_drawdown_pct.toFixed(1)}% trades=${artifact.n_trades}`,
  }
}

// ── Mutator: 12 mutation kinds over HarnessConfig ────────────────────────────
const MUTATION_KINDS = [
  'rsi_period', 'rsi_threshold', 'ema_periods', 'stop_loss', 'take_profit',
  'entry_threshold', 'rule_weight', 'position_size', 'add_rule', 'drop_rule',
  'flip_condition', 'max_positions',
] as const

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function jitter(rng: () => number, range: number): number {
  return (rng() * 2 - 1) * range
}

function makeRng(seed: number): () => number {
  // Tiny mulberry32 — deterministic given seed.
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function mutateHarness(parent: HarnessConfig, seed: number): HarnessConfig {
  const child: HarnessConfig = JSON.parse(JSON.stringify(parent))
  child.version = (parent.version ?? 1) + 1
  const rng = makeRng(seed)
  const kind = MUTATION_KINDS[Math.floor(rng() * MUTATION_KINDS.length)]

  switch (kind) {
    case 'rsi_period': {
      for (const rule of child.entry_rules) {
        if (rule.signal.type === 'rsi') {
          rule.signal.period = clamp(rule.signal.period + Math.round(jitter(rng, 4)), 5, 50)
          break
        }
      }
      break
    }
    case 'rsi_threshold': {
      for (const rule of child.entry_rules) {
        if (rule.signal.type === 'rsi') {
          if (rule.condition.type === 'below') rule.condition.threshold = clamp(rule.condition.threshold + jitter(rng, 8), 5, 45)
          else if (rule.condition.type === 'above') rule.condition.threshold = clamp(rule.condition.threshold + jitter(rng, 8), 55, 95)
          break
        }
      }
      break
    }
    case 'ema_periods': {
      for (const rule of child.entry_rules) {
        if (rule.signal.type === 'ema_cross') {
          const ns = clamp(rule.signal.short_period + Math.round(jitter(rng, 3)), 3, 50)
          const nl = clamp(rule.signal.long_period + Math.round(jitter(rng, 5)), 10, 200)
          if (ns < nl) { rule.signal.short_period = ns; rule.signal.long_period = nl }
          break
        }
      }
      break
    }
    case 'stop_loss': {
      for (const exit of child.exit_rules) {
        if (exit.type === 'stop_loss') { exit.pct = clamp(exit.pct + jitter(rng, 2), 1, 15); break }
      }
      break
    }
    case 'take_profit': {
      for (const exit of child.exit_rules) {
        if (exit.type === 'take_profit') { exit.pct = clamp(exit.pct + jitter(rng, 4), 2, 30); break }
      }
      break
    }
    case 'entry_threshold': {
      child.entry_threshold = clamp(child.entry_threshold + jitter(rng, 0.2), 0.05, 0.95)
      break
    }
    case 'rule_weight': {
      if (child.entry_rules.length > 0) {
        const idx = Math.floor(rng() * child.entry_rules.length)
        const rule = child.entry_rules[idx]
        if (rule) rule.weight = clamp(rule.weight + jitter(rng, 0.3), 0.05, 1.0)
      }
      break
    }
    case 'position_size': {
      if (child.position_sizing.method === 'fixed_fraction') {
        child.position_sizing.fraction = clamp(child.position_sizing.fraction + jitter(rng, 0.04), 0.02, 0.4)
      }
      break
    }
    case 'add_rule': {
      if (child.entry_rules.length < 5) {
        const newRule: EntryRule = {
          signal: { type: 'rsi', period: 14 },
          condition: { type: 'below', threshold: 20 + Math.floor(rng() * 20) },
          weight: 0.2 + rng() * 0.6,
          tokens: [],
        }
        child.entry_rules.push(newRule)
      }
      break
    }
    case 'drop_rule': {
      if (child.entry_rules.length > 1) {
        const idx = Math.floor(rng() * child.entry_rules.length)
        child.entry_rules.splice(idx, 1)
      }
      break
    }
    case 'flip_condition': {
      for (const rule of child.entry_rules) {
        if (rule.condition.type === 'cross_above') { rule.condition = { type: 'cross_below' }; break }
        if (rule.condition.type === 'cross_below') { rule.condition = { type: 'cross_above' }; break }
        if (rule.condition.type === 'below') { rule.condition = { type: 'above', threshold: 100 - rule.condition.threshold }; break }
        if (rule.condition.type === 'above') { rule.condition = { type: 'below', threshold: 100 - rule.condition.threshold }; break }
      }
      break
    }
    case 'max_positions': {
      child.max_positions = clamp(child.max_positions + Math.round(jitter(rng, 2)), 1, 10)
      break
    }
  }

  // Invariants — match the Rust HarnessConfig::validate gate.
  if (child.entry_rules.length === 0) child.entry_rules.push(BASELINE_HARNESS.entry_rules[0]!)
  if (child.exit_rules.length === 0) child.exit_rules.push({ type: 'stop_loss', pct: 5 })
  return child
}

// ── Glue: build the campaign matrix (scenarios + dispatchWithSurface + judge)
function buildMatrix(opts: HarnessEvalOptions): {
  scenarios: BotScenario[]
  dispatchWithSurface: (surface: string, scenario: BotScenario) => Promise<BacktestArtifact>
  judge: JudgeConfig<BacktestArtifact, BotScenario>
} {
  const bots = (opts.bots ?? DEFAULT_BOTS).filter((b) => !opts.botIds || opts.botIds.includes(b.id))
  const cacheDir = opts.cacheDir ?? mkdtempSync(join(tmpdir(), 'harness-candles-'))
  mkdirSync(cacheDir, { recursive: true })
  const candlesLimit = opts.candlesLimit ?? DEFAULT_CANDLES_LIMIT

  const scenarios: BotScenario[] = bots.map((bot) => ({
    id: bot.id,
    kind: 'trading-bot',
    tags: [bot.venue_label, bot.symbol],
    bot,
  }))

  const dispatchWithSurface = async (
    surface: string,
    scenario: BotScenario,
  ): Promise<BacktestArtifact> => {
    const harness: HarnessConfig = surface.trim().length > 0
      ? (JSON.parse(surface) as HarnessConfig)
      : BASELINE_HARNESS
    return dispatchHarnessBacktest(harness, scenario.bot, { candlesLimit, cacheDir })
  }

  const judge: JudgeConfig<BacktestArtifact, BotScenario> = {
    name: 'harness-composite',
    dimensions: [
      { key: 'sharpe', description: 'main Sharpe ratio (trade-scale)' },
      { key: 'sharpe_ci_lo', description: 'bootstrap 95% CI lower bound on Sharpe' },
      { key: 'oos_sharpe', description: 'out-of-sample Sharpe on the 30% holdout window' },
      { key: 'max_drawdown_pct', description: 'maximum realised drawdown %' },
      { key: 'is_oos_gap', description: 'IS Sharpe minus OOS Sharpe — overfit signal' },
      { key: 'n_trades', description: 'number of trades closed' },
      { key: 'win_rate_pct', description: 'percentage of winning trades' },
      { key: 'total_return_pct', description: 'realised total return %' },
    ],
    async score({ artifact }) {
      return compositeScore(artifact)
    },
  }

  return { scenarios, dispatchWithSurface, judge }
}

// ── Public surface ───────────────────────────────────────────────────────────
export interface HarnessEvalOptions {
  bots?: TradingBot[]
  botIds?: string[]
  candlesLimit?: number
  cacheDir?: string
  reps?: number
  seed?: number
  runDir?: string
  labeledStore?: LabeledScenarioStore
}

/** Goal-1 MEASURE: run the bot matrix for the current (baseline) HarnessConfig. */
export async function runHarnessEval(
  opts: HarnessEvalOptions & { surface?: string } = {},
): Promise<CampaignResult<BacktestArtifact, BotScenario>> {
  const { scenarios, dispatchWithSurface, judge } = buildMatrix(opts)
  const surface = opts.surface ?? JSON.stringify(BASELINE_HARNESS)
  return runCampaign<BotScenario, BacktestArtifact>({
    scenarios,
    dispatch: (scenario) => dispatchWithSurface(surface, scenario),
    judges: [judge],
    runDir: opts.runDir ?? resolveRepo(`.evolve/eval-runs/harness-eval-${Date.now()}`),
    reps: opts.reps ?? 1,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.labeledStore ? { labeledStore: opts.labeledStore } : {}),
    captureSource: 'eval-run',
  })
}

export interface HarnessSelfImprovementOptions extends HarnessEvalOptions {
  baselineHarness?: HarnessConfig
  /** Bot ids reserved for the gate (held OUT of training). */
  holdoutBotIds: string[]
  populationSize?: number
  maxGenerations?: number
  promoteTopK?: number
  deltaThreshold?: number
}

/**
 * Goal-1 IMPROVE: optimize the HarnessConfig over TRAIN bots, gate the
 * winner on the HELD-OUT bot split. Returns the winner + verdict; caller
 * promotes (writes the new HarnessConfig + optionally opens a PR — see
 * `proposeAutomatedPullRequest` from agent-eval/auto-pr).
 */
export async function runHarnessSelfImprovement(
  opts: HarnessSelfImprovementOptions,
): Promise<RunImprovementLoopResult<BacktestArtifact, BotScenario>> {
  const holdoutSet = new Set(opts.holdoutBotIds)
  const filteredBotIds = opts.botIds?.filter((id) => !holdoutSet.has(id))
  const trainWiring = buildMatrix({
    ...opts,
    ...(filteredBotIds !== undefined ? { botIds: filteredBotIds } : {}),
  })
  const train = trainWiring.scenarios.filter((s) => !holdoutSet.has(s.id))
  const holdout = trainWiring.scenarios.filter((s) => holdoutSet.has(s.id))
  if (train.length === 0 || holdout.length === 0) {
    throw new Error(
      `runHarnessSelfImprovement: need non-empty train (${train.length}) AND holdout (${holdout.length}) bot splits`,
    )
  }

  const baseline = opts.baselineHarness ?? BASELINE_HARNESS

  const mutator: Mutator = {
    kind: 'harness-config',
    async mutate({ currentSurface, populationSize }) {
      const parent: HarnessConfig =
        typeof currentSurface === 'string' && currentSurface.trim().length > 0
          ? (JSON.parse(currentSurface) as HarnessConfig)
          : baseline
      return Array.from({ length: populationSize }, (_, i) => {
        const seed = (Date.now() ^ (i * 0x9e3779b1)) >>> 0
        const mutant = mutateHarness(parent, seed)
        return JSON.stringify(mutant)
      })
    },
  }

  return runImprovementLoop<BotScenario, BacktestArtifact>({
    scenarios: train,
    holdoutScenarios: holdout,
    judges: [trainWiring.judge],
    baselineSurface: JSON.stringify(baseline),
    dispatchWithSurface: (surface: MutableSurface, scenario) => {
      if (typeof surface !== 'string') throw new Error('harness self-improvement: surface must be a JSON string')
      return trainWiring.dispatchWithSurface(surface, scenario)
    },
    driver: evolutionaryDriver({ mutator }),
    populationSize: opts.populationSize ?? 8,
    maxGenerations: opts.maxGenerations ?? 4,
    promoteTopK: opts.promoteTopK ?? 3,
    reps: opts.reps ?? 1,
    gate: defaultProductionGate<BacktestArtifact, BotScenario>({
      holdoutScenarios: holdout,
      deltaThreshold: opts.deltaThreshold ?? 0.05,
    }),
    autoOnPromote: 'none',
    runDir: opts.runDir ?? resolveRepo(`.evolve/eval-runs/harness-self-improve-${Date.now()}`),
    ...(opts.labeledStore ? { labeledStore: opts.labeledStore } : {}),
    captureSource: 'eval-run',
  })
}
