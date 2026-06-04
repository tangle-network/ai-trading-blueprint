import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyLoopMode,
  classifySelfImprovement,
  classifyStrategyAlignment,
  mapWithConcurrency,
  summarizeObservatory,
  summarizeRevisionArena,
  summarizeRuns,
  summarizeTickArtifacts,
  summarizeTrades,
} from './live-agent-fleet-audit.js'

test('mapWithConcurrency preserves order while bounding active work', async () => {
  let active = 0
  let maxActive = 0
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return value * 10
  })

  assert.deepEqual(results, [10, 20, 30, 40, 50])
  assert.equal(maxActive, 2)
})

test('classifies zero-token direct fast ticks separately from agentic LLM runs', () => {
  const deterministic = summarizeRuns({
    status: 200,
    ok: true,
    json: {
      runs: [
        {
          run_id: 'r1',
          workflow_kind: 'trading',
          input_tokens: 0,
          output_tokens: 0,
          transcript_available: false,
          session_id: 'direct-fast-trading-bot-1',
        },
      ],
    },
  } as never)
  assert.equal(classifyLoopMode(deterministic), 'deterministic-fast-tick')

  const agentic = summarizeRuns({
    status: 200,
    ok: true,
    json: {
      runs: [
        {
          run_id: 'r2',
          workflow_kind: 'research',
          input_tokens: 1200,
          output_tokens: 500,
          transcript_available: true,
        },
      ],
    },
  } as never)
  assert.equal(classifyLoopMode(agentic), 'agentic-llm-run')
})

test('self-improvement status distinguishes rev-0-only from inaccessible state', () => {
  const noRuns = {
    status: 200,
    count: 0,
    latest: [],
  }
  const rev0Only = summarizeRevisionArena({
    status: 200,
    ok: true,
    json: { revisions: [{ revision_id: 'rev-0' }] },
  } as never)
  assert.equal(classifySelfImprovement(noRuns, rev0Only), 'not-firing')

  assert.equal(
    classifySelfImprovement(
      { status: 403, count: null, latest: [] },
      { status: 403, revision_count: null, keys: [], latest: null },
    ),
    'inaccessible',
  )
})

test('tick-artifact parser extracts decisions, reasons, metrics, and strategy files', () => {
  const artifacts = summarizeTickArtifacts({
    status: 200,
    ok: true,
    json: {
      decisions_jsonl: [
        JSON.stringify({ timestamp: '2026-06-04T00:00:00Z', action: 'skip', reason: 'no-edge' }),
        JSON.stringify({ timestamp: '2026-06-04T00:05:00Z', decision: { action: 'trade', reason: 'rebalance' } }),
      ].join('\n'),
      coverage_jsonl: JSON.stringify({ finding: 'insufficient_coverage', have: 12, need: 30 }),
      decision_contexts_jsonl: JSON.stringify({
        context_id: 'ctx_1',
        evidence: { observed_portfolio: true, observed_market: true, observed_news: false, signals_generated: 0 },
      }),
      reflections_jsonl: JSON.stringify({
        reflection_id: 'refl_1',
        decision_context_id: 'ctx_1',
        mode: 'deterministic-runtime-reflection',
        verdict: 'improve',
        summary: 'Found 1 behavior gap; improve.',
        emitted_improvement_intent_id: 'intent_1',
        findings: [{ code: 'repeated-skip' }],
      }),
      improvement_intents_jsonl: JSON.stringify({ intent_id: 'intent_1', priority: 'high' }),
      improvement_dispatches_jsonl: JSON.stringify({ intent_id: 'intent_1' }),
      usage_telemetry_jsonl: [
        JSON.stringify({
          event_id: 'usage_smoke',
          surface: 'telemetry-smoke',
          operation: 'usage-writer',
          provider: 'smoke-test',
          model: 'manual-writer',
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          cost_usd: 99,
          token_count_status: 'reported',
          metadata: { synthetic: true },
        }),
        JSON.stringify({
          event_id: 'usage_1',
          surface: 'operator-chat',
          operation: 'agents-run',
          provider: 'zai-coding-plan',
          model: 'glm-4.7',
          input_tokens: 120,
          output_tokens: 48,
          total_tokens: 168,
          cost_usd: 0.0021,
          token_count_status: 'reported',
          metadata: { trace_grounded: true, trace: { decision_context_id: 'ctx_1' } },
        }),
      ].join('\n'),
      metrics_latest: { portfolio_value_usd: 10000, signals_generated: 0, trade_count: 1 },
      strategies: { 'candidate.js': 'module.exports = {}' },
    },
  } as never)

  assert.equal(artifacts.captured, true)
  assert.equal(artifacts.decisions, 2)
  assert.deepEqual(artifacts.actions, ['skip', 'trade'])
  assert.deepEqual(artifacts.reasons, ['no-edge', 'rebalance'])
  assert.equal(artifacts.latest_decision?.action, 'trade')
  assert.deepEqual(artifacts.strategy_files, ['candidate.js'])
  assert.equal(artifacts.coverage_findings, 1)
  assert.equal(artifacts.decision_contexts, 1)
  assert.equal(artifacts.reflections, 1)
  assert.equal(artifacts.latest_reflection?.verdict, 'improve')
  assert.deepEqual(artifacts.latest_reflection?.finding_codes, ['repeated-skip'])
  assert.equal(artifacts.improvement_intents, 1)
  assert.equal(artifacts.improvement_dispatches, 1)
  assert.equal(artifacts.usage_telemetry.event_count, 1)
  assert.equal(artifacts.usage_telemetry.synthetic_event_count, 1)
  assert.equal(artifacts.usage_telemetry.trace_grounded_events, 1)
  assert.equal(artifacts.usage_telemetry.input_tokens, 120)
  assert.equal(artifacts.usage_telemetry.output_tokens, 48)
  assert.equal(artifacts.usage_telemetry.cost_usd, 0.0021)
  assert.deepEqual(artifacts.usage_telemetry.providers, ['zai-coding-plan'])
})

test('observatory summary proves freshness, usage accounting, and gated delegated builds', () => {
  const now = new Date().toISOString()
  const summary = summarizeObservatory({
    status: 200,
    ok: true,
    json: {
      records: {
        world_signal_digests: [{ created_at: now }],
        reflection_runs: [{
          created_at: now,
          usage_summary: {
            reporting_status: 'unreported',
            event_count: 1,
            total_tokens: 0,
            cost_usd: 0,
          },
        }],
        ideas: [{ created_at: now, idea_id: 'idea_1' }],
        research_tasks: [],
        delegated_work_sessions: [{
          created_at: now,
          source: 'owner-feedback:self-improvement-mcp',
          status: 'queued',
          artifact_ref: 'artifact://mcp-self-improvement/tasks/task_1.json',
          summary: 'Owner delegated build work for an instrumentation idea.',
        }],
        owner_feedback: [],
        delegation_pressure: {
          active_sessions: 1,
          pressure_level: 'medium',
          allows_new_delegation: true,
          deny_reasons: [],
        },
      },
    },
  } as never, { id: 'bot_1', trading_active: true })

  assert.equal(summary.capability, 'installed')
  assert.equal(summary.fresh_24h, true)
  assert.equal(summary.fresh_48h, true)
  assert.equal(summary.usage_reporting_status, 'unreported')
  assert.equal(summary.usage_present_or_unreported, true)
  assert.equal(summary.delegated_build_session_count, 1)
  assert.equal(summary.delegated_build_safe, true)
  assert.equal(summary.delegation_pressure.pressure_level, 'medium')
})

test('observatory summary flags active empty/error bots and skips inactive bots explicitly', () => {
  const emptyActive = summarizeObservatory({
    status: 200,
    ok: true,
    json: { records: {} },
  } as never, { id: 'bot_1', trading_active: true })
  assert.equal(emptyActive.capability, 'empty')
  assert.equal(emptyActive.fresh_24h, false)
  assert.equal(emptyActive.usage_present_or_unreported, false)

  const errorActive = summarizeObservatory({
    status: 502,
    ok: false,
    json: null,
    error: 'load sandbox failed',
  }, { id: 'bot_2', trading_active: true })
  assert.equal(errorActive.capability, 'error')
  assert.equal(errorActive.error, 'load sandbox failed')

  const inactive = summarizeObservatory({
    status: 502,
    ok: false,
    json: null,
    error: 'load sandbox failed',
  }, { id: 'bot_3', trading_active: false })
  assert.equal(inactive.capability, 'skipped')
  assert.equal(inactive.skip_reason, 'bot_not_trading_active')
})

test('observatory delegated build safety treats blocked paper self-improvement as gated', () => {
  const now = new Date().toISOString()
  const summary = summarizeObservatory({
    status: 200,
    ok: true,
    json: {
      records: {
        world_signal_digests: [{ created_at: now }],
        reflection_runs: [{
          created_at: now,
          usage_summary: { reporting_status: 'not_applicable', event_count: 0 },
        }],
        ideas: [],
        research_tasks: [],
        delegated_work_sessions: [
          {
            created_at: now,
            source: 'runtime-self-improvement',
            status: 'backtest_pass',
            summary: 'Improve paper-only behavior and leave live promotion blocked for the conductor.',
            artifact_ref: 'artifact://self-improvement/run.json',
          },
          {
            created_at: now,
            source: 'improvement-dispatch',
            status: 'dispatched',
            summary: 'intent_1',
            artifact_ref: 'artifact://memory/decision-contexts.jsonl#ctx_1',
          },
        ],
        owner_feedback: [],
      },
    },
  } as never, { id: 'bot_1', trading_active: true })

  assert.equal(summary.delegated_build_session_count, 2)
  assert.equal(summary.unsafe_delegated_build_session_count, 0)
  assert.equal(summary.delegated_build_safe, true)
})

test('strategy alignment catches prompt-to-config mandate mismatches', () => {
  const noTrades = summarizeTrades({ status: 200, ok: true, json: [] } as never)
  const runs = summarizeRuns({ status: 200, ok: true, json: [{ run_id: 'r1' }] } as never)

  assert.equal(
    classifyStrategyAlignment({
      strategyType: 'perp',
      strategyConfig: { available_protocols: ['gmx_v2'] },
      userPrompt: 'I want an agent that trades ETH perps on Hyperliquid.',
      trades: noTrades,
      runs,
    }),
    'mismatch',
  )

  assert.equal(
    classifyStrategyAlignment({
      strategyType: 'yield',
      strategyConfig: { available_protocols: ['aave_v3'] },
      userPrompt: 'Build a diversified trading agent: 60% DEX, 30% yield, 10% prediction markets.',
      trades: noTrades,
      runs,
    }),
    'mismatch',
  )
})

test('strategy alignment does not treat negative Hyperliquid mention as mandate', () => {
  const noTrades = summarizeTrades({ status: 200, ok: true, json: [] } as never)
  const runs = summarizeRuns({ status: 200, ok: true, json: [{ run_id: 'r1' }] } as never)

  assert.equal(
    classifyStrategyAlignment({
      strategyType: 'perp',
      strategyConfig: { available_protocols: ['gmx_v2', 'vertex'] },
      userPrompt: 'Use GMX and Vertex. Do not use Hyperliquid native execution.',
      trades: noTrades,
      runs,
    }),
    'aligned',
  )
})
