#!/usr/bin/env node
// Deterministic market-making tick (strategy_type "mm") for vault-backed AMMs
// (Aerodrome / Uniswap). The Trading API executes swaps, not resting CLOB
// quotes, so the machine-checkable MM behavior is inventory management: hold a
// target base/quote ratio around mid and re-center with a single swap whenever
// inventory drifts outside the no-trade band. One trade per tick.

const t = require('/home/agent/tools/tick-common');

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const { weth, usdc } = t.pairTokens(config);
  const mm = harness.mm || harness.market_making || {};
  const protocol = (harness.execution && harness.execution.protocol)
    || (config.strategy_config && config.strategy_config.protocol)
    || 'aerodrome';
  const targetBaseWeight = clamp(t.asNumber(mm.target_base_weight, 0.5), 0, 1);
  const bandPct = Math.max(0.01, t.asNumber(mm.rebalance_band_pct, 0.1));
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  const maxDrawdownPct = t.asNumber((harness.risk || {}).max_drawdown_pct, 10);

  const [portfolioRes, pricesRes] = await Promise.all([
    api.apiCall('POST', '/portfolio/state', {}),
    api.apiCall('POST', '/market-data/prices', { tokens: [weth, usdc] }),
  ]);
  const portfolio = t.body(portfolioRes);
  const prices = t.priceMap(t.body(pricesRes));
  const wethPrice = prices.get(weth.toLowerCase());
  const usdcPrice = prices.get(usdc.toLowerCase()) ?? 1;

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

  const drift = baseWeight - targetBaseWeight;
  if (Math.abs(drift) <= bandPct) {
    return { decision: { action: 'skip', reason: 'inventory-within-band', checkedState }, checkedState, metrics };
  }

  // Over-weight base → sell WETH into USDC; under-weight base → buy WETH.
  const rebalanceUsd = Math.abs(drift) * inventoryUsd;
  if (drift > 0) {
    const sellUsd = Math.min(rebalanceUsd, baseValueUsd);
    if (sellUsd < minOrderUsd) {
      return { decision: { action: 'skip', reason: 'rebalance-below-minimum', checkedState }, checkedState, metrics };
    }
    return submit(ctx, { tokenIn: weth, tokenOut: usdc, amountHuman: sellUsd / wethPrice, prices, protocol, rationale: 'mm-rebalance-sell-base', checkedState, metrics, drift });
  }
  const buyUsd = Math.min(rebalanceUsd, quoteValueUsd);
  if (buyUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'rebalance-below-minimum', checkedState }, checkedState, metrics };
  }
  return submit(ctx, { tokenIn: usdc, tokenOut: weth, amountHuman: buyUsd / usdcPrice, prices, protocol, rationale: 'mm-rebalance-buy-base', checkedState, metrics, drift });
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

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

t.runTick('mm', decide);
