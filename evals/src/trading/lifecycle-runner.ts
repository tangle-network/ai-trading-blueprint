import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { importAgentEval } from '../lib/agent-eval.js'
import { sha256 } from '../lib/crypto.js'
import { currentCommitSha, runPersonaSuite } from './persona-runner.js'
import { numericRaw, type PersonaEvalResult } from './persona-types.js'
import { tradingLifecyclePersonas } from './lifecycle-personas.js'
import type {
  LifecycleLabel,
  StrategyRevision,
  TradingLifecyclePersona,
  TradingLifecycleRun,
} from './lifecycle-types.js'

export interface LifecycleEvalOptions {
  personaReportPath: string
  outputPath: string
  feedbackJsonlPath?: string
}

export async function runTradingLifecycleEval(options: LifecycleEvalOptions): Promise<{
  suite: string
  total: number
  passed: number
  failed: number
  output: string
  feedback_jsonl: string
  runs: TradingLifecycleRun[]
}> {
  const personaReport = runPersonaSuite(options.personaReportPath)
  const scenarioById = new Map(personaReport.results.map((result) => [result.scenario_id, result]))
  const runs = tradingLifecyclePersonas.map((persona) => runPersonaLifecycle(persona, scenarioById))
  const passed = runs.filter((run) => run.validation.pass).length
  const summary = {
    suite: 'trading-lifecycle-user-simulation',
    total: runs.length,
    passed,
    failed: runs.length - passed,
    output: options.outputPath,
    commitSha: currentCommitSha(),
    runs,
  }

  mkdirSync(dirname(options.outputPath), { recursive: true })
  writeFileSync(options.outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  const feedbackJsonlPath = options.feedbackJsonlPath ?? '.evolve/agent-eval/trading-lifecycle-feedback.jsonl'
  await maybeEmitFeedbackTrajectories(runs, feedbackJsonlPath)

  return { ...summary, feedback_jsonl: feedbackJsonlPath }
}

function runPersonaLifecycle(
  persona: TradingLifecyclePersona,
  scenarioById: Map<string, PersonaEvalResult>,
): TradingLifecycleRun {
  const revisions = persona.turns.map((turn, index): StrategyRevision => {
    const scenarioIds = scenarioIdsForTurn(turn.intent, persona.strategyFocus)
    return {
      id: `${persona.id}-rev-${index}`,
      turn: index,
      userIntent: turn.intent,
      description: deterministicRevisionDescription(persona, turn.intent),
      artifactType: turn.intent === 'find_new_pairs' ? 'research_plan' : 'harness_config',
      riskPosture: turn.intent === 'risk_adjustment' && persona.riskProfile !== 'aggressive'
        ? 'risk_off'
        : persona.riskProfile,
      testsRun: ['cargo test -p trading-runtime persona_eval_suite_has_required_coverage_and_passes'],
      backtestScenarioIds: scenarioIds,
    }
  })
  const validation = validateLifecycle(persona, revisions, scenarioById)
  return {
    scenarioId: persona.id,
    persona,
    revisions,
    validation,
  }
}

function scenarioIdsForTurn(intent: string, focus: string[]): string[] {
  if (focus.includes('polymarket_clob')) {
    if (intent === 'microstructure_review') {
      return ['second_order_crowded_breakout_fade', 'third_order_crowded_alpha_decay']
    }
    if (intent === 'find_new_pairs') {
      return ['third_order_adaptive_counterparty_rotation']
    }
    return ['prediction_market_mm_misleading_signal', 'second_order_stop_cascade_recovery']
  }
  if (focus.includes('uniswap_v3')) {
    if (intent === 'microstructure_review') {
      return ['second_order_amm_rebalancer_flow', 'third_order_adaptive_counterparty_rotation']
    }
    return ['uniswap_v3_lp_range_rebalance', 'second_order_amm_rebalancer_flow']
  }
  return ['risk_on_arbitrage_dislocation_decay']
}

function deterministicRevisionDescription(persona: TradingLifecyclePersona, intent: string): string {
  switch (intent) {
    case 'initial_market_maker':
      return `Initial bounded strategy for ${persona.strategyFocus.join(', ')} with explicit risk limits.`
    case 'risk_adjustment':
      return persona.riskProfile === 'aggressive'
        ? 'Increase aggressiveness only through validated sizing/threshold changes.'
        : 'Reduce risk by tightening sizing, churn, and drawdown-sensitive thresholds.'
    case 'microstructure_review':
      return 'Analyze bot-pattern evidence and revise only when held-out validation supports the change.'
    case 'find_new_pairs':
      return 'Search adjacent markets and reject expansion when liquidity or edge evidence is weak.'
    default:
      return 'No-op revision.'
  }
}

function validateLifecycle(
  persona: TradingLifecyclePersona,
  revisions: StrategyRevision[],
  scenarioById: Map<string, PersonaEvalResult>,
) {
  const labels: LifecycleLabel[] = []
  let score = 1

  for (const revision of revisions) {
    for (const scenarioId of revision.backtestScenarioIds) {
      const result = scenarioById.get(scenarioId)
      if (!result) {
        labels.push({
          source: 'environment',
          kind: 'missing_backtest',
          value: scenarioId,
          reason: `No deterministic backtest result exists for ${scenarioId}.`,
          severity: 'error',
        })
        score -= 0.25
        continue
      }
      if (!result.passed) {
        labels.push({
          source: 'metric',
          kind: 'backtest_failed',
          value: scenarioId,
          reason: `${scenarioId} failed deterministic gates.`,
          severity: 'error',
        })
        score -= 0.25
      }
      if (revision.riskPosture === 'risk_off' && result.test_candidate_drawdown_pct > 3) {
        labels.push({
          source: 'policy',
          kind: 'risk_off_drawdown_breach',
          value: result.test_candidate_drawdown_pct,
          reason: `Risk-off turn exceeded 3% drawdown on ${scenarioId}.`,
          severity: 'error',
        })
        score -= 0.2
      }
    }
  }

  const hasMicrostructureTurn = revisions.some((revision) => revision.userIntent === 'microstructure_review')
  if (!hasMicrostructureTurn) {
    labels.push({
      source: 'judge',
      kind: 'missing_microstructure_review',
      value: false,
      reason: 'Lifecycle did not force the agent to evaluate changing counterparty behavior.',
      severity: 'error',
    })
    score -= 0.2
  }

  if (labels.length === 0) {
    labels.push({
      source: 'system',
      kind: 'accepted',
      value: true,
      reason: `${persona.id} satisfied deterministic lifecycle gates.`,
      severity: 'info',
    })
  }

  const boundedScore = Math.max(0, Math.min(1, score))
  return {
    pass: boundedScore >= 0.8 && labels.every((label) => label.severity !== 'error'),
    score: boundedScore,
    labels,
    metrics: {
      revisions: revisions.length,
      backtest_links: revisions.reduce((sum, revision) => sum + revision.backtestScenarioIds.length, 0),
      microstructure_turns: revisions.filter((revision) => revision.userIntent === 'microstructure_review').length,
    },
  }
}

async function maybeEmitFeedbackTrajectories(runs: TradingLifecycleRun[], feedbackJsonlPath: string): Promise<void> {
  const agentEval = await importAgentEval().catch(() => null)
  mkdirSync(dirname(feedbackJsonlPath), { recursive: true })
  for (const run of runs) {
    const input = {
      projectId: 'ai-trading-blueprint',
      scenarioId: run.scenarioId,
      task: {
        intent: run.persona.goal,
        context: {
          role: run.persona.role,
          strategyFocus: run.persona.strategyFocus,
          riskProfile: run.persona.riskProfile,
        },
      },
      attempts: run.revisions.map((revision, index) => ({
        id: revision.id,
        stepIndex: index,
        artifactType: revision.artifactType,
        artifact: revision,
        createdAt: new Date().toISOString(),
      })),
      labels: run.validation.labels.map((label) => ({
        ...label,
        createdAt: new Date().toISOString(),
      })),
      metadata: {
        configHash: sha256(run.persona),
        outcome: run.validation,
      },
    }
    const trajectory = agentEval?.createFeedbackTrajectory ? agentEval.createFeedbackTrajectory(input) : input
    appendFileSync(feedbackJsonlPath, `${JSON.stringify(trajectory)}\n`, 'utf8')
  }
}
