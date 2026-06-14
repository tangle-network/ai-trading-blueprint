'use strict';

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');

// Load the author with its /home/agent/tools/agentic-decision require redirected
// to the real local module (same trick the other tool tests use for absolute
// sandbox paths).
function loadAuthor() {
  const file = path.join(__dirname, 'agentic_strategy_author.js');
  const src = fs.readFileSync(file, 'utf8');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const orig = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '/home/agent/tools/agentic-decision') return require('./agentic_decision.js');
    return orig.call(this, request, parent, isMain);
  };
  try {
    mod._compile(src, file);
    return mod.exports;
  } finally {
    Module._load = orig;
  }
}

const { authorStrategy, validateHarness } = loadAuthor();
const ENV = { ZAI_API_KEY: 'k', TRADING_AGENTIC_DECISIONS: '1' };

const GOOD = {
  rationale: 'Trend-follow with a protective stop in a fearful regime.',
  entry_rules: [
    { signal: { type: 'ema_cross', short_period: 12, long_period: 26 }, condition: { type: 'cross_above' }, weight: 0.7 },
    { signal: { type: 'rsi', period: 14 }, condition: { type: 'below', threshold: 35 }, weight: 0.3 },
  ],
  exit_rules: [{ type: 'stop_loss', pct: 4 }, { type: 'take_profit', pct: 10 }],
  position_sizing: { method: 'fixed_fraction', fraction: 0.1 },
  entry_threshold: 0.5,
  max_positions: 3,
};

function fetchJson(obj, { ok = true } = {}) {
  return async () => ({ ok, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { total_tokens: 200 } }) });
}

test('authors a valid harness program from clean output', async () => {
  const r = await authorStrategy({ family: 'dex', parentHarness: { version: 4 } }, { env: ENV, fetch: fetchJson(GOOD) });
  assert.ok(r);
  assert.equal(r.harness.authored_by, 'model');
  assert.equal(r.harness.version, 5); // parent + 1
  assert.equal(r.harness.entry_rules.length, 2);
  assert.equal(r.harness.entry_rules[0].signal.type, 'ema_cross');
  assert.ok(r.harness.exit_rules.length >= 1);
  assert.equal(r.harness.position_sizing.method, 'fixed_fraction');
});

test('clamps out-of-range numerics into the grammar bounds', async () => {
  const wild = { ...GOOD, entry_threshold: 9, max_positions: 99, position_sizing: { method: 'fixed_fraction', fraction: 5 }, entry_rules: [{ ...GOOD.entry_rules[0], weight: 100 }] };
  const r = await authorStrategy({ family: 'dex', parentHarness: { version: 1 } }, { env: ENV, fetch: fetchJson(wild) });
  assert.ok(r.harness.entry_threshold <= 0.95);
  assert.ok(r.harness.max_positions <= 10);
  assert.ok(r.harness.position_sizing.fraction <= 0.5);
  assert.ok(r.harness.entry_rules[0].weight <= 1);
});

test('injects a default stop_loss when the model omits exits', async () => {
  const noExit = { ...GOOD, exit_rules: [] };
  const r = await authorStrategy({ family: 'dex', parentHarness: {} }, { env: ENV, fetch: fetchJson(noExit) });
  assert.ok(r.harness.exit_rules.some((e) => e.type === 'stop_loss'));
});

test('rejects an out-of-grammar signal type (fail-closed)', async () => {
  const bad = { ...GOOD, entry_rules: [{ signal: { type: 'astrology' }, condition: { type: 'below', threshold: 30 }, weight: 0.5 }] };
  const r = await authorStrategy({ family: 'dex', parentHarness: {} }, { env: ENV, fetch: fetchJson(bad) });
  assert.equal(r, null);
});

test('rejects an out-of-grammar exit type', async () => {
  const bad = { ...GOOD, exit_rules: [{ type: 'vibes_check', pct: 5 }] };
  const r = await authorStrategy({ family: 'dex', parentHarness: {} }, { env: ENV, fetch: fetchJson(bad) });
  assert.equal(r, null);
});

test('rejects an empty entry-rule set', async () => {
  const bad = { ...GOOD, entry_rules: [] };
  const r = await authorStrategy({ family: 'dex', parentHarness: {} }, { env: ENV, fetch: fetchJson(bad) });
  assert.equal(r, null);
});

test('fails closed on malformed JSON', async () => {
  const r = await authorStrategy({ family: 'dex', parentHarness: {} }, { env: ENV, fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }) });
  assert.equal(r, null);
});

test('fails closed on a network throw', async () => {
  const r = await authorStrategy({ family: 'dex', parentHarness: {} }, { env: ENV, fetch: async () => { throw new Error('econnreset'); } });
  assert.equal(r, null);
});

test('disabled when no model is configured', async () => {
  const r = await authorStrategy({ family: 'dex', parentHarness: {} }, { env: { TRADING_AGENTIC_DECISIONS: '1' }, fetch: fetchJson(GOOD) });
  assert.equal(r, null);
});

test('validateHarness is pure and reusable', () => {
  assert.ok(validateHarness(GOOD));
  assert.equal(validateHarness({ entry_rules: [] }), null);
  assert.equal(validateHarness(null), null);
});
