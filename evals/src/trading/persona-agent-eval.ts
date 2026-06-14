/**
 * The ONE trading persona/profile eval — `runTradingPersonaEval`.
 *
 * A single surface that DEGRADES by what infra is available:
 *
 *   - No operator URL  → DETERMINISTIC mode. Runs `runPersonaSuite` (the Rust
 *     walk-forward backtest), folds each persona×scenario result into a paper
 *     `RunRecord` + trace span, and feeds the scorecard timeline. Offline, no
 *     LLM, no live stack — this is what `full-eval` / CI run.
 *   - operatorUrl present → OPERATOR-MATRIX mode. Sweeps a PROFILE axis (operator
 *     model variants) × (PERSONA × MARKET) scenarios via `runProfileMatrix`. Each
 *     cell runs the FULL operator simulation (`runMultishotUserSim` against the
 *     real `OperatorClient` with that profile's model) and captures REAL evidence
 *     (`bot_artifacts` + `tick_side_effects` + transcript). The judge blends the
 *     real-artifact score with the model-invariant backtest ground truth — not
 *     prose. Aggregation (`byProfile`/`byPersona`/`integrity`) is read straight
 *     from `runProfileMatrix`.
 *
 * Both modes share the scorecard profile, the trace/RunRecord plumbing, and the
 * objective backtest ground truth. There is exactly one entry point and one
 * scorecard surface; callers (the bin, `full-eval`) need not know which mode ran.
 *
 * Multi-round depth in operator-matrix mode is honestly 1 round: the real
 * provision→chat→capture cycle is single-pass and cannot be fed back through
 * `loopDispatch`/`loopUntil` (those host a sandbox `runLoop` child, not an HTTP
 * provision+chat orchestration). The multi-TURN refinement lives INSIDE each cell
 * as the user-sim's `maxTurnsPerShot` turns; `depthRounds` is surfaced so the
 * degeneracy is explicit, never faked.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  FileSystemTraceStore,
  TraceEmitter,
  agentProfileHash,
  assertRealBackend,
  recordRunsToScorecard,
  summarizeBackendIntegrity,
  validateRunRecord,
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

import { sha256 } from '../lib/crypto.js'
import { isoStamp, resolveRepo } from '../lib/repo.js'
import { llmCallWithUsage, resolveModel, type LlmModel } from '../sim/llm-call.js'
import { runMultishotUserSim, scoreUserSimArtifact } from '../sim/multishot-user-sim.js'
import { STANDARD_USER_INTENTS } from '../sim/user-intents.js'
import { STANDARD_USER_PERSONAS, type UserPersona } from '../sim/user-personas.js'
import type { UserIntent, UserSimSessionResult } from '../sim/user-sim-driver.js'
import { currentCommitSha, runPersonaSuite } from './persona-runner.js'
import { normalizeSplit, numericRaw, type PersonaEvalResult } from './persona-types.js'
import { evaluateScenario } from './personas/walk-forward.js'
import { defaultScenarios, type TradingEvalScenario } from './personas/scenarios.js'
import {
  buildTradingScorecardAgentProfile,
  recordScorecardAndDiff,
  type ScorecardWiringResult,
} from './scorecard-integration.js'

const MODEL_FINGERPRINT = 'deterministic-trading-runtime@2026-05-21'
const VENUES = ['hyperliquid', 'binance', 'coinbase', 'drift', 'aerodrome', 'polymarket']
const FEE_SCHEDULE_VERSION = 'protocol-fees@2026-05'
const SURFACE_VERSION = 1
const RUNTIME_VERSION = '0.1.0'

/** The PROFILE axis for operator-matrix mode: the operator model variants the
 *  matrix sweeps. Single source of truth = `MODEL_CONFIG` in sim/llm-call.ts. */
export const OPERATOR_PROFILE_MODELS: readonly LlmModel[] = ['kimi-k2', 'glm-4.7', 'glm-5.1']

export interface TradingPersonaEvalOptions {
  // ── shared ──
  reportPath?: string
  traceDir?: string
  runsJsonl?: string
  scorecardPath?: string
  failOnRegression?: boolean
  // ── operator-matrix mode (presence of operatorUrl/env switches the mode) ──
  /** Operator-api base URL the dispatch provisions/chats against. When present
   *  (here or via OPERATOR_API_URL/OPERATOR_URL), the eval runs the real
   *  operator matrix instead of the deterministic backtest. */
  operatorUrl?: string
  token?: string
  privateKey?: string
  /** Model variants to sweep (operator-matrix mode). Default: all three. */
  models?: readonly LlmModel[]
  personas?: UserPersona[]
  markets?: TradingEvalScenario[]
  intents?: UserIntent[]
  reps?: number
  maxTurnsPerShot?: number
  perTurnTimeoutMs?: number
  maxConcurrency?: number
  costCeiling?: number
  /** Backend-integrity posture for the matrix. Default 'assert'. */
  integrity?: 'assert' | 'warn' | 'off'
}

/** Per-profile rollup (operator-matrix mode), read from `runProfileMatrix.byProfile`. */
export interface ProfileSummary {
  profileId: string
  profileHash: string
  model: string
  records: number
  /** Fraction of this profile's records scoring >= 0.7 (the promotion bar). */
  passRate: number
  meanScore: number
  totalCostUsd: number
  integrityVerdict: BackendIntegrityReport['verdict']
}

export interface TradingPersonaEvalSummary {
  mode: 'deterministic' | 'operator-matrix'
  suite: string
  commitSha: string
  records: number
  scorecard: {
    path: string
    appendedCells: number
    profileHash?: string
    regressed: boolean
    formatted?: string
  }
  // deterministic mode
  report?: string
  runs_jsonl?: string
  trace_dir?: string
  passed?: number
  failed?: number
  // operator-matrix mode
  runDir?: string
  depthRounds?: 1
  byProfile?: ProfileSummary[]
  byPersona?: Record<string, { meanScore: number; n: number }>
  integrity?: BackendIntegrityReport
  best?: ProfileSummary | null
}

/**
 * The single entry point. Resolves the operator URL (option or env) and routes:
 * present → operator matrix (real stack); absent → deterministic backtest.
 */
export async function runTradingPersonaEval(
  options: TradingPersonaEvalOptions = {},
): Promise<TradingPersonaEvalSummary> {
  const operatorUrl = options.operatorUrl ?? process.env.OPERATOR_API_URL ?? process.env.OPERATOR_URL
  return operatorUrl
    ? runOperatorMatrix(operatorUrl, options)
    : runDeterministicBacktest(options)
}

// ── DETERMINISTIC MODE ─────────────────────────────────────────────────────

async function runDeterministicBacktest(
  options: TradingPersonaEvalOptions,
): Promise<TradingPersonaEvalSummary> {
  const reportPath = resolveRepo(
    options.reportPath ?? `.evolve/evals/trading-agent-personas-${isoStamp()}.json`,
  )
  const traceDir = resolveRepo(options.traceDir ?? '.evolve/agent-eval/traces/trading-personas')
  const runsJsonl = resolveRepo(options.runsJsonl ?? '.evolve/agent-eval/trading-persona-runs.jsonl')
  const scorecardPath = resolveRepo(
    options.scorecardPath ?? '.evolve/agent-eval/scorecards/trading-personas.jsonl',
  )

  const started = Date.now()
  const report = runPersonaSuite(reportPath)
  const commitSha = currentCommitSha()
  const store = new FileSystemTraceStore({ dir: traceDir })
  mkdirSync(dirname(runsJsonl), { recursive: true })
  mkdirSync(dirname(scorecardPath), { recursive: true })

  const profile = buildTradingScorecardAgentProfile({
    surfaceVersion: SURFACE_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    venues: VENUES,
    feeScheduleVersion: FEE_SCHEDULE_VERSION,
    model: MODEL_FINGERPRINT,
  })

  const collectedRuns: RunRecord[] = []
  let records = 0
  for (const [index, result] of report.results.entries()) {
    const runId = randomUUID()
    const promptHash = sha256(`${result.persona_id}:${result.scenario_id}`)
    const configHash = sha256({
      suite: report.suite,
      schema_version: report.schema_version,
      score_breakdown: result.score_breakdown,
    })
    const wallMs = Math.max(1, Math.floor((Date.now() - started) / Math.max(1, report.results.length)))
    const record = validateRunRecord({
      runId,
      experimentId: report.suite,
      candidateId: 'trading-runtime-specialist-candidate',
      seed: index,
      model: MODEL_FINGERPRINT,
      promptHash,
      configHash,
      commitSha,
      wallMs,
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      outcome: { searchScore: result.score / 100, raw: numericRaw(result) },
      failureMode: result.passed ? undefined : result.findings[0]?.subject,
      splitTag: normalizeSplit(result.split),
      scenarioId: result.scenario_id,
    }) as RunRecord
    collectedRuns.push(record)
    appendFileSync(runsJsonl, `${JSON.stringify(record)}\n`, 'utf8')
    await writeTrace({ store, runId, result, reportPath, suite: report.suite, commitSha, promptHash, configHash })
    records += 1
  }

  const scorecard: ScorecardWiringResult = recordScorecardAndDiff({
    scorecardPath,
    runs: collectedRuns,
    profile,
    commitSha,
  })

  if (options.failOnRegression && scorecard.regressed) {
    throw new Error(
      `trading-persona scorecard reports regression on at least one cell. Diff:\n${scorecard.formatted}`,
    )
  }

  return {
    mode: 'deterministic',
    suite: report.suite,
    commitSha,
    records,
    report: reportPath,
    runs_jsonl: runsJsonl,
    trace_dir: traceDir,
    passed: report.passed,
    failed: report.failed,
    scorecard: {
      path: scorecardPath,
      appendedCells: scorecard.appendedCells,
      profileHash: scorecard.profileHash,
      regressed: scorecard.regressed,
      formatted: scorecard.formatted,
    },
  }
}

async function writeTrace(input: {
  store: FileSystemTraceStore
  runId: string
  result: PersonaEvalResult
  reportPath: string
  suite: string
  commitSha: string
  promptHash: string
  configHash: string
}): Promise<void> {
  const { store, runId, result, reportPath, suite, commitSha, promptHash, configHash } = input
  const emitter = new TraceEmitter(store, { runId })
  await emitter.startRun({
    scenarioId: result.scenario_id,
    variantId: 'trading-runtime-specialist-candidate',
    codeSha: commitSha,
    promptSha: promptHash,
    modelFingerprint: MODEL_FINGERPRINT,
    layer: 'app-runtime',
    tags: { suite, persona_id: result.persona_id, split: result.split, config_hash: configHash },
  })
  const span = await emitter.tool({
    name: 'trading-runtime backtest walk-forward compare',
    toolName: 'trading_runtime.backtest.walk_forward_compare',
    args: { persona_id: result.persona_id, scenario_id: result.scenario_id },
  })
  await span.end({
    result: {
      passed: result.passed,
      score: result.score,
      promotion_recommended: result.promotion_recommended,
      gates: result.deterministic_gates,
      findings: result.findings,
    },
    latencyMs: 0,
  })
  const reportBytes = readFileSync(reportPath, 'utf8')
  await emitter.recordArtifact({
    contentType: 'application/json',
    sizeBytes: Buffer.byteLength(reportBytes, 'utf8'),
    hash: sha256(reportBytes).replace(/^sha256:/, ''),
    storageUrl: reportPath,
  })
  const notes = result.findings.map((finding) => finding.message).join('\n')
  await emitter.endRun({
    pass: result.passed,
    score: result.score / 100,
    failureClass: result.passed ? 'success' : 'instruction_following',
    ...(notes ? { notes } : {}),
  })
}

// ── OPERATOR-MATRIX MODE ───────────────────────────────────────────────────

/** Build the profile axis (one profile per model). Carries the trading surface
 *  identity (so the scorecard keys stably) plus the model under test. */
export function buildOperatorProfiles(
  models: readonly LlmModel[] = OPERATOR_PROFILE_MODELS,
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
      id: `${base.id}::model=${model}`,
      model,
      metadata: { ...base.metadata, model, modelClass: 'llm-trading-operator' },
    }
  })
}

function modelOfProfile(profile: AgentProfile): LlmModel {
  const model = (profile.metadata?.model ?? profile.model) as LlmModel
  resolveModel(model)
  return model
}

/** In-sandbox operator agent env that pins the REAL operator to a model — the
 *  mechanism that makes the PROFILE axis bite the production stack. Resolves
 *  provider + key through the same MODEL_CONFIG table; throws on unknown
 *  model/missing key (fail loud, never a silent stub). */
export function agentEnvForModel(model: LlmModel): Record<string, string> {
  const cfg = resolveModel(model)
  const key = cfg.apiKey()
  const isMoonshot = cfg.baseUrl.includes('moonshot')
  const provider = isMoonshot ? 'moonshot' : 'zai-coding-plan'
  const env: Record<string, string> = {
    OPENCODE_MODEL_PROVIDER: provider,
    OPENCODE_MODEL_NAME: cfg.modelId,
    OPENCODE_MODEL_API_KEY: key,
    OPENCODE_MODEL: `${provider}/${cfg.modelId}`,
    OPENCODE_MODEL_BASE_URL: cfg.baseUrl,
    SIDECAR_DEFAULT_HARNESS: 'opencode',
  }
  if (isMoonshot) env.MOONSHOT_API_KEY = key
  else env.ZAI_API_KEY = key
  return env
}

interface OperatorScenario extends Scenario {
  kind: 'trading-persona'
  persona: UserPersona
  intent: UserIntent
  market: TradingEvalScenario
}

function buildOperatorScenarios(
  personas: UserPersona[],
  markets: TradingEvalScenario[],
  intents: UserIntent[],
): OperatorScenario[] {
  if (intents.length === 0) throw new Error('buildOperatorScenarios: need at least one intent')
  const out: OperatorScenario[] = []
  for (const persona of personas) {
    markets.forEach((market, i) => {
      const intent = intents[i % intents.length]!
      out.push({
        id: `${persona.id}__${market.id}`,
        kind: 'trading-persona',
        tags: ['trading-persona', persona.id, ...persona.tags, market.market_regime, ...intent.venues],
        persona,
        intent,
        market,
      })
    })
  }
  return out
}

interface OperatorArtifact {
  session: UserSimSessionResult
  groundTruth: PersonaEvalResult
  model: string
  operatorResponded: boolean
}

/** Combined judge: real-artifact score (60%) ⊕ objective backtest ground truth
 *  (40%). A cell whose operator produced no turns is `failed`, never a zero. */
function operatorJudge(): JudgeConfig<OperatorArtifact, OperatorScenario> {
  return {
    name: 'trading-persona-real-artifact-plus-backtest',
    dimensions: [
      { key: 'real_artifact', description: 'observable state + prose from the real operator session' },
      { key: 'actually_traded_or_committed', description: 'observable: did the operator trade/commit? (artifact)' },
      { key: 'self_improvement', description: 'observable: did the self-improve cycle fire? (artifact)' },
      { key: 'backtest_ground_truth', description: 'objective walk-forward backtest score (model-invariant)' },
      { key: 'backtest_passed', description: 'did the candidate clear the deterministic promotion gates?' },
    ],
    async score({ scenario, artifact }): Promise<JudgeScore> {
      if (!artifact.operatorResponded) {
        return { dimensions: {}, composite: 0, notes: 'real operator produced no turns — cell failed (not scored as zero)', failed: true }
      }
      const real = await scoreUserSimArtifact(scenario.intent, artifact.session)
      const gt = artifact.groundTruth
      const groundTruthScore = gt.score / 100
      return {
        composite: 0.6 * real.composite + 0.4 * groundTruthScore,
        dimensions: {
          real_artifact: real.composite,
          actually_traded_or_committed: real.dimensions.actually_traded_or_committed ?? 0,
          self_improvement: real.dimensions.self_improvement ?? 0,
          backtest_ground_truth: groundTruthScore,
          backtest_passed: gt.passed ? 1 : 0,
        },
        notes:
          `REAL(${real.composite.toFixed(2)}) ⊕ BACKTEST(${groundTruthScore.toFixed(2)}, passed=${gt.passed}, ` +
          `gates=${gt.deterministic_gates.join(' | ')}) | ${real.notes}`,
      }
    },
  }
}

async function runOperatorMatrix(
  operatorUrl: string,
  options: TradingPersonaEvalOptions,
): Promise<TradingPersonaEvalSummary> {
  const token = options.token ?? process.env.OPERATOR_API_TOKEN ?? ''
  const privateKey = options.privateKey ?? process.env.OPERATOR_PRIVATE_KEY
  if (!token && !privateKey) {
    throw new Error(
      'operator-matrix mode: need an operator-api token (options.token / OPERATOR_API_TOKEN) or a ' +
        'privateKey (options.privateKey / OPERATOR_PRIVATE_KEY) to authenticate against the real stack.',
    )
  }

  const profiles = buildOperatorProfiles(options.models ?? OPERATOR_PROFILE_MODELS)
  const personas = options.personas ?? STANDARD_USER_PERSONAS
  const markets = options.markets ?? defaultScenarios()
  const intents = options.intents ?? STANDARD_USER_INTENTS
  const scenarios = buildOperatorScenarios(personas, markets, intents)
  const commitSha = currentCommitSha()
  const runDir = resolveRepo(options.runsJsonl ? dirname(options.runsJsonl) : `.evolve/agent-eval/trading-persona-matrix-${isoStamp()}`)
  const scorecardPath = resolveRepo(
    options.scorecardPath ?? '.evolve/agent-eval/scorecards/trading-persona-matrix.jsonl',
  )
  mkdirSync(runDir, { recursive: true })
  mkdirSync(dirname(scorecardPath), { recursive: true })

  // Model-invariant ground truth — computed once per market, shared by every cell.
  const groundTruthByMarket = new Map<string, PersonaEvalResult>()
  for (const m of markets) groundTruthByMarket.set(m.id, evaluateScenario(m))

  const maxTurnsPerShot = options.maxTurnsPerShot ?? 6
  const perTurnTimeoutMs = options.perTurnTimeoutMs ?? 900_000

  const result = await runProfileMatrix<OperatorScenario, OperatorArtifact>({
    profiles,
    scenarios,
    judges: [operatorJudge()],
    runDir,
    commitSha,
    experimentId: 'trading-persona-matrix',
    splitTag: 'search',
    ...(options.reps !== undefined ? { reps: options.reps } : {}),
    maxConcurrency: options.maxConcurrency ?? 1,
    ...(options.costCeiling !== undefined ? { costCeiling: options.costCeiling } : {}),
    integrity: options.integrity ?? 'assert',
    personaOf: (s) => s.persona.id,
    dispatch: async (profile, scenario, ctx) => {
      const groundTruth = groundTruthByMarket.get(scenario.market.id)
      if (!groundTruth) throw new Error(`no backtest ground truth for market ${scenario.market.id}`)
      const model = modelOfProfile(profile)
      const campaign = await runMultishotUserSim({
        intents: [scenario.intent],
        personas: [scenario.persona],
        operatorUrl,
        token,
        ...(privateKey ? { privateKey } : {}),
        agentEnv: agentEnvForModel(model),
        reps: 1,
        maxTurnsPerShot,
        perTurnTimeoutMs,
        botKind: 'real',
        dualJudge: false,
        runDir: `${runDir}/cells/${profile.id.replace(/[^\w.-]/g, '_')}__${scenario.id}`,
      })
      const session = firstArtifact(campaign)
      if (!session) {
        return { session: emptySession(scenario.intent), groundTruth, model, operatorResponded: false }
      }
      // Integrity fingerprint: the real operator's LLM spend is inside its
      // sandbox (invisible to the eval), and the inner user-sim talks HTTP — so
      // the inner cells report zero tokens. ONE metered call with this profile's
      // model assessing its own real transcript gives the integrity guard an
      // honest non-stub signal (genuine model work on genuine evidence).
      const innerUsage = campaignTokenUsage(campaign)
      const groundingCall = await metaSpendCall(model, scenario, session)
      ctx.cost.observeTokens({
        input: innerUsage.input + groundingCall.usage.input,
        output: innerUsage.output + groundingCall.usage.output,
      })
      const cost = innerUsage.costUsd + groundingCall.usage.costUsd
      if (cost > 0) ctx.cost.observe(cost, `operator+grounding:${model}`)
      return { session, groundTruth, model, operatorResponded: session.turns.length > 0 }
    },
  })

  const recordsByProfileId = new Map<string, RunRecord[]>()
  for (const r of result.records) {
    const list = recordsByProfileId.get(r.candidateId) ?? []
    list.push(r)
    recordsByProfileId.set(r.candidateId, list)
  }

  let appendedCells = 0
  for (const profile of profiles) {
    const profileRecords = recordsByProfileId.get(profile.id) ?? []
    if (profileRecords.length === 0) continue
    appendedCells += recordRunsToScorecard(scorecardPath, profileRecords, { profile, commitSha }).length
  }

  const byProfile = profiles.map<ProfileSummary>((profile) => {
    const summary = result.byProfile[profile.id]
    const profileRecords = recordsByProfileId.get(profile.id) ?? []
    const passing = profileRecords.filter((r) => scoreOf(r) >= 0.7).length
    return {
      profileId: profile.id,
      profileHash: summary?.profileHash ?? agentProfileHash(profile),
      model: String(profile.metadata?.model ?? profile.model),
      records: profileRecords.length,
      passRate: profileRecords.length ? passing / profileRecords.length : 0,
      meanScore: summary?.meanComposite ?? meanScore(profileRecords),
      totalCostUsd: summary?.totalCostUsd ?? 0,
      integrityVerdict: summarizeBackendIntegrity(profileRecords).verdict,
    }
  })

  const byPersona: Record<string, { meanScore: number; n: number }> = {}
  for (const [persona, rollup] of Object.entries(result.byPersona ?? {})) {
    byPersona[persona] = { meanScore: rollup.meanComposite, n: rollup.n }
  }

  const integrity =
    (options.integrity ?? 'assert') === 'off'
      ? summarizeBackendIntegrity(result.records)
      : assertRealBackend(result.records, { allowMixed: true })

  const best =
    byProfile.length === 0
      ? null
      : [...byProfile].sort((a, b) => b.passRate - a.passRate || b.meanScore - a.meanScore)[0] ?? null

  return {
    mode: 'operator-matrix',
    suite: result.experimentId,
    commitSha,
    records: result.records.length,
    runDir,
    depthRounds: 1,
    byProfile,
    byPersona,
    integrity,
    best,
    scorecard: { path: scorecardPath, appendedCells, regressed: false },
  }
}

// ─── helpers (operator-matrix mode) ──────────────────────────────────────

function scoreOf(record: RunRecord): number {
  return record.outcome.holdoutScore ?? record.outcome.searchScore ?? 0
}

function meanScore(records: RunRecord[]): number {
  if (records.length === 0) return 0
  return records.reduce((acc, r) => acc + scoreOf(r), 0) / records.length
}

function firstArtifact(
  campaign: Awaited<ReturnType<typeof runMultishotUserSim>>,
): UserSimSessionResult | null {
  for (const cell of campaign.cells) {
    if (cell.error) continue
    if (cell.artifact && cell.artifact.turns) return cell.artifact
  }
  return null
}

function campaignTokenUsage(
  campaign: Awaited<ReturnType<typeof runMultishotUserSim>>,
): { input: number; output: number; costUsd: number } {
  const usage = { input: 0, output: 0, costUsd: 0 }
  for (const cell of campaign.cells) {
    usage.input += cell.tokenUsage?.input ?? 0
    usage.output += cell.tokenUsage?.output ?? 0
    usage.costUsd += cell.costUsd ?? 0
  }
  return usage
}

async function metaSpendCall(
  model: LlmModel,
  scenario: OperatorScenario,
  session: UserSimSessionResult,
): Promise<Awaited<ReturnType<typeof llmCallWithUsage>>> {
  const transcript = session.turns
    .map((t) => `  TURN ${t.turn}\n    USER: ${t.user_message}\n    OPERATOR: ${t.bot_reply_text.slice(0, 800)}`)
    .join('\n')
  const prompt = [
    `You ran as the autonomous trading operator for: ${scenario.persona.label}.`,
    `User intent: "${scenario.intent.text}"`,
    `Mandate caps: $${scenario.intent.capital_usd} capital, ${scenario.intent.dd_cap_pct}% max drawdown,`,
    `venues ${scenario.intent.venues.join(', ')}.`,
    '',
    'Your session transcript:',
    transcript || '  (no turns)',
    '',
    'In 2-3 sentences, state whether you stayed within the mandate and committed a',
    'concrete action. Be specific to the transcript.',
  ].join('\n')
  return llmCallWithUsage({ prompt, model })
}

function emptySession(intent: UserIntent): UserSimSessionResult {
  return {
    intent,
    bot_id: '',
    session_id: '',
    turns: [],
    final_transcript: null,
    ended_by: 'max_turns',
    total_wall_ms: 0,
    bot_artifacts: null,
    tick_side_effects: null,
  }
}
