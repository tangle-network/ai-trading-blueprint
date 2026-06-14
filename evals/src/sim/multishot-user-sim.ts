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
import { runEval } from '@tangle-network/agent-eval/campaign'
import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'

/** Local disk-backed CampaignStorage. The bundled `fsCampaignStorage`
 *  from @tangle-network/agent-eval uses a dynamic `require('fs')` that
 *  fails under ESM ("Dynamic require of 'fs' is not supported"), so we
 *  re-implement the four-method interface inline against `node:fs`. */
function localFsCampaignStorage() {
  return {
    ensureDir(dir: string): void {
      fsMkdirSync(dir, { recursive: true })
    },
    exists(path: string): boolean {
      return fsExistsSync(path)
    },
    read(path: string): string | undefined {
      try {
        return fsReadFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    write(path: string, content: string | Uint8Array): void {
      fsWriteFileSync(path, content)
    },
  }
}

import { resolveRepo } from '../lib/repo.js'
import {
  judgeViaSkepticalSecondary,
  runNullBotSession,
  runStallBotSession,
} from './baseline-bots.js'
import { runProfileJson } from './llm-call.js'
import { primaryRubricJudgeProfile } from '../profiles/primary-rubric-judge.js'
import { deterministicAgentEnv, OperatorClient } from './operator-client.js'
import { inferStrategyTypeFromVenues } from './strategy-type.js'
import type { UserPersona } from './user-personas.js'
import {
  nextUserTurn,
  runUserSimSession,
  type UserIntent,
  type UserSimSessionResult,
} from './user-sim-driver.js'

export type BotKind = 'real' | 'null' | 'stall'


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
  /** Bearer token resolved by `local-stack-runner.ts::createOperatorSession`.
   *  Used directly when `privateKey` isn't supplied; ignored otherwise. */
  token: string
  /** If set, the dispatch will (re)authenticate via OperatorClient.authenticate(),
   *  enabling automatic token refresh on expiry — required for campaigns longer
   *  than the operator-api session lifetime (~60min). When omitted, falls back
   *  to the legacy no-refresh path that 401s mid-run on long campaigns. */
  privateKey?: string
  maxTurnsPerShot: number
  perTurnTimeoutMs: number
  /** Per-cell override for the in-sandbox agent's LLM credentials. When set,
   *  this is the env `configureSecrets` writes into the bot's sandbox — i.e.
   *  it pins WHICH model the REAL operator agent runs (the PROFILE axis of the
   *  unified matrix). When omitted, falls back to `deterministicAgentEnv()`
   *  (the single-profile default). */
  agentEnv?: Record<string, string>
}

export function makeUserSimDispatch(opts: MultishotDispatchOptions, botKind: BotKind = 'real') {
  return async (scenario: UserIntentScenario): Promise<UserSimSessionResult> => {
    try {
      return await dispatchInner(opts, botKind, scenario)
    } catch (e) {
      // Surface the failure reason immediately to stderr — the campaign
      // substrate records cellsFailed but swallows the error text. We
      // want to SEE what broke without waiting for the post-mortem.
      process.stderr.write(`  ✗ dispatch failed (${botKind}/${scenario.id}): ${(e as Error).message?.slice(0, 400) ?? e}\n`)
      throw e
    }
  }
}

async function dispatchInner(
  opts: MultishotDispatchOptions,
  botKind: BotKind,
  scenario: UserIntentScenario,
): Promise<UserSimSessionResult> {
    // Bind the persona to nextUserTurn so the stub bots (null/stall) get
    // persona-flavoured user turns the same way the real bot path does.
    const persona = scenario.persona ?? null
    const turnGen = async (intent: UserIntent, priorTurns: Parameters<typeof nextUserTurn>[1]) =>
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
    // Prefer authenticate() so the token can self-refresh mid-cell; fall
    // back to the raw-token constructor when no privateKey is wired through.
    const client = opts.privateKey
      ? await OperatorClient.authenticate(opts.operatorUrl, opts.privateKey)
      : new OperatorClient({ operatorUrl: opts.operatorUrl, token: opts.token })
    const botId = await client.provisionBot({
      prompt: scenario.intent.text,
      name: scenario.intent.text.slice(0, 50),
      // Explicit intent override wins (MM on a DEX venue, multi-venue
      // portfolio); otherwise infer from venues. This is the single
      // provisioning SOT — same call the product's create path makes.
      strategy_type: scenario.intent.strategy_type ?? inferStrategyTypeFromVenues(scenario.intent.venues),
    })
    // Bot create is instant in operator DB; vault resolution is async
    // (on-chain). configureSecrets returns 500 without a resolved vault.
    await client.waitForVaultResolved(botId)
    // Then configure sandbox-agent LLM credentials before chatting. A per-cell
    // override (the matrix PROFILE axis) pins which model the REAL operator runs;
    // otherwise the single-profile default applies.
    await client.configureSecrets(botId, opts.agentEnv ?? deterministicAgentEnv())
    const sessionId = await client.createSession(botId, `user-sim:${scenario.id}`)
    return runUserSimSession({
      intent: scenario.intent,
      persona,
      operatorUrl: opts.operatorUrl,
      token: opts.token,
      ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
      botId,
      sessionId,
      maxTurns: opts.maxTurnsPerShot,
      perTurnTimeoutMs: opts.perTurnTimeoutMs,
      stallMs: opts.perTurnTimeoutMs,
    })
}

// ─── Judge: an LLM rubric over the session artifact ────────────────────

interface JudgeRubricScores {
  intent_fulfilled: number          // 0..1
  respected_constraints: number     // 0..1
  actually_traded_or_committed: number  // 0..1
  productive_conversation: number   // 0..1
  notes: string
}

async function judgePrimaryRubric(intent: UserIntent, artifact: UserSimSessionResult): Promise<JudgeRubricScores> {
  const turnsView = artifact.turns
    .map((t) => `  TURN ${t.turn}:\n    USER: ${t.user_message}\n    BOT:  ${t.bot_reply_text.slice(0, 1200)}`)
    .join('\n')
  // Rubric + model live in the profile (evals/src/profiles/primary-rubric-judge.ts);
  // here we only supply the per-cell data as the user message.
  const message = `User's intent: "${intent.text}"
Hard constraints: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues allowed: ${intent.venues.join(', ')}.
Session ended by: ${artifact.ended_by} after ${artifact.turns.length} turns.

Transcript:
${turnsView}`
  const { result, raw } = await runProfileJson<JudgeRubricScores>(primaryRubricJudgeProfile, { message })
  return result ?? {
    intent_fulfilled: 0,
    respected_constraints: 0,
    actually_traded_or_committed: 0,
    productive_conversation: 0,
    notes: !raw.ok ? `judge_failed: ${raw.stderr.slice(0, 200)}` : `judge_unparseable: ${raw.output.slice(0, 200)}`,
  }
}

/** State-based signals derived from the bot's OBSERVABLE work-product
 *  (bot_artifacts), not from transcript prose. This is the Gen-2 core:
 *  "did the world change the way the brief asked" beats "did the chat
 *  sound good." A bot that wrote a strategy + placed a (paper) trade
 *  scores high even with terse prose; a bot with eloquent prose and zero
 *  state change cannot exceed the prose-only ceiling.
 *
 *  - committed: 1.0 if it actually traded (observable), 0.5 if it
 *    committed a strategy (harness present / self-improvement fired) but
 *    didn't trade yet, else falls back to a DISCOUNTED prose claim (0.3×)
 *    because prose claims of action are cheap and gameable.
 *  - selfImprovement: did the headline capability (self-improve cycle)
 *    fire? Bonus for promotions. */
function deriveStateScores(
  artifact: UserSimSessionResult,
  proseTradedClaim: number,
): { committed: number; selfImprovement: number; evidence: string } {
  const a = artifact.bot_artifacts
  if (!a) {
    // No artifact inspection — fall back to a heavily-discounted prose claim.
    return {
      committed: 0.3 * proseTradedClaim,
      selfImprovement: 0,
      evidence: 'no bot_artifacts (inspection failed); prose claim discounted 0.3×',
    }
  }
  const trades = a.execution.trades_total
  const hasStrategy = a.current_strategy.harness_version !== undefined && a.current_strategy.harness_version > 0
  const cycles = a.self_improvement.cycles_fired
  const promoted = a.self_improvement.revisions_promoted

  let committed: number
  let evidence: string
  if (trades > 0) {
    committed = 1.0
    evidence = `${trades} trade(s) placed (${a.execution.trades_paper} paper / ${a.execution.trades_live} live)`
  } else if (hasStrategy || cycles > 0) {
    committed = 0.5
    evidence = `strategy committed (v${a.current_strategy.harness_version ?? '?'}, ${cycles} self-improve cycle(s)) but no trade yet`
  } else {
    committed = 0.3 * proseTradedClaim
    evidence = `no observable trade or strategy; prose claim discounted 0.3×`
  }

  const selfImprovement = cycles > 0 ? Math.min(1, 0.5 + 0.5 * (promoted > 0 ? 1 : 0)) : 0
  return { committed, selfImprovement, evidence }
}

/** The artifact-based score for ONE user-sim session, factored out of
 *  `userSimJudge` so other eval surfaces (the unified trading matrix) can score
 *  a real session WITHOUT re-running a `runEval` campaign. Composite weights
 *  OBSERVABLE state (trades/strategy/self-improve from `bot_artifacts`) at 55%
 *  and prose (rubric judge) at 45% — the same weighting `userSimJudge` uses. */
export interface UserSimArtifactScore {
  composite: number
  dimensions: Record<string, number>
  notes: string
}

export async function scoreUserSimArtifact(
  intent: UserIntent,
  artifact: UserSimSessionResult,
): Promise<UserSimArtifactScore> {
  const r = await judgePrimaryRubric(intent, artifact)
  const state = deriveStateScores(artifact, r.actually_traded_or_committed)
  const composite =
    0.20 * r.intent_fulfilled +
    0.15 * r.respected_constraints +
    0.40 * state.committed +
    0.15 * state.selfImprovement +
    0.10 * r.productive_conversation
  return {
    composite,
    dimensions: {
      intent_fulfilled: r.intent_fulfilled,
      respected_constraints: r.respected_constraints,
      actually_traded_or_committed: state.committed,
      self_improvement: state.selfImprovement,
      productive_conversation: r.productive_conversation,
      prose_traded_claim: r.actually_traded_or_committed,
    },
    notes: `${r.notes} | STATE: ${state.evidence}`,
  }
}

export function userSimJudge(opts: { dualJudge?: boolean } = {}): JudgeConfig<UserSimSessionResult, UserIntentScenario> {
  const useDual = opts.dualJudge ?? false
  return {
    name: 'user-sim-outcome',
    dimensions: [
      { key: 'intent_fulfilled', description: 'Did the bot address the user intent? (prose)' },
      { key: 'respected_constraints', description: 'Did it stay within capital/DD/venue caps? (prose)' },
      { key: 'actually_traded_or_committed', description: 'Observable state: did it trade/commit a strategy? (artifact-derived)' },
      { key: 'self_improvement', description: 'Did the self-improvement cycle fire? (artifact-derived)' },
      { key: 'productive_conversation', description: 'Were turns moving forward? (prose)' },
      { key: 'prose_traded_claim', description: 'What the prose judge CLAIMED re: action — for prose-vs-state gap analysis' },
      ...(useDual
        ? [
            { key: 'secondary_intent_fulfilled', description: 'Skeptical secondary judge — same intent question' },
            { key: 'secondary_actually_traded_or_committed', description: 'Skeptical secondary judge — same action question' },
            { key: 'judge_disagreement', description: 'L1 norm between primary and secondary on shared dimensions; high = unreliable judge' },
          ]
        : []),
    ],
    async score({ scenario, artifact }: { scenario: UserIntentScenario; artifact: UserSimSessionResult }) {
      const r = await judgePrimaryRubric(scenario.intent, artifact)
      // State-based override: actually_traded_or_committed comes from the
      // bot's OBSERVABLE work-product, not the prose judge's guess.
      const state = deriveStateScores(artifact, r.actually_traded_or_committed)
      // Composite weights observable state as the dominant signal (0.40 +
      // 0.15 self-improve = 55% from artifacts), prose as supporting.
      const composite =
        0.20 * r.intent_fulfilled +
        0.15 * r.respected_constraints +
        0.40 * state.committed +
        0.15 * state.selfImprovement +
        0.10 * r.productive_conversation
      const dimensions: Record<string, number> = {
        intent_fulfilled: r.intent_fulfilled,
        respected_constraints: r.respected_constraints,
        actually_traded_or_committed: state.committed,
        self_improvement: state.selfImprovement,
        productive_conversation: r.productive_conversation,
        prose_traded_claim: r.actually_traded_or_committed,
      }
      let notes = `${r.notes} | STATE: ${state.evidence}`
      if (useDual) {
        const s = await judgeViaSkepticalSecondary(scenario.intent, artifact)
        dimensions.secondary_intent_fulfilled = s.intent_fulfilled
        dimensions.secondary_actually_traded_or_committed = s.actually_traded_or_committed
        const disagreement =
          Math.abs(r.intent_fulfilled - s.intent_fulfilled) +
          Math.abs(r.respected_constraints - s.respected_constraints) +
          Math.abs(r.actually_traded_or_committed - s.actually_traded_or_committed) +
          Math.abs(r.productive_conversation - s.productive_conversation)
        dimensions.judge_disagreement = disagreement
        notes = `primary: ${notes} | secondary: ${s.notes} | disagreement L1=${disagreement.toFixed(2)}`
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
  /** Optional — passed through to dispatch so cells can auto-refresh tokens
   *  on expiry. Strongly recommended for any campaign with >12 real-arm cells
   *  (each cell is ~3-5min wall, and the operator-api token only lives 60min). */
  privateKey?: string
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
  /** Per-run override for the in-sandbox agent's LLM credentials — pins WHICH
   *  model the REAL operator agent runs. Used by the unified trading matrix to
   *  drive each PROFILE's model through the real operator stack. */
  agentEnv?: Record<string, string>
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
      ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
      maxTurnsPerShot: opts.maxTurnsPerShot ?? 8,
      // 900s default = 3× the bot's 5-min conversation cron. smoke v5 traces
      // showed turn-1 work spans multiple ticks (bot reads protocol, configures
      // integration, writes strategy) and 480s caught 0/12 turn-1 replies. The
      // bot is async-cron-driven; the per-turn budget must cover ≥3 ticks for
      // multi-step work to land. (The real fix is tick-driving — task #108 —
      // but a 3-cron budget makes the current sync-poll model honest.)
      perTurnTimeoutMs: opts.perTurnTimeoutMs ?? 900_000,
      ...(opts.agentEnv ? { agentEnv: opts.agentEnv } : {}),
    },
    botKind,
  )
  return runEval<UserIntentScenario, UserSimSessionResult>({
    scenarios,
    dispatch,
    judges: [userSimJudge({ dualJudge: opts.dualJudge ?? true })],
    runDir: opts.runDir ?? resolveRepo(`.evolve/eval-runs/multishot-user-sim-${botKind}-${Date.now()}`),
    reps: opts.reps ?? 5,
    // Disk-backed storage gives the campaign substrate cell-level
    // resumability — each cell's artifact + judge scores land in
    // <runDir>/cells/<cellId>/ as soon as the cell finishes. A SIGKILL
    // mid-campaign loses ONE cell, not all of them; the next run with the
    // same runDir resumes from where the last left off.
    storage: localFsCampaignStorage(),
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
  // Each arm gets its own runDir so the fs-backed campaign storage doesn't
  // collide on cells/<cellId>/ across arms. Resumability works per-arm:
  // re-running with the same outer runDir picks up where each arm left off.
  const armRunDir = (arm: BotKind): string | undefined =>
    opts.runDir ? `${opts.runDir}/${arm}` : undefined
  const [real, nullBot, stallBot] = await Promise.all([
    runMultishotUserSim({ ...opts, botKind: 'real', ...(armRunDir('real') ? { runDir: armRunDir('real')! } : {}) }),
    runMultishotUserSim({ ...opts, botKind: 'null', ...(armRunDir('null') ? { runDir: armRunDir('null')! } : {}) }),
    runMultishotUserSim({ ...opts, botKind: 'stall', ...(armRunDir('stall') ? { runDir: armRunDir('stall')! } : {}) }),
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
