#!/usr/bin/env node
// Deterministic portfolio-rebalance tick (strategy_type "multi").
//
// Holds the portfolio to harness-configured target weights across a small asset
// universe. Each tick computes current USD weights, finds the largest over- and
// under-weight assets, and executes a single swap from the over- into the
// under-weight asset when drift exceeds the band. One bounded trade per tick.

const t = require('/home/agent/tools/tick-common');

function targetAssets(config, harness) {
  const { weth, usdc } = t.pairTokens(config);
  const configured = (harness.portfolio && harness.portfolio.assets)
    || (config.strategy_config && config.strategy_config.portfolio && config.strategy_config.portfolio.assets);
  let assets;
  if (Array.isArray(configured) && configured.length >= 2) {
    assets = configured
      .filter((a) => a && a.address)
      .map((a) => ({ symbol: a.symbol || a.address, address: a.address, target: t.asNumber(a.target_weight, 0) }));
  } else {
    assets = [
      { symbol: 'USDC', address: usdc, target: 0.5 },
      { symbol: 'WETH', address: weth, target: 0.5 },
    ];
  }
  const totalTarget = assets.reduce((sum, a) => sum + a.target, 0) || 1;
  for (const a of assets) a.target /= totalTarget;
  return assets;
}

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const assets = targetAssets(config, harness);
  const paperTrade = config.strategy_config && config.strategy_config.paper_trade === true;
  const minBandPct = paperTrade ? 0.0005 : 0.02;
  const bandPct = Math.max(minBandPct, t.asNumber((harness.portfolio || {}).rebalance_band_pct, 0.05));
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  const maxDrawdownPct = t.asNumber((harness.risk || {}).max_drawdown_pct, 10);
  const protocol = (harness.execution && harness.execution.protocol) || 'uniswap_v3';

  const [portfolioRes, pricesRes] = await Promise.all([
    api.apiCall('POST', '/portfolio/state', {}),
    api.apiCall('POST', '/market-data/prices', { tokens: assets.map((a) => a.address) }),
  ]);
  const portfolio = t.body(portfolioRes);
  const prices = t.priceMap(t.body(pricesRes));

  let total = 0;
  for (const a of assets) {
    const price = a.address.toLowerCase() === t.pairTokens(config).usdc.toLowerCase()
      ? (prices.get(a.address.toLowerCase()) ?? 1)
      : prices.get(a.address.toLowerCase());
    a.price = price;
    a.held = t.vaultSpotAmount(portfolio, a.address);
    a.valueUsd = Number.isFinite(price) ? a.held * price : 0;
    total += a.valueUsd;
  }
  for (const a of assets) a.weight = total > 0 ? a.valueUsd / total : 0;

  const checkedState = {
    protocol,
    total_value_usd: total,
    assets: assets.map((a) => ({ symbol: a.symbol, weight: a.weight, target: a.target, value_usd: a.valueUsd, price: a.price ?? null })),
  };
  const metrics = { portfolio_value_usd: t.asNumber(portfolio.total_value_usd, total) };

  if (await t.circuitBreakerTripped(api, maxDrawdownPct)) {
    return { decision: { action: 'skip', reason: 'circuit-breaker-triggered' }, checkedState, metrics };
  }
  if (total < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'portfolio-below-minimum', checkedState }, checkedState, metrics };
  }

  const over = assets
    .filter((a) => a.weight - a.target > bandPct && Number.isFinite(a.price) && a.price > 0 && a.valueUsd > 0)
    .sort((x, y) => (y.weight - y.target) - (x.weight - x.target))[0];
  const under = assets
    .filter((a) => a.target - a.weight > bandPct && Number.isFinite(a.price) && a.price > 0)
    .sort((x, y) => (y.target - y.weight) - (x.target - x.weight))[0];

  if (!over || !under) {
    return { decision: { action: 'skip', reason: 'portfolio-within-band', checkedState }, checkedState, metrics };
  }

  const overExcessUsd = (over.weight - over.target) * total;
  const underDeficitUsd = (under.target - under.weight) * total;
  const rebalanceUsd = Math.min(overExcessUsd, underDeficitUsd, over.valueUsd);
  if (rebalanceUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'rebalance-below-minimum', checkedState }, checkedState, metrics };
  }

  const slippageBps = await t.recommendSlippageBps(api, over.address, under.address, 100);
  const amountInUnits = t.decimalToBaseUnits(rebalanceUsd / over.price, t.tokenDecimals(over.address));
  const intent = t.buildSwapIntent({
    config,
    strategyId: `multi-${config.bot_id || 'bot'}`,
    tokenIn: over.address,
    tokenOut: under.address,
    amountInUnits,
    prices,
    slippageBps,
    protocol,
    metadata: { signal: 'portfolio-rebalance', from: over.symbol, to: under.symbol, rebalance_usd: rebalanceUsd },
  });
  if (!intent) {
    return { decision: { action: 'skip', reason: 'intent-construction-failed', checkedState }, checkedState, metrics };
  }
  const submission = await t.submitIntent(api, config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: `rebalance-${over.symbol}-to-${under.symbol}`, intent }
    : { action: 'skip', reason: 'submission-rejected', intent };
  return { decision, checkedState, metrics, resultExtra: { trade_action: { attempted: true, ...submission } } };
}

t.runTick('multi', decide);
