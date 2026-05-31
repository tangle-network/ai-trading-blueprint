/**
 * Developer-side HarnessConfig self-improvement loop. Runs the
 * `agent-eval` substrate's `runImprovementLoop` + `evolutionaryDriver`
 * across the canonical multi-bot fleet — TRAIN bots drive the search,
 * HOLDOUT bots gate the winner.
 *
 *   - Surface mutator → `harnessMutator()` (shared with the per-bot loop)
 *   - Cell dispatch  → `dispatchHarnessBacktest()` (Rust CLI; single
 *     source of truth for fitness numbers — same engine the live
 *     backtest endpoint uses)
 *   - Judge          → `harnessJudge()` (production promotion gate)
 *
 * The per-bot runtime counterpart lives in `per-bot-self-improve.ts`
 * and reuses the same three primitives — only the scenario set + the
 * promotion-action differ (no PR, write to local state).
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CampaignResult,
  defaultProductionGate,
  evolutionaryDriver,
  type LabeledScenarioStore,
  type MutableSurface,
  type RunImprovementLoopResult,
  runCampaign,
  runImprovementLoop,
  type Scenario,
} from '@tangle-network/agent-eval/campaign'
import { resolveRepo } from '../lib/repo.js'
import { dispatchHarnessBacktest, ensureHarnessBacktestBinary } from './harness-dispatch.js'
import { harnessJudge } from './harness-fitness.js'
import { harnessMutator } from './harness-mutator.js'
import {
  BASELINE_HARNESS,
  type BacktestArtifact,
  type BotContext,
  type HarnessConfig,
} from './harness-types.js'

export interface BotScenario extends Scenario {
  bot: BotContext
}

export const DEFAULT_BOTS: BotContext[] = [
  { id: 'hl-btc',          source: 'hyperliquid',   symbol: 'BTC',       fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'hl-eth',          source: 'hyperliquid',   symbol: 'ETH',       fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'hl-sol',          source: 'hyperliquid',   symbol: 'SOL',       fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'hl-hype',         source: 'hyperliquid',   symbol: 'HYPE',      fee_protocol: 'hyperliquid_perp', venue_label: 'hyperliquid' },
  { id: 'drift-sol',       source: 'drift',         symbol: 'SOL',       fee_protocol: 'drift',            venue_label: 'drift' },
  { id: 'drift-btc',       source: 'drift',         symbol: 'BTC',       fee_protocol: 'drift',            venue_label: 'drift' },
  { id: 'aerodrome-eth',   source: 'geckoterminal', symbol: 'base:ETH',  fee_protocol: 'aerodrome',        venue_label: 'aerodrome' },
]

const DEFAULT_CANDLES_LIMIT = 4320

interface MatrixWiring {
  scenarios: BotScenario[]
  dispatchWithSurface: (surface: string, scenario: BotScenario) => Promise<BacktestArtifact>
}

function buildMatrix(opts: HarnessEvalOptions): MatrixWiring {
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
    const harness: HarnessConfig =
      surface.trim().length > 0 ? (JSON.parse(surface) as HarnessConfig) : BASELINE_HARNESS
    return dispatchHarnessBacktest(harness, scenario.bot, { candlesLimit, cacheDir })
  }

  return { scenarios, dispatchWithSurface }
}

export interface HarnessEvalOptions {
  bots?: BotContext[]
  botIds?: string[]
  candlesLimit?: number
  cacheDir?: string
  reps?: number
  seed?: number
  runDir?: string
  labeledStore?: LabeledScenarioStore
}

/** MEASURE: run the bot matrix for the current baseline HarnessConfig. */
export async function runHarnessEval(
  opts: HarnessEvalOptions & { surface?: string } = {},
): Promise<CampaignResult<BacktestArtifact, BotScenario>> {
  ensureHarnessBacktestBinary()
  const { scenarios, dispatchWithSurface } = buildMatrix(opts)
  const surface = opts.surface ?? JSON.stringify(BASELINE_HARNESS)
  return runCampaign<BotScenario, BacktestArtifact>({
    scenarios,
    dispatch: (scenario) => dispatchWithSurface(surface, scenario),
    judges: [harnessJudge<BotScenario>()],
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
 * IMPROVE: optimize the HarnessConfig over TRAIN bots, gate the winner
 * on the HELD-OUT bot split. Returns the substrate's verdict + winner.
 * Promotion belongs to the caller (the developer eval bin writes the
 * winner to a tracked file + optionally opens a PR; the per-bot loop
 * writes to local state).
 */
export async function runHarnessSelfImprovement(
  opts: HarnessSelfImprovementOptions,
): Promise<RunImprovementLoopResult<BacktestArtifact, BotScenario>> {
  ensureHarnessBacktestBinary()
  const holdoutSet = new Set(opts.holdoutBotIds)
  const filteredBotIds = opts.botIds?.filter((id) => !holdoutSet.has(id))
  const wiring = buildMatrix({
    ...opts,
    ...(filteredBotIds !== undefined ? { botIds: filteredBotIds } : {}),
  })
  const train = wiring.scenarios.filter((s) => !holdoutSet.has(s.id))
  const holdout = wiring.scenarios.filter((s) => holdoutSet.has(s.id))
  if (train.length === 0 || holdout.length === 0) {
    throw new Error(
      `runHarnessSelfImprovement: need non-empty train (${train.length}) AND holdout (${holdout.length}) bot splits`,
    )
  }

  const baseline = opts.baselineHarness ?? BASELINE_HARNESS

  return runImprovementLoop<BotScenario, BacktestArtifact>({
    scenarios: train,
    holdoutScenarios: holdout,
    judges: [harnessJudge<BotScenario>()],
    baselineSurface: JSON.stringify(baseline),
    dispatchWithSurface: (surface: MutableSurface, scenario) => {
      if (typeof surface !== 'string') {
        throw new Error('harness self-improvement: surface must be a JSON string')
      }
      return wiring.dispatchWithSurface(surface, scenario)
    },
    driver: evolutionaryDriver({ mutator: harnessMutator({ baseline }) }),
    populationSize: opts.populationSize ?? 16,
    maxGenerations: opts.maxGenerations ?? 6,
    promoteTopK: opts.promoteTopK ?? 5,
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
