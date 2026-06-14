// Regression tests for the EVM-perp tick's model-driven decision path
// (strategy_type "perp" — GMX v2 / Vertex on Arbitrum). The tick ships as a
// CommonJS script under /home/agent/tools and runs on load via t.runTick,
// printing one schema-v1 JSON object. To isolate that on-load execution (and its
// stdout) from the node:test reporter, each scenario runs in a child process via
// an inline runner that installs the sandbox mocks before requiring the tick.
//
// The REAL tick-common runtime is used (so the risk guards, sizing envelope, and
// submitIntent code under test actually run); only the leaf I/O modules
// (api-client, agentic-decision, log-decision, write-metrics, reflection-loop)
// are stubbed. tick-common is a CommonJS file under a "type":"module" root, so we
// can't require it by path locally; instead we point the sandbox alias
// '/home/agent/tools/tick-common' at the real source file and let the child load
// it as CommonJS (its filename ends in .js but tick-common has no ESM syntax).

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const TICK = path.join(__dirname, 'perp_tick.js')
const TICK_COMMON = path.join(__dirname, 'tick_common.js')
const AGENTIC = path.join(__dirname, 'agentic_decision.js')

// Inline runner executed in a child node process. argv[1] = JSON scenario:
//   { tickPath, tickCommonPath, agenticPath, agenticEnabled, decision (or null),
//     positions, totalNav, breakerTripped, validationApproved, config, env }
// It intercepts the leaf sandbox requires and prints a wrapper JSON
// { result, intents } so the parent can assert on the decision + execution.
const RUNNER = `
const Module = require('module')
const s = JSON.parse(process.argv[1])
Object.assign(process.env, s.env || {})
const CLOSES = s.closes || Array.from({ length: 80 }, (_, i) => 2000 + i)
const intents = { validate: [], execute: [] }
const api = {
  loadConfig: () => s.config,
  normalizeIntent: () => ({ strategy_id: 'perp-strat' }),
  validate: async (intent) => { intents.validate.push(intent); return { status: 200, data: { approved: s.validationApproved } } },
  execute: async (intent) => { intents.execute.push(intent); return { status: 200, data: { executed: true } } },
  checkCircuitBreaker: async () => ({ data: { should_break: s.breakerTripped } }),
  apiCall: async (method, p, b) => {
    if (p === '/portfolio/state') return { data: { total_value_usd: s.totalNav, positions: s.positions } }
    if (p === '/adapters') return { data: { adapters: [] } }
    if (p === '/market-data/prices') return { data: { prices: [ { token: 'ETH', price_usd: 2000 }, { token: 'BTC', price_usd: 60000 } ] } }
    if (p === '/market-data/candles/fetch') return { data: {} }
    if (typeof p === 'string' && p.startsWith('/market-data/candles')) return { data: { candles: CLOSES.map((c) => ({ close: c })) } }
    if (typeof p === 'string' && p.startsWith('/market-data/funding')) return { data: { funding_rate: 0.0001 } }
    return { data: {} }
  },
}
const agentic = {
  agenticDecisionsEnabled: () => s.agenticEnabled,
  agenticDecision: async () => s.decision,
}
const mocks = {
  '/home/agent/tools/tick-common': s.tickCommonPath,
  '/home/agent/tools/agentic-decision': agentic,
  '/home/agent/tools/api-client': api,
  '/home/agent/tools/log-decision': { provenanceHash: () => 'sha256:test' },
  '/home/agent/tools/write-metrics': {},
  '/home/agent/tools/reflection-loop': {
    recordDecisionContext: () => ({ context_id: 'ctx-1', evidence: {} }),
    reflectOnDecisionContext: () => ({ reflection_id: 'r-1', decision_context_id: 'ctx-1', mode: 'cadence', verdict: 'ok', summary: '' }),
  },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const m = mocks[request]
  if (m !== undefined) {
    // tick-common is loaded from a real path (so the runtime runs); the others
    // are object stubs. log-decision/write-metrics are spawned by tick-common
    // via child_process('node', [...]), so stub spawnSync too (below).
    if (typeof m === 'string') return origLoad.call(this, m, parent, isMain)
    return m
  }
  return origLoad.call(this, request, parent, isMain)
}
// tick-common's logDecision/writeMetrics spawn node child processes against
// /home/agent/tools/*.js which don't exist here; stub spawnSync to succeed so
// the side-effect writes report ok without a real subprocess.
const cp = require('child_process')
const realSpawnSync = cp.spawnSync
cp.spawnSync = function (cmd, args, opts) {
  if (typeof args === 'object' && Array.isArray(args) && String(args[0] || '').includes('/home/agent/tools/')) {
    return { status: 0, stdout: '', stderr: '' }
  }
  return realSpawnSync.call(this, cmd, args, opts)
}
let captured = ''
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (c) => { captured += c; return true }
require(s.tickPath)
const wait = async () => {
  const deadline = Date.now() + 6000
  while (!captured.includes('\\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  process.stdout.write = realWrite
  const line = captured.split('\\n').find((l) => l.trim().startsWith('{'))
  realWrite(JSON.stringify({ result: JSON.parse(line), intents }) + '\\n')
}
wait()
`

function baseConfig(overrides = {}) {
  return {
    bot_id: 'perp-test',
    strategy_config: {
      strategy_type: 'perp',
      paper_trade: true,
      initial_capital_usd: 10000,
      protocol_chain_id: 42161,
      protocol_chain_ids: { gmx_v2: 42161, vertex: 42161 },
      available_protocols: ['gmx_v2', 'vertex'],
      perps: { max_leverage: 2, max_position_pct: 5, stop_loss_pct: 5 },
      ...overrides,
    },
  }
}

function runTick(scenario) {
  const s = {
    tickPath: TICK,
    tickCommonPath: TICK_COMMON,
    agenticPath: AGENTIC,
    agenticEnabled: true,
    decision: null,
    positions: [],
    totalNav: 10000,
    breakerTripped: false,
    validationApproved: true,
    closes: null,
    config: baseConfig(),
    env: { EXTERNAL_SIGNALS_DISABLED: '1' },
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
    key_signals: ['ema_12'],
    model: 'glm-4.7',
    prompt_hash: 'sha256:abc',
    decided_by: 'model',
    ...extra,
  }
}

test('model "long" opens a gmx_v2 perp with asset+leverage metadata, size clamped to <= max_position_pct*NAV', () => {
  const { result, intents } = runTick({ decision: modelDecision('long') })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(result.decision.model, 'glm-4.7')
  const intent = result.decision.intent
  assert.equal(intent.action, 'open_long')
  assert.equal(intent.target_protocol, 'gmx_v2')
  assert.equal(intent.token_out, 'ETH')
  // Perp execution contract: metadata.asset (string) + leverage (number) + a
  // stop-loss distance the execute route can parse.
  assert.equal(intent.metadata.asset, 'ETH')
  assert.equal(typeof intent.metadata.leverage, 'number')
  assert.ok(intent.metadata.stop_loss_distance > 0)
  // Entry mark price must be threaded so the paper executor can value the perp
  // fill as notional/price asset units (not a spot swap). Harness ETH = $2000.
  assert.equal(intent.metadata.mark_price, '2000')
  // size_fraction=1 → max_position_pct (5%) of 10k NAV = 500.
  assert.ok(Number(intent.amount_in) <= 500.0001, `notional ${intent.amount_in} > 500 cap`)
  // leverage cap: never exceeds max_leverage=2.
  assert.ok(intent.metadata.leverage <= 2, `leverage ${intent.metadata.leverage} > 2 cap`)
  assert.equal(intents.execute.length, 1)
})

test('model "short" opens a short — direction the old stub never took', () => {
  const { result } = runTick({ decision: modelDecision('short', { size_fraction: 0.5 }) })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.intent.action, 'open_short')
  assert.equal(result.decision.intent.metadata.reduce_only, undefined)
  // 0.5 * 500 cap = 250.
  assert.ok(Number(result.decision.intent.amount_in) <= 250.0001)
})

test('size clamped to envelope even when the model overshoots size_fraction', () => {
  // agenticDecision clamps size_fraction to [0,1]; even at 1 the notional is
  // bounded by max_position_pct*NAV. Assert the hard ceiling holds.
  const { result } = runTick({ decision: modelDecision('long', { size_fraction: 5 }) })
  assert.ok(Number(result.decision.intent.amount_in) <= 500.0001)
})

test('flat + model-null → skip, never trades', () => {
  const { result, intents } = runTick({ decision: null })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-unavailable-skip')
  assert.equal(intents.execute.length, 0)
})

test('model "skip" when flat keeps provenance and trades nothing', () => {
  const { result, intents } = runTick({ decision: modelDecision('skip', { size_fraction: 0 }) })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-no-trade')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(intents.execute.length, 0)
})

test('config-incomplete (wrong chain) → skip', () => {
  const config = baseConfig({ protocol_chain_id: 8453, protocol_chain_ids: { gmx_v2: 8453, vertex: 8453 } })
  const { result, intents } = runTick({ config, decision: modelDecision('long') })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'perp-config-incomplete')
  assert.ok(result.decision.missing_config.length > 0)
  assert.equal(intents.execute.length, 0)
})

test('no usable venue (gmx_v2/vertex absent from available_protocols) → model-reasoned skip', () => {
  // available_protocols lists the venues so the config-incomplete guard passes,
  // but perps.venues points at venues NOT in available_protocols → none usable.
  const config = baseConfig({
    available_protocols: ['gmx_v2', 'vertex'],
    perps: { max_leverage: 2, max_position_pct: 5, stop_loss_pct: 5, venues: ['dydx'] },
  })
  const { result, intents } = runTick({ config, decision: modelDecision('long') })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'perp-no-usable-venue')
  assert.equal(intents.execute.length, 0)
})

test('disabled (TRADING_AGENTIC_DECISIONS=0) → deterministic baseline no-trade, no model provenance', () => {
  const { result, intents } = runTick({
    agenticEnabled: false,
    decision: null,
    env: { EXTERNAL_SIGNALS_DISABLED: '1', TRADING_AGENTIC_DECISIONS: '0' },
  })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'baseline-no-perp-edge')
  assert.equal(result.decision.agentic_disabled, true)
  assert.equal(result.decision.decided_by, undefined)
  assert.equal(intents.execute.length, 0)
})

test('drawdown breaker tripped while flat → skip, no trade', () => {
  const { result, intents } = runTick({ breakerTripped: true, decision: modelDecision('long') })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'circuit-breaker-tripped-flat')
  assert.equal(intents.execute.length, 0)
})

test('drawdown breaker tripped while holding → deterministic flatten (reduce_only close), model never asked', () => {
  const positions = [
    { token: 'ETH', symbol: 'ETH', amount: 0.25, protocol: 'gmx_v2', position_type: 'longperp', current_price: 2000, value_usd: 500, unrealized_pnl: -40 },
  ]
  const { result, intents } = runTick({ breakerTripped: true, positions, decision: modelDecision('hold', { size_fraction: 0 }) })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.reason, 'drawdown-derisk-exit')
  assert.equal(result.decision.intent.action, 'close_long')
  assert.equal(result.decision.intent.metadata.reduce_only, true)
  // Close intents thread the position's mark price so the executor realizes the
  // perp PnL at the exit price rather than failing closed on a missing price.
  assert.equal(result.decision.intent.metadata.mark_price, '2000')
  assert.equal(result.decision.decided_by, undefined)
  assert.equal(intents.execute.length, 1)
})

test('model "close" on an open perp exits via reduce_only with provenance', () => {
  const positions = [
    { token: 'ETH', symbol: 'ETH', amount: 0.25, protocol: 'gmx_v2', position_type: 'longperp', current_price: 2000, value_usd: 500, unrealized_pnl: 5 },
  ]
  const { result } = runTick({ positions, decision: modelDecision('close', { size_fraction: 0 }) })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.intent.action, 'close_long')
  assert.equal(result.decision.intent.metadata.reduce_only, true)
  assert.equal(result.decision.intent.metadata.mark_price, '2000')
  assert.equal(result.decision.decided_by, 'model')
})

test('model "hold" on an open perp holds without trading', () => {
  const positions = [
    { token: 'ETH', symbol: 'ETH', amount: 0.25, protocol: 'gmx_v2', position_type: 'longperp', current_price: 2000, value_usd: 500, unrealized_pnl: 2 },
  ]
  const { result, intents } = runTick({ positions, decision: modelDecision('hold', { size_fraction: 0 }) })
  assert.equal(result.decision.action, 'hold')
  assert.equal(result.decision.reason, 'model-hold')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(intents.execute.length, 0)
})

test('validation rejected → skip, no execute', () => {
  const { result, intents } = runTick({ decision: modelDecision('long'), validationApproved: false })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'perp-validation-rejected')
  assert.equal(intents.execute.length, 0)
})
