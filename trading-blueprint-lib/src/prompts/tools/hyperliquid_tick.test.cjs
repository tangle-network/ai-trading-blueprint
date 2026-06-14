// Regression tests for the Hyperliquid perpetuals tick's model-driven decision
// path. The tick ships as a CommonJS script under /home/agent/tools and runs
// main() on load, printing one JSON object. To isolate that on-load execution
// (and its stdout) from the node:test reporter, each scenario runs in a child
// process via an inline runner that installs the sandbox mocks before requiring
// the tick.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const TICK = path.join(__dirname, 'hyperliquid_tick.js')

// Inline runner executed in a child node process. argv[2] = JSON scenario:
//   { tickPath, agenticEnabled, decision (or null), positions, usableMargin,
//     validationApproved, env }
// It intercepts every sandbox require (api-client, agentic-decision,
// log-decision, write-metrics via child_process, reflection-loop) and prints a
// wrapper JSON { result, intents } so the parent can assert on the decision and
// the execution intents.
const RUNNER = `
const Module = require('module')
const s = JSON.parse(process.argv[1])
Object.assign(process.env, s.env || {})
const CLOSES = s.closes || Array.from({ length: 80 }, (_, i) => 1000 + i)
const intents = { validate: [], execute: [] }
const api = {
  loadConfig: () => ({ bot_id: 'hl-test', strategy_config: { hyperliquid_account_address: '0xacct' } }),
  normalizeIntent: () => ({ strategy_id: 'hl-strat' }),
  getHyperliquidNav: async () => ({ data: { snapshot: { total_nav: 10000, idle_usdc: 4000, hyperliquid_equity: 6000, status: 'ok' } } }),
  getHyperliquidMode: async () => ({ data: { snapshot: { mode: 'trading' } } }),
  getHyperliquidFundingStatus: async () => ({ data: { perp_margin_usdc: s.usableMargin, funding_rate: 0.0001 } }),
  fundHyperliquidMargin: async () => ({ status: 200, data: {} }),
  approveHyperliquidApiWallet: async () => ({ status: 200, data: { verified_corewriter_approval: true } }),
  validate: async (intent) => { intents.validate.push(intent); return { status: 200, data: { approved: s.validationApproved } } },
  execute: async (intent) => { intents.execute.push(intent); return { status: 200, data: { executed: true } } },
  apiCall: async (method, p) => {
    if (p === '/hyperliquid/account') return { data: { positions: s.positions } }
    if (p === '/hyperliquid/prices') return { data: { ETH: 2000, BTC: 60000, SOL: 150 } }
    if (p === '/market-data/candles/fetch') return { data: {} }
    if (typeof p === 'string' && p.startsWith('/market-data/candles')) return { data: { candles: CLOSES.map((c) => ({ close: c })) } }
    return { data: {} }
  },
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
  realWrite(JSON.stringify({ result: JSON.parse(line), intents }) + '\\n')
}
wait()
`

function runTick(scenario) {
  const s = {
    tickPath: TICK,
    agenticEnabled: true,
    decision: null,
    positions: [],
    usableMargin: 5000,
    validationApproved: true,
    closes: null,
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
    key_signals: ['ema_12'],
    model: 'glm-4.7',
    prompt_hash: 'sha256:abc',
    decided_by: 'model',
    ...extra,
  }
}

test('model "long" opens a long capped to the size envelope', () => {
  const { result, intents } = runTick({ decision: modelDecision('long') })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(result.decision.model, 'glm-4.7')
  assert.equal(result.trade_action.intent.action, 'open_long')
  // max_position_pct defaults to 5% of 10k NAV = 500; also <= margin*2.
  assert.ok(Number(result.trade_action.intent.amount_in) <= 500.0001)
  assert.equal(intents.execute.length, 1)
})

test('model "short" opens a short — direction the deterministic rule never took', () => {
  const { result } = runTick({ decision: modelDecision('short', { size_fraction: 0.5 }) })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.trade_action.intent.action, 'open_short')
  assert.equal(result.trade_action.intent.metadata.reduce_only, undefined)
})

test('model "skip" when flat trades nothing and keeps provenance', () => {
  const { result, intents } = runTick({ decision: modelDecision('skip', { size_fraction: 0 }) })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-no-trade')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(intents.execute.length, 0)
})

test('fail-closed: model null when flat SKIPS, never trades the rule', () => {
  const { result, intents } = runTick({ decision: null })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-unavailable-skip')
  assert.equal(intents.execute.length, 0)
})

test('deterministic baseline (model disabled) still opens long on RSI-oversold', () => {
  // Descending closes → RSI<=30 → rsi-oversold long in the deterministic rule.
  const closes = Array.from({ length: 80 }, (_, i) => 2000 - i * 5)
  const { result } = runTick({
    agenticEnabled: false,
    decision: null,
    closes,
    env: { TRADING_AGENTIC_DECISIONS: '0' },
  })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.trade_action.intent.action, 'open_long')
  assert.equal(result.decision.reason, 'rsi-oversold')
  assert.equal(result.decision.decided_by, undefined)
})

test('PnL take-profit guard flattens an open position deterministically, bypassing the model', () => {
  const { result } = runTick({
    positions: [{ asset: 'ETH', szi: 0.5, position: { positionValue: 1000, unrealizedPnl: 50 } }],
    decision: modelDecision('hold', { size_fraction: 0 }),
  })
  // +5% PnL >= 1% take-profit trigger → deterministic close, model never asked.
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.trade_action.intent.action, 'close_long')
  assert.equal(result.trade_action.intent.metadata.reduce_only, true)
  // The deterministic guard fired, so no model provenance on the decision.
  assert.equal(result.decision.decided_by, undefined)
})

test('model "hold" on a non-triggered open position holds without trading', () => {
  const { result, intents } = runTick({
    positions: [{ asset: 'ETH', szi: 0.5, position: { positionValue: 1000, unrealizedPnl: 2 } }],
    decision: modelDecision('hold', { size_fraction: 0 }),
  })
  assert.equal(result.decision.action, 'hold')
  assert.equal(result.decision.reason, 'model-hold')
  assert.equal(result.decision.decided_by, 'model')
  assert.equal(intents.execute.length, 0)
})

test('model "close" on a non-triggered position exits via reduce_only', () => {
  const { result } = runTick({
    positions: [{ asset: 'ETH', szi: 0.5, position: { positionValue: 1000, unrealizedPnl: 2 } }],
    decision: modelDecision('close', { size_fraction: 0 }),
  })
  assert.equal(result.decision.action, 'trade')
  assert.equal(result.trade_action.intent.action, 'close_long')
  assert.equal(result.trade_action.intent.metadata.reduce_only, true)
  assert.equal(result.decision.decided_by, 'model')
})

test('fail-closed: model null while holding HOLDS, never flattens silently', () => {
  const { result, intents } = runTick({
    positions: [{ asset: 'ETH', szi: 0.5, position: { positionValue: 1000, unrealizedPnl: 2 } }],
    decision: null,
  })
  assert.equal(result.decision.action, 'skip')
  assert.equal(result.decision.reason, 'model-unavailable-hold')
  assert.equal(intents.execute.length, 0)
})
