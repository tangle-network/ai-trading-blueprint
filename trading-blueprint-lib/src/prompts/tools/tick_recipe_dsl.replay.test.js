// Replay parity test for the F1 typed tick-recipe DSL (mm pilot).
//
// Success metric: the mm rebalance decision is reproducible from a <30-line
// typed recipe and is byte-identical to the imperative reference on a fixed
// fixture set. We drive BOTH planners (recipe-compiled and hand-written) over
// the same inventory states and assert deep equality of the resulting plan, and
// separately replay the recipe's core math against a frozen golden vector so a
// silent change in any operator surfaces as a failed assertion.
//
// Run: node --test tick_recipe_dsl.replay.test.js
//
// dex_mm_tick.js requires the sandbox-absolute tool paths
// (/home/agent/tools/...). We remap those to the local sibling files so the
// real tool module loads unmodified here — the same code that runs in the box.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const TOOLS_DIR = __dirname;
const SANDBOX_MAP = {
  '/home/agent/tools/tick-common': path.join(TOOLS_DIR, 'tick_common.js'),
  '/home/agent/tools/tick-recipe-dsl': path.join(TOOLS_DIR, 'tick_recipe_dsl.js'),
  // dex_mm_tick now requires the model alpha layer at top of module. These
  // replay tests exercise only the deterministic pure planners (the rebalance
  // recipe), so the real agentic-decision module loads unmodified — it stays
  // disabled without API keys and is never invoked off the pure-planner paths.
  '/home/agent/tools/agentic-decision': path.join(TOOLS_DIR, 'agentic_decision.js'),
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (SANDBOX_MAP[request]) return SANDBOX_MAP[request];
  return originalResolve.call(this, request, ...rest);
};

// tick_common.js requires only `fs` and `child_process` at load time and does no
// IO until runTick is called, so importing the real mm tool module is safe here.
const mm = require('./dex_mm_tick.js');
const { runRecipe, OPERATORS } = require('./tick_recipe_dsl.js');

// Fixed fixtures: each is a full mm inventory state. They span every branch of
// the rebalance decision: within-band, over-weight sell, under-weight buy,
// notional clamped to available value, and below-minimum skips.
const FIXTURES = [
  { name: 'within-band', baseWeight: 0.52, targetBaseWeight: 0.5, band: 0.1, inventoryUsd: 10000, baseValueUsd: 5200, quoteValueUsd: 4800, minOrderUsd: 10 },
  { name: 'over-weight-sell', baseWeight: 0.8, targetBaseWeight: 0.5, band: 0.1, inventoryUsd: 10000, baseValueUsd: 8000, quoteValueUsd: 2000, minOrderUsd: 10 },
  { name: 'under-weight-buy', baseWeight: 0.2, targetBaseWeight: 0.5, band: 0.1, inventoryUsd: 10000, baseValueUsd: 2000, quoteValueUsd: 8000, minOrderUsd: 10 },
  { name: 'sell-clamped-to-base', baseWeight: 0.95, targetBaseWeight: 0.1, band: 0.05, inventoryUsd: 10000, baseValueUsd: 9500, quoteValueUsd: 500, minOrderUsd: 10 },
  { name: 'rebalance-below-minimum', baseWeight: 0.62, targetBaseWeight: 0.5, band: 0.1, inventoryUsd: 50, baseValueUsd: 31, quoteValueUsd: 19, minOrderUsd: 10 },
  { name: 'exact-band-edge', baseWeight: 0.6, targetBaseWeight: 0.5, band: 0.1, inventoryUsd: 10000, baseValueUsd: 6000, quoteValueUsd: 4000, minOrderUsd: 10 },
];

test('recipe planner is byte-identical to the imperative reference on every fixture', () => {
  for (const f of FIXTURES) {
    const viaRecipe = mm.recipeRebalancePlan(f);
    const viaImperative = mm.imperativeRebalancePlan(f);
    assert.deepEqual(viaRecipe, viaImperative, `plan mismatch on fixture "${f.name}"`);
  }
});

test('mm paper target cycling is explicit, never implied by showcase mode alone', () => {
  const base = {
    runStartedAt: '2026-06-01T09:40:00.000Z',
    config: { bot_id: 'bot-mm', strategy_config: { paper_trade: true } },
    harness: { aggressive_paper_mode: true },
  };

  assert.deepEqual(mm.resolveTargetBaseWeight(base, {}, 0.5), {
    targetBaseWeight: 0.5,
    targetSource: 'configured_target_base_weight',
  });

  const explicit = mm.resolveTargetBaseWeight(
    {
      ...base,
      harness: {
        aggressive_paper_mode: true,
        paper_target_cycle: { values: [0.2, 0.8], period_secs: 300 },
      },
    },
    {},
    0.5,
  );
  assert.ok([0.2, 0.8].includes(explicit.targetBaseWeight));
  assert.equal(explicit.targetSource, 'explicit_paper_target_cycle');
});

test('recipe core matches imperative core (drift / withinBand / rebalanceUsd)', () => {
  for (const f of FIXTURES) {
    const r = mm.recipeRebalanceCore(f);
    const i = mm.imperativeRebalanceCore(f);
    assert.equal(r.drift, i.drift, `drift on "${f.name}"`);
    assert.equal(r.absDrift, i.absDrift, `absDrift on "${f.name}"`);
    assert.equal(r.withinBand, i.withinBand, `withinBand on "${f.name}"`);
    assert.equal(r.rebalanceUsd, i.rebalanceUsd, `rebalanceUsd on "${f.name}"`);
  }
});

test('frozen golden vector pins the recipe math (catches silent operator drift)', () => {
  // over-weight-sell: drift = 0.8 - 0.5 (IEEE-754: 0.30000000000000004),
  // |drift| > band 0.1 -> trade, sellUsd = min(|drift|*10000, 8000), sell-base.
  // The recipe and imperative paths share this exact float (asserted elsewhere);
  // the golden vector pins the literal IEEE-754 result so a units/op change trips.
  const driftGolden = 0.8 - 0.5;
  const core = mm.recipeRebalanceCore(FIXTURES[1]);
  assert.deepEqual(core, { drift: driftGolden, absDrift: driftGolden, withinBand: false, rebalanceUsd: driftGolden * 10000 });
  const plan = mm.recipeRebalancePlan(FIXTURES[1]);
  assert.deepEqual(plan, { action: 'trade', side: 'sell-base', reason: 'mm-rebalance-sell-base', notionalUsd: driftGolden * 10000, drift: driftGolden });
});

test('the recipe is the small composable DAG it claims to be (<30 nodes)', () => {
  assert.ok(mm.MM_REBALANCE_RECIPE.nodes.length <= 8, 'mm recipe should be a handful of nodes');
  assert.equal(mm.MM_REBALANCE_RECIPE.output, 'core');
  // Replaying the exported recipe directly (not via the helper) yields the core.
  const driftGolden = 0.8 - 0.5;
  const direct = runRecipe(mm.MM_REBALANCE_RECIPE, {
    base_weight: 0.8, target_base_weight: 0.5, band: 0.1, inventory_usd: 10000,
  });
  assert.deepEqual(direct, { drift: driftGolden, absDrift: driftGolden, withinBand: false, rebalanceUsd: driftGolden * 10000 });
});

test('unimplemented operators fail loud, never fake success', () => {
  for (const op of ['rank', 'filter', 'top_n']) {
    assert.throws(() => OPERATORS[op]({}, []), /not implemented/, `${op} must throw`);
  }
});

test('runRecipe rejects forward references and unknown operators', () => {
  assert.throws(
    () => runRecipe({ name: 'x', output: 'a', nodes: [{ id: 'a', op: 'abs', in: ['b'] }, { id: 'b', op: 'const', params: { value: 1 } }] }, {}),
    /referenced before definition/,
  );
  assert.throws(
    () => runRecipe({ name: 'x', output: 'a', nodes: [{ id: 'a', op: 'nope' }] }, {}),
    /unknown operator/,
  );
});

test.after(() => { Module._resolveFilename = originalResolve; });
