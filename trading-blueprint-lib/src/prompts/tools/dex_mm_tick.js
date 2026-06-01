#!/usr/bin/env node
// Deterministic market-making tick (strategy_type "mm") for vault-backed AMMs
// (Aerodrome / Uniswap). The Trading API executes swaps, not resting CLOB
// quotes, so the machine-checkable MM behavior is inventory management: hold a
// target base/quote ratio around mid and re-center with a single swap whenever
// inventory drifts outside the no-trade band. One trade per tick.
//
// The rebalance math is expressed two equivalent ways:
//   1. MM_REBALANCE_RECIPE — a typed tick-recipe DAG (F1 pilot) compiled by
//      tick_recipe_dsl.js. This is the attestable form: same inputs -> same
//      ops -> same core, replayable without the API.
//   2. imperativeRebalanceCore — the original hand-written reference.
// recipeRebalancePlan() and imperativeRebalancePlan() are proven identical by
// the replay test (tick_recipe_dsl.replay.test.js). decide() uses the recipe by
// default; set harness.mm.use_recipe=false to fall back to the reference.

const t = require('/home/agent/tools/tick-common');
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

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const { weth, usdc } = t.pairTokens(config);
  const mm = harness.mm || harness.market_making || {};
  const protocol = (harness.execution && harness.execution.protocol)
    || (config.strategy_config && config.strategy_config.protocol)
    || 'aerodrome';
  const configuredTargetBaseWeight = t.clamp(t.asNumber(mm.target_base_weight, 0.5), 0, 1);
  const targetBaseWeight = t.paperCycleWeight(
    ctx,
    mm.paper_target_cycle || harness.paper_target_cycle,
    configuredTargetBaseWeight,
    [0.2, 0.8],
    'mm-target-base-weight',
  );
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

  if (await t.circuitBreakerTripped(api, maxDrawdownPct)) {
    return { decision: { action: 'skip', reason: 'circuit-breaker-triggered' }, checkedState, metrics };
  }
  if (!Number.isFinite(wethPrice) || wethPrice <= 0) {
    return { decision: { action: 'skip', reason: 'pricing-unavailable' }, checkedState, metrics };
  }
  if (inventoryUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'inventory-below-minimum', checkedState }, checkedState, metrics };
  }

  const state = { baseWeight, targetBaseWeight, band: bandPct, inventoryUsd, baseValueUsd, quoteValueUsd, minOrderUsd };
  const plan = useRecipe ? recipeRebalancePlan(state) : imperativeRebalancePlan(state);

  if (plan.action === 'skip') {
    return { decision: { action: 'skip', reason: plan.reason, checkedState }, checkedState, metrics };
  }

  if (plan.side === 'sell-base') {
    return submit(ctx, { tokenIn: weth, tokenOut: usdc, amountHuman: plan.notionalUsd / wethPrice, prices, protocol, rationale: plan.reason, checkedState, metrics, drift: plan.drift });
  }
  return submit(ctx, { tokenIn: usdc, tokenOut: weth, amountHuman: plan.notionalUsd / usdcPrice, prices, protocol, rationale: plan.reason, checkedState, metrics, drift: plan.drift });
}

async function submit(ctx, { tokenIn, tokenOut, amountHuman, prices, protocol, rationale, checkedState, metrics, drift }) {
  const { api, config } = ctx;
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
    return { decision: { action: 'skip', reason: 'intent-construction-failed', checkedState }, checkedState, metrics };
  }
  const submission = await t.submitIntent(api, config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: rationale, intent }
    : { action: 'skip', reason: 'submission-rejected', intent };
  return { decision, checkedState, metrics, resultExtra: { trade_action: { attempted: true, ...submission } } };
}

module.exports = {
  MM_REBALANCE_RECIPE,
  recipeRebalanceCore,
  imperativeRebalanceCore,
  recipeRebalancePlan,
  imperativeRebalancePlan,
  planFromCore,
};

if (require.main === module) {
  t.runTick('mm', decide);
}
