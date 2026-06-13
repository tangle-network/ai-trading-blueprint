// Regression tests for the conservative-yield tick's model-driven decision path.
// The tick ships as a CommonJS script under /home/agent/tools and runs its tick
// runner on load, printing one JSON object. To isolate that on-load execution
// (and its stdout) from the node:test reporter, each scenario runs in a child
// process via an inline runner that installs the sandbox mocks before requiring
// the tick — same harness shape as hyperliquid_tick.test.cjs.
//
// The bug these tests lock down (LIVE on the box): the operator's paper portfolio
// synthesizer seeds idle cash as a position with token "USDC" (the SYMBOL, not the
// chain address) and `position_type: null`. The tick's strict vault-spot read
// (`position_type === 'spot'` + exact address match) returned 0, so 'supply' was
// dropped from the candidate set even though $10k of deployable stable was idle.
// The model — correctly seeing idle cash — answered 'supply', which agenticDecision
// rejected as out-of-contract → null → "model-unavailable". The bot never supplied.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const TICK = path.join(__dirname, 'yield_tick.js')
const USDC_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

// Inline runner executed in a child node process. argv[1] = JSON scenario:
//   { tickPath, agenticEnabled, decision (or null), positions, totalValueUsd,
//     validationApproved, env }
// It intercepts every sandbox require (tick-common, agentic-decision, api-client,
// log-decision, reflection-loop) and stubs the spawnSync-backed loggers so the
// full tick path completes, then prints a wrapper JSON { result, agentic } so the
// parent can assert on the decision AND on what was actually sent to the model.
const RUNNER = `
const Module = require('module')
const cp = require('child_process')
const realSpawn = cp.spawnSync
// The real tick-common log/metrics writers spawn node against /home/agent/tools/*.js
// which do not exist in this repo; no-op those so the path completes.
cp.spawnSync = (cmd, args) =>
  (Array.isArray(args) && typeof args[0] === 'string' && args[0].includes('/home/agent/tools/'))
    ? { status: 0, stdout: '{}', stderr: '' }
    : realSpawn(cmd, args)

const s = JSON.parse(process.argv[1])
Object.assign(process.env, s.env || {})
const tickCommon = require(${JSON.stringify(path.join(__dirname, 'tick_common.js'))})

const agenticCalls = []
const api = {
  loadConfig: () => ({ bot_id: 'yield-test', strategy_config: { protocol_chain_id: 8453 } }),
  apiCall: async (method, p) => {
    if (p === '/portfolio/state') return { data: { positions: s.positions, total_value_usd: s.totalValueUsd } }
    if (p === '/market-data/prices') return { data: { prices: s.prices || [] } }
    return { data: {} }
  },
  checkCircuitBreaker: async () => ({ data: { should_break: Boolean(s.circuitBreak) } }),
  validate: async () => ({ status: 200, data: { approved: s.validationApproved } }),
  execute: async () => ({ status: 200, data: { executed: true } }),
  normalizeIntent: (i) => i,
}
const agentic = {
  agenticDecisionsEnabled: () => s.agenticEnabled,
  agenticDecision: async (spec) => {
    agenticCalls.push(spec)
    // Honor the real fail-closed contract: an out-of-contract action returns null.
    if (s.decision && !spec.candidates.includes(s.decision.action)) return null
    return s.decision
  },
}
const mocks = {
  '/home/agent/tools/tick-common': tickCommon,
  '/home/agent/tools/agentic-decision': agentic,
  '/home/agent/tools/api-client': api,
  '/home/agent/tools/log-decision': { provenanceHash: () => 'sha256:test' },
  '/home/agent/tools/reflection-loop': {
    recordDecisionContext: () => ({ context_id: 'ctx-1', evidence: {} }),
    reflectOnDecisionContext: () => ({ reflection_id: 'r-1', decision_context_id: 'ctx-1', mode: 'cadence', verdict: 'ok', summary: '' }),
  },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
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
  realWrite(JSON.stringify({ result: JSON.parse(line), agentic: agenticCalls }) + '\\n')
}
wait()
`

function runTick(scenario) {
  const s = {
    tickPath: TICK,
    agenticEnabled: true,
    decision: null,
    positions: [],
    totalValueUsd: 10000,
    prices: [{ token: USDC_ADDR, price_usd: 1 }],
    validationApproved: true,
    circuitBreak: false,
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
    confidence: 0.85,
    rationale: 'idle cash should earn yield',
    key_signals: ['idle_usdc'],
    model: 'glm-4.7',
    prompt_hash: 'sha256:abc',
    decided_by: 'model',
    ...extra,
  }
}

// The exact shape the operator's paper synthesizer emits for seeded idle cash:
// token = "USDC" SYMBOL, position_type null, protocol null. Pre-fix this was
// invisible to the tick.
const SYNTH_PAPER_CASH = [{ token: 'USDC', amount: 10000, value_usd: 10000 }]

test('THE BUG: synthesized paper cash makes the model see "supply" and a supply trade is produced', () => {
  const { result, agentic } = runTick({
    positions: SYNTH_PAPER_CASH,
    decision: modelDecision('supply'),
  })
  // The model WAS consulted...
  assert.equal(agentic.length, 1, 'agenticDecision must be called exactly once')
  // ...with 'supply' offered (the candidate that was silently dropped pre-fix).
  assert.ok(agentic[0].candidates.includes('supply'), `candidates missing supply: ${JSON.stringify(agentic[0].candidates)}`)
  // ...and the supply trade was produced, not "model-unavailable".
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.reason, 'model-supply')
  assert.equal(result.decision.decided_by, 'model')
  // Idle was resolved via the symbol fallback, and surfaced for audit.
  assert.equal(result.checked_state.idle_usdc, 10000)
  assert.equal(result.checked_state.idle_source, 'token_match_fallback')
})

test('idle cash labeled by address with position_type spot still resolves directly', () => {
  const { result, agentic } = runTick({
    positions: [{ token: USDC_ADDR, position_type: 'spot', amount: 10000, value_usd: 10000, protocol: 'paper' }],
    decision: modelDecision('supply'),
  })
  assert.ok(agentic[0].candidates.includes('supply'))
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.reason, 'model-supply')
  assert.equal(result.checked_state.idle_source, 'vault_spot')
})

test('fail-closed: a genuine model null with idle cash HOLDS, never supplies on the rule', () => {
  const { result, agentic } = runTick({
    positions: SYNTH_PAPER_CASH,
    decision: null, // model unavailable
  })
  // The model was still consulted with 'supply' offered — so this is a true
  // model failure, not the dropped-candidate bug.
  assert.equal(agentic.length, 1)
  assert.ok(agentic[0].candidates.includes('supply'))
  assert.equal(result.decision.action, 'hold')
  assert.equal(result.decision.reason, 'model-unavailable')
})

test('model "hold" with idle cash holds and keeps provenance (no churn on noise)', () => {
  const { result } = runTick({
    positions: SYNTH_PAPER_CASH,
    decision: modelDecision('hold', { size_fraction: 0 }),
  })
  assert.equal(result.decision.action, 'hold')
  assert.equal(result.decision.reason, 'model-no-trade')
  assert.equal(result.decision.decided_by, 'model')
})

test('truly empty portfolio short-circuits at the risk guard — model NOT consulted', () => {
  const { result, agentic } = runTick({ positions: [], decision: modelDecision('supply') })
  assert.equal(agentic.length, 0, 'no balance must not reach the model')
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'no-stable-balance')
})

test('deterministic baseline (model disabled) supplies idle cash toward target', () => {
  const { result, agentic } = runTick({
    positions: SYNTH_PAPER_CASH,
    agenticEnabled: false,
    decision: null,
    env: { TRADING_AGENTIC_DECISIONS: '0' },
  })
  assert.equal(agentic.length, 0, 'model must not be consulted when disabled')
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.reason, 'aave-supply-to-target')
  assert.equal(result.decision.decided_by, undefined)
})

test('risk guard wins: tripped breaker while supplied withdraws, bypassing the model', () => {
  const { result, agentic } = runTick({
    positions: [{ token: USDC_ADDR, protocol: 'aave_v3', amount: 8000, value_usd: 8000 }],
    circuitBreak: true,
    decision: modelDecision('supply'),
  })
  assert.equal(agentic.length, 0, 'breaker must short-circuit before the model')
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.reason, 'drawdown-derisk-withdraw')
})
