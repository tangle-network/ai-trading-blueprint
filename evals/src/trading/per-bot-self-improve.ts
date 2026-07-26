/**
 * Per-bot runtime self-improvement loop for one running bot, venue, and symbol.
 * Two history lengths drive search and a shorter final horizon checks the winner.
 *
 * Architecture:
 *
 *   ─ NO PRs are opened in the product path. The terminal action on a
 *     promoted surface is a LOCAL write to this bot's running state
 *     (HarnessConfig → /strategy/config endpoint, prompt addendum →
 *     /home/agent/config/, knowledge → /home/agent/.agent-knowledge/).
 *
 *   ─ Worktrees are EPHEMERAL and LOCAL. `selfImprove` keeps each
 *     candidate as a `MutableSurface`
 *     value (the HarnessConfig JSON) — no git worktree on disk for the
 *     evolutionary path. When `agenticGenerator` is wired (future:
 *     code-level changes), worktrees materialise under
 *     `.evolve/candidates/<id>/` and are deleted at finalize/discard.
 *
 *   ─ Same primitives as `harness-self-improve.ts` (developer-side):
 *     `evolutionaryDriver({mutator: harnessMutator()})`, the shared
 *     `harnessJudge`, the shared `dispatchHarnessBacktest` Rust CLI.
 *     The ONLY difference is the scenario set + the promotion action.
 *
 * Called by the in-sandbox `self_improvement_loop.ts` tool over HTTP
 * once the trading-http-api proxies this entry point. Until then, it's
 * directly invokable from the test runner.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultProductionGate,
  type LabeledScenarioStore,
  type MutableSurface,
  type Scenario,
} from '@tangle-network/agent-eval/campaign'
import {
  selfImprove,
  type SelfImproveResult,
} from '@tangle-network/agent-eval/contract'
import { resolveRepo } from '../lib/repo.js'
import { dispatchHarnessBacktest, ensureHarnessBacktestBinary } from './harness-dispatch.js'
import { harnessJudge } from './harness-fitness.js'
import { harnessOptimizationMethod } from './harness-mutator.js'
import {
  BASELINE_HARNESS,
  type BacktestArtifact,
  type BotContext,
  type HarnessConfig,
} from './harness-types.js'

/** A time-window scenario over a single bot's candle stream. */
export interface BotWindowScenario extends Scenario {
  bot: BotContext
  /** Hourly bars to fetch from the venue, ending at the window's `endsAt`. */
  candlesLimit: number
  /** `train`: older history, used by the optimizer.
   *  `holdout`: most-recent window the gate evaluates. */
  window: 'train' | 'holdout'
}

export interface PerBotImprovementOptions {
  bot: BotContext
  /** Bars in the TRAIN window. Default 4320 (180 days hourly). */
  trainCandlesLimit?: number
  /** Bars in the HOLDOUT window. Default 720 (30 days hourly). */
  holdoutCandlesLimit?: number
  /** Current running HarnessConfig — defaults to the canonical baseline.
   *  Loaded by the caller from `data/trading.db` or `/home/agent/config/harness.json`. */
  currentHarness?: HarnessConfig
  /** Final promote step: caller writes the winning surface into the bot's
   *  running state (e.g. POST /strategy/config). Called only when the
   *  substrate's gate accepts the winner. */
  promoteToLocalState?: (winningHarness: HarnessConfig) => Promise<void>
  maxEvaluations?: number
  deltaThreshold?: number
  reps?: number
  seed?: number
  cacheDir?: string
  runDir?: string
  labeledStore?: LabeledScenarioStore
}

export interface PerBotImprovementResult {
  bot: BotContext
  improvement: SelfImproveResult<BotWindowScenario, BacktestArtifact>
  promoted: boolean
  winningHarness: HarnessConfig | null
}

/**
 * Run the self-improvement loop for a single bot in its production
 * runtime context. On a passing gate verdict, the optional
 * `promoteToLocalState` callback fires with the winning HarnessConfig.
 * The substrate's `autoOnPromote: 'none'` ensures no PR is ever opened
 * from this path.
 */
export async function runPerBotSelfImprovement(
  opts: PerBotImprovementOptions,
): Promise<PerBotImprovementResult> {
  ensureHarnessBacktestBinary()
  const trainLimit = opts.trainCandlesLimit ?? 4320
  const holdoutLimit = opts.holdoutCandlesLimit ?? 720
  const cacheDir = opts.cacheDir ?? mkdtempSync(join(tmpdir(), `per-bot-${opts.bot.id}-`))
  mkdirSync(cacheDir, { recursive: true })
  const baseline = opts.currentHarness ?? BASELINE_HARNESS

  const searchScenarios: BotWindowScenario[] = [
    {
      id: `${opts.bot.id}-train-long`,
      kind: 'per-bot-train-window',
      tags: [opts.bot.venue_label, opts.bot.symbol, 'train-long'],
      bot: opts.bot,
      candlesLimit: trainLimit,
      window: 'train',
    },
    {
      id: `${opts.bot.id}-train-medium`,
      kind: 'per-bot-train-window',
      tags: [opts.bot.venue_label, opts.bot.symbol, 'train-medium'],
      bot: opts.bot,
      candlesLimit: Math.max(holdoutLimit + 1, Math.floor(trainLimit * 0.67)),
      window: 'train',
    },
  ]
  const holdoutScenario: BotWindowScenario = {
    id: `${opts.bot.id}-final`,
    kind: 'per-bot-holdout-window',
    tags: [opts.bot.venue_label, opts.bot.symbol, 'final'],
    bot: opts.bot,
    candlesLimit: holdoutLimit,
    window: 'holdout',
  }

  const dispatchWithSurface = async (
    surface: string,
    scenario: BotWindowScenario,
  ): Promise<BacktestArtifact> => {
    const harness: HarnessConfig =
      surface.trim().length > 0 ? (JSON.parse(surface) as HarnessConfig) : baseline
    return dispatchHarnessBacktest(harness, scenario.bot, {
      candlesLimit: scenario.candlesLimit,
      cacheDir,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    })
  }

  const improvement = await selfImprove<BotWindowScenario, BacktestArtifact>({
    scenarios: [...searchScenarios, holdoutScenario],
    budget: {
      reps: opts.reps ?? 1,
      holdoutScenarios: [holdoutScenario],
    },
    judge: harnessJudge<BotWindowScenario>(),
    baselineSurface: JSON.stringify(baseline),
    agent: (surface: MutableSurface, scenario) => {
      if (typeof surface !== 'string') {
        throw new Error('per-bot self-improvement: surface must be a JSON string')
      }
      return dispatchWithSurface(surface, scenario)
    },
    method: harnessOptimizationMethod<BotWindowScenario>({
      maxEvaluations: opts.maxEvaluations ?? 96,
      ...(opts.seed === undefined ? {} : { seedSalt: opts.seed }),
    }),
    gate: defaultProductionGate<BacktestArtifact, BotWindowScenario>({
      holdoutScenarios: [holdoutScenario],
      deltaThreshold: opts.deltaThreshold ?? 0.05,
    }),
    runDir: opts.runDir ?? resolveRepo(`.evolve/eval-runs/per-bot-${opts.bot.id}-${Date.now()}`),
    ...(opts.labeledStore ? { labeledStore: opts.labeledStore } : {}),
    captureSource: 'eval-run',
  })

  const promoted = improvement.gateDecision === 'ship'
  const winningHarness =
    promoted && typeof improvement.winner.surface === 'string'
      ? (JSON.parse(improvement.winner.surface) as HarnessConfig)
      : null

  if (promoted && winningHarness && opts.promoteToLocalState) {
    await opts.promoteToLocalState(winningHarness)
  }

  return { bot: opts.bot, improvement, promoted, winningHarness }
}

/**
 * Convenience writeback that pins the winning HarnessConfig to a local
 * JSON file (matching the path the in-sandbox `self_improvement_loop.ts`
 * already reads: `${AGENT_WORKSPACE}/config/harness.json`). For HTTP-based
 * writebacks (POST /strategy/config) the caller passes its own callback.
 */
export function writeHarnessToLocalFile(path: string): (h: HarnessConfig) => Promise<void> {
  return async (harness) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(harness, null, 2)}\n`, 'utf8')
  }
}
