const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

function loadReflectionLoop(tmp) {
  const filename = path.join(__dirname, 'reflection_loop.js')
  const previous = {
    AGENT_ROOT: process.env.AGENT_ROOT,
    AGENT_MEMORY_DIR: process.env.AGENT_MEMORY_DIR,
    AGENT_DECISION_LOG: process.env.AGENT_DECISION_LOG,
    AGENT_IMPROVEMENT_INTENT_COOLDOWN_MS: process.env.AGENT_IMPROVEMENT_INTENT_COOLDOWN_MS,
    AGENT_IMPROVEMENT_DISPATCH_COOLDOWN_MS: process.env.AGENT_IMPROVEMENT_DISPATCH_COOLDOWN_MS,
  }
  process.env.AGENT_ROOT = tmp
  process.env.AGENT_MEMORY_DIR = path.join(tmp, 'memory')
  process.env.AGENT_DECISION_LOG = path.join(tmp, 'logs', 'decisions.jsonl')
  process.env.AGENT_IMPROVEMENT_INTENT_COOLDOWN_MS = '0'
  process.env.AGENT_IMPROVEMENT_DISPATCH_COOLDOWN_MS = String(24 * 60 * 60 * 1000)

  const source = fs.readFileSync(filename, 'utf8')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod._compile(source, filename)

  return {
    api: mod.exports,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('records decision context, reflects, and queues a behavior-grounded improvement intent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-loop-'))
  const { api, restore } = loadReflectionLoop(tmp)
  try {
    fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true })
    fs.appendFileSync(
      path.join(tmp, 'logs', 'decisions.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-06-04T10:00:00.000Z', action: 'skip', reason: 'perp-config-incomplete' }),
        JSON.stringify({ timestamp: '2026-06-04T10:05:00.000Z', action: 'skip', reason: 'perp-config-incomplete' }),
        JSON.stringify({ timestamp: '2026-06-04T10:10:00.000Z', action: 'skip', reason: 'perp-config-incomplete' }),
      ].join('\n') + '\n',
    )

    const context = api.recordDecisionContext({
      family: 'perp',
      run_started_at: '2026-06-04T10:15:00.000Z',
      run_completed_at: '2026-06-04T10:15:01.000Z',
      config: {
        bot_id: 'bot-eth',
        strategy_type: 'perp',
        strategy_config: {
          user_prompt: 'I want an agent that trades ETH perps on Hyperliquid.',
          available_protocols: ['gmx_v2'],
          paper_trade: true,
        },
      },
      harness: { version: 1, aggressive_paper_mode: true },
      checked_state: {
        total_nav_usdc: 10000,
        prices: { BTC: 68000 },
      },
      decision: { action: 'skip', reason: 'perp-config-incomplete' },
      metrics: { portfolio_value_usd: 10000, signals_generated: 0 },
      recipe_hash: 'recipe',
      input_hash: 'input',
    })

    assert.match(context.context_id, /^ctx_/)
    assert.equal(context.evidence.observed_portfolio, true)
    assert.equal(context.evidence.mandate_alignment, 'mismatch')
    assert.equal(context.prior.recent_decisions.length, 3)

    const reflection = api.reflectOnDecisionContext(context)
    assert.match(reflection.reflection_id, /^refl_/)
    assert.equal(reflection.verdict, 'improve')
    assert.ok(reflection.findings.some((finding) => finding.code === 'mandate-hyperliquid-not-observed'))
    assert.ok(reflection.findings.some((finding) => finding.code === 'repeated-skip'))
    assert.match(reflection.emitted_improvement_intent_id, /^intent_/)

    const contexts = readJsonl(api.DECISION_CONTEXTS_FILE)
    const reflections = readJsonl(api.REFLECTIONS_FILE)
    const intents = readJsonl(api.IMPROVEMENT_INTENTS_FILE)
    assert.equal(contexts.length, 1)
    assert.equal(reflections.length, 1)
    assert.equal(intents.length, 1)
    assert.equal(intents[0].decision_context_id, context.context_id)
    assert.match(intents[0].prompt, /DecisionContext/)
    assert.match(intents[0].prompt, /paper-only/)
  } finally {
    restore()
  }
})

test('cadence selector dispatches each pending improvement intent once per cooldown window', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-loop-'))
  const { api, restore } = loadReflectionLoop(tmp)
  try {
    fs.mkdirSync(path.dirname(api.IMPROVEMENT_INTENTS_FILE), { recursive: true })
    fs.appendFileSync(
      api.IMPROVEMENT_INTENTS_FILE,
      JSON.stringify({
        schema_version: 1,
        intent_id: 'intent_hot',
        timestamp: '2026-06-04T11:00:00.000Z',
        priority: 'high',
        status: 'pending',
        prompt: 'Fix the hot issue.',
      }) + '\n',
    )

    const selected = api.nextImprovementIntent('default periodic prompt')
    assert.equal(selected.intent.intent_id, 'intent_hot')
    assert.equal(selected.prompt, 'Fix the hot issue.')

    api.recordIntentDispatch(selected.intent, { pid: 123 })
    const afterDispatch = api.nextImprovementIntent('default periodic prompt')
    assert.equal(afterDispatch.intent, null)
    assert.equal(afterDispatch.prompt, 'default periodic prompt')
  } finally {
    restore()
  }
})

test('external signal evidence distinguishes unavailable provider from missing observation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-loop-'))
  const { api, restore } = loadReflectionLoop(tmp)
  try {
    const context = api.recordDecisionContext({
      family: 'prediction',
      run_started_at: '2026-06-04T12:00:00.000Z',
      run_completed_at: '2026-06-04T12:00:01.000Z',
      config: {
        bot_id: 'bot-politics',
        strategy_type: 'prediction',
        strategy_config: {
          user_prompt: 'Trade prediction markets around politics and election catalysts.',
          available_protocols: ['polymarket'],
          paper_trade: true,
        },
      },
      checked_state: {
        portfolio_value_usd: 10000,
        market: { probability_mid: 0.54 },
        external_signal_evidence: {
          checked: true,
          required: true,
          provider_configured: false,
          source_status: 'unavailable_no_provider',
          unavailable: true,
          market_signal_count: 1,
          external_observation_count: 0,
          generated_signal_count: 0,
        },
      },
      decision: { action: 'skip', reason: 'no-event-edge' },
      metrics: {
        portfolio_value_usd: 10000,
        probability_mid: 0.54,
        external_signal_checked: 1,
        external_signal_required: 1,
        external_signal_unavailable: 1,
        signals_generated: 0,
      },
    })

    assert.equal(context.evidence.observed_news, false)
    assert.equal(context.evidence.observed_external_signals, true)
    assert.equal(context.evidence.external_signal_unavailable, true)

    const reflection = api.reflectOnDecisionContext(context)
    const codes = reflection.findings.map((finding) => finding.code)
    assert.ok(codes.includes('external-signal-source-unavailable'))
    assert.ok(!codes.includes('missing-external-signal-observation'))
    assert.ok(!codes.includes('signals-generated-zero'))
  } finally {
    restore()
  }
})
