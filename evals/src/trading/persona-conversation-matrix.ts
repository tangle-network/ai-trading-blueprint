/**
 * Conversational trading persona MATRIX — the OFFICIAL `runPersonaDispatch`
 * adoption (agent-runtime 0.52.0) on top of `runProfileMatrix` (agent-eval).
 *
 * This is the persona-DRIVES-worker variant: a `PersonaDriver` (the simulated
 * user, role-playing one of our `UserPersona`s) talks to a WORKER profile (an
 * LLM standing in for the trading operator) over N conversation turns; the
 * finished `ConversationTurn[]` transcript becomes the scored artifact. The
 * official `runPersonaDispatch` builds the `ProfileDispatchFn` — we no longer
 * hand-roll the per-cell conversation loop, the worker/persona backend wiring,
 * or the usage metering (it meters the worker through `ctx.cost` so the matrix's
 * `assertRealBackend` integrity guard sees real tokens).
 *
 * ── What is wired vs what is honestly deferred ──
 *
 * WIRED (real, runs against live model providers):
 *   - `runPersonaDispatch` → `runProfileMatrix` for the PROFILE × PERSONA matrix.
 *   - `backendFor(profile, role)` returns a real `createOpenAICompatibleBackend`
 *     resolved through the SAME `MODEL_CONFIG`/`resolveModel` table the bot and
 *     every other eval call use (worker = the profile's model under test; persona
 *     = the user-sim's persona model). No new provider table.
 *   - `personaOf(scenario)` returns a `profile`-kind `PersonaDriver` built from
 *     the scenario's `UserPersona` (its system prompt is the persona voice).
 *   - `systemPromptOf` renders the trading-operator identity for the worker and
 *     the persona voice for the persona driver.
 *   - `artifactOf(transcript, scenario)` builds the scored artifact from the
 *     transcript, reusing the multishot rubric DIMENSIONS via an LLM judge.
 *
 * DEFERRED (cannot be honestly wired in this self-contained mode — documented,
 * not faked):
 *   - The PRODUCTION trading operator is HTTP-operator + sandbox-cron driven
 *     (provision → configureSecrets → chat → async tick). It is NOT a
 *     router-reachable conversational backend, so `runPersonaConversation`
 *     (which builds its OWN backend per profile and runs a synchronous turn
 *     loop) cannot drive it. This matrix therefore tests an LLM STANDING IN for
 *     the operator — a model-comparison surface ("which model best role-plays
 *     the operator against each persona"), NOT the production stack. The
 *     production stack is covered by `runMultishotUserSim` (OperatorClient over
 *     HTTP), which `runPersonaDispatch` does not and cannot subsume.
 *   - Because the worker here is an LLM, NOT the real bot, there are no
 *     `bot_artifacts` / `tick_side_effects` to inspect. The multishot judge's
 *     STATE-based dimensions (`actually_traded_or_committed`, `self_improvement`)
 *     have no observable substrate here, so this judge scores the PROSE
 *     dimensions only and labels itself accordingly. State dimensions stay the
 *     province of `runMultishotUserSim`. We do NOT fabricate a state score.
 *
 * Relationship to the deterministic backtest matrix (`persona-profile-matrix.ts`):
 *   - That module is the model-INVARIANT ground-truth path (deterministic
 *     walk-forward backtest + a per-cell rationale call). It stays as-is.
 *   - This module is the CONVERSATIONAL path. Both are profile × persona matrices
 *     over `runProfileMatrix`; they answer different questions and coexist.
 */

import { mkdirSync } from 'node:fs'

import {
  assertRealBackend,
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
import {
  createOpenAICompatibleBackend,
  runPersonaDispatch,
  type AgentExecutionBackend,
  type ConversationTurn,
  type PersonaDriver,
} from '@tangle-network/agent-runtime'

import { isoStamp, resolveRepo } from '../lib/repo.js'
import { llmCallJson, resolveModel, type LlmModel } from '../sim/llm-call.js'
import {
  STANDARD_USER_PERSONAS,
  type UserPersona,
} from '../sim/user-personas.js'
import type { UserIntent } from '../sim/user-sim-driver.js'
import { currentCommitSha } from './persona-runner.js'

/** The PROFILE axis: the worker (operator-stand-in) model variants under test.
 *  Single source of truth = `MODEL_CONFIG` in sim/llm-call.ts. */
export const CONVERSATION_WORKER_MODELS: readonly LlmModel[] = ['kimi-k2', 'glm-4.7', 'glm-5.1']

/** Model the persona DRIVER speaks as. Cheap + fast — it is the test harness,
 *  not the side under test, and `runPersonaDispatch` does not meter it. */
const PERSONA_DRIVER_MODEL: LlmModel = 'kimi-k2'

const WORKER_NAME = 'trading-operator'

/** The trading-operator identity the WORKER profile speaks as. Mirrors the
 *  production operator's AGENTS.md identity (the autonomous on-chain vault
 *  operator), so the conversation is grounded in the real persona even though
 *  the backend is an LLM stand-in, not the production stack. */
function operatorSystemPrompt(): string {
  return [
    'You are the autonomous trading operator running a user\'s on-chain vault.',
    'You manage capital across DEX/perp/MM/yield venues under a strict mandate:',
    'you respect the user\'s capital cap, max-drawdown cap, and allow-listed venues',
    'on every decision. You act, you do not just discuss — when the user states an',
    'intent you commit a concrete strategy and explain the risk model (position',
    'sizing, drawdown stop, expected trade cadence) in specific numbers, not vibes.',
    'You never quote a Sharpe without an n and a CI. You are terse and decisive.',
  ].join('\n')
}

/** One conversational persona/intent cell. Carries the persona + intent so
 *  `personaOf` can build the driver and the judge can read the mandate. */
export interface ConversationScenario extends Scenario {
  kind: 'trading-conversation'
  persona: UserPersona
  intent: UserIntent
}

/** Build the profile × scenario corpus: scenarios are persona × intent. */
export function buildConversationScenarios(
  personas: UserPersona[],
  intents: UserIntent[],
): ConversationScenario[] {
  const out: ConversationScenario[] = []
  for (const persona of personas) {
    for (const intent of intents) {
      out.push({
        id: `${persona.id}__${intent.id}`,
        kind: 'trading-conversation',
        tags: ['conversation', persona.id, ...persona.tags, ...intent.venues],
        persona,
        intent,
      })
    }
  }
  return out
}

/** The worker profile axis — each pins one model under test. */
export function buildConversationWorkerProfiles(
  models: readonly LlmModel[] = CONVERSATION_WORKER_MODELS,
): AgentProfile[] {
  return models.map((model) => ({
    id: `trading-operator-conversation::model=${model}`,
    model,
    promptVersion: 'operator-conversation@1',
    metadata: { model, modelClass: 'llm-trading-operator-stand-in', surface: 'conversation' },
  }))
}

/** The artifact a conversational cell produces: the transcript + the persona /
 *  intent context the judge scores against. */
export interface ConversationArtifact {
  transcript: ConversationTurn[]
  personaId: string
  intentId: string
  /** Worker turns only (the side under test) — what the judge reads as "the
   *  operator's replies". */
  workerTurns: ConversationTurn[]
}

/** Resolve a logical model to a real OpenAI-compatible backend through the
 *  shared MODEL_CONFIG table. Throws on unknown model / missing key (fail loud
 *  at the dispatch boundary rather than scoring a stub). */
function backendForModel(model: LlmModel): AgentExecutionBackend {
  const cfg = resolveModel(model)
  return createOpenAICompatibleBackend({
    apiKey: cfg.apiKey(),
    baseUrl: cfg.baseUrl,
    model: cfg.modelId,
  })
}

function modelOfProfile(profile: AgentProfile): LlmModel {
  return String(profile.metadata?.model ?? profile.model)
}

/**
 * Prose-only conversational judge. Scores the transcript on the PROSE
 * dimensions of the multishot rubric — intent fulfilment, constraint respect,
 * productive conversation — via the same `llmCallJson` path every other judge
 * uses. The STATE dimensions (`actually_traded_or_committed`, `self_improvement`)
 * are DELIBERATELY ABSENT: an LLM worker has no observable work-product to
 * inspect, and fabricating a state score from prose is exactly the prose-claim
 * gaming the multishot judge discounts. Those dimensions remain the province of
 * `runMultishotUserSim` against the real bot.
 */
export function conversationJudge(): JudgeConfig<ConversationArtifact, ConversationScenario> {
  return {
    name: 'trading-conversation-prose',
    dimensions: [
      { key: 'intent_fulfilled', description: 'Did the operator address the user intent? (prose)' },
      { key: 'respected_constraints', description: 'Did it stay within capital/DD/venue caps? (prose)' },
      { key: 'committed_concrete_decision', description: 'Did it commit a concrete strategy with a numeric risk model? (prose)' },
      { key: 'productive_conversation', description: 'Were the turns moving forward? (prose)' },
    ],
    async score({ scenario, artifact }): Promise<JudgeScore> {
      if (artifact.workerTurns.length === 0) {
        return {
          dimensions: {},
          composite: 0,
          notes: 'worker produced no turns — cell failed (not scored as zero)',
          failed: true,
        }
      }
      const transcript = artifact.transcript
        .map((t) => `  ${t.speaker}: ${t.text.slice(0, 1200)}`)
        .join('\n')
      const intent = scenario.intent
      const message = [
        `User's intent: "${intent.text}"`,
        `Hard constraints: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues allowed: ${intent.venues.join(', ')}.`,
        `Persona: ${scenario.persona.label}.`,
        '',
        'Conversation transcript:',
        transcript,
        '',
        'Score the TRADING OPERATOR (not the user) on a 0..1 scale for each key and',
        'return ONLY JSON: {"intent_fulfilled":0..1,"respected_constraints":0..1,',
        '"committed_concrete_decision":0..1,"productive_conversation":0..1,"notes":"..."}.',
        'committed_concrete_decision is HIGH only when the operator named a concrete',
        'strategy with numeric position sizing AND a drawdown stop — prose intent',
        'without numbers is LOW.',
      ].join('\n')
      const { result, raw } = await llmCallJson<{
        intent_fulfilled: number
        respected_constraints: number
        committed_concrete_decision: number
        productive_conversation: number
        notes: string
      }>({ prompt: message, model: 'glm-5.1' })
      const r = result ?? {
        intent_fulfilled: 0,
        respected_constraints: 0,
        committed_concrete_decision: 0,
        productive_conversation: 0,
        notes: !raw.ok ? `judge_failed: ${raw.stderr.slice(0, 200)}` : `judge_unparseable: ${raw.output.slice(0, 200)}`,
      }
      const dimensions = {
        intent_fulfilled: clamp01(r.intent_fulfilled),
        respected_constraints: clamp01(r.respected_constraints),
        committed_concrete_decision: clamp01(r.committed_concrete_decision),
        productive_conversation: clamp01(r.productive_conversation),
      }
      // Weight the concrete-decision dimension highest — it is the closest prose
      // proxy for "did the operator actually do the job" without claiming the
      // (unavailable) observable state.
      const composite =
        0.25 * dimensions.intent_fulfilled +
        0.20 * dimensions.respected_constraints +
        0.40 * dimensions.committed_concrete_decision +
        0.15 * dimensions.productive_conversation
      return { composite, dimensions, notes: `PROSE-ONLY (no observable state in conversation mode): ${r.notes}` }
    },
  }
}

export interface ConversationMatrixOptions {
  models?: readonly LlmModel[]
  personas?: UserPersona[]
  intents: UserIntent[]
  reps?: number
  runDir?: string
  maxConcurrency?: number
  costCeiling?: number
  /** Speaker-turn cap per cell (worker + persona). Default 8. */
  maxTurns?: number
  /** Backend-integrity posture. Default 'assert'. 'warn' for a keyless dry run. */
  integrity?: 'assert' | 'warn' | 'off'
}

export interface ConversationProfileSummary {
  profileId: string
  model: string
  records: number
  meanScore: number
  totalCostUsd: number
  integrityVerdict: BackendIntegrityReport['verdict']
}

export interface ConversationMatrixSummary {
  matrixId: string
  experimentId: string
  commitSha: string
  runDir: string
  records: number
  byProfile: ConversationProfileSummary[]
  byPersona: Record<string, { meanScore: number; n: number }>
  integrity: BackendIntegrityReport
  best: ConversationProfileSummary | null
}

/**
 * Sweep the conversational PROFILE × PERSONA matrix using the OFFICIAL
 * `runPersonaDispatch` to build the `ProfileDispatchFn`. The dispatch runs each
 * cell as a persona-driven conversation; we own only the four seams the official
 * config asks for (`backendFor`, `systemPromptOf`, `personaOf`, `artifactOf`).
 */
export async function runTradingConversationMatrix(
  options: ConversationMatrixOptions,
): Promise<ConversationMatrixSummary> {
  const models = options.models ?? CONVERSATION_WORKER_MODELS
  const personas = options.personas ?? STANDARD_USER_PERSONAS.slice(0, 3)
  const profiles = buildConversationWorkerProfiles(models)
  const scenarios = buildConversationScenarios(personas, options.intents)
  const commitSha = currentCommitSha()
  const runDir = resolveRepo(
    options.runDir ?? `.evolve/agent-eval/trading-conversation-matrix-${isoStamp()}`,
  )
  mkdirSync(runDir, { recursive: true })

  const maxTurns = options.maxTurns ?? 8

  // The OFFICIAL dispatch. We supply the four seams; agent-runtime owns the
  // per-cell conversation loop + worker metering.
  const dispatch = runPersonaDispatch<ConversationScenario, ConversationArtifact>({
    backendFor: (profile, role) =>
      role === 'worker'
        ? backendForModel(modelOfProfile(profile))
        : backendForModel(PERSONA_DRIVER_MODEL),
    systemPromptOf: (profile) =>
      profile.metadata?.role === 'persona' ? '' : operatorSystemPrompt(),
    personaOf: (scenario): PersonaDriver => ({
      kind: 'profile',
      profile: {
        id: `persona::${scenario.persona.id}`,
        model: PERSONA_DRIVER_MODEL,
        promptVersion: 'user-sim-persona@1',
        // `role: 'persona'` lets systemPromptOf branch; the persona voice rides
        // in the prompt below.
        metadata: { role: 'persona', personaId: scenario.persona.id },
      },
    }),
    artifactOf: (transcript, scenario): ConversationArtifact => ({
      transcript,
      personaId: scenario.persona.id,
      intentId: scenario.intent.id,
      // The worker speaker label is `slugifySpeaker(workerName)`; match by slug
      // prefix so a slugified label still resolves the worker's turns.
      workerTurns: transcript.filter((t) => t.speaker === WORKER_NAME || t.speaker.startsWith(WORKER_NAME)),
    }),
    maxTurns: () => maxTurns,
    seed: (scenario) =>
      // The persona's opening line IS the intent text (a real user's first
      // message), prefixed with the persona voice so the driver stays in role.
      `${scenario.persona.system_prompt}\n\nOpen the conversation with this intent, in character: "${scenario.intent.text}"`,
    workerName: WORKER_NAME,
  })

  const result = await runProfileMatrix<ConversationScenario, ConversationArtifact>({
    profiles,
    scenarios,
    judges: [conversationJudge()],
    dispatch,
    runDir,
    commitSha,
    experimentId: 'trading-agent-conversation-matrix',
    splitTag: 'search',
    ...(options.reps !== undefined ? { reps: options.reps } : {}),
    maxConcurrency: options.maxConcurrency ?? 2,
    ...(options.costCeiling !== undefined ? { costCeiling: options.costCeiling } : {}),
    integrity: options.integrity ?? 'assert',
    personaOf: (s) => s.persona.id,
  })

  const recordsByProfileId = new Map<string, RunRecord[]>()
  for (const r of result.records) {
    const list = recordsByProfileId.get(r.candidateId) ?? []
    list.push(r)
    recordsByProfileId.set(r.candidateId, list)
  }

  const byProfile = profiles.map<ConversationProfileSummary>((profile) => {
    const summary = result.byProfile[profile.id]
    const records = recordsByProfileId.get(profile.id) ?? []
    return {
      profileId: profile.id,
      model: modelOfProfile(profile),
      records: records.length,
      meanScore: summary?.meanComposite ?? meanScore(records),
      totalCostUsd: summary?.totalCostUsd ?? 0,
      integrityVerdict: summarizeBackendIntegrity(records).verdict,
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
      : [...byProfile].sort((a, b) => b.meanScore - a.meanScore)[0] ?? null

  return {
    matrixId: result.matrixId,
    experimentId: result.experimentId,
    commitSha,
    runDir,
    records: result.records.length,
    byProfile,
    byPersona,
    integrity,
    best,
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function scoreOf(record: RunRecord): number {
  return record.outcome.holdoutScore ?? record.outcome.searchScore ?? 0
}

function meanScore(records: RunRecord[]): number {
  if (records.length === 0) return 0
  return records.reduce((acc, r) => acc + scoreOf(r), 0) / records.length
}
