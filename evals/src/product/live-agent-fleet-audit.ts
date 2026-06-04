import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DEFAULT_OPERATOR_URL } from './active-user-lab.js'
import { OperatorApiError, OperatorClient } from '../sim/operator-client.js'

export type LoopMode = 'deterministic-fast-tick' | 'agentic-llm-run' | 'inactive' | 'unknown'
export type SelfImprovementState = 'active' | 'not-firing' | 'inaccessible' | 'unknown'
export type StrategyAlignment = 'aligned' | 'partial' | 'mismatch' | 'inactive'

export interface LiveFleetAuditOptions {
  operatorUrl?: string
  token?: string
  privateKey?: string
  outDir?: string
  limit?: number
}

interface EndpointCapture<T = unknown> {
  status: number
  ok: boolean
  json: T | null
  error?: string
}

interface BotRecord {
  id?: string
  name?: string
  strategy_type?: string | null
  paper_trade?: boolean | null
  trading_active?: boolean | null
  prompt?: string | null
  strategy_config?: unknown
}

interface BotListResponse {
  bots?: BotRecord[]
  total?: number
}

interface RunRecord {
  run_id?: string
  kind?: string
  workflow_kind?: string
  status?: string
  started_at?: number | string | null
  input_tokens?: number | string | null
  output_tokens?: number | string | null
  transcript_available?: boolean | null
  trace_id?: string | null
  session_id?: string | null
}

interface TradeRecord {
  id?: string
  trade_id?: string
  timestamp?: string
  created_at?: string
  executed_at?: string
  action?: string
  target_protocol?: string
  venue?: string
  protocol?: string
  token_in?: string
  token_out?: string
  asset?: string
  notional_usd?: string | number
  status?: string
  execution_status?: string
  pnl_usd?: string | number | null
  pnl?: string | number | null
  intent?: {
    action?: string
    token_in?: string
    token_out?: string
  }
}

interface UsageTelemetryEvent {
  event_id?: string
  timestamp?: string | number | null
  surface?: string | null
  operation?: string | null
  provider?: string | null
  model?: string | null
  status?: string | null
  token_count_status?: string | null
  input_tokens?: number | string | null
  output_tokens?: number | string | null
  total_tokens?: number | string | null
  cost_usd?: number | string | null
  cost_source?: string | null
  duration_ms?: number | string | null
  metadata?: unknown
}

export interface UsageTelemetrySummary {
  event_count: number
  synthetic_event_count: number
  trace_grounded_events: number
  events_with_reported_tokens: number
  events_with_reported_or_estimated_cost: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cost_usd: number
  providers: string[]
  models: string[]
  latest: Array<{
    event_id: string | null
    timestamp: string | number | null
    surface: string | null
    operation: string | null
    provider: string | null
    model: string | null
    status: string | null
    token_count_status: string | null
    input_tokens: number
    output_tokens: number
    total_tokens: number
    cost_usd: number | null
    cost_source: string | null
    duration_ms: number
    trace_grounded: boolean
  }>
}

export interface RunSummary {
  status: number
  count: number
  by_kind: Record<string, number>
  input_tokens: number
  output_tokens: number
  transcript_runs: number
  trace_runs: number
  latest: Array<{
    run_id: string | null
    kind: string | null
    status: string | null
    started_at: number | string | null
    input_tokens: number
    output_tokens: number
    transcript_available: boolean | null
    trace_id: string | null
    session_id: string | null
  }>
}

export interface TradeSummary {
  status: number
  count: number
  venues: string[]
  actions: string[]
  latest: Array<{
    id: string | null
    timestamp: string | null
    action: string | null
    target_protocol: string | null
    token_in: string | null
    token_out: string | null
    asset: string | null
    notional_usd: string | number | null
    status: string | null
    pnl_usd: string | number | null
  }>
}

export interface TickArtifactSummary {
  status: number
  captured: boolean
  decisions: number
  actions: string[]
  reasons: string[]
  latest_decision: {
    timestamp: string | number | null
    action: string | null
    reason: string | null
    confidence: number | string | null
    market: string | null
    keys: string[]
  } | null
  metrics_latest: unknown
  metrics_keys: string[]
  strategy_files: string[]
  coverage_findings: number
  latest_coverage: unknown
  decision_contexts: number
  latest_decision_context: unknown
  reflections: number
  latest_reflection: {
    timestamp: string | number | null
    mode: string | null
    verdict: string | null
    summary: string | null
    decision_context_id: string | null
    emitted_improvement_intent_id: string | null
    finding_codes: string[]
  } | null
  improvement_intents: number
  latest_improvement_intent: unknown
  improvement_dispatches: number
  usage_telemetry: UsageTelemetrySummary
  error?: string
}

export interface EvolutionSummary {
  status: number
  count: number | null
  latest: Array<{
    run_id: string | null
    status: string | null
    approved: boolean | null
    created_at: string | number | null
    candidate_hash: string | null
    blockers: unknown
    promoted_at: string | number | null
  }>
  error?: string
}

export interface RevisionArenaSummary {
  status: number
  revision_count: number | null
  keys: string[]
  latest: unknown
  error?: string
}

export interface BotAudit {
  id: string
  name: string
  strategy_type: string
  paper_trade: boolean | null
  trading_active: boolean | null
  user_prompt: string | null
  strategy_config: unknown
  runs: RunSummary
  trades: TradeSummary
  portfolio: EndpointCapture
  tick_artifacts: TickArtifactSummary
  self_improvement: EvolutionSummary
  revision_arena: RevisionArenaSummary
  sessions: EndpointCapture
  loop_mode: LoopMode
  self_improvement_state: SelfImprovementState
  strategy_alignment: StrategyAlignment
  observations: {
    portfolio: boolean
    trades: boolean
    market: boolean
    news: boolean
    external_signals_checked: boolean
    external_signals_required: boolean
    external_signals_unavailable: boolean
    external_signal_status: string | null
    signals_generated: number | null
  }
  flags: string[]
}

export interface FleetAuditResult {
  fetched_at: string
  operator_url: string
  bot_count: number
  summary: {
    active_bots: number
    paper_bots: number
    deterministic_fast_tick_bots: number
    agentic_llm_run_bots: number
    inactive_bots: number
    bots_with_trades: number
    bots_with_tick_artifacts: number
    bots_with_runtime_reflection_evidence: number
    bots_with_improvement_intents: number
    bots_with_self_improvement_evidence: number
    bots_with_strategy_mismatch: number
    total_recent_runs: number
    total_recent_input_tokens: number
    total_recent_output_tokens: number
    total_usage_events: number
    total_synthetic_usage_events: number
    total_trace_grounded_usage_events: number
    bots_with_usage_telemetry: number
    total_usage_input_tokens: number
    total_usage_output_tokens: number
    total_usage_cost_usd: number
    bots_with_news_evidence: number
    bots_with_external_signal_checks: number
    bots_with_external_signals_unavailable: number
    total_recent_trades: number
    flag_counts: Array<{ flag: string; count: number }>
  }
  bots: BotAudit[]
  verdict: {
    recursive_self_improvement_live: boolean
    runtime_reflection_live: boolean
    llm_market_reflection_live: boolean
    follows_user_mandates: 'yes' | 'partially' | 'no'
    succinct_wiring_plan: string[]
  }
}

export async function runLiveAgentFleetAudit(options: LiveFleetAuditOptions = {}): Promise<FleetAuditResult> {
  const operatorUrl = (options.operatorUrl ?? process.env.TRADING_OPERATOR_API_URL ?? DEFAULT_OPERATOR_URL).replace(/\/$/, '')
  const client = await buildClient(operatorUrl, options)
  const botCapture = await capture<BotListResponse>(client, `/api/bots?limit=${options.limit ?? 200}`)
  if (!botCapture.ok || !botCapture.json?.bots) {
    throw new Error(`fleet audit failed to fetch bots (${botCapture.status}): ${botCapture.error ?? 'missing bots array'}`)
  }

  const bots = botCapture.json.bots.filter((bot): bot is BotRecord & { id: string } => typeof bot.id === 'string' && bot.id.length > 0)
  const audits = await Promise.all(bots.map((bot) => inspectBot(client, bot)))
  const result = composeFleetAudit(operatorUrl, audits)

  if (options.outDir) {
    writeFleetAuditArtifacts(result, options.outDir)
  }

  return result
}

async function buildClient(operatorUrl: string, options: LiveFleetAuditOptions): Promise<OperatorClient> {
  const privateKey = options.privateKey ?? process.env.TRADING_OPERATOR_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY
  if (privateKey) return OperatorClient.authenticate(operatorUrl, privateKey)

  const token = options.token ?? process.env.TRADING_OPERATOR_SESSION_TOKEN ?? process.env.OPERATOR_SESSION_TOKEN
  if (!token) {
    throw new Error('live fleet audit requires --private-key/TRADING_OPERATOR_PRIVATE_KEY or --token/OPERATOR_SESSION_TOKEN')
  }
  return new OperatorClient({ operatorUrl, token })
}

async function inspectBot(client: OperatorClient, bot: BotRecord & { id: string }): Promise<BotAudit> {
  const id = bot.id
  const encoded = encodeURIComponent(id)
  const [runs, trades, portfolio, artifacts, selfImprove, arena, sessions] = await Promise.all([
    capture<unknown>(client, `/api/bots/${encoded}/runs?limit=200`),
    capture<unknown>(client, `/api/bots/${encoded}/trades?limit=200`),
    capture<unknown>(client, `/api/bots/${encoded}/portfolio/state`),
    capture<unknown>(client, `/api/bots/${encoded}/tick-artifacts`),
    capture<unknown>(client, `/api/bots/${encoded}/evolution/self-improve/runs`),
    capture<unknown>(client, `/api/bots/${encoded}/evolution/revision-arena`),
    capture<unknown>(client, `/api/bots/${encoded}/session/sessions?limit=20`),
  ])

  const runSummary = summarizeRuns(runs)
  const tradeSummary = summarizeTrades(trades)
  const artifactSummary = summarizeTickArtifacts(artifacts)
  const selfImprovementSummary = summarizeEvolution(selfImprove)
  const revisionArenaSummary = summarizeRevisionArena(arena)
  const strategyConfig = bot.strategy_config
  const userPrompt = stringAt(strategyConfig, ['user_prompt']) ?? bot.prompt ?? null
  const observations = summarizeObservations(artifactSummary, tradeSummary)
  const strategyAlignment = classifyStrategyAlignment({
    strategyType: bot.strategy_type ?? '',
    strategyConfig,
    userPrompt,
    trades: tradeSummary,
    runs: runSummary,
  })
  const loopMode = classifyLoopMode(runSummary)
  const selfImprovementState = classifySelfImprovement(selfImprovementSummary, revisionArenaSummary)
  const flags = buildFlags({
    strategyType: bot.strategy_type ?? '',
    userPrompt,
    loopMode,
    selfImprovementState,
    strategyAlignment,
    runs: runSummary,
    trades: tradeSummary,
    artifacts: artifactSummary,
    observations,
  })

  return {
    id,
    name: bot.name ?? id,
    strategy_type: bot.strategy_type ?? 'unknown',
    paper_trade: bot.paper_trade ?? null,
    trading_active: bot.trading_active ?? null,
    user_prompt: userPrompt,
    strategy_config: strategyConfig,
    runs: runSummary,
    trades: tradeSummary,
    portfolio,
    tick_artifacts: artifactSummary,
    self_improvement: selfImprovementSummary,
    revision_arena: revisionArenaSummary,
    sessions,
    loop_mode: loopMode,
    self_improvement_state: selfImprovementState,
    strategy_alignment: strategyAlignment,
    observations,
    flags,
  }
}

async function capture<T>(client: OperatorClient, path: string): Promise<EndpointCapture<T>> {
  try {
    return { status: 200, ok: true, json: await client.get<T>(path) }
  } catch (error) {
    if (error instanceof OperatorApiError) {
      return { status: error.status, ok: false, json: null, error: error.body }
    }
    return { status: 0, ok: false, json: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export function summarizeRuns(captureResult: EndpointCapture<unknown>): RunSummary {
  const list = arrayFromResponse<RunRecord>(captureResult.json, 'runs')
  const byKind: Record<string, number> = {}
  let inputTokens = 0
  let outputTokens = 0
  let transcriptRuns = 0
  let traceRuns = 0

  for (const run of list) {
    const kind = run.workflow_kind ?? run.kind ?? 'unknown'
    byKind[kind] = (byKind[kind] ?? 0) + 1
    inputTokens += toNumber(run.input_tokens)
    outputTokens += toNumber(run.output_tokens)
    if (run.transcript_available === true) transcriptRuns += 1
    if (run.trace_id) traceRuns += 1
  }

  return {
    status: captureResult.status,
    count: list.length,
    by_kind: byKind,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    transcript_runs: transcriptRuns,
    trace_runs: traceRuns,
    latest: list.slice(0, 3).map((run) => ({
      run_id: run.run_id ?? null,
      kind: run.workflow_kind ?? run.kind ?? null,
      status: run.status ?? null,
      started_at: run.started_at ?? null,
      input_tokens: toNumber(run.input_tokens),
      output_tokens: toNumber(run.output_tokens),
      transcript_available: run.transcript_available ?? null,
      trace_id: run.trace_id ?? null,
      session_id: run.session_id ?? null,
    })),
  }
}

export function summarizeTrades(captureResult: EndpointCapture<unknown>): TradeSummary {
  const list = arrayFromResponse<TradeRecord>(captureResult.json, 'trades')
  const venues = uniqueSorted(list.map((trade) => trade.target_protocol ?? trade.venue ?? trade.protocol))
  const actions = uniqueSorted(list.map((trade) => trade.action ?? trade.intent?.action))
  return {
    status: captureResult.status,
    count: list.length,
    venues,
    actions,
    latest: list.slice(0, 5).map((trade) => ({
      id: trade.id ?? trade.trade_id ?? null,
      timestamp: trade.timestamp ?? trade.created_at ?? trade.executed_at ?? null,
      action: trade.action ?? trade.intent?.action ?? null,
      target_protocol: trade.target_protocol ?? trade.venue ?? trade.protocol ?? null,
      token_in: trade.token_in ?? trade.intent?.token_in ?? null,
      token_out: trade.token_out ?? trade.intent?.token_out ?? null,
      asset: trade.asset ?? null,
      notional_usd: trade.notional_usd ?? null,
      status: trade.status ?? trade.execution_status ?? null,
      pnl_usd: trade.pnl_usd ?? trade.pnl ?? null,
    })),
  }
}

export function summarizeTickArtifacts(captureResult: EndpointCapture<unknown>): TickArtifactSummary {
  if (!captureResult.ok) {
    return {
      status: captureResult.status,
      captured: false,
      decisions: 0,
      actions: [],
      reasons: [],
      latest_decision: null,
      metrics_latest: null,
      metrics_keys: [],
      strategy_files: [],
      coverage_findings: 0,
      latest_coverage: null,
      decision_contexts: 0,
      latest_decision_context: null,
      reflections: 0,
      latest_reflection: null,
      improvement_intents: 0,
      latest_improvement_intent: null,
      improvement_dispatches: 0,
      usage_telemetry: emptyUsageTelemetrySummary(),
      ...(captureResult.error ? { error: captureResult.error } : {}),
    }
  }

  const payload = isRecord(captureResult.json) ? captureResult.json : {}
  const decisions = parseJsonl(String(payload.decisions_jsonl ?? ''))
  const coverage = parseJsonl(String(payload.coverage_jsonl ?? ''))
  const decisionContexts = parseJsonl(String(payload.decision_contexts_jsonl ?? ''))
  const reflections = parseJsonl(String(payload.reflections_jsonl ?? ''))
  const improvementIntents = parseJsonl(String(payload.improvement_intents_jsonl ?? ''))
  const improvementDispatches = parseJsonl(String(payload.improvement_dispatches_jsonl ?? ''))
  const usageTelemetry = summarizeUsageTelemetry(parseJsonl(String(payload.usage_telemetry_jsonl ?? '')))
  const latest = decisions.at(-1)
  const latestReflection = reflections.at(-1)
  const metricsLatest = payload.metrics_latest ?? null
  const strategies = isRecord(payload.strategies) ? payload.strategies : {}

  return {
    status: captureResult.status,
    captured: true,
    decisions: decisions.length,
    actions: uniqueSorted(decisions.map((decision) => decisionAction(decision) ?? 'unknown')),
    reasons: uniqueSorted(decisions.map((decision) => decisionReason(decision))).slice(0, 12),
    latest_decision: latest
      ? {
          timestamp: primitive(latest.timestamp) ?? primitive(latest.ts) ?? null,
          action: decisionAction(latest),
          reason: decisionReason(latest),
          confidence: primitive(latest.confidence) ?? (isRecord(latest.decision) ? primitive(latest.decision.confidence) : null),
          market: stringValue(latest.market) ?? stringValue(latest.symbol) ?? stringValue(latest.token),
          keys: Object.keys(latest).slice(0, 18),
        }
      : null,
    metrics_latest: metricsLatest,
    metrics_keys: isRecord(metricsLatest) ? Object.keys(metricsLatest).sort() : [],
    strategy_files: Object.keys(strategies).sort(),
    coverage_findings: coverage.length,
    latest_coverage: coverage.at(-1) ?? null,
    decision_contexts: decisionContexts.length,
    latest_decision_context: decisionContexts.at(-1) ?? null,
    reflections: reflections.length,
    latest_reflection: latestReflection
      ? {
          timestamp: primitive(latestReflection.timestamp),
          mode: stringValue(latestReflection.mode),
          verdict: stringValue(latestReflection.verdict),
          summary: stringValue(latestReflection.summary),
          decision_context_id: stringValue(latestReflection.decision_context_id),
          emitted_improvement_intent_id: stringValue(latestReflection.emitted_improvement_intent_id),
          finding_codes: arrayFromUnknown(latestReflection.findings)
            .map((finding) => (isRecord(finding) ? stringValue(finding.code) : null))
            .filter((code): code is string => Boolean(code))
            .slice(0, 12),
        }
      : null,
    improvement_intents: improvementIntents.length,
    latest_improvement_intent: improvementIntents.at(-1) ?? null,
    improvement_dispatches: improvementDispatches.length,
    usage_telemetry: usageTelemetry,
  }
}

export function summarizeEvolution(captureResult: EndpointCapture<unknown>): EvolutionSummary {
  if (!captureResult.ok) {
    return {
      status: captureResult.status,
      count: null,
      latest: [],
      ...(captureResult.error ? { error: captureResult.error } : {}),
    }
  }
  const list = arrayFromResponse<Record<string, unknown>>(captureResult.json, 'runs')
  return {
    status: captureResult.status,
    count: list.length,
    latest: list.slice(0, 3).map((run) => ({
      run_id: stringValue(run.run_id),
      status: stringValue(run.status),
      approved: typeof run.approved === 'boolean' ? run.approved : null,
      created_at: primitive(run.created_at),
      candidate_hash: stringValue(run.candidate_hash),
      blockers: run.blockers ?? null,
      promoted_at: primitive(run.promoted_at),
    })),
  }
}

export function summarizeRevisionArena(captureResult: EndpointCapture<unknown>): RevisionArenaSummary {
  if (!captureResult.ok) {
    return {
      status: captureResult.status,
      revision_count: null,
      keys: [],
      latest: null,
      ...(captureResult.error ? { error: captureResult.error } : {}),
    }
  }
  const payload = isRecord(captureResult.json) ? captureResult.json : {}
  const revisions = arrayFromResponse<unknown>(payload, 'revisions')
  return {
    status: captureResult.status,
    revision_count: revisions.length,
    keys: Object.keys(payload).sort(),
    latest: revisions[0] ?? null,
  }
}

export function classifyLoopMode(runs: RunSummary): LoopMode {
  if (runs.count === 0) return 'inactive'
  if (runs.input_tokens === 0 && runs.output_tokens === 0 && runs.transcript_runs === 0) return 'deterministic-fast-tick'
  if (runs.input_tokens > 0 || runs.output_tokens > 0 || runs.transcript_runs > 0) return 'agentic-llm-run'
  return 'unknown'
}

export function classifySelfImprovement(selfImprove: EvolutionSummary, arena: RevisionArenaSummary): SelfImprovementState {
  if (selfImprove.status === 403 || arena.status === 403) return 'inaccessible'
  if ((selfImprove.count ?? 0) > 0 || (arena.revision_count ?? 0) > 1) return 'active'
  if (selfImprove.status === 200 || arena.status === 200) return 'not-firing'
  return 'unknown'
}

export function classifyStrategyAlignment(input: {
  strategyType: string
  strategyConfig: unknown
  userPrompt: string | null
  trades: TradeSummary
  runs: RunSummary
}): StrategyAlignment {
  if (input.runs.count === 0) return 'inactive'
  const strategyType = input.strategyType.toLowerCase()
  const prompt = (input.userPrompt ?? '').toLowerCase()
  const allowedProtocols = arrayStringsAt(input.strategyConfig, ['available_protocols'])
  const tradedOutsideAllowed = allowedProtocols.length > 0 && input.trades.venues.some((venue) => !allowedProtocols.includes(venue))

  if (tradedOutsideAllowed) return 'mismatch'
  if (hasPositiveHyperliquidMandate(prompt) && !strategyType.includes('hyperliquid')) return 'mismatch'
  if ((prompt.includes('gmx') || prompt.includes('vertex')) && !allowedProtocols.includes('gmx_v2')) return 'mismatch'
  if (prompt.includes('vertex') && !allowedProtocols.includes('vertex')) return 'partial'
  if ((prompt.includes('diversified') || prompt.includes('60% dex') || prompt.includes('cross-strategy')) && strategyType !== 'multi') return 'mismatch'
  if (input.trades.count === 0 && ['mm', 'dex', 'multi', 'yield'].includes(strategyType)) return 'partial'
  return 'aligned'
}

function hasPositiveHyperliquidMandate(prompt: string): boolean {
  if (!prompt.includes('hyperliquid')) return false
  if (/(do not|don't|dont|no|without|not)\s+(use\s+|trade\s+|execute\s+|route\s+through\s+)?hyperliquid/.test(prompt)) return false
  return true
}

function summarizeObservations(artifacts: TickArtifactSummary, trades: TradeSummary): BotAudit['observations'] {
  const metrics = isRecord(artifacts.metrics_latest) ? artifacts.metrics_latest : {}
  const latestContext = isRecord(artifacts.latest_decision_context) ? artifacts.latest_decision_context : {}
  const evidence = isRecord(latestContext.evidence) ? latestContext.evidence : {}
  const checkedState = isRecord(latestContext.checked_state) ? latestContext.checked_state : {}
  const externalEvidence = isRecord(checkedState.external_signal_evidence) ? checkedState.external_signal_evidence : {}
  const signalsGenerated = isFiniteNumber(metrics.signals_generated)
    ? Number(metrics.signals_generated)
    : isFiniteNumber(evidence.signals_generated)
      ? Number(evidence.signals_generated)
      : null
  const externalSignalsChecked =
    evidence.external_signal_checked === true
    || externalEvidence.checked === true
    || toNumber(metrics.external_signal_checked) > 0
  const externalSignalsRequired =
    evidence.external_signal_required === true
    || externalEvidence.required === true
    || toNumber(metrics.external_signal_required) > 0
  const externalSignalsUnavailable =
    evidence.external_signal_unavailable === true
    || externalEvidence.unavailable === true
    || toNumber(metrics.external_signal_unavailable) > 0
  const externalSignalStatus = stringValue(evidence.external_signal_source_status) ?? stringValue(externalEvidence.source_status)
  const marketMetricKeys = artifacts.metrics_keys.filter((key) => ![
    'external_signal_checked',
    'external_signal_required',
    'external_signal_provider_configured',
    'external_signal_unavailable',
    'market_signal_count',
    'external_observation_count',
  ].includes(key))
  return {
    portfolio: evidence.observed_portfolio === true || artifacts.metrics_keys.some((key) => key.includes('portfolio') || key.includes('position')) || isFiniteNumber(metrics.portfolio_value_usd),
    trades: trades.count > 0 || artifacts.metrics_keys.includes('trade_count'),
    market: evidence.observed_market === true || marketMetricKeys.some((key) => /price|funding|rsi|ema|candle|volatility|spread|liquidity|market/i.test(key)) || toNumber(metrics.market_signal_count) > 0,
    news: evidence.observed_news === true || artifacts.metrics_keys.some((key) => /news|headline|sentiment|event/i.test(key)),
    external_signals_checked: externalSignalsChecked,
    external_signals_required: externalSignalsRequired,
    external_signals_unavailable: externalSignalsUnavailable,
    external_signal_status: externalSignalStatus,
    signals_generated: signalsGenerated,
  }
}

function userPromptRequiresExternalSignals(userPrompt: string | null, strategyType: string): boolean {
  const text = `${userPrompt ?? ''} ${strategyType}`.toLowerCase()
  return /news|headline|sentiment|event|catalyst|prediction|polymarket|volatility|macro|election|politic/.test(text)
}

function buildFlags(input: {
  strategyType: string
  userPrompt: string | null
  loopMode: LoopMode
  selfImprovementState: SelfImprovementState
  strategyAlignment: StrategyAlignment
  runs: RunSummary
  trades: TradeSummary
  artifacts: TickArtifactSummary
  observations: BotAudit['observations']
}): string[] {
  const flags: string[] = []
  if (input.loopMode === 'deterministic-fast-tick') flags.push('deterministic-no-llm-loop')
  if (input.loopMode === 'inactive') flags.push('inactive-no-runs')
  if (input.selfImprovementState === 'not-firing') flags.push('no-self-improvement-evidence')
  if (input.selfImprovementState === 'inaccessible') flags.push('self-improvement-inaccessible')
  const requiresExternalSignals = input.observations.external_signals_required || userPromptRequiresExternalSignals(input.userPrompt, input.strategyType)
  if (requiresExternalSignals && !input.observations.news && !input.observations.external_signals_checked) flags.push('no-news-ingestion-evidence')
  if (requiresExternalSignals && input.observations.external_signals_unavailable) flags.push('external-signals-unavailable')
  if (requiresExternalSignals && (input.observations.signals_generated ?? 0) === 0 && !input.observations.external_signals_unavailable) flags.push('signals-generated-zero')
  if (input.trades.count === 0) flags.push('no-trades-placed')
  if (input.strategyAlignment === 'mismatch') flags.push('strategy-mandate-mismatch')
  if (input.strategyAlignment === 'partial') flags.push('strategy-mandate-partial')
  if (!input.artifacts.captured && input.runs.count > 0) flags.push('tick-artifacts-not-captured')
  if (input.artifacts.captured && input.artifacts.decision_contexts === 0) flags.push('no-decision-context-evidence')
  if (input.artifacts.captured && input.artifacts.reflections === 0) flags.push('no-runtime-reflection-evidence')
  if (input.artifacts.latest_reflection?.verdict === 'improve') flags.push('runtime-reflection-says-improve')
  if (input.artifacts.improvement_intents > 0) flags.push('runtime-improvement-intent-queued')
  if ((input.loopMode === 'agentic-llm-run' || input.selfImprovementState === 'active') && input.artifacts.usage_telemetry.event_count === 0) {
    flags.push('llm-usage-telemetry-missing')
  }
  if (input.artifacts.usage_telemetry.event_count > 0 && input.artifacts.usage_telemetry.events_with_reported_tokens === 0) {
    flags.push('llm-token-counts-unreported')
  }
  if (input.selfImprovementState === 'active' && input.artifacts.usage_telemetry.trace_grounded_events === 0) {
    flags.push('llm-trace-grounding-missing')
  }
  return flags
}

function composeFleetAudit(operatorUrl: string, bots: BotAudit[]): FleetAuditResult {
  const flagCounts = new Map<string, number>()
  for (const bot of bots) {
    for (const flag of bot.flags) flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1)
  }

  const botsWithStrategyMismatch = bots.filter((bot) => bot.strategy_alignment === 'mismatch').length
  const botsWithSelfImprovementEvidence = bots.filter((bot) => bot.self_improvement_state === 'active').length
  const botsWithRuntimeReflectionEvidence = bots.filter((bot) => bot.tick_artifacts.reflections > 0).length
  const botsWithImprovementIntents = bots.filter((bot) => bot.tick_artifacts.improvement_intents > 0).length

  return {
    fetched_at: new Date().toISOString(),
    operator_url: operatorUrl,
    bot_count: bots.length,
    summary: {
      active_bots: bots.filter((bot) => bot.trading_active === true).length,
      paper_bots: bots.filter((bot) => bot.paper_trade === true).length,
      deterministic_fast_tick_bots: bots.filter((bot) => bot.loop_mode === 'deterministic-fast-tick').length,
      agentic_llm_run_bots: bots.filter((bot) => bot.loop_mode === 'agentic-llm-run').length,
      inactive_bots: bots.filter((bot) => bot.loop_mode === 'inactive').length,
      bots_with_trades: bots.filter((bot) => bot.trades.count > 0).length,
      bots_with_tick_artifacts: bots.filter((bot) => bot.tick_artifacts.captured).length,
      bots_with_runtime_reflection_evidence: botsWithRuntimeReflectionEvidence,
      bots_with_improvement_intents: botsWithImprovementIntents,
      bots_with_self_improvement_evidence: botsWithSelfImprovementEvidence,
      bots_with_strategy_mismatch: botsWithStrategyMismatch,
      total_recent_runs: bots.reduce((sum, bot) => sum + bot.runs.count, 0),
      total_recent_input_tokens: bots.reduce((sum, bot) => sum + bot.runs.input_tokens, 0),
      total_recent_output_tokens: bots.reduce((sum, bot) => sum + bot.runs.output_tokens, 0),
      total_usage_events: bots.reduce((sum, bot) => sum + bot.tick_artifacts.usage_telemetry.event_count, 0),
      total_synthetic_usage_events: bots.reduce((sum, bot) => sum + bot.tick_artifacts.usage_telemetry.synthetic_event_count, 0),
      total_trace_grounded_usage_events: bots.reduce((sum, bot) => sum + bot.tick_artifacts.usage_telemetry.trace_grounded_events, 0),
      bots_with_usage_telemetry: bots.filter((bot) => bot.tick_artifacts.usage_telemetry.event_count > 0).length,
      total_usage_input_tokens: bots.reduce((sum, bot) => sum + bot.tick_artifacts.usage_telemetry.input_tokens, 0),
      total_usage_output_tokens: bots.reduce((sum, bot) => sum + bot.tick_artifacts.usage_telemetry.output_tokens, 0),
      total_usage_cost_usd: Number(bots.reduce((sum, bot) => sum + bot.tick_artifacts.usage_telemetry.cost_usd, 0).toFixed(8)),
      bots_with_news_evidence: bots.filter((bot) => bot.observations.news).length,
      bots_with_external_signal_checks: bots.filter((bot) => bot.observations.external_signals_checked).length,
      bots_with_external_signals_unavailable: bots.filter((bot) => bot.observations.external_signals_unavailable).length,
      total_recent_trades: bots.reduce((sum, bot) => sum + bot.trades.count, 0),
      flag_counts: Array.from(flagCounts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([flag, count]) => ({ flag, count })),
    },
    bots,
    verdict: {
      recursive_self_improvement_live: botsWithSelfImprovementEvidence > 0,
      runtime_reflection_live: botsWithRuntimeReflectionEvidence > 0,
      llm_market_reflection_live: bots.some((bot) => bot.tick_artifacts.usage_telemetry.trace_grounded_events > 0 && bot.observations.market),
      follows_user_mandates: botsWithStrategyMismatch === 0 ? 'yes' : botsWithStrategyMismatch < bots.length ? 'partially' : 'no',
      succinct_wiring_plan: [
        'Make each fast tick emit a compact DecisionContext: mandate, portfolio, open positions, recent fills, market snapshot, external/news signals, and prior decision outcome.',
        'Run a bounded reflection step on schedule or after material PnL/risk events; write ReflectionRecords with diagnosis, proposed harness mutation, and explicit no-change rationale.',
        'Feed ReflectionRecords into the existing self-improvement MCP/evolution store, then require backtest, forward paper evidence, and promotion-conductor approval before the harness changes.',
        'Expose the same records in Chat/Runs/Agent detail so users see why the bot traded, skipped, learned, or refused.',
      ],
    },
  }
}

export function renderFleetAuditMarkdown(result: FleetAuditResult): string {
  const lines: string[] = []
  lines.push(`# Live Agent Fleet Audit`)
  lines.push('')
  lines.push(`Fetched: ${result.fetched_at}`)
  lines.push(`Operator: ${result.operator_url}`)
  lines.push('')
  lines.push('## BLUF')
  lines.push('')
  lines.push(`- Recursive self-improvement live: **${result.verdict.recursive_self_improvement_live ? 'yes' : 'no'}**.`)
  lines.push(`- Runtime reflection live: **${result.verdict.runtime_reflection_live ? 'yes' : 'no'}**.`)
  lines.push(`- LLM market reflection live: **${result.verdict.llm_market_reflection_live ? 'yes' : 'no'}**.`)
  lines.push(`- User mandate adherence: **${result.verdict.follows_user_mandates}**.`)
  lines.push(`- ${result.summary.deterministic_fast_tick_bots}/${result.bot_count} bots are deterministic fast ticks; ${result.summary.agentic_llm_run_bots}/${result.bot_count} show LLM-token or transcript evidence in recent runs.`)
  lines.push(`- Usage telemetry: **${result.summary.total_usage_events} events** across ${result.summary.bots_with_usage_telemetry}/${result.bot_count} bots; reported/estimated cost **$${result.summary.total_usage_cost_usd.toFixed(6)}**; tokens **${result.summary.total_usage_input_tokens}/${result.summary.total_usage_output_tokens}** in/out.`)
  if (result.summary.total_synthetic_usage_events > 0 || result.summary.total_trace_grounded_usage_events > 0) {
    lines.push(`- Usage classification: **${result.summary.total_trace_grounded_usage_events} trace-grounded** events; **${result.summary.total_synthetic_usage_events} synthetic smoke** events excluded from cost totals.`)
  }
  lines.push(`- External signal evidence: **${result.summary.bots_with_news_evidence}/${result.bot_count} actual news/event evidence**, **${result.summary.bots_with_external_signal_checks}/${result.bot_count} checked**, **${result.summary.bots_with_external_signals_unavailable}/${result.bot_count} unavailable-source**.`)
  lines.push(`- ${result.summary.bots_with_trades}/${result.bot_count} bots have recent trades; ${result.summary.bots_with_runtime_reflection_evidence}/${result.bot_count} show runtime reflection; ${result.summary.bots_with_improvement_intents}/${result.bot_count} have queued improvement intents; ${result.summary.bots_with_self_improvement_evidence}/${result.bot_count} show promotion/evolution evidence.`)
  lines.push('')
  lines.push('## Fleet Table')
  lines.push('')
  lines.push('| Bot | Strategy | Loop | Runs | Run tokens | Usage events | Usage cost | Trades | Tick actions | Reflection | Intents | Self-improve | Alignment | Top flags |')
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- |')
  for (const bot of result.bots) {
    lines.push([
      escapeCell(bot.name),
      escapeCell(bot.strategy_type),
      bot.loop_mode,
      String(bot.runs.count),
      `${bot.runs.input_tokens}/${bot.runs.output_tokens}`,
      String(bot.tick_artifacts.usage_telemetry.event_count),
      `$${bot.tick_artifacts.usage_telemetry.cost_usd.toFixed(6)}`,
      String(bot.trades.count),
      escapeCell(bot.tick_artifacts.actions.join(', ') || '-'),
      bot.tick_artifacts.latest_reflection?.verdict ?? '-',
      String(bot.tick_artifacts.improvement_intents),
      bot.self_improvement_state,
      bot.strategy_alignment,
      escapeCell(bot.flags.slice(0, 4).join(', ') || '-'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  lines.push('')
  lines.push('## Wiring Plan')
  lines.push('')
  result.verdict.succinct_wiring_plan.forEach((item, index) => {
    lines.push(`${index + 1}. ${item}`)
  })
  lines.push('')
  lines.push('## Flag Counts')
  lines.push('')
  for (const flag of result.summary.flag_counts) {
    lines.push(`- ${flag.flag}: ${flag.count}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function writeFleetAuditArtifacts(result: FleetAuditResult, outDir: string): void {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'fleet-audit.json'), JSON.stringify(result, null, 2))
  writeFileSync(resolve(outDir, 'fleet-audit.md'), renderFleetAuditMarkdown(result))
}

function arrayFromResponse<T>(json: unknown, key: string): T[] {
  if (Array.isArray(json)) return json as T[]
  if (isRecord(json) && Array.isArray(json[key])) return json[key] as T[]
  return []
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseJsonl(raw: string): Array<Record<string, unknown>> {
  return raw
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown
        return isRecord(parsed) ? parsed : { value: parsed }
      } catch {
        return { parse_error: line.slice(0, 200) }
      }
    })
}

function emptyUsageTelemetrySummary(): UsageTelemetrySummary {
  return {
    event_count: 0,
    synthetic_event_count: 0,
    trace_grounded_events: 0,
    events_with_reported_tokens: 0,
    events_with_reported_or_estimated_cost: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    providers: [],
    models: [],
    latest: [],
  }
}

export function summarizeUsageTelemetry(events: Array<Record<string, unknown>>): UsageTelemetrySummary {
  const realEvents = events.filter((event) => !isSyntheticUsageEvent(event))
  const inputTokens = realEvents.reduce((sum, event) => sum + toNumber(event.input_tokens), 0)
  const outputTokens = realEvents.reduce((sum, event) => sum + toNumber(event.output_tokens), 0)
  const totalTokens = realEvents.reduce((sum, event) => sum + toNumber(event.total_tokens), 0) || inputTokens + outputTokens
  const costUsd = realEvents.reduce((sum, event) => sum + toNumber(event.cost_usd), 0)
  return {
    event_count: realEvents.length,
    synthetic_event_count: events.length - realEvents.length,
    trace_grounded_events: realEvents.filter(isTraceGroundedUsageEvent).length,
    events_with_reported_tokens: realEvents.filter((event) => event.token_count_status === 'reported').length,
    events_with_reported_or_estimated_cost: realEvents.filter((event) => event.cost_usd != null && Number.isFinite(Number(event.cost_usd))).length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_usd: Number(costUsd.toFixed(8)),
    providers: uniqueSorted(realEvents.map((event) => stringValue(event.provider))),
    models: uniqueSorted(realEvents.map((event) => stringValue(event.model))),
    latest: realEvents.slice(-5).map((event) => ({
      event_id: stringValue(event.event_id),
      timestamp: primitive(event.timestamp),
      surface: stringValue(event.surface),
      operation: stringValue(event.operation),
      provider: stringValue(event.provider),
      model: stringValue(event.model),
      status: stringValue(event.status),
      token_count_status: stringValue(event.token_count_status),
      input_tokens: toNumber(event.input_tokens),
      output_tokens: toNumber(event.output_tokens),
      total_tokens: toNumber(event.total_tokens),
      cost_usd: event.cost_usd != null && Number.isFinite(Number(event.cost_usd)) ? Number(event.cost_usd) : null,
      cost_source: stringValue(event.cost_source),
      duration_ms: toNumber(event.duration_ms),
      trace_grounded: isTraceGroundedUsageEvent(event),
    })),
  }
}

function usageMetadata(event: Record<string, unknown>): Record<string, unknown> {
  return isRecord(event.metadata) ? event.metadata : {}
}

function isSyntheticUsageEvent(event: Record<string, unknown>): boolean {
  const metadata = usageMetadata(event)
  return event.synthetic === true || metadata.synthetic === true || stringValue(event.surface) === 'telemetry-smoke'
}

function isTraceGroundedUsageEvent(event: Record<string, unknown>): boolean {
  const metadata = usageMetadata(event)
  return metadata.trace_grounded === true || isRecord(metadata.trace) || stringValue(event.operation) === 'trace-analyst-loop'
}

function decisionAction(decision: Record<string, unknown>): string | null {
  return stringValue(decision.action)
    ?? (isRecord(decision.decision) ? stringValue(decision.decision.action) : null)
    ?? (isRecord(decision.result) && isRecord(decision.result.decision) ? stringValue(decision.result.decision.action) : null)
}

function decisionReason(decision: Record<string, unknown>): string | null {
  return stringValue(decision.reason)
    ?? (isRecord(decision.decision) ? stringValue(decision.decision.reason) : null)
    ?? (isRecord(decision.result) && isRecord(decision.result.decision) ? stringValue(decision.result.decision.reason) : null)
}

function arrayStringsAt(value: unknown, path: string[]): string[] {
  const target = getAt(value, path)
  return Array.isArray(target) ? target.filter((item): item is string => typeof item === 'string') : []
}

function stringAt(value: unknown, path: string[]): string | null {
  return stringValue(getAt(value, path))
}

function getAt(value: unknown, path: string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function primitive(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))).sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}
