import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { importAgentEval } from '../lib/agent-eval.js'
import { sha256 } from '../lib/crypto.js'
import { currentCommitSha, runPersonaSuite } from './persona-runner.js'
import { type PersonaEvalResult } from './persona-types.js'
import { tradingLifecyclePersonas } from './lifecycle-personas.js'
import type {
  LifecycleLabel,
  StrategyRevision,
  TradingLifecyclePersona,
  TradingLifecycleRun,
} from './lifecycle-types.js'

type LifecycleMode = 'deterministic' | 'real-api'

export interface LifecycleEvalOptions {
  personaReportPath: string
  outputPath: string
  feedbackJsonlPath?: string
  mode?: LifecycleMode
  maxAgentTurns?: number
}

interface RealApiContext {
  tradingApiUrl: string
  token: string
  baseSnapshotId: string
  parentRevisionId?: string
}

export async function runTradingLifecycleEval(options: LifecycleEvalOptions): Promise<{
  suite: string
  mode: LifecycleMode
  total: number
  passed: number
  failed: number
  output: string
  feedback_jsonl: string
  runs: TradingLifecycleRun[]
}> {
  const mode = options.mode ?? 'deterministic'
  const personaReport = runPersonaSuite(options.personaReportPath)
  const scenarioById = new Map(personaReport.results.map((result) => [result.scenario_id, result]))
  const personas = typeof options.maxAgentTurns === 'number' && options.maxAgentTurns > 0
    ? tradingLifecyclePersonas.map((persona) => ({ ...persona, turns: persona.turns.slice(0, options.maxAgentTurns) }))
    : tradingLifecyclePersonas
  const realApi = mode === 'real-api' ? await prepareRealApiContext() : undefined

  const runs: TradingLifecycleRun[] = []
  for (const persona of personas) {
    runs.push(await runPersonaLifecycle(persona, scenarioById, mode, realApi))
  }

  const passed = runs.filter((run) => run.validation.pass).length
  const summary = {
    suite: mode === 'real-api' ? 'trading-lifecycle-real-api' : 'trading-lifecycle-user-simulation',
    mode,
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

async function runPersonaLifecycle(
  persona: TradingLifecyclePersona,
  scenarioById: Map<string, PersonaEvalResult>,
  mode: LifecycleMode,
  realApi?: RealApiContext,
): Promise<TradingLifecycleRun> {
  const revisions: StrategyRevision[] = []
  for (let index = 0; index < persona.turns.length; index += 1) {
    const turn = persona.turns[index]
    if (!turn) continue
    const revision = baseRevision(persona, turn.intent, index)
    revisions.push(mode === 'real-api' && realApi
      ? await runRealApiRevision(persona, index, revision, realApi)
      : revision)
  }
  return {
    scenarioId: persona.id,
    persona,
    revisions,
    validation: validateLifecycle(persona, revisions, scenarioById, mode),
  }
}

function baseRevision(persona: TradingLifecyclePersona, intent: string, index: number): StrategyRevision {
  return {
    id: `${persona.id}-rev-${index}`,
    turn: index,
    userIntent: intent as StrategyRevision['userIntent'],
    description: deterministicRevisionDescription(persona, intent),
    artifactType: intent === 'find_new_pairs' ? 'research_plan' : 'harness_config',
    riskPosture: intent === 'risk_adjustment' && persona.riskProfile !== 'aggressive'
      ? 'risk_off'
      : persona.riskProfile,
    testsRun: [
      'cargo test -p trading-runtime persona_eval_suite_has_required_coverage_and_passes',
      'POST /market-data/candles',
      'POST /evolution/self-improve',
      'GET /evolution/revision-arena',
    ],
    backtestScenarioIds: scenarioIdsForTurn(intent, persona.strategyFocus),
  }
}

async function runRealApiRevision(
  persona: TradingLifecyclePersona,
  index: number,
  revision: StrategyRevision,
  ctx: RealApiContext,
): Promise<StrategyRevision> {
  const turn = persona.turns[index]
  if (!turn) return revision

  const patch = [
    `diff --git a/eval-lifecycle/${persona.id}.md b/eval-lifecycle/${persona.id}.md`,
    `+turn=${index}`,
    `+intent=${turn.intent}`,
    `+message=${turn.message}`,
  ].join('\n')
  const response = await postJson<SelfImproveResponse>(ctx, '/evolution/self-improve', {
    user_intent: `${turn.message} Expected behavior: ${turn.expectedAgentBehavior.join('; ')}`,
    current: backtestConfig(),
    candidate: candidateForIntent(turn.intent),
    token: 'ETH',
    train_pct: 0.7,
    min_paper_trades: 20,
    max_paper_drawdown_pct: revision.riskPosture === 'risk_off' ? 3 : 10,
    sandbox_mutation: {
      base_snapshot_id: ctx.baseSnapshotId,
      ...(ctx.parentRevisionId ? { parent_revision_id: ctx.parentRevisionId } : {}),
      patch,
      files_changed: [`eval-lifecycle/${persona.id}.md`],
      tests: revision.testsRun,
      status: 'candidate',
    },
  })
  const arena = await getJson<RevisionArenaResponse>(ctx, '/evolution/revision-arena')
  const sandboxRevisionId = asOptionalString(response.run.sandbox_revision_id)
  if (sandboxRevisionId) ctx.parentRevisionId = sandboxRevisionId

  const realInfra: NonNullable<StrategyRevision['realInfra']> = {
    tradingApiUrl: ctx.tradingApiUrl,
    snapshotId: ctx.baseSnapshotId,
    selfImprovementRunId: response.run.run_id,
    promotionApproved: response.promotion.approved,
    blockers: response.promotion.blockers,
    candlesUsed: response.promotion.candles_used,
    arenaActiveRevisionId: arena.active_revision_id,
    arenaRevisionCount: arena.revisions.length,
  }
  if (sandboxRevisionId) realInfra.sandboxRevisionId = sandboxRevisionId

  return {
    ...revision,
    description: `Real API self-improvement run ${response.run.run_id} for turn ${index}: ${turn.message}`,
    realInfra,
  }
}

async function prepareRealApiContext(): Promise<RealApiContext> {
  const tradingApiUrl = trimTrailingSlash(process.env.TRADING_EVAL_TRADING_URL ?? '')
  const token = process.env.TRADING_EVAL_BOT_TOKEN ?? process.env.TRADING_API_TOKEN ?? ''
  if (!tradingApiUrl || !token) {
    throw new Error('real-api lifecycle eval requires TRADING_EVAL_TRADING_URL and TRADING_EVAL_BOT_TOKEN')
  }
  const ctx: RealApiContext = { tradingApiUrl, token, baseSnapshotId: '' }
  await getJson(ctx, '/health')
  await postJson(ctx, '/market-data/candles', { candles: loadRealApiCandles() })
  const snapshot = await postJson<SandboxSnapshot>(ctx, '/evolution/sandbox/snapshot', {
    base_repo: 'https://github.com/tangle-network/ai-trading-blueprint',
    base_ref: currentCommitSha(),
    base_commit: currentCommitSha(),
    base_image_digest: process.env.TRADING_EVAL_IMAGE_DIGEST ?? 'local-dev',
    workspace_digest: sha256({ commit: currentCommitSha(), suite: 'trading-lifecycle-real-api' }),
    workspace_path: process.cwd(),
    notes: 'Lifecycle eval baseline snapshot; revision 0 is the activated starting state.',
  })
  ctx.baseSnapshotId = snapshot.snapshot_id
  return ctx
}

async function getJson<T = unknown>(ctx: RealApiContext, path: string): Promise<T> {
  return requestJson<T>(ctx, 'GET', path)
}

async function postJson<T = unknown>(ctx: RealApiContext, path: string, body: unknown): Promise<T> {
  return requestJson<T>(ctx, 'POST', path, body)
}

async function requestJson<T>(ctx: RealApiContext, method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`${ctx.tradingApiUrl}${path}`, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`)
  }
  return JSON.parse(text) as T
}

function syntheticEvolutionCandles() {
  const candles = []
  for (let i = 0; i < 80; i += 1) {
    const base = i < 40 ? 120 - i * 0.8 : 88 + (i - 40) * 1.1
    candles.push({
      timestamp: i * 3600,
      token: 'ETH',
      open: base.toFixed(2),
      high: (base + 1.2).toFixed(2),
      low: (base - 0.7).toFixed(2),
      close: (base + 0.4).toFixed(2),
      volume: '100000',
    })
  }
  return candles
}

function loadRealApiCandles(): unknown[] {
  const candlesJson = process.env.TRADING_EVAL_CANDLES_JSON
  if (candlesJson) {
    const parsed = JSON.parse(readFileSync(candlesJson, 'utf8')) as unknown
    if (Array.isArray(parsed)) return parsed
    if (isRecord(parsed) && Array.isArray(parsed.candles)) return parsed.candles
    throw new Error(`TRADING_EVAL_CANDLES_JSON must point to a JSON array or {"candles":[...]}; got ${candlesJson}`)
  }
  if (process.env.TRADING_EVAL_ALLOW_SYNTHETIC_CANDLES === '1') {
    return syntheticEvolutionCandles()
  }
  throw new Error('real-api lifecycle eval requires TRADING_EVAL_CANDLES_JSON with recorded market candles; set TRADING_EVAL_ALLOW_SYNTHETIC_CANDLES=1 only for API-route smoke tests')
}

interface EvalBacktestConfig {
  initial_capital: string
  harness: {
    version: number
    entry_rules: Array<{
      signal: { type: string; period: number }
      condition: { type: string; threshold: number }
      weight: number
      tokens: string[]
    }>
    exit_rules: Array<{ type: string; pct: number }>
    filters: Array<Record<string, string>>
    position_sizing: { method: string; fraction: number }
    entry_threshold: number
    max_positions: number
  }
  slippage: { model: string; bps: number }
  gas_cost_usd: string
  taker_fee_bps: number
}

function backtestConfig(): EvalBacktestConfig {
  return {
    initial_capital: '10000',
    harness: {
      version: 1,
      entry_rules: [{
        signal: { type: 'rsi', period: 5 },
        condition: { type: 'below', threshold: 40 },
        weight: 1,
        tokens: [],
      }],
      exit_rules: [
        { type: 'take_profit', pct: 10 },
        { type: 'stop_loss', pct: 8 },
      ],
      filters: [],
      position_sizing: { method: 'fixed_fraction', fraction: 0.3 },
      entry_threshold: 0.3,
      max_positions: 3,
    },
    slippage: { model: 'fixed_bps', bps: 5 },
    gas_cost_usd: '1',
    taker_fee_bps: 5,
  }
}

function candidateForIntent(intent: string) {
  const candidate = backtestConfig()
  candidate.harness.version = 2
  if (intent === 'risk_adjustment') {
    candidate.harness.position_sizing.fraction = 0.12
    candidate.harness.entry_threshold = 0.42
    candidate.harness.exit_rules = [
      { type: 'take_profit', pct: 8 },
      { type: 'stop_loss', pct: 5 },
    ]
  } else if (intent === 'microstructure_review') {
    candidate.harness.entry_threshold = 0.36
    candidate.harness.filters = [{ type: 'min_volume', threshold: '50000' }]
  } else if (intent === 'find_new_pairs') {
    candidate.harness.max_positions = 2
    const firstRule = candidate.harness.entry_rules[0]
    if (firstRule) firstRule.tokens = ['ETH']
  }
  return candidate
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
  mode: LifecycleMode,
) {
  const labels: LifecycleLabel[] = []
  let score = 1

  for (const revision of revisions) {
    for (const scenarioId of revision.backtestScenarioIds) {
      const result = scenarioById.get(scenarioId)
      if (!result) {
        labels.push(errorLabel('environment', 'missing_backtest', scenarioId, `No deterministic backtest result exists for ${scenarioId}.`))
        score -= 0.25
        continue
      }
      if (!result.passed) {
        labels.push(errorLabel('metric', 'backtest_failed', scenarioId, `${scenarioId} failed deterministic gates.`))
        score -= 0.25
      }
      if (revision.riskPosture === 'risk_off' && result.test_candidate_drawdown_pct > 3) {
        labels.push(errorLabel('policy', 'risk_off_drawdown_breach', result.test_candidate_drawdown_pct, `Risk-off turn exceeded 3% drawdown on ${scenarioId}.`))
        score -= 0.2
      }
    }

    if (mode === 'real-api') {
      if (!revision.realInfra?.selfImprovementRunId || !revision.realInfra.sandboxRevisionId) {
        labels.push(errorLabel('environment', 'missing_real_infra_evidence', revision.id, `${revision.id} did not create a real self-improvement run and sandbox revision.`))
        score -= 0.4
      }
      if ((revision.realInfra?.arenaRevisionCount ?? 0) < 2) {
        labels.push(errorLabel('environment', 'revision_arena_missing_candidate', revision.id, `${revision.id} was not visible in /evolution/revision-arena.`))
        score -= 0.2
      }
      if (revision.realInfra?.promotionApproved) {
        labels.push(errorLabel('policy', 'unexpected_live_promotion', revision.id, `${revision.id} should remain blocked without persisted paper evidence.`))
        score -= 0.25
      }
      if (!revision.realInfra?.blockers.some((blocker) => blocker.includes('paper'))) {
        labels.push(errorLabel('policy', 'missing_paper_evidence_gate', revision.id, `${revision.id} was not blocked by persisted paper evidence.`))
        score -= 0.2
      }
    }
  }

  if (!revisions.some((revision) => revision.userIntent === 'microstructure_review')) {
    labels.push(errorLabel('judge', 'missing_microstructure_review', false, 'Lifecycle did not force the agent to evaluate changing counterparty behavior.'))
    score -= 0.2
  }

  if (labels.length === 0) {
    labels.push({
      source: 'system',
      kind: 'accepted',
      value: true,
      reason: `${persona.id} satisfied lifecycle gates.`,
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
      real_api_runs: revisions.filter((revision) => revision.realInfra).length,
    },
  }
}

function errorLabel(source: LifecycleLabel['source'], kind: string, value: string | number | boolean, reason: string): LifecycleLabel {
  return { source, kind, value, reason, severity: 'error' }
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
        realInfra: revision.realInfra,
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface SelfImproveResponse {
  run: {
    run_id: string
    sandbox_revision_id?: string | null
  }
  promotion: {
    approved: boolean
    blockers: string[]
    candles_used: number
  }
}

interface SandboxSnapshot {
  snapshot_id: string
}

interface RevisionArenaResponse {
  active_revision_id: string
  revisions: unknown[]
}
