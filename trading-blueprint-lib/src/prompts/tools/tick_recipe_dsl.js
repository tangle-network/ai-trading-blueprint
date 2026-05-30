// Typed tick-recipe DSL (F1). A recipe is a DAG of small typed operators that
// compiles to a deterministic decision. This LIFTS agency: the family tool still
// fetches state and submits the intent; the recipe only expresses the pure,
// machine-checkable decision math so it can be replayed, diffed, and attested
// without re-running the whole tick. Same inputs -> same op outputs -> same
// decision, every time.
//
// Design:
//   - Operators are pure: (params, resolvedInputs) -> value. No IO, no clock,
//     no randomness. Determinism is the whole point.
//   - A recipe is an ordered list of typed nodes { id, op, in, ...params }.
//     `in` names the upstream node ids (or `$<inputKey>` for recipe inputs)
//     whose values feed the op. Evaluation is topological by construction:
//     every node may only reference ids declared before it.
//   - A recipe declares a single `output` node id; runRecipe returns its value.
//
// Extending: add one entry to OPERATORS. Each operator documents its param and
// input shape in JSDoc. Unimplemented operators throw a clear "not implemented"
// error rather than silently returning a wrong value (no fake success).

'use strict';

/**
 * @typedef {Object} RecipeNode
 * @property {string} id      Unique node id within the recipe.
 * @property {string} op      Operator name (a key of OPERATORS).
 * @property {string[]} [in]  Upstream references: node ids, or "$key" for a
 *                            value from the recipe `inputs` map.
 * @property {Object} [params] Operator-specific parameters.
 */

/**
 * @typedef {Object} Recipe
 * @property {string} name
 * @property {RecipeNode[]} nodes
 * @property {string} output  Id of the node whose value the recipe returns.
 */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('expected an array input');
  }
  return value.map((v) => num(v, NaN));
}

// Operator catalog. Each: (params, inputs) -> value. `inputs` is the ordered
// list of resolved upstream values named by the node's `in` array.
const OPERATORS = {
  // --- series statistics -------------------------------------------------
  /** Exponential moving average over a numeric series. params: { period }. */
  ema(params, [series]) {
    const values = asArray(series);
    const period = num(params.period);
    if (period <= 0) throw new RangeError('ema: period must be > 0');
    if (values.length < period) return null;
    const alpha = 2 / (period + 1);
    let cur = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (const v of values.slice(period)) cur = v * alpha + cur * (1 - alpha);
    return cur;
  },

  /** Wilder-style RSI over a series. params: { period = 14 }. */
  rsi(params, [series]) {
    const values = asArray(series);
    const period = num(params.period, 14);
    if (values.length <= period) return null;
    let gains = 0;
    let losses = 0;
    for (let i = values.length - period; i < values.length; i += 1) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gains += d;
      else losses -= d;
    }
    if (losses === 0) return 100;
    return 100 - 100 / (1 + gains / losses);
  },

  /** Mean of the trailing `window` (or whole series). params: { window? }. */
  rolling_mean(params, [series]) {
    const values = asArray(series);
    const w = params.window ? num(params.window) : values.length;
    if (values.length === 0 || w <= 0) return null;
    const slice = values.slice(-w);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  },

  /** Sample std-dev of the trailing `window`. params: { window? }. */
  rolling_std(params, [series]) {
    const values = asArray(series);
    const w = params.window ? num(params.window) : values.length;
    const slice = values.slice(-w);
    if (slice.length < 2) return null;
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (slice.length - 1);
    return Math.sqrt(variance);
  },

  /** Z-score of the latest value vs the trailing window. params: { window? }. */
  rolling_zscore(params, [series]) {
    const values = asArray(series);
    const mean = OPERATORS.rolling_mean(params, [values]);
    const std = OPERATORS.rolling_std(params, [values]);
    if (mean === null || std === null || std === 0) return null;
    return (values[values.length - 1] - mean) / std;
  },

  // --- scalar transforms -------------------------------------------------
  /** difference a - b. in: [a, b]. */
  sub(_params, [a, b]) {
    return num(a) - num(b);
  },

  /** Constant value. params: { value }. */
  const(params) {
    return num(params.value);
  },

  /** Pull a named scalar out of an object input. params: { key }. */
  pick(params, [obj]) {
    const v = obj == null ? undefined : obj[params.key];
    return v === undefined ? null : v;
  },

  /** Clamp a scalar into [lo, hi]. params: { lo, hi }. */
  clamp(params, [x]) {
    return Math.min(num(params.hi), Math.max(num(params.lo), num(x)));
  },

  /** Sign of a scalar: -1, 0, or 1. */
  sign(_params, [x]) {
    return Math.sign(num(x));
  },

  /** Absolute value of a scalar. */
  abs(_params, [x]) {
    return Math.abs(num(x));
  },

  /** Product a * b. in: [a, b]. */
  mul(_params, [a, b]) {
    return num(a) * num(b);
  },

  /** Crossover state of two series/scalars: 1 if a>b, -1 if a<b, 0 if equal. */
  crossover(_params, [a, b]) {
    const av = Array.isArray(a) ? a[a.length - 1] : num(a);
    const bv = Array.isArray(b) ? b[b.length - 1] : num(b);
    if (av > bv) return 1;
    if (av < bv) return -1;
    return 0;
  },

  /**
   * Pack the resolved inputs into an object under params.keys (1:1 with `in`).
   * Generic recipe terminator for recipes that yield a struct, not a scalar.
   * params: { keys: string[] }.
   */
  record(params, inputs) {
    const keys = Array.isArray(params.keys) ? params.keys : [];
    const out = {};
    keys.forEach((k, i) => { out[k] = inputs[i]; });
    return out;
  },

  /** Weighted linear combination. params: { weights:number[] }. in: scalars. */
  score_combine(params, inputs) {
    const weights = Array.isArray(params.weights) ? params.weights : [];
    return inputs.reduce((acc, v, i) => acc + num(v) * num(weights[i], 1), 0);
  },

  /**
   * Pure conditional. params: {
   *   when:  ['lte'|'lt'|'gt'|'gte'|'abs_lte'|'abs_gt', threshold],
   *   then:  any, else: any }.
   * in: [scalar]. Returns `then`/`else` literally (used to branch decisions).
   */
  regime_condition(params, [x]) {
    const v = num(x);
    const [cmp, threshold] = params.when || [];
    const th = num(threshold);
    let hit;
    switch (cmp) {
      case 'lte': hit = v <= th; break;
      case 'lt': hit = v < th; break;
      case 'gt': hit = v > th; break;
      case 'gte': hit = v >= th; break;
      case 'abs_lte': hit = Math.abs(v) <= th; break;
      case 'abs_gt': hit = Math.abs(v) > th; break;
      default: throw new Error(`regime_condition: unknown comparator "${cmp}"`);
    }
    return hit ? params.then : params.else;
  },

  // --- stubs: declared in the catalog, not yet needed by the mm pilot. ----
  // They throw loudly so a recipe that reaches for them fails fast instead of
  // silently producing a wrong decision.
  rank() {
    throw new Error('operator "rank" not implemented (mm pilot does not use it)');
  },
  filter() {
    throw new Error('operator "filter" not implemented (mm pilot does not use it)');
  },
  top_n() {
    throw new Error('operator "top_n" not implemented (mm pilot does not use it)');
  },
};

/**
 * Evaluate a recipe DAG against a flat `inputs` map.
 * @param {Recipe} recipe
 * @param {Record<string, any>} inputs  Values referenced as "$key" by nodes.
 * @returns {any} value of the recipe's declared output node.
 */
function runRecipe(recipe, inputs) {
  if (!recipe || !Array.isArray(recipe.nodes)) {
    throw new TypeError('runRecipe: recipe.nodes must be an array');
  }
  const env = new Map();
  const resolveRef = (ref) => {
    if (typeof ref !== 'string') throw new TypeError(`bad reference: ${ref}`);
    if (ref.startsWith('$')) {
      const key = ref.slice(1);
      if (!(key in inputs)) throw new Error(`recipe input "${key}" not provided`);
      return inputs[key];
    }
    if (!env.has(ref)) throw new Error(`node "${ref}" referenced before definition`);
    return env.get(ref);
  };
  // A param value of the form "$key" is resolved from recipe inputs; arrays are
  // resolved element-wise. This lets thresholds/weights be recipe inputs without
  // leaving the single-DAG form (e.g. regime_condition's `when:[cmp,'$band']`).
  const resolveParam = (value) => {
    if (typeof value === 'string' && value.startsWith('$')) {
      const key = value.slice(1);
      if (!(key in inputs)) throw new Error(`recipe input "${key}" not provided`);
      return inputs[key];
    }
    if (Array.isArray(value)) return value.map(resolveParam);
    return value;
  };
  const resolveParams = (params) => {
    const out = {};
    for (const [k, v] of Object.entries(params || {})) out[k] = resolveParam(v);
    return out;
  };
  for (const node of recipe.nodes) {
    if (env.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
    const op = OPERATORS[node.op];
    if (!op) throw new Error(`unknown operator "${node.op}"`);
    const resolved = (node.in || []).map(resolveRef);
    env.set(node.id, op(resolveParams(node.params), resolved));
  }
  if (!env.has(recipe.output)) {
    throw new Error(`recipe output node "${recipe.output}" not found`);
  }
  return env.get(recipe.output);
}

module.exports = { OPERATORS, runRecipe, num };
