#!/usr/bin/env node
// Market-making tick (strategy_type "mm") for vault-backed AMMs (Aerodrome /
// Uniswap). The Trading API executes swaps, not resting CLOB quotes, so the
// machine-checkable MM behavior is inventory management: hold a target
// base/quote ratio around mid and re-center with a single swap whenever
// inventory drifts outside the no-trade band. One trade per tick.
//
// Decision architecture (mirrors dex_tick / multi_tick):
//   1. RISK GUARDS run first and stay deterministic + fail-closed — the drawdown
//      circuit breaker, pricing sanity, min-order/min-notional, and the
//      inventory-below-minimum / config skips. The model NEVER overrides these.
//   2. ALPHA is the model's job. mm is inventory ALLOCATION, so the MODEL sets
//      the target base-asset (WETH) inventory weight from evidence (price,
//      momentum, RSI/EMA, inventory drift, market signals) via agenticAllocation.
//      The existing mechanical rebalancer then trades toward the model's target
//      instead of the static config ratio. This is the alpha injection: a static
//      target_base_weight made mm bots re-buy a falling base asset every tick.
//   3. FAIL CLOSED. The model path is gated on agenticDecisionsEnabled(); if the
//      model is disabled (evals set TRADING_AGENTIC_DECISIONS=0) or returns null
//      (timeout/malformed/unavailable), the bot rebalances toward the configured
//      static target — the deterministic baseline, never a hidden rule.
//
// The rebalance math itself is expressed two equivalent ways:
//   1. MM_REBALANCE_RECIPE — a typed tick-recipe DAG (F1 pilot) compiled by
//      tick_recipe_dsl.js. This is the attestable form: same inputs -> same
//      ops -> same core, replayable without the API.
//   2. imperativeRebalanceCore — the original hand-written reference.
// recipeRebalancePlan() and imperativeRebalancePlan() are proven identical by
// the replay test (tick_recipe_dsl.replay.test.js). decide() uses the recipe by
// default; set harness.mm.use_recipe=false to fall back to the reference.

const t = require('/home/agent/tools/tick-common');
const { agenticAllocation, agenticDecisionsEnabled } = require('/home/agent/tools/agentic-decision');
// The typed recipe runtime is optional at load time: if the DSL module has not
// been deployed to the sandbox yet, the tick still runs via the imperative
// reference (decide() falls back). This keeps the tool safe to ship ahead of the
// activation embed for tick-recipe-dsl.js.
let runRecipe = null;
try {
  ({ runRecipe } = require('/home/agent/tools/tick-recipe-dsl'));
} catch {
  runRecipe = null;
}

// Typed rebalance recipe (the whole decision pivot in 6 generic typed nodes;
// the catalog has zero mm-specific knowledge). Inputs:
//   base_weight, target_base_weight, band, inventory_usd.
// Output: { drift, absDrift, withinBand, rebalanceUsd }.
const MM_REBALANCE_RECIPE = {
  name: 'mm.rebalance.v1',
  output: 'core',
  nodes: [
    { id: 'drift', op: 'sub', in: ['$base_weight', '$target_base_weight'] },
    { id: 'absDrift', op: 'abs', in: ['drift'] },
    { id: 'withinBand', op: 'regime_condition', in: ['drift'], params: { when: ['abs_lte', '$band'], then: true, else: false } },
    { id: 'rebalanceUsd', op: 'mul', in: ['absDrift', '$inventory_usd'] },
    { id: 'core', op: 'record', in: ['drift', 'absDrift', 'withinBand', 'rebalanceUsd'], params: { keys: ['drift', 'absDrift', 'withinBand', 'rebalanceUsd'] } },
  ],
};

function recipeRebalanceCore({ baseWeight, targetBaseWeight, band, inventoryUsd }) {
  if (!runRecipe) throw new Error('tick-recipe-dsl not available; cannot run recipe core');
  return runRecipe(MM_REBALANCE_RECIPE, {
    base_weight: baseWeight,
    target_base_weight: targetBaseWeight,
    band,
    inventory_usd: inventoryUsd,
  });
}

function imperativeRebalanceCore({ baseWeight, targetBaseWeight, band, inventoryUsd }) {
  const drift = baseWeight - targetBaseWeight;
  const withinBand = Math.abs(drift) <= band;
  return { drift, absDrift: Math.abs(drift), withinBand, rebalanceUsd: Math.abs(drift) * inventoryUsd };
}

// Turn the core scalars + token values into the trade/skip plan. Pure: no IO.
function planFromCore(core, { baseValueUsd, quoteValueUsd, minOrderUsd }) {
  if (core.withinBand) {
    return { action: 'skip', reason: 'inventory-within-band' };
  }
  if (core.drift > 0) {
    const sellUsd = Math.min(core.rebalanceUsd, baseValueUsd);
    if (sellUsd < minOrderUsd) return { action: 'skip', reason: 'rebalance-below-minimum' };
    return { action: 'trade', side: 'sell-base', reason: 'mm-rebalance-sell-base', notionalUsd: sellUsd, drift: core.drift };
  }
  const buyUsd = Math.min(core.rebalanceUsd, quoteValueUsd);
  if (buyUsd < minOrderUsd) return { action: 'skip', reason: 'rebalance-below-minimum' };
  return { action: 'trade', side: 'buy-base', reason: 'mm-rebalance-buy-base', notionalUsd: buyUsd, drift: core.drift };
}

// Exported pure planners — the replay test asserts these two are identical.
function recipeRebalancePlan(state) {
  return planFromCore(recipeRebalanceCore(state), state);
}
function imperativeRebalancePlan(state) {
  return planFromCore(imperativeRebalanceCore(state), state);
}

function hasExplicitPaperTargetCycle(settings) {
  return t.normalizeCycleValues(settings, []).length >= 2;
}

function resolveTargetBaseWeight(ctx, mm, configuredTargetBaseWeight) {
  const cycle = mm.paper_target_cycle || ctx.harness.paper_target_cycle;
  if (t.isPaperShowcaseMode(ctx.config, ctx.harness) && hasExplicitPaperTargetCycle(cycle)) {
    return {
      targetBaseWeight: t.paperCycleWeight(
        ctx,
        cycle,
        configuredTargetBaseWeight,
        [],
        'mm-target-base-weight',
      ),
      targetSource: 'explicit_paper_target_cycle',
    };
  }
  return {
    targetBaseWeight: configuredTargetBaseWeight,
    targetSource: 'configured_target_base_weight',
  };
}

// Let the model set the tactical target base (WETH) inventory weight from market
// evidence, overriding the static config/paper-cycle target in place. The
// mechanical rebalancer below then re-centers toward whatever target is set —
// model (live) or config (eval/fallback). On any model failure the config target
// stands: fail-closed to the declared mandate, never to a hidden rule. Mirrors
// multi_tick.js applyModelTargets, specialized to the two-asset {WETH,USDC}
// inventory of an mm bot.
async function applyModelTarget(ctx, evidence, maxDrawdownPct) {
  if (!agenticDecisionsEnabled()) return { source: 'config', applied: false };
  const out = await agenticAllocation({
    family: 'mm',
    assets: [
      { symbol: 'WETH', current_weight: evidence.base_weight, target_hint: evidence.target_base_weight, price: evidence.weth_price ?? null },
      { symbol: 'USDC', current_weight: 1 - evidence.base_weight, target_hint: 1 - evidence.target_base_weight, price: 1 },
    ],
    mandate: { max_drawdown_pct: maxDrawdownPct, asset: 'WETH', venue: evidence.protocol },
    evidence,
  });
  if (!out || !out.weights || !Number.isFinite(out.weights.WETH)) {
    return { source: 'config', applied: false };
  }
  return {
    source: 'model',
    applied: true,
    targetBaseWeight: t.clamp(out.weights.WETH, 0, 1),
    model: out.model,
    confidence: out.confidence,
    rationale: out.rationale,
    key_signals: out.key_signals,
    prompt_hash: out.prompt_hash,
  };
}

// Compact, model-legible market evidence beyond the inventory scalars: recent
// candle-derived momentum + RSI/EMA + external market signals. The model reasons
// over these to set the inventory tilt; none of them are a directional rule.
async function gatherModelEvidence(ctx, checkedState, metrics) {
  const closes = await t.fetchCandles(ctx.api, 'WETH').catch(() => []);
  const last = Array.isArray(closes) && closes.length ? closes[closes.length - 1] : null;
  const ago = (n) => (Array.isArray(closes) && closes.length > n ? closes[closes.length - 1 - n] : null);
  const pct = (from) => (Number.isFinite(from) && from > 0 && Number.isFinite(last) ? ((last - from) / from) * 100 : null);
  let marketSignals = [];
  try {
    const ev = t.buildExternalSignalEvidence({ config: ctx.config, family: 'mm', checkedState, metrics });
    const signals = Array.isArray(ev.external_signals) ? ev.external_signals : [];
    marketSignals = signals.slice(0, 5).map((s) => ({ kind: s.kind, value: s.value, label: s.label }));
  } catch {
    marketSignals = [];
  }
  return {
    rsi_14: t.rsi(closes, 14),
    ema_12: t.ema(closes, 12),
    ema_26: t.ema(closes, 26),
    return_1h_pct: pct(ago(1)),
    return_6h_pct: pct(ago(6)),
    return_24h_pct: pct(ago(24)),
    market_signals: marketSignals,
  };
}

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const { weth, usdc } = t.pairTokens(config);
  const mm = harness.mm || harness.market_making || {};
  const protocol = (harness.execution && harness.execution.protocol)
    || (config.strategy_config && config.strategy_config.protocol)
    || 'aerodrome';
  const configuredTargetBaseWeight = t.clamp(t.asNumber(mm.target_base_weight, 0.5), 0, 1);
  const baseline = resolveTargetBaseWeight(ctx, mm, configuredTargetBaseWeight);
  let targetBaseWeight = baseline.targetBaseWeight;
  let targetSource = baseline.targetSource;
  const paperTrade = config.strategy_config && config.strategy_config.paper_trade === true;
  const minBandPct = paperTrade ? 0.0001 : 0.01;
  const bandPct = Math.max(minBandPct, t.asNumber(mm.rebalance_band_pct, 0.1));
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  const maxDrawdownPct = t.asNumber((harness.risk || {}).max_drawdown_pct, 10);
  const useRecipe = mm.use_recipe !== false && runRecipe != null;

  const [portfolioRes, pricesRes] = await Promise.all([
    api.apiCall('POST', '/portfolio/state', {}),
    api.apiCall('POST', '/market-data/prices', { tokens: [weth, usdc] }),
  ]);
  const portfolio = t.body(portfolioRes);
  const prices = t.priceMap(t.body(pricesRes));
  const wethPrice = await t.resolveUsdPrice(api, portfolio, weth, prices);
  const usdcPrice = await t.resolveUsdPrice(api, portfolio, usdc, prices, 1);

  const wethHeld = t.vaultSpotAmount(portfolio, weth);
  const usdcHeld = t.vaultSpotAmount(portfolio, usdc);
  const baseValueUsd = wethHeld * (wethPrice || 0);
  const quoteValueUsd = usdcHeld * usdcPrice;
  const inventoryUsd = baseValueUsd + quoteValueUsd;
  const baseWeight = inventoryUsd > 0 ? baseValueUsd / inventoryUsd : 0;

  const checkedState = {
    protocol,
    target_base_weight: targetBaseWeight,
    target_source: targetSource,
    allocation_source: 'config',
    rebalance_band_pct: bandPct,
    base_weight: baseWeight,
    base_value_usd: baseValueUsd,
    quote_value_usd: quoteValueUsd,
    inventory_usd: inventoryUsd,
    weth_price: wethPrice ?? null,
    plan_source: useRecipe ? 'recipe' : 'imperative',
    aggressive_paper_mode: t.isPaperShowcaseMode(config, harness),
  };
  const metrics = { portfolio_value_usd: t.asNumber(portfolio.total_value_usd, inventoryUsd) };

  // ---- RISK GUARDS (deterministic, fail-closed, always run first) ----
  // The model never sees these — they gate whether any rebalance is permitted.
  if (await t.circuitBreakerTripped(api, maxDrawdownPct)) {
    return { decision: { action: 'skip', reason: 'circuit-breaker-triggered' }, checkedState, metrics };
  }
  if (!Number.isFinite(wethPrice) || wethPrice <= 0) {
    return { decision: { action: 'skip', reason: 'pricing-unavailable' }, checkedState, metrics };
  }
  if (inventoryUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'inventory-below-minimum', checkedState }, checkedState, metrics };
  }

  // ---- ALPHA: the model sets the target inventory tilt inside the guards ----
  // The mechanical rebalancer below re-centers toward this target. On model
  // failure the configured static target stands (deterministic baseline).
  const allocation = await applyModelTarget(
    ctx,
    {
      protocol,
      base_weight: baseWeight,
      target_base_weight: targetBaseWeight,
      weth_price: wethPrice,
      base_value_usd: baseValueUsd,
      quote_value_usd: quoteValueUsd,
      inventory_usd: inventoryUsd,
      rebalance_band_pct: bandPct,
      ...(await gatherModelEvidence(ctx, checkedState, metrics)),
    },
    maxDrawdownPct,
  );
  if (allocation.applied) {
    targetBaseWeight = allocation.targetBaseWeight;
    targetSource = 'model_allocation';
  }
  checkedState.target_base_weight = targetBaseWeight;
  checkedState.target_source = targetSource;
  checkedState.allocation_source = allocation.source;
  const allocMeta = allocation.applied
    ? { decided_by: 'model', model: allocation.model, confidence: allocation.confidence, model_rationale: allocation.rationale, key_signals: allocation.key_signals, prompt_hash: allocation.prompt_hash }
    : {};

  const state = { baseWeight, targetBaseWeight, band: bandPct, inventoryUsd, baseValueUsd, quoteValueUsd, minOrderUsd };
  const plan = useRecipe ? recipeRebalancePlan(state) : imperativeRebalancePlan(state);

  if (plan.action === 'skip') {
    return { decision: { action: 'skip', reason: plan.reason, checkedState, ...allocMeta }, checkedState, metrics };
  }

  if (plan.side === 'sell-base') {
    return submit(ctx, { tokenIn: weth, tokenOut: usdc, amountHuman: plan.notionalUsd / wethPrice, prices, protocol, rationale: plan.reason, checkedState, metrics, drift: plan.drift, allocMeta });
  }
  return submit(ctx, { tokenIn: usdc, tokenOut: weth, amountHuman: plan.notionalUsd / usdcPrice, prices, protocol, rationale: plan.reason, checkedState, metrics, drift: plan.drift, allocMeta });
}

async function submit(ctx, { tokenIn, tokenOut, amountHuman, prices, protocol, rationale, checkedState, metrics, drift, allocMeta }) {
  const { api, config } = ctx;
  const meta = allocMeta || {};
  const slippageBps = await t.recommendSlippageBps(api, tokenIn, tokenOut, 50);
  const amountInUnits = t.decimalToBaseUnits(amountHuman, t.tokenDecimals(tokenIn));
  const intent = t.buildSwapIntent({
    config,
    strategyId: `mm-${config.bot_id || 'bot'}`,
    tokenIn,
    tokenOut,
    amountInUnits,
    prices,
    slippageBps,
    protocol,
    metadata: { signal: rationale, drift },
  });
  if (!intent) {
    return { decision: { action: 'skip', reason: 'intent-construction-failed', checkedState, ...meta }, checkedState, metrics };
  }
  const submission = await t.submitIntent(api, config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: rationale, intent, ...meta }
    : { action: 'skip', reason: 'submission-rejected', intent, ...meta };
  return { decision, checkedState, metrics, resultExtra: { trade_action: { attempted: true, ...submission } } };
}

module.exports = {
  MM_REBALANCE_RECIPE,
  recipeRebalanceCore,
  imperativeRebalanceCore,
  recipeRebalancePlan,
  imperativeRebalancePlan,
  planFromCore,
  hasExplicitPaperTargetCycle,
  resolveTargetBaseWeight,
};

if (require.main === module) {
  t.runTick('mm', decide);
}
