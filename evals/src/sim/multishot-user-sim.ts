/**
 * Multishot user-sim eval — `runEval` wired to drive the real local
 * product stack with K user-sim sessions, one per intent.
 *
 * For each scenario (= one user intent):
 *   1. Provision a fresh bot through the operator's product API
 *      (`POST /api/bots`) — exactly the path the frontend takes.
 *   2. Open a manual chat session.
 *   3. Run `runUserSimSession` — LLM-driven user turns, bot replies via
 *      its real tool surface.
 *   4. Return the captured artifact (transcript + session metadata) for
 *      the judge to score.
 *
 * No frozen arm. No mid-run interference. The bot does whatever the
 * bot does; the user-sim sees only what a user would see.
 */

import type {
  CampaignResult,
  JudgeConfig,
  LabeledScenarioStore,
  Scenario,
} from '@tangle-network/agent-eval/campaign'
import { inMemoryCampaignStorage, runEval } from '@tangle-network/agent-eval/campaign'

import { resolveRepo } from '../lib/repo.js'
import {
  judgeViaSkepticalSecondary,
  runNullBotSession,
  runStallBotSession,
} from './baseline-bots.js'
import { llmCallJson } from './llm-call.js'
import { OperatorClient } from './operator-client.js'
import { inferStrategyTypeFromVenues } from './strategy-type.js'
import type { UserPersona } from './user-personas.js'
import {
  nextUserTurn,
  runUserSimSession,
  type UserIntent,
  type UserSimSessionResult,
} from './user-sim-driver.js'

export type BotKind = 'real' | 'null' | 'stall'

const JUDGE_MODEL = 'claude-haiku-4-5'

// ─── Scenario shape ────────────────────────────────────────────────────

export interface UserIntentScenario extends Scenario {
  intent: UserIntent
  /** Optional user-sim persona. When set, the user-sim's voice is the
   *  persona's system prompt prepended to the base instructions. */
  persona?: UserPersona
}

export function intentScenarios(intents: UserIntent[]): UserIntentScenario[] {
  return intents.map((intent) => ({
    id: intent.id,
    kind: 'user-sim',
    tags: ['user-sim', ...intent.venues],
    intent,
  }))
}

/** Build scenarios over the cross-product of personas × intents.
 *  Scenario id = `${persona.id}__${intent.id}`. */
export function personaIntentScenarios(
  personas: UserPersona[],
  intents: UserIntent[],
): UserIntentScenario[] {
  const out: UserIntentScenario[] = []
  for (const persona of personas) {
    for (const intent of intents) {
      out.push({
        id: `${persona.id}__${intent.id}`,
        kind: 'user-sim',
        tags: ['user-sim', persona.id, ...persona.tags, ...intent.venues],
        intent,
        persona,
      })
    }
  }
  return out
}

// ─── Dispatch: provision a fresh bot + run one user-sim session ────────

export interface MultishotDispatchOptions {
  operatorUrl: string
  /** Bearer token resolved by `local-stack-runner.ts::createOperatorSession`. */
  token: string
  maxTurnsPerShot: number
  perTurnTimeoutMs: number
}

export function makeUserSimDispatch(opts: MultishotDispatchOptions, botKind: BotKind = 'real') {
  return async (scenario: UserIntentScenario): Promise<UserSimSessionResult> => {
    // Bind the persona to nextUserTurn so the stub bots (null/stall) get
    // persona-flavoured user turns the same way the real bot path does.
    const persona = scenario.persona ?? null
    const turnGen = (intent: UserIntent, priorTurns: Parameters<typeof nextUserTurn>[1]) =>
      nextUserTurn(intent, priorTurns, persona)
    // Stub bots (null / stall) don't touch the product stack at all.
    if (botKind === 'null') {
      return runNullBotSession(scenario.intent, turnGen, {
        maxTurns: opts.maxTurnsPerShot,
        perTurnTimeoutMs: opts.perTurnTimeoutMs,
      })
    }
    if (botKind === 'stall') {
      return runStallBotSession(scenario.intent, turnGen, {
        maxTurns: opts.maxTurnsPerShot,
        perTurnTimeoutMs: opts.perTurnTimeoutMs,
      })
    }
    // Real bot: full provision + chat flow through OperatorClient — same
    // path as research/robustness drivers, single source of truth.
    const client = new OperatorClient({ operatorUrl: opts.operatorUrl, token: opts.token })
    const botId = await client.provisionBot({
      prompt: scenario.intent.text,
      name: scenario.intent.text.slice(0, 50),
      strategy_type: inferStrategyTypeFromVenues(scenario.intent.venues),
    })
    const sessionId = await client.createSession(botId, `user-sim:${scenario.id}`)
    return runUserSimSession({
      intent: scenario.intent,
      persona,
      operatorUrl: opts.operatorUrl,
      token: opts.token,
      botId,
      sessionId,
      maxTurns: opts.maxTurnsPerShot,
      perTurnTimeoutMs: opts.perTurnTimeoutMs,
      stallMs: opts.perTurnTimeoutMs,
    })
  }
}

// ─── Judge: an LLM rubric over the session artifact ────────────────────

interface JudgeRubricScores {
  intent_fulfilled: number          // 0..1
  respected_constraints: number     // 0..1
  actually_traded_or_committed: number  // 0..1
  productive_conversation: number   // 0..1
  notes: string
}

function judgeViaClaude(intent: UserIntent, artifact: UserSimSessionResult): JudgeRubricScores {
  const turnsView = artifact.turns
    .map((t) => `  TURN ${t.turn}:\n    USER: ${t.user_message}\n    BOT:  ${t.bot_reply_text.slice(0, 1200)}`)
    .join('\n')
  const prompt = `You are scoring a user↔bot conversation from a trading bot eval.

User's intent: "${intent.text}"
Hard constraints: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues allowed: ${intent.venues.join(', ')}.
Session ended by: ${artifact.ended_by} after ${artifact.turns.length} turns.

Transcript:
${turnsView}

Score four dimensions, each 0.0 to 1.0:

  intent_fulfilled: Did the bot meaningfully address what the user asked for?
  respected_constraints: Did it stay within capital / DD / venue constraints (or refuse cleanly if asked to violate)?
  actually_traded_or_committed: Did it take action (place trades, write a strategy, set config) — or did it just chat?
  productive_conversation: Was each turn moving forward, or stuck in loops / hedging / questions?

Output ONE JSON object, no prose, no fences:
  {"intent_fulfilled": 0.0, "respected_constraints": 0.0, "actually_traded_or_committed": 0.0, "productive_conversation": 0.0, "notes": "<1-2 sentences>"}`
  const { result, raw } = llmCallJson<JudgeRubricScores>({ prompt, model: JUDGE_MODEL })
  return result ?? {
    intent_fulfilled: 0,
    respected_constraints: 0,
    actually_traded_or_committed: 0,
    productive_conversation: 0,
    notes: !raw.ok ? `judge_failed: ${raw.stderr.slice(0, 200)}` : `judge_unparseable: ${raw.output.slice(0, 200)}`,
  }
}

export function userSimJudge(opts: { dualJudge?: boolean } = {}): JudgeConfig<UserSimSessionResult, UserIntentScenario> {
  const useDual = opts.dualJudge ?? false
  return {
    name: 'user-sim-outcome',
    dimensions: [
      { key: 'intent_fulfilled', description: 'Did the bot address the user intent?' },
      { key: 'respected_constraints', description: 'Did it stay within capital/DD/venue caps?' },
      { key: 'actually_traded_or_committed', description: 'Did it take real action?' },
      { key: 'productive_conversation', description: 'Were turns moving forward?' },
      ...(useDual
        ? [
            { key: 'secondary_intent_fulfilled', description: 'Skeptical secondary judge — same intent question' },
            { key: 'secondary_actually_traded_or_committed', description: 'Skeptical secondary judge — same action question' },
            { key: 'judge_disagreement', description: 'L1 norm between primary and secondary on shared dimensions; high = unreliable judge' },
          ]
        : []),
    ],
    async score({ scenario, artifact }: { scenario: UserIntentScenario; artifact: UserSimSessionResult }) {
      const r = judgeViaClaude(scenario.intent, artifact)
      const composite =
        0.3 * r.intent_fulfilled +
        0.3 * r.respected_constraints +
        0.3 * r.actually_traded_or_committed +
        0.1 * r.productive_conversation
      const dimensions: Record<string, number> = {
        intent_fulfilled: r.intent_fulfilled,
        respected_constraints: r.respected_constraints,
        actually_traded_or_committed: r.actually_traded_or_committed,
        productive_conversation: r.productive_conversation,
      }
      let notes = r.notes
      if (useDual) {
        const s = judgeViaSkepticalSecondary(scenario.intent, artifact)
        dimensions.secondary_intent_fulfilled = s.intent_fulfilled
        dimensions.secondary_actually_traded_or_committed = s.actually_traded_or_committed
        const disagreement =
          Math.abs(r.intent_fulfilled - s.intent_fulfilled) +
          Math.abs(r.respected_constraints - s.respected_constraints) +
          Math.abs(r.actually_traded_or_committed - s.actually_traded_or_committed) +
          Math.abs(r.productive_conversation - s.productive_conversation)
        dimensions.judge_disagreement = disagreement
        notes = `primary: ${r.notes} | secondary: ${s.notes} | disagreement L1=${disagreement.toFixed(2)}`
      }
      return { composite, dimensions, notes }
    },
  }
}

// ─── Public entry: runEval over the K intent scenarios ─────────────────

export interface RunMultishotUserSimOptions {
  intents: UserIntent[]
  operatorUrl: string
  token: string
  runDir?: string
  /** Reps per scenario for bootstrap CI bands. Default 5 — refuse to
   *  publish a mean without an interval. */
  reps?: number
  seed?: number
  maxTurnsPerShot?: number
  perTurnTimeoutMs?: number
  labeledStore?: LabeledScenarioStore
  /** Which bot to run against — real (full product), null (echo), stall ("I'll think"). */
  botKind?: BotKind
  /** When true, also runs the skeptical secondary judge and surfaces
   *  judge-disagreement as a dimension. Default true — single-judge
   *  results are not allowed to ship without this verification. */
  dualJudge?: boolean
  /** Optional user-sim personas — when provided, scenarios are the
   *  cross-product of personas × intents (5 personas × N intents = 5N cells).
   *  When omitted, the base "demanding user" voice runs across intents
   *  (N cells). The persona axis is the multi-voice eval surface — a
   *  bot scoring high on a newbie persona's intents but low on a
   *  veteran's is a real product signal. */
  personas?: UserPersona[]
}

export async function runMultishotUserSim(
  opts: RunMultishotUserSimOptions,
): Promise<CampaignResult<UserSimSessionResult, UserIntentScenario>> {
  const scenarios = opts.personas && opts.personas.length > 0
    ? personaIntentScenarios(opts.personas, opts.intents)
    : intentScenarios(opts.intents)
  const botKind = opts.botKind ?? 'real'
  const dispatch = makeUserSimDispatch(
    {
      operatorUrl: opts.operatorUrl,
      token: opts.token,
      maxTurnsPerShot: opts.maxTurnsPerShot ?? 8,
      perTurnTimeoutMs: opts.perTurnTimeoutMs ?? 240_000,
    },
    botKind,
  )
  return runEval<UserIntentScenario, UserSimSessionResult>({
    scenarios,
    dispatch,
    judges: [userSimJudge({ dualJudge: opts.dualJudge ?? true })],
    runDir: opts.runDir ?? resolveRepo(`.evolve/eval-runs/multishot-user-sim-${botKind}-${Date.now()}`),
    reps: opts.reps ?? 5,
    storage: inMemoryCampaignStorage(),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.labeledStore ? { labeledStore: opts.labeledStore } : {}),
    captureSource: 'eval-run',
  })
}

// ─── Multishot WITH baseline comparison ──────────────────────────────

export interface BaselineComparisonResult {
  real: CampaignResult<UserSimSessionResult, UserIntentScenario>
  null_bot: CampaignResult<UserSimSessionResult, UserIntentScenario>
  stall_bot: CampaignResult<UserSimSessionResult, UserIntentScenario>
  /** Real - null and real - stall per scenario, in composite units. If
   *  real - null is <0.4 on any scenario, the judge is suspect. */
  per_scenario_deltas: Record<
    string,
    {
      real_mean: number
      null_mean: number
      stall_mean: number
      delta_vs_null: number
      delta_vs_stall: number
    }
  >
}

export async function runMultishotWithBaselines(
  opts: RunMultishotUserSimOptions,
): Promise<BaselineComparisonResult> {
  const [real, nullBot, stallBot] = await Promise.all([
    runMultishotUserSim({ ...opts, botKind: 'real' }),
    runMultishotUserSim({ ...opts, botKind: 'null' }),
    runMultishotUserSim({ ...opts, botKind: 'stall' }),
  ])
  const per_scenario_deltas: BaselineComparisonResult['per_scenario_deltas'] = {}
  for (const id of Object.keys(real.aggregates.byScenario)) {
    const rm = real.aggregates.byScenario[id]?.meanComposite ?? 0
    const nm = nullBot.aggregates.byScenario[id]?.meanComposite ?? 0
    const sm = stallBot.aggregates.byScenario[id]?.meanComposite ?? 0
    per_scenario_deltas[id] = {
      real_mean: rm,
      null_mean: nm,
      stall_mean: sm,
      delta_vs_null: rm - nm,
      delta_vs_stall: rm - sm,
    }
  }
  return { real, null_bot: nullBot, stall_bot: stallBot, per_scenario_deltas }
}
