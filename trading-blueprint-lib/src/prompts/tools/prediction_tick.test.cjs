// Regression tests for the prediction-market tick. The tick ships as a CommonJS
// script under /home/agent/tools and runs runTick() on load, printing one JSON
// object. Each scenario runs in a child node process via an inline runner that
// installs the sandbox mocks (api-client, agentic-decision, log/metrics/reflection)
// AND a stub global.fetch (Gamma + CLOB) before requiring the tick, then prints a
// wrapper JSON { result, intents } so the parent can assert on the decision and
// the validate/execute intents.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const TICK = path.join(__dirname, 'prediction_tick.js')

const RUNNER = `
const Module = require('module')
const s = JSON.parse(process.argv[1])
Object.assign(process.env, s.env || {})
const intents = { validate: [], execute: [] }

// Stub network: Gamma events + CLOB midpoint. s.markets controls discovery;
// s.networkFail forces a fetch rejection (no-markets path).
global.fetch = async (url) => {
  if (s.networkFail) throw new Error('network down')
  const u = String(url)
  if (u.includes('gamma-api.polymarket.com')) {
    return { ok: true, json: async () => s.events }
  }
  if (u.includes('clob.polymarket.com/midpoint')) {
    return { ok: true, json: async () => ({ mid: s.clobMid }) }
  }
  return { ok: false, json: async () => ({}) }
}

const api = {
  loadConfig: () => ({ bot_id: 'pred-test', strategy_config: { protocol_chain_id: 1 } }),
  apiCall: async (method, p) => {
    if (p === '/portfolio/state') {
      return { data: { total_value_usd: s.nav, positions: s.positions } }
    }
    if (p === '/circuit-breaker/check') return { data: { should_break: s.breakerTripped } }
    return { data: {} }
  },
  checkCircuitBreaker: async () => ({ data: { should_break: s.breakerTripped } }),
  validate: async (intent) => { intents.validate.push(intent); return { status: 200, data: { approved: s.validationApproved } } },
  execute: async (intent) => { intents.execute.push(intent); return { status: 200, data: { executed: true } } },
}
const agentic = {
  agenticDecisionsEnabled: () => s.agenticEnabled,
  agenticDecision: async () => s.decision,
}
const mocks = {
  '/home/agent/tools/api-client': api,
  '/home/agent/tools/agentic-decision': agentic,
  '/home/agent/tools/log-decision': { provenanceHash: () => 'sha256:test' },
  '/home/agent/tools/reflection-loop': {
    recordDecisionContext: () => ({ context_id: 'ctx-1', evidence: {} }),
    reflectOnDecisionContext: () => ({ reflection_id: 'r-1', decision_context_id: 'ctx-1', mode: 'cadence', verdict: 'ok', summary: '' }),
  },
  child_process: { spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) },
}
// tick-common is exercised for real (asNumber/positionsOf/vaultSpotAmount/
// submitIntent/runTick); map its sandbox path to the local source. Its own
// internal sandbox requires (api-client, log-decision, reflection-loop) resolve
// through the mocks below.
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '/home/agent/tools/tick-common') return origLoad.call(this, s.tickCommon, parent, isMain)
  if (mocks[request]) return mocks[request]
  return origLoad.call(this, request, parent, isMain)
}
let captured = ''
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (c) => { captured += c; return true }
require(s.tickPath)
const wait = async () => {
  const deadline = Date.now() + 4000
  while (!captured.includes('\\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  process.stdout.write = realWrite
  const line = captured.split('\\n').find((l) => l.trim())
  realWrite(JSON.stringify({ result: JSON.parse(line), intents }) + '\\n')
}
wait()
`

// One seeded USDC spot position (Polygon USDC) so idle cash is deployable.
const POLYGON_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
function cashPositions(usd) {
  return [{ token: POLYGON_USDC, position_type: 'spot', amount: usd, value_usd: usd }]
}

function gammaEvents() {
  return [
    {
      title: 'Election event',
      markets: [
        {
          id: 'cond-aaa',
          question: 'Will candidate A win?',
          volume: '5000000',
          liquidity: '200000',
          outcomePrices: JSON.stringify(['0.62', '0.38']),
          clobTokenIds: JSON.stringify(['token-yes-aaa', 'token-no-aaa']),
          endDate: '2030-01-01T00:00:00Z',
        },
        {
          id: 'cond-bbb',
          question: 'Will event B happen?',
          volume: '1000000',
          liquidity: '50000',
          outcomePrices: JSON.stringify(['0.50', '0.50']),
          clobTokenIds: JSON.stringify(['token-yes-bbb', 'token-no-bbb']),
          endDate: '2030-01-01T00:00:00Z',
        },
      ],
    },
  ]
}

function runTick(scenario) {
  const s = {
    tickPath: TICK,
    tickCommon: path.join(__dirname, 'tick_common.js'),
    agenticEnabled: true,
    decision: null,
    nav: 10000,
    positions: cashPositions(5000),
    events: gammaEvents(),
    clobMid: 0.62,
    networkFail: false,
    breakerTripped: false,
    validationApproved: true,
    env: {},
    ...scenario,
  }
  const out = spawnSync(process.execPath, ['-e', RUNNER, JSON.stringify(s)], {
    encoding: 'utf8',
    env: { ...process.env, ...s.env },
  })
  assert.equal(out.status, 0, `runner exited non-zero: ${out.stderr}`)
  const line = out.stdout.split('\n').find((l) => l.trim().startsWith('{'))
  assert.ok(line, `no JSON in runner stdout: ${out.stdout}\n${out.stderr}`)
  return JSON.parse(line)
}

function modelDecision(action, extra = {}) {
  return {
    action,
    size_fraction: 1,
    confidence: 0.8,
    rationale: 'r',
    key_signals: ['yes_implied_prob'],
    model: 'glm-4.7',
    prompt_hash: 'sha256:abc',
    decided_by: 'model',
    ...extra,
  }
}

// ── The required disabled/eval baseline ─────────────────────────────────────
test('disabled (TRADING_AGENTIC_DECISIONS=0): emits schema-v1 no-model baseline skip', () => {
  const { result, intents } = runTick({
    agenticEnabled: false,
    decision: null,
    env: { TRADING_AGENTIC_DECISIONS: '0' },
  })
  assert.equal(result.result_schema_version, 1)
  assert.equal(result.family, 'prediction')
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'prediction-no-model-baseline')
  assert.equal(result.decision.decided_by, undefined)
  // The schema-v1 side-effect flags are present (log/metrics writers are stubbed
  // in-process, so their truthiness is asserted in-sandbox, not here).
  assert.equal(typeof result.logs_written, 'boolean')
  assert.equal(typeof result.metrics_written, 'boolean')
  assert.ok(result.checked_state)
  assert.equal(intents.execute.length, 0)
})

// ── Model alpha path ────────────────────────────────────────────────────────
test('model "enter_yes" buys the YES token of the top-ranked market, capped to envelope', () => {
  const { result, intents } = runTick({ decision: modelDecision('enter_yes') })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(result.decision.model, 'glm-4.7')
  assert.equal(result.decision.intent.target_protocol, 'polymarket_clob')
  assert.equal(result.decision.intent.token_out, 'token-yes-aaa')
  assert.equal(result.decision.intent.metadata.outcome, 'YES')
  assert.equal(result.decision.intent.metadata.condition_id, 'cond-aaa')
  // 10% of 10k NAV = $1000 deploy cap; shares = 1000 / 0.62.
  assert.ok(result.decision.intent.metadata.notional_usd <= 1000.0001)
  assert.equal(intents.execute.length, 1)
})

test('model "enter_no" buys the NO token of the top-ranked market', () => {
  const { result } = runTick({ decision: modelDecision('enter_no', { size_fraction: 0.5 }) })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.intent.token_out, 'token-no-aaa')
  assert.equal(result.decision.intent.metadata.outcome, 'NO')
  assert.equal(result.decision.intent.metadata.outcome_index, 1)
})

test('model "skip" trades nothing and keeps provenance (model-chose-skip)', () => {
  const { result, intents } = runTick({ decision: modelDecision('skip', { size_fraction: 0 }) })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-chose-skip')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(intents.execute.length, 0)
})

test('model "hold" (the shared prompt\'s no-trade word) is accepted as a skip, not a failure', () => {
  // The generic decision system prompt tells the model to answer "hold"/"skip"
  // when undecisive. "hold" is now an accepted candidate that normalizes to a
  // model-chosen skip WITH provenance — it must NOT fall through to the failure
  // path. This is the regression for the live `model-no-edge`/`decided_by:None` bug.
  const { result, intents } = runTick({ decision: modelDecision('hold', { size_fraction: 0 }) })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-chose-skip')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(intents.execute.length, 0)
})

test('fail-closed: model null SKIPS with a DISTINCT failure reason (not a benign skip)', () => {
  const { result, intents } = runTick({ decision: null })
  assert.equal(result.decision.action, 'skip')
  // A model/transport failure must be distinguishable from a model-chosen skip so
  // a dead decision path surfaces instead of hiding behind model-chose-skip.
  assert.equal(result.decision.reason, 'model-decision-unavailable')
  assert.equal(result.decision.decided_by, undefined)
  assert.equal(intents.execute.length, 0)
})

// ── Deterministic risk guards (run before the model) ────────────────────────
test('circuit breaker tripped halts new entries', () => {
  const { result, intents } = runTick({ breakerTripped: true, decision: modelDecision('enter_yes') })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'circuit-breaker-triggered')
  assert.equal(intents.execute.length, 0)
})

test('no open markets skips (network failure fails closed)', () => {
  const { result } = runTick({ networkFail: true, decision: modelDecision('enter_yes') })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'no-open-markets')
})

test('idle cash below minimum skips', () => {
  const { result } = runTick({ positions: cashPositions(2), decision: modelDecision('enter_yes') })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'idle-cash-below-minimum')
})

test('model size below minimum skips with provenance', () => {
  const { result, intents } = runTick({ decision: modelDecision('enter_yes', { size_fraction: 0.001 }) })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-size-below-minimum')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(intents.execute.length, 0)
})

test('validation rejection becomes a logged skip', () => {
  const { result } = runTick({ decision: modelDecision('enter_yes'), validationApproved: false })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'submission-rejected')
  assert.equal(result.decision.decided_by, 'model')
})

// ── End-to-end through the REAL agentic-decision module ─────────────────────
// The tests above stub agenticDecision wholesale, so they never exercise the
// `candidates.includes(action)` gate that nulled the LIVE call (a discovered
// market + idle cash, yet `model-no-edge`/`decided_by:None`). This runner loads
// the real agentic_decision.js and routes its model HTTP call through the fetch
// stub, proving the model IS consulted and its reply maps onto the prediction
// sides — including the `"hold"` reply the shared prompt naturally produces.
const E2E_RUNNER = `
const Module = require('module')
const s = JSON.parse(process.argv[1])
Object.assign(process.env, s.env || {})
const intents = { validate: [], execute: [] }
let modelCalled = false

global.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('gamma-api.polymarket.com')) return { ok: true, json: async () => s.events }
  if (u.includes('clob.polymarket.com/midpoint')) return { ok: true, json: async () => ({ mid: s.clobMid }) }
  if (u.includes('/chat/completions')) {
    // Assert the tick fed the model the allowed actions + the candidate market.
    modelCalled = true
    const sent = JSON.parse(init.body)
    const userMsg = sent.messages.find((m) => m.role === 'user').content
    if (!userMsg.includes('enter_yes') || !userMsg.includes('candidate_market')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"skip","size_fraction":0}' } }] }) }
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(s.modelReply) } }], usage: { total_tokens: 10 } }) }
  }
  return { ok: false, json: async () => ({}) }
}

const api = {
  loadConfig: () => ({ bot_id: 'pred-test', strategy_config: { protocol_chain_id: 1 } }),
  apiCall: async (method, p) => {
    if (p === '/portfolio/state') return { data: { total_value_usd: s.nav, positions: s.positions } }
    return { data: {} }
  },
  checkCircuitBreaker: async () => ({ data: { should_break: false } }),
  validate: async (intent) => { intents.validate.push(intent); return { status: 200, data: { approved: true } } },
  execute: async (intent) => { intents.execute.push(intent); return { status: 200, data: { executed: true } } },
}
const mocks = {
  '/home/agent/tools/api-client': api,
  // REAL agentic-decision — the model gate under test.
  '/home/agent/tools/agentic-decision': require(s.agenticReal),
  '/home/agent/tools/log-decision': { provenanceHash: () => 'sha256:test' },
  '/home/agent/tools/reflection-loop': {
    recordDecisionContext: () => ({ context_id: 'ctx-1', evidence: {} }),
    reflectOnDecisionContext: () => ({ reflection_id: 'r-1', decision_context_id: 'ctx-1', mode: 'cadence', verdict: 'ok', summary: '' }),
  },
  child_process: { spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '/home/agent/tools/tick-common') return origLoad.call(this, s.tickCommon, parent, isMain)
  if (mocks[request]) return mocks[request]
  return origLoad.call(this, request, parent, isMain)
}
let captured = ''
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (c) => { captured += c; return true }
require(s.tickPath)
const wait = async () => {
  const deadline = Date.now() + 4000
  while (!captured.includes('\\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  process.stdout.write = realWrite
  const line = captured.split('\\n').find((l) => l.trim())
  realWrite(JSON.stringify({ result: JSON.parse(line), intents, modelCalled }) + '\\n')
}
wait()
`

function runTickE2E(scenario) {
  const s = {
    tickPath: TICK,
    tickCommon: path.join(__dirname, 'tick_common.js'),
    agenticReal: path.join(__dirname, 'agentic_decision.js'),
    nav: 10000,
    positions: cashPositions(5000),
    events: gammaEvents(),
    clobMid: 0.62,
    modelReply: { action: 'enter_yes', size_fraction: 1, confidence: 0.8, rationale: 'edge', key_signals: ['yes_implied_prob'] },
    // The decision module is enabled by an API key + base url in env.
    env: { ZAI_API_KEY: 'test-key', TRADING_AGENTIC_DECISIONS: '1' },
    ...scenario,
  }
  const out = spawnSync(process.execPath, ['-e', E2E_RUNNER, JSON.stringify(s)], {
    encoding: 'utf8',
    env: { ...process.env, ...s.env },
  })
  assert.equal(out.status, 0, `runner exited non-zero: ${out.stderr}`)
  const line = out.stdout.split('\n').find((l) => l.trim().startsWith('{'))
  assert.ok(line, `no JSON in runner stdout: ${out.stdout}\n${out.stderr}`)
  return JSON.parse(line)
}

test('E2E: a discovered market => the model IS consulted and enter_yes produces a real trade', () => {
  const { result, intents, modelCalled } = runTickE2E({})
  assert.equal(modelCalled, true, 'the model endpoint was never hit')
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(result.decision.intent.target_protocol, 'polymarket_clob')
  assert.equal(result.decision.intent.metadata.outcome, 'YES')
  assert.equal(intents.execute.length, 1)
})

test('E2E: the shared prompt\'s "hold" reply maps to model-chose-skip, NOT a null failure', () => {
  // This is the exact live failure shape: a valid top market + idle cash, but the
  // model answers "hold". Before the candidate-vocabulary fix, agenticDecision
  // nulled this (hold not in candidates) and the tick reported it as a failure.
  const { result, modelCalled } = runTickE2E({
    modelReply: { action: 'hold', size_fraction: 0, confidence: 0.2, rationale: 'no edge' },
  })
  assert.equal(modelCalled, true)
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-chose-skip')
  assert.equal(result.decision.decided_by, 'model')
})

test('E2E: a genuine model failure (HTTP non-ok) fails closed as model-decision-unavailable', () => {
  // Out-of-contract action that agenticDecision rejects => null => the DISTINCT
  // failure reason, not model-chose-skip.
  const { result, modelCalled } = runTickE2E({
    modelReply: { action: 'moon', size_fraction: 1, confidence: 0.9, rationale: 'lol' },
  })
  assert.equal(modelCalled, true)
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-decision-unavailable')
  assert.equal(result.decision.decided_by, undefined)
})
