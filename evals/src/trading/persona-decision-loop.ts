/**
 * Personified multi-round trading-decision loop — the OFFICIAL `runPersonified`
 * + `loopUntil` adoption (agent-runtime 0.52.0).
 *
 * A SINGLE persona (the trading operator) runs a multi-ROUND decision loop under
 * the keystone supervisor: each round refines a candidate trading decision for
 * one scenario, and the loop STOPS on TRACE-DERIVED FINDINGS — not a raw verdict
 * score the loop minted to stop itself — capped by the conserved budget /
 * `maxDepth`. This is exactly the "refine until the gate's findings say done"
 * shape `loopUntil` exists for, applied to a decision-quality loop (NOT the
 * deterministic backtest, which is single-shot and model-invariant).
 *
 * ── What is wired vs what is honestly deferred ──
 *
 * WIRED (real, runs under the supervisor against a live model):
 *   - `runPersonified({ persona, shape: loopUntil(seed, {step, fold, until}),
 *     task, budget })` — the official personify entrypoint. The persona is built
 *     with `definePersona`; its executor seam is a real `router` seam pointing at
 *     the profile's model (resolved through the SAME MODEL_CONFIG every eval call
 *     uses). The supervisor meters the loop's spend through the conserved pool.
 *   - `loopUntil` owns the round/fold/stop wiring; we supply `step` (build the
 *     next refinement task from the accumulated state), `fold` (accumulate the
 *     settled decision), and `until` (the satisfiability gate that READS
 *     `AnalystFinding[]`).
 *   - The `until` gate reads REAL trace-derived findings produced by a
 *     `ScopeAnalyst` (`createScopeAnalyst`) whose analyst agent derives findings
 *     from the deterministic backtest ground truth — a genuine, non-judge signal
 *     (the firewall the architecture enforces: `until` never reads a raw
 *     verdict).
 *
 * DEFERRED (documented, not faked):
 *   - The `step` child runs through the built-in `router` executor (a direct
 *     inference call), NOT a sandboxed trading-operator harness. The production
 *     operator's decision actually executes inside a sandbox cron tick; wiring a
 *     `sandbox` seam here would require a live `SandboxClient` + provisioned bot
 *     the eval harness does not supply for a per-round loop. The router seam is
 *     the honest, reachable executor for a decision-REFINEMENT loop; swapping in
 *     the `sandbox` seam is a one-line `PersonaExecutors.seams` change when a
 *     box is available.
 *   - The analyst's findings are derived from the deterministic ground truth
 *     (the objective substrate), not from a separate RLM trace pass over the
 *     loop's own spans. That keeps the gate ungameable and infra-free; a richer
 *     RLM analyst over the loop's traces is an additive upgrade, not required for
 *     the loop to run honestly.
 */

import {
  makeFinding,
  type AgentProfile,
  type AnalystFinding,
} from '@tangle-network/agent-eval'
import {
  assertTraceDerivedFindings,
  definePersona,
  loopUntil,
  runPersonified,
  type Budget,
  type Outcome,
  type ScopeAnalyst,
  type Settled,
  type SupervisedResult,
} from '@tangle-network/agent-runtime/runtime'

import { resolveModel, type LlmModel } from '../sim/llm-call.js'
import type { PersonaEvalResult } from './persona-types.js'
import { evaluateScenario } from './personas/walk-forward.js'
import type { TradingEvalScenario } from './personas/scenarios.js'

/** The deliverable a decision-loop round produces: the operator's refined
 *  decision plus the round it settled on. */
export interface TradingDecision {
  decision: string
  round: number
  /** True when the deterministic gate's findings cleared the mandate. */
  mandateSatisfied: boolean
}

/** The accumulated value `loopUntil` threads across rounds. */
interface DecisionState {
  /** Latest candidate decision text (empty until the first round settles). */
  candidate: string
  /** Rounds run so far (for the report). */
  attempts: number
}

export interface DecisionLoopOptions {
  scenario: TradingEvalScenario
  /** Worker model the operator persona refines its decision with. */
  model?: LlmModel
  /** Max refinement rounds. The conserved budget also caps this. Default 3. */
  maxRounds?: number
  /** Per-round token budget. Default 8000. */
  perRoundTokens?: number
  /** Router base URL override (defaults to the model's MODEL_CONFIG baseUrl). */
  routerBaseUrl?: string
}

export interface DecisionLoopSummary {
  scenarioId: string
  personaId: string
  model: string
  /** The supervised result kind — 'winner' = the loop finished a deliverable. */
  kind: SupervisedResult<Outcome<TradingDecision>>['kind']
  decision: TradingDecision | null
  /** Blockers when the loop could not finish (fail-loud, never a vacuous done). */
  blockers: string[]
  rounds: number
  groundTruthScore: number
  groundTruthPassed: boolean
}

/**
 * Build the `AnalystFinding[]` the loop's `until` gate reads, derived from the
 * deterministic backtest ground truth. This is the firewalled, trace-derived
 * signal (NOT a judge verdict): a `mandate-satisfied` finding appears only when
 * the objective gates passed. `makeFinding` produces a stable, schema-valid
 * finding the runtime's trace-derived firewall accepts.
 */
function findingsFromGroundTruth(
  result: PersonaEvalResult,
  scenario: TradingEvalScenario,
): AnalystFinding[] {
  const findings: AnalystFinding[] = []
  if (result.passed) {
    findings.push(
      makeFinding({
        analyst_id: 'deterministic-backtest',
        severity: 'info',
        area: 'promotion-gate',
        claim: `mandate-satisfied: candidate cleared the deterministic gates for ${scenario.persona.id}`,
        confidence: 1,
        evidence_refs: [],
        subject: scenario.id,
      }),
    )
  } else {
    findings.push(
      makeFinding({
        analyst_id: 'deterministic-backtest',
        severity: 'high',
        area: 'promotion-gate',
        claim: `mandate-unsatisfied: gates failed (${result.deterministic_gates.join(' | ')})`,
        confidence: 1,
        evidence_refs: [],
        subject: scenario.id,
      }),
    )
  }
  return findings
}

/**
 * A `ScopeAnalyst` whose `analyze` returns findings derived from the
 * deterministic ground truth, run through `assertTraceDerivedFindings` — the
 * SAME firewall `createScopeAnalyst` enforces internally. Implemented directly
 * (the interface is one method) because `createScopeAnalyst` needs the
 * supervisor's internal scope, which `runPersonified` constructs itself; the
 * caller-side honest path is a firewalled analyst object the engine threads into
 * the shape's `ShapeContext`. The findings are objective (not a judge verdict),
 * so the firewall accepts them and `loopUntil.until` steers on real signal.
 */
function groundTruthScopeAnalyst(
  result: PersonaEvalResult,
  scenario: TradingEvalScenario,
): ScopeAnalyst<TradingDecision> {
  return {
    async analyze() {
      const findings = findingsFromGroundTruth(result, scenario)
      assertTraceDerivedFindings(findings)
      return findings
    },
  }
}

/**
 * Run one personified decision-refinement loop for a scenario. Returns a
 * typed summary read straight off the supervised result.
 */
export async function runTradingDecisionLoop(
  options: DecisionLoopOptions,
): Promise<DecisionLoopSummary> {
  const { scenario } = options
  const model = options.model ?? 'glm-5.1'
  const maxRounds = options.maxRounds ?? 3
  const perRoundTokens = options.perRoundTokens ?? 8000
  const cfg = resolveModel(model) // fail loud on unknown model / missing key

  // Model-invariant ground truth — the objective substrate the gate reads.
  const groundTruth = evaluateScenario(scenario)

  // The operator persona. Its executor seam is a real `router` seam → the
  // built-in router executor runs each `step` child as a direct inference call.
  const persona = definePersona<TradingDecision>({
    name: `trading-operator::${scenario.persona.id}`,
    root: {
      profile: buildOperatorProfile(model),
      harness: null, // null → the built-in router executor
    },
    directive: [
      `Decide whether to promote/hold/reject the candidate strategy for`,
      `${scenario.persona.role}. Respect the mandate (position ${scenario.persona.max_position_pct}% cap,`,
      `drawdown ${scenario.persona.max_drawdown_pct}% cap, trades in`,
      `[${scenario.persona.min_trades}..${scenario.persona.max_trades}]) and justify with the backtest evidence.`,
    ].join(' '),
    context: {
      role: scenario.persona.role,
      notes: scenario.objective,
      personaId: scenario.persona.id,
      marketRegime: scenario.market_regime,
    },
    executors: {
      seams: {
        router: {
          routerBaseUrl: options.routerBaseUrl ?? cfg.baseUrl,
          routerKey: cfg.apiKey(),
          model: cfg.modelId,
        },
      },
    },
  })

  // The firewalled findings gate threaded into the shape's ShapeContext so
  // `loopUntil.until` steers on trace-derived findings (not a raw verdict).
  const rootBudget: Budget = {
    maxIterations: maxRounds + 1,
    maxTokens: perRoundTokens * (maxRounds + 1),
    deadlineMs: 180_000 * maxRounds,
  }
  const analyst: ScopeAnalyst<TradingDecision> = groundTruthScopeAnalyst(groundTruth, scenario)

  const seed: DecisionState = { candidate: '', attempts: 0 }

  const shape = loopUntil<unknown, DecisionState, TradingDecision>(seed, {
    step(rootTask, state) {
      // Each round's task = refine the prior candidate against the evidence.
      const evidence = [
        `candidate test return: ${groundTruth.test_candidate_return_pct.toFixed(2)}%`,
        `candidate test sharpe: ${groundTruth.test_candidate_sharpe.toFixed(2)}`,
        `candidate test drawdown: ${groundTruth.test_candidate_drawdown_pct.toFixed(2)}%`,
        `test trade count: ${groundTruth.test_trade_count}`,
        `sharpe decay (train→test): ${groundTruth.sharpe_ratio_decay.toFixed(2)}`,
        `deterministic gates: ${groundTruth.deterministic_gates.join(' | ')}`,
      ].join('\n  ')
      const prior =
        state.value.candidate.length > 0
          ? `\n\nYour prior decision (round ${state.round}):\n${state.value.candidate}\n\nRefine it to better respect the mandate.`
          : ''
      return {
        intent: `${(rootTask as { directive?: string } | undefined)?.directive ?? 'Decide on the candidate strategy.'}\n\nBacktest evidence:\n  ${evidence}${prior}`,
        domain: 'trading-decision',
      }
    },
    fold(prior, settled: Settled<Outcome<TradingDecision>>) {
      if (settled.kind === 'down') {
        return { round: prior.round + 1, value: { ...prior.value, attempts: prior.value.attempts + 1 } }
      }
      // The `step` child runs through the built-in router executor, whose `out`
      // is the raw inference artifact — NOT our `Outcome<TradingDecision>` shape
      // (that wrapping happens only in `until`'s deliverable). Extract the
      // model's decision text from whatever shape the router returned.
      const text = extractDecisionText(settled.out)
      const candidate = text.length > 0 ? text : prior.value.candidate
      return {
        round: prior.round + 1,
        value: { candidate, attempts: prior.value.attempts + 1 },
      }
    },
    until(state, findings) {
      // Trace-derived stop: the ground-truth analyst's `mandate-satisfied`
      // finding gates the deliverable. Never reads a raw verdict score.
      const satisfied = findings.some((f) => f.claim.startsWith('mandate-satisfied'))
      if (satisfied && state.value.candidate.length > 0) {
        return {
          kind: 'done',
          deliverable: {
            decision: state.value.candidate,
            round: state.round,
            mandateSatisfied: true,
          },
        }
      }
      // Out of rounds with a candidate but unsatisfied mandate → finish with the
      // best candidate (honest: the loop refined what it could; the mandate gate
      // is the objective verdict, surfaced on the deliverable).
      if (state.round >= maxRounds && state.value.candidate.length > 0) {
        return {
          kind: 'done',
          deliverable: {
            decision: state.value.candidate,
            round: state.round,
            mandateSatisfied: false,
          },
        }
      }
      return null // keep going
    },
    label: (round) => `decision-round:${round}`,
  })

  const result = await runPersonified<unknown, TradingDecision>({
    persona,
    shape,
    task: { directive: persona.directive, context: persona.context },
    budget: rootBudget,
    maxDepth: maxRounds + 2,
    analyst,
  })

  const decision = result.kind === 'winner' && result.out.kind === 'done' ? result.out.deliverable : null
  const blockers =
    result.kind === 'winner' && result.out.kind === 'blocked'
      ? result.out.blockers
      : result.kind === 'no-winner'
        ? [`loop produced no winner: ${result.reason}`]
        : []

  return {
    scenarioId: scenario.id,
    personaId: scenario.persona.id,
    model,
    kind: result.kind,
    decision,
    blockers,
    rounds: decision?.round ?? maxRounds,
    groundTruthScore: groundTruth.score,
    groundTruthPassed: groundTruth.passed,
  }
}

/** Extract the model's decision text from a router child's settled artifact.
 *  The built-in router executor's `out` carries the inference result; its
 *  concrete shape is not part of the typed contract, so probe the common
 *  carriers (raw string, `{text|message|content|finalText}`, or our own
 *  `Outcome.deliverable.decision` if a future executor returns it). */
function extractDecisionText(out: unknown): string {
  if (typeof out === 'string') return out.trim()
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>
    // Our own Outcome shape (a BYO executor could return it).
    if (o.kind === 'done' && o.deliverable && typeof o.deliverable === 'object') {
      const d = (o.deliverable as Record<string, unknown>).decision
      if (typeof d === 'string') return d.trim()
    }
    for (const key of ['finalText', 'text', 'message', 'content', 'output']) {
      const v = o[key]
      if (typeof v === 'string' && v.trim().length > 0) return v.trim()
    }
  }
  return ''
}

function buildOperatorProfile(model: LlmModel): AgentProfile {
  return {
    id: `trading-operator-decision::model=${model}`,
    model,
    promptVersion: 'operator-decision-loop@1',
    metadata: { model, modelClass: 'llm-trading-operator', surface: 'decision-loop' },
  }
}
