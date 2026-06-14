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

test('retries on 429 then succeeds (rate-limit backoff)', async () => {
  let calls = 0;
  const fetch429then200 = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({ error: 'rate limit' }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"action":"buy","size_fraction":0.4,"confidence":0.7}' } }] }) };
  };
  const d = await agenticDecision(SPEC, { env: ENV, fetch: fetch429then200, backoffMs: [5, 5] });
  assert.equal(calls, 2, 'should retry once after a 429');
  assert.equal(d.action, 'buy');
});

test('gives up fail-closed after exhausting retries on persistent 429', async () => {
  let calls = 0;
  const always429 = async () => { calls += 1; return { ok: false, status: 429, json: async () => ({}) }; };
  const d = await agenticDecision(SPEC, { env: ENV, fetch: always429, backoffMs: [5, 5, 5, 5] });
  assert.equal(d, null);
  assert.equal(calls, 5, 'initial + 4 retries (default)');
});

test('honors a server Retry-After header on 429', async () => {
  let calls = 0;
  const waits = [];
  const start = Date.now();
  const retryAfterThen200 = async () => {
    calls += 1;
    waits.push(Date.now() - start);
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.05' : null) },
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"action":"hold","size_fraction":0,"confidence":0.5}' } }] }) };
  };
  // backoffMs floor of 1ms; Retry-After=50ms should dominate the wait.
  const d = await agenticDecision(SPEC, { env: ENV, fetch: retryAfterThen200, backoffMs: [1] });
  assert.equal(calls, 2);
  assert.ok(waits[1] >= 45, `second attempt should wait ~Retry-After (got ${waits[1]}ms)`);
  assert.equal(d.action, 'hold');
});

test('does NOT retry a non-retryable 4xx (e.g. 400)', async () => {
  let calls = 0;
  const always400 = async () => { calls += 1; return { ok: false, status: 400, json: async () => ({}) }; };
  const d = await agenticDecision(SPEC, { env: ENV, fetch: always400, backoffMs: [5, 5] });
  assert.equal(d, null);
  assert.equal(calls, 1, 'a 400 is the caller’s fault — no retry');
});

test('agenticAllocation also retries on 429', async () => {
  let calls = 0;
  const fetch429then200 = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"weights":{"WETH":0.5,"USDC":0.5}}' } }] }) };
  };
  const a = await agenticAllocation(ALLOC_SPEC, { env: ENV, fetch: fetch429then200, backoffMs: [5, 5] });
  assert.equal(calls, 2);
  assert.ok(a && a.weights);
});
