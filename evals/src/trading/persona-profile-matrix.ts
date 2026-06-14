/**
 * Trading persona/profile MATRIX — the PROFILE axis on top of the existing
 * single-profile persona bridge (`persona-agent-eval.ts`).
 *
 * The single bridge runs ONE profile (the deterministic backtest runtime) over
 * persona × scenario and records a scorecard. This module adds the third axis —
 * PROFILE — and sweeps it with `@tangle-network/agent-eval`'s `runProfileMatrix`
 * + a `ProfileDispatchFn`, answering "which model trades the personas best?".
 *
 * ── Honest accounting of what the profile axis can and cannot be ──
 *
 * The Rust persona suite (`runPersonaSuite` → `walk_forward_backtest`) is a
 * DETERMINISTIC backtest. It takes NO model parameter and makes NO LLM call, so
 * a profile's `model` cannot change its numbers and a pure-backtest matrix would
 * report ZERO tokens on every cell — which `runProfileMatrix`'s
 * `assertRealBackend` guard correctly reads as a STUB and fails on.
 *
 * So the matrix here is genuinely two-layer, and both layers are real:
 *
 *   1. GROUND TRUTH (model-invariant): the deterministic walk-forward backtest +
 *      the 6 persona gates. Run ONCE per scenario, shared across every profile.
 *      This is the objective, ungameable substrate — the same `PersonaEvalResult`
 *      the single bridge scores.
 *   2. PROFILE-VARYING (the axis under test): for each (profile, scenario) cell,
 *      the profile's MODEL is actually invoked to produce the trading agent's
 *      decision rationale for that persona under that regime, GIVEN the backtest
 *      evidence. This is real LLM work — real, differing tokens per model — so
 *      the integrity guard sees a real backend and the per-profile aggregation
 *      compares models that genuinely behaved differently.
 *
 * The artifact each cell returns carries BOTH layers; the judge scores the
 * deterministic gates (objective) and rewards a rationale that is consistent
 * with the persona's mandate (the model-varying signal). A profile whose model
 * can't be driven surfaces as a FAILED cell (a thrown judge / empty completion),
 * never a fabricated score.
 *
 * `loopDispatch` (agent-runtime) is the dispatch path for agents that run inside
 * a sandbox `runLoop` (it auto-reports token usage). The trading agent is
 * HTTP-operator / deterministic-runtime driven, not sandbox-runLoop driven, so
 * this module uses a CUSTOM `ProfileDispatchFn` that drives the profile's model
 * directly and reports usage via `ctx.cost.observeTokens`. If/when the persona
 * eval is wired through a sandbox `runLoop`, swap this dispatch for `loopDispatch`.
 *
 * Backward compat: the single-profile bridge (`runTradingPersonaAgentEvalBridge`)
 * is untouched. This matrix path is opt-in via `runTradingProfileMatrix` (or the
 * `TRADING_PERSONA_MATRIX=1` env on the shared bin).
 */

import { mkdirSync } from 'node:fs'

import {
  agentProfileHash,
  assertRealBackend,
  recordRunsToScorecard,
  summarizeBackendIntegrity,
  type AgentProfile,
  type BackendIntegrityReport,
  type RunRecord,
} from '@tangle-network/agent-eval'
import {
  runProfileMatrix,
  type JudgeConfig,
  type JudgeScore,
  type Scenario,
} from '@tangle-network/agent-eval/campaign'

import { isoStamp, resolveRepo } from '../lib/repo.js'
import { llmCallWithUsage, resolveModel, type LlmModel } from '../sim/llm-call.js'
import { currentCommitSha } from './persona-runner.js'
import type { PersonaEvalResult } from './persona-types.js'
import { evaluateScenario } from './personas/walk-forward.js'
import { defaultScenarios, type TradingEvalScenario } from './personas/scenarios.js'
import { buildTradingScorecardAgentProfile } from './scorecard-integration.js'

const SURFACE_VERSION = 1
const RUNTIME_VERSION = '0.1.0'
const FEE_SCHEDULE_VERSION = 'protocol-fees@2026-05'
const VENUES = ['hyperliquid', 'binance', 'coinbase', 'drift', 'aerodrome', 'polymarket']

/** The PROFILE axis: the LLM model variants the eval substrate routes to
 *  (single source of truth = `MODEL_CONFIG` in sim/llm-call.ts). Each profile
 *  pins one model so the matrix answers "which model trades the personas best".
 *  ids/models are stable so scorecard hashing + per-axis aggregation are
 *  reproducible across commits. */
export const TRADING_PROFILE_MODELS: readonly LlmModel[] = ['kimi-k2', 'glm-4.7', 'glm-5.1']

/** Build the profile axis. Each profile carries the trading surface identity
 *  (so two commits with the same surface key into the same cell) plus the
 *  model under test in both `model` and `metadata.model` (behaviour-bearing →
 *  hashed). */
export function buildTradingModelProfiles(
  models: readonly LlmModel[] = TRADING_PROFILE_MODELS,
): AgentProfile[] {
  return models.map((model) => {
    const base = buildTradingScorecardAgentProfile({
      surfaceVersion: SURFACE_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      venues: VENUES,
      feeScheduleVersion: FEE_SCHEDULE_VERSION,
      model,
    })
    return {
      ...base,
      // The model is THE axis — fold it into the id so each column is a
      // distinct, stable profile (and thus a distinct scorecard cell / hash).
      id: `${base.id}::model=${model}`,
      model,
      metadata: { ...base.metadata, model, modelClass: 'llm-trading-operator' },
    }
  })
}

/** One persona/scenario in the matrix. Carries the full Rust eval scenario so
 *  the dispatch can both render the persona prompt and read the deterministic
 *  ground truth. `personaOf` keys on `persona_id` for the `byPersona` pivot. */
export interface PersonaScenario extends Scenario {
  kind: 'trading-persona'
  scenario: TradingEvalScenario
}

export function buildPersonaScenarios(
  scenarios: TradingEvalScenario[] = defaultScenarios(),
): PersonaScenario[] {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    kind: 'trading-persona',
    tags: [scenario.persona.id, scenario.split, scenario.market_regime],
    scenario,
  }))
}

/** The artifact a cell produces: the model-invariant deterministic result PLUS
 *  the profile-model's rationale (the axis-varying signal) and its provenance. */
export interface PersonaMatrixArtifact {
  result: PersonaEvalResult
  /** The profile model's decision rationale for this persona/scenario. */
  rationale: string
  /** Which model produced the rationale (profile axis provenance). */
  model: string
  /** True when the model actually responded (used by the judge to fail a cell
   *  whose profile could not be driven instead of fabricating a score). */
  modelResponded: boolean
}

/**
 * Run the deterministic ground truth ONCE per scenario and cache it, keyed by
 * scenario id. Model-invariant by construction — every profile reads the same
 * objective numbers, so the only thing that varies across the profile axis is
 * the model's rationale, which is exactly the axis we want to measure.
 */
function buildGroundTruthCache(scenarios: PersonaScenario[]): Map<string, PersonaEvalResult> {
  const cache = new Map<string, PersonaEvalResult>()
  for (const s of scenarios) {
    cache.set(s.id, evaluateScenario(s.scenario))
  }
  return cache
}

function personaPrompt(scenario: TradingEvalScenario, result: PersonaEvalResult): string {
  const m = scenario.persona
  return [
    `You are the autonomous trading operator acting as: ${m.role} (${m.id}).`,
    `Mandate: venues=${m.venues.join(',')} chains=${m.chains.join(',')}; `,
    `max position ${m.max_position_pct}% of capital, max drawdown ${m.max_drawdown_pct}%, `,
    `trade count within [${m.min_trades}..${m.max_trades}], execution=${m.execution_mode}.`,
    '',
    `Market regime: ${scenario.market_regime}.`,
    `Objective: ${scenario.objective}`,
    '',
    'A deterministic walk-forward backtest of your candidate strategy against the',
    'current production strategy produced this out-of-sample (test split) evidence:',
    `  candidate test return: ${result.test_candidate_return_pct.toFixed(2)}%`,
    `  candidate test sharpe: ${result.test_candidate_sharpe.toFixed(2)}`,
    `  candidate test drawdown: ${result.test_candidate_drawdown_pct.toFixed(2)}%`,
    `  test trade count: ${result.test_trade_count}`,
    `  sharpe decay (train→test): ${result.sharpe_ratio_decay.toFixed(2)}`,
    `  deterministic promotion gates: ${result.deterministic_gates.join(' | ')}`,
    '',
    'In 3-5 sentences, give your trading decision for this persona under this',
    'regime: promote/hold/reject the candidate, why, and how you stay within the',
    'mandate (position size, drawdown, trade count). Be specific to the evidence.',
  ].join('\n')
}

/** Map a profile to the logical LLM model. The profile id encodes the model;
 *  `metadata.model` is the canonical source. Throws on an unknown model so a
 *  misconfigured profile fails loud rather than silently scoring a stub. */
function modelOfProfile(profile: AgentProfile): LlmModel {
  const model = (profile.metadata?.model ?? profile.model) as LlmModel
  // Validate routing exists (throws on unknown model / missing api key) so a
  // profile that can't be driven is a hard error at dispatch boundary.
  resolveModel(model)
  return model
}

/**
 * Deterministic persona judge. Composite = the persona suite's own 0-100 score
 * normalized to [0,1] — the OBJECTIVE, ungameable substrate. A cell whose
 * profile model could not be driven is marked `failed` (excluded from means),
 * never folded into a zero. The model-varying rationale is captured in notes for
 * trace inspection; scoring stays on the deterministic gates so the profile axis
 * is compared on real outcomes, not on a second LLM's opinion of prose.
 */
export function personaMatrixJudge(): JudgeConfig<PersonaMatrixArtifact, PersonaScenario> {
  return {
    name: 'trading-persona-deterministic-gates',
    dimensions: [
      { key: 'risk', description: 'position-size + drawdown gates' },
      { key: 'execution', description: 'trade-count + real-backtest gates' },
      { key: 'economics', description: 'candidate beats baseline out-of-sample' },
      { key: 'adaptation', description: 'walk-forward generalization' },
    ],
    score({ artifact }): JudgeScore {
      const { result, modelResponded, rationale } = artifact
      if (!modelResponded) {
        return {
          dimensions: {},
          composite: 0,
          notes: 'profile model produced no rationale — cell failed (not scored as zero)',
          failed: true,
        }
      }
      const b = result.score_breakdown
      return {
        dimensions: {
          risk: (b.risk / 25) || 0,
          execution: (b.execution / 20) || 0,
          economics: (b.economics / 20) || 0,
          adaptation: (b.adaptation / 15) || 0,
        },
        composite: result.score / 100,
        notes: `deterministic score ${result.score}/100; passed=${result.passed}; rationale: ${rationale.slice(0, 280)}`,
      }
    },
  }
}

export interface TradingProfileMatrixOptions {
  /** LLM model variants to sweep. Default: all three from MODEL_CONFIG. */
  models?: readonly LlmModel[]
  /** Override the scenario corpus (default: the 11 persona scenarios). */
  scenarios?: TradingEvalScenario[]
  /** Per-cell replicates for CI bands. Default 1. */
  reps?: number
  /** Where each profile's campaign writes artifacts/traces. */
  runDir?: string
  /** Scorecard JSONL log — folds matrix records into the cross-commit timeline. */
  scorecardPath?: string
  /** Max concurrent cells within each profile campaign. Default 2. */
  maxConcurrency?: number
  /** Cumulative USD cap per profile campaign. */
  costCeiling?: number
  /** Backend-integrity posture. Default 'assert' (fail loud on a stub run).
   *  Set 'warn' for a dry run when LLM keys are absent. */
  integrity?: 'assert' | 'warn' | 'off'
}

/** Per-profile rollup surfaced from the matrix's `byProfile` aggregation. */
export interface ProfileAxisSummary {
  profileId: string
  profileHash: string
  model: string
  records: number
  /** Pass rate = fraction of this profile's records whose deterministic
   *  persona gate passed (composite >= 0.7, the suite's own threshold). */
  passRate: number
  /** Mean composite (0-1) across this profile's records. */
  meanScore: number
  totalCostUsd: number
  /** Per-profile backend-integrity verdict (a single profile can run stub even
   *  when the matrix as a whole looks real). */
  integrityVerdict: BackendIntegrityReport['verdict']
}

export interface TradingProfileMatrixSummary {
  matrixId: string
  experimentId: string
  commitSha: string
  runDir: string
  scorecard: { path: string; appendedCells: number }
  records: number
  /** Per-PROFILE aggregation — the axis the matrix exists to compare. */
  byProfile: ProfileAxisSummary[]
  /** Per-PERSONA aggregation (the `personaOf` pivot). */
  byPersona: Record<string, { meanScore: number; n: number }>
  /** Whole-matrix backend-integrity report. */
  integrity: BackendIntegrityReport
  /** Best profile by pass rate then mean score. */
  best: ProfileAxisSummary | null
}

/**
 * Sweep the PROFILE × PERSONA × scenario matrix.
 *
 * - profiles axis = LLM model variants (each an `AgentProfile`)
 * - scenarios axis = persona scenarios (each carries its persona; `personaOf`
 *   labels the persona pivot)
 * - dispatch = run the deterministic ground truth (cached, model-invariant) +
 *   drive the profile's model for the persona rationale, reporting real tokens
 *
 * Aggregation is read STRAIGHT from the substrate's `byProfile`/`byPersona`/
 * `integrity` return — no hand-rolled re-aggregation. Records are folded into
 * the scorecard timeline so `diffScorecard` can flag a per-profile regression.
 */
export async function runTradingProfileMatrix(
  options: TradingProfileMatrixOptions = {},
): Promise<TradingProfileMatrixSummary> {
  const models = options.models ?? TRADING_PROFILE_MODELS
  const profiles = buildTradingModelProfiles(models)
  const scenarioCorpus = options.scenarios ?? defaultScenarios()
  const scenarios = buildPersonaScenarios(scenarioCorpus)
  const commitSha = currentCommitSha()
  const runDir = resolveRepo(
    options.runDir ?? `.evolve/agent-eval/trading-persona-matrix-${isoStamp()}`,
  )
  const scorecardPath = resolveRepo(
    options.scorecardPath ?? '.evolve/agent-eval/scorecards/trading-persona-matrix.jsonl',
  )
  mkdirSync(runDir, { recursive: true })
  mkdirSync(resolveRepo('.evolve/agent-eval/scorecards'), { recursive: true })

  // Model-invariant ground truth — computed once, shared by every profile.
  const groundTruth = buildGroundTruthCache(scenarios)

  const result = await runProfileMatrix<PersonaScenario, PersonaMatrixArtifact>({
    profiles,
    scenarios,
    judges: [personaMatrixJudge()],
    runDir,
    commitSha,
    experimentId: 'trading-agent-personas-matrix',
    splitTag: 'search',
    ...(options.reps !== undefined ? { reps: options.reps } : {}),
    maxConcurrency: options.maxConcurrency ?? 2,
    ...(options.costCeiling !== undefined ? { costCeiling: options.costCeiling } : {}),
    integrity: options.integrity ?? 'assert',
    personaOf: (s) => s.scenario.persona.id,
    dispatch: async (profile, scenario, ctx) => {
      const result = groundTruth.get(scenario.id)
      if (!result) {
        throw new Error(`no deterministic ground truth for scenario ${scenario.id}`)
      }
      const model = modelOfProfile(profile)
      const call = await llmCallWithUsage({
        prompt: personaPrompt(scenario.scenario, result),
        model,
      })
      // Report real usage so the backend-integrity guard sees a real backend.
      // A dispatch that never reports tokens is indistinguishable from a stub.
      ctx.cost.observeTokens({ input: call.usage.input, output: call.usage.output })
      if (call.usage.costUsd > 0) ctx.cost.observe(call.usage.costUsd, `llm:${model}`)
      return {
        result,
        rationale: call.output,
        model,
        modelResponded: call.ok,
      }
    },
  })

  // `runProfileMatrix` keys `byProfile` and stamps each record by `profile.id`
  // (RunRecord.candidateId), not the profile hash — group accordingly.
  const recordsByProfileId = new Map<string, RunRecord[]>()
  for (const r of result.records) {
    const list = recordsByProfileId.get(r.candidateId) ?? []
    list.push(r)
    recordsByProfileId.set(r.candidateId, list)
  }

  // Fold every matrix record into the cross-commit scorecard timeline, keyed by
  // each profile so a per-model regression is visible run-to-run. One profile's
  // records per append (the scorecard keys on a single profile per call).
  let appendedCells = 0
  for (const profile of profiles) {
    const profileRecords = recordsByProfileId.get(profile.id) ?? []
    if (profileRecords.length === 0) continue
    const lines = recordRunsToScorecard(scorecardPath, profileRecords, { profile, commitSha })
    appendedCells += lines.length
  }

  const byProfile = profiles.map<ProfileAxisSummary>((profile) => {
    const summary = result.byProfile[profile.id]
    const profileRecords = recordsByProfileId.get(profile.id) ?? []
    const passing = profileRecords.filter((r) => searchScoreOf(r) >= 0.7).length
    const integrity = summarizeBackendIntegrity(profileRecords)
    return {
      profileId: profile.id,
      profileHash: summary?.profileHash ?? agentProfileHash(profile),
      model: String(profile.metadata?.model ?? profile.model),
      records: profileRecords.length,
      passRate: profileRecords.length ? passing / profileRecords.length : 0,
      meanScore: summary?.meanComposite ?? meanSearchScore(profileRecords),
      totalCostUsd: summary?.totalCostUsd ?? 0,
      integrityVerdict: integrity.verdict,
    }
  })

  const byPersona: Record<string, { meanScore: number; n: number }> = {}
  for (const [persona, rollup] of Object.entries(result.byPersona ?? {})) {
    byPersona[persona] = { meanScore: rollup.meanComposite, n: rollup.n }
  }

  // Defense in depth: re-run the integrity guard over ALL records. The matrix
  // already asserts internally (integrity:'assert'); this surfaces the report
  // even when posture is 'warn'/'off' and keeps the bridge's fail-loud behavior.
  const integrity =
    (options.integrity ?? 'assert') === 'off'
      ? summarizeBackendIntegrity(result.records)
      : assertRealBackend(result.records, { allowMixed: true })

  const best =
    byProfile.length === 0
      ? null
      : [...byProfile].sort((a, b) => b.passRate - a.passRate || b.meanScore - a.meanScore)[0] ?? null

  return {
    matrixId: result.matrixId,
    experimentId: result.experimentId,
    commitSha,
    runDir,
    scorecard: { path: scorecardPath, appendedCells },
    records: result.records.length,
    byProfile,
    byPersona,
    integrity,
    best,
  }
}

/** The cell composite, regardless of split (search vs holdout outcome shape). */
function searchScoreOf(record: RunRecord): number {
  return record.outcome.holdoutScore ?? record.outcome.searchScore ?? 0
}

function meanSearchScore(records: RunRecord[]): number {
  if (records.length === 0) return 0
  const sum = records.reduce((acc, r) => acc + searchScoreOf(r), 0)
  return sum / records.length
}
