// Regression tests for the multi-asset rebalance sidecar. The sidecar runs as
// CommonJS in /home/agent/tools, while this repo root is ESM; load through the
// Module API so tests exercise the shipped source under the sandbox module mode.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const PAIRS = {
  weth: '0x4200000000000000000000000000000000000006',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}

function loadMultiTick(mockTick) {
  const filename = path.join(__dirname, 'multi_tick.js')
  const source = fs.readFileSync(filename, 'utf8')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (request === '/home/agent/tools/tick-common') return mockTick
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    mod._compile(source, filename)
    return mod.exports
  } finally {
    Module._load = originalLoad
  }
}

function mockTick(overrides = {}) {
  return {
    pairTokens: () => PAIRS,
    isPaperShowcaseMode: (config, harness) => Boolean(
      config && config.strategy_config && config.strategy_config.paper_trade === true && harness && harness.aggressive_paper_mode === true,
    ),
    asNumber: (value, fallback = 0) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    },
    paperCycleWeight: () => {
      throw new Error('paper target cycle should not run without explicit cycle config')
    },
    ...overrides,
  }
}

function bySymbol(assets, symbol) {
  return assets.find((asset) => asset.symbol === symbol)
}

test('prompt allocation is honored without implicit paper-cycle oscillation', () => {
  let cycleCalls = 0
  const multi = loadMultiTick(mockTick({
    paperCycleWeight: () => {
      cycleCalls += 1
      throw new Error('implicit paper cycle must not run')
    },
  }))

  const assets = multi.targetAssets({
    config: {
      bot_id: 'trading-live-regression',
      strategy_config: {
        paper_trade: true,
        user_prompt: 'Target allocation: 60% WETH, 40% USDC. Rebalance when drift exceeds 5%.',
      },
    },
    harness: { aggressive_paper_mode: true },
  })

  assert.equal(cycleCalls, 0)
  assert.equal(bySymbol(assets, 'WETH').target, 0.6)
  assert.equal(bySymbol(assets, 'USDC').target, 0.4)
  assert.equal(bySymbol(assets, 'WETH').target_source, 'prompt')
})

test('structured portfolio assets can use symbols without addresses', () => {
  const multi = loadMultiTick(mockTick())

  const assets = multi.targetAssets({
    config: { strategy_config: { paper_trade: true } },
    harness: {
      portfolio: {
        assets: [
          { symbol: 'WETH', target_weight: 0.78 },
          { symbol: 'USDC', target_weight: 0.22 },
        ],
      },
    },
  })

  assert.equal(bySymbol(assets, 'WETH').address, PAIRS.weth)
  assert.equal(bySymbol(assets, 'USDC').address, PAIRS.usdc)
  assert.equal(bySymbol(assets, 'WETH').target, 0.78)
  assert.equal(bySymbol(assets, 'USDC').target, 0.22)
})

test('explicit paper target cycle still works when configured', () => {
  let cycleSettings = null
  const multi = loadMultiTick(mockTick({
    paperCycleWeight: (_ctx, settings, fallback) => {
      cycleSettings = settings
      assert.equal(fallback, 0.6)
      return 0.9
    },
  }))

  const assets = multi.targetAssets({
    config: { strategy_config: { paper_trade: true } },
    harness: {
      aggressive_paper_mode: true,
      portfolio: {
        paper_target_cycle: { values: [0.1, 0.9], period_secs: 300 },
        assets: [
          { symbol: 'WETH', target_weight: 0.6 },
          { symbol: 'USDC', target_weight: 0.4 },
        ],
      },
    },
  })

  assert.deepEqual(cycleSettings, { values: [0.1, 0.9], period_secs: 300 })
  assert.equal(bySymbol(assets, 'WETH').target, 0.9)
  assert.ok(Math.abs(bySymbol(assets, 'USDC').target - 0.1) < 0.000000001)
  assert.equal(bySymbol(assets, 'WETH').target_source, 'explicit_paper_target_cycle')
})
