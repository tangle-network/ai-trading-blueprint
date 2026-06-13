'use strict';

const assert = require('node:assert');
const test = require('node:test');
const {
  agenticDecision,
  agenticAllocation,
  agenticDecisionsEnabled,
  resolveModelEndpoint,
  stripJsonFence,
} = require('./agentic_decision.js');

const ALLOC_SPEC = {
  family: 'multi',
  assets: [{ symbol: 'WETH', current_weight: 0.5 }, { symbol: 'USDC', current_weight: 0.5 }],
  mandate: { max_drawdown_pct: 6 },
  evidence: { rsi_14: 72 },
};

const ENV = { ZAI_API_KEY: 'k', TRADING_AGENTIC_DECISIONS: '1' };

function fetchReturning(content, { ok = true, usage = null } = {}) {
  return async () => ({
    ok,
    json: async () => ({ choices: [{ message: { content } }], usage }),
  });
}

const SPEC = {
  family: 'dex',
  candidates: ['buy', 'hold', 'flatten'],
  sizing: { max_fraction: 0.2 },
  mandate: { max_drawdown_pct: 4 },
  position: { held: 0 },
  evidence: { rsi_14: 28, weth_price: 1600 },
};

test('returns a validated decision from clean JSON', async () => {
  const d = await agenticDecision(SPEC, {
    env: ENV,
    fetch: fetchReturning('{"action":"buy","size_fraction":0.5,"confidence":0.8,"rationale":"oversold","key_signals":["rsi_14"]}'),
  });
  assert.equal(d.action, 'buy');
  // size_fraction clamps to the sizing envelope max (0.2), not the raw 0.5
  assert.equal(d.size_fraction, 0.2);
  assert.equal(d.confidence, 0.8);
  assert.equal(d.decided_by, 'model');
  assert.ok(d.prompt_hash.startsWith('sha256:'));
});

test('tolerates code-fenced JSON and leading prose', async () => {
  const d = await agenticDecision(SPEC, {
    env: ENV,
    fetch: fetchReturning('Here is my call:\n```json\n{"action":"hold","size_fraction":0,"confidence":0.3}\n```'),
  });
  assert.equal(d.action, 'hold');
  assert.equal(d.size_fraction, 0);
});

test('fails closed on an action outside the allowed set', async () => {
  const d = await agenticDecision(SPEC, {
    env: ENV,
    fetch: fetchReturning('{"action":"short","size_fraction":1}'),
  });
  assert.equal(d, null);
});

test('fails closed on malformed JSON', async () => {
  const d = await agenticDecision(SPEC, {
    env: ENV,
    fetch: fetchReturning('not json at all'),
  });
  assert.equal(d, null);
});

test('fails closed on a non-ok HTTP response', async () => {
  const d = await agenticDecision(SPEC, {
    env: ENV,
    fetch: fetchReturning('{"action":"buy"}', { ok: false }),
  });
  assert.equal(d, null);
});

test('fails closed on a network throw', async () => {
  const d = await agenticDecision(SPEC, {
    env: ENV,
    fetch: async () => {
      throw new Error('econnreset');
    },
  });
  assert.equal(d, null);
});

test('disabled when TRADING_AGENTIC_DECISIONS=0', async () => {
  assert.equal(agenticDecisionsEnabled({ ZAI_API_KEY: 'k', TRADING_AGENTIC_DECISIONS: '0' }), false);
  const d = await agenticDecision(SPEC, {
    env: { ZAI_API_KEY: 'k', TRADING_AGENTIC_DECISIONS: '0' },
    fetch: fetchReturning('{"action":"buy","size_fraction":0.1}'),
  });
  assert.equal(d, null);
});

test('disabled when no api key is configured', async () => {
  assert.equal(agenticDecisionsEnabled({ TRADING_AGENTIC_DECISIONS: '1' }), false);
});

test('resolveModelEndpoint prefers TRADING_DECISION_* overrides', () => {
  const r = resolveModelEndpoint({
    ZAI_API_KEY: 'z',
    TRADING_DECISION_API_KEY: 'override',
    TRADING_DECISION_MODEL: 'glm-5.1',
  });
  assert.equal(r.apiKey, 'override');
  assert.equal(r.model, 'glm-5.1');
});

test('stripJsonFence returns null when there is no object', () => {
  assert.equal(stripJsonFence('hello world'), null);
});

test('agenticAllocation renormalizes weights to sum 1', async () => {
  const a = await agenticAllocation(ALLOC_SPEC, {
    env: ENV,
    fetch: fetchReturning('{"weights":{"WETH":0.3,"USDC":0.9},"confidence":0.6,"rationale":"overbought"}'),
  });
  assert.ok(Math.abs(a.weights.WETH + a.weights.USDC - 1) < 1e-9);
  assert.ok(Math.abs(a.weights.WETH - 0.25) < 1e-9); // 0.3 / 1.2
  assert.equal(a.decided_by, 'model');
});

test('agenticAllocation fails closed when an asset weight is missing', async () => {
  const a = await agenticAllocation(ALLOC_SPEC, {
    env: ENV,
    fetch: fetchReturning('{"weights":{"WETH":0.5}}'),
  });
  assert.equal(a, null);
});

test('agenticAllocation fails closed on a negative weight', async () => {
  const a = await agenticAllocation(ALLOC_SPEC, {
    env: ENV,
    fetch: fetchReturning('{"weights":{"WETH":-0.1,"USDC":1.1}}'),
  });
  assert.equal(a, null);
});

test('agenticAllocation disabled returns null', async () => {
  const a = await agenticAllocation(ALLOC_SPEC, {
    env: { ZAI_API_KEY: 'k', TRADING_AGENTIC_DECISIONS: '0' },
    fetch: fetchReturning('{"weights":{"WETH":0.5,"USDC":0.5}}'),
  });
  assert.equal(a, null);
});
