#!/usr/bin/env node
// Deterministic portfolio-rebalance tick (strategy_type "multi").
//
// Holds the portfolio to harness-configured target weights across a small asset
// universe. Each tick computes current USD weights, finds the largest over- and
// under-weight assets, and executes a single swap from the over- into the
// under-weight asset when drift exceeds the band. One bounded trade per tick.

const t = require('/home/agent/tools/tick-common');

function targetNumber(value, fallback = NaN) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const pct = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
    const parsed = pct ? Number(pct[1]) / 100 : Number(trimmed);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed > 1 ? parsed / 100 : parsed;
  }
  const parsed = t.asNumber(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed > 1 ? parsed / 100 : parsed;
}

function targetWeight(asset) {
  for (const key of [
    'target_weight',
    'targetWeight',
    'weight',
    'target',
    'allocation',
    'allocation_weight',
    'allocation_pct',
    'target_pct',
    'percentage',
    'percent',
  ]) {
    if (asset && asset[key] !== undefined) return targetNumber(asset[key]);
  }
  return NaN;
}

function normalizedSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'ETH') return 'WETH';
  if (['USD COIN', 'STABLECOIN', 'STABLECOINS', 'STABLE', 'STABLES'].includes(raw)) return 'USDC';
  return raw;
}

function addressForAsset(asset, pairs) {
  if (asset && typeof asset.address === 'string' && asset.address.length > 0) return asset.address;
  const symbol = normalizedSymbol(asset && (asset.symbol || asset.asset || asset.token || asset.name));
  if (symbol === 'WETH') return pairs.weth;
  if (symbol === 'USDC') return pairs.usdc;
  return null;
}

function firstAssetList(candidates) {
  return candidates.find((candidate) => Array.isArray(candidate) && candidate.length >= 2) || null;
}

function userConfiguredPortfolioAssets(config) {
  const strategy = config.strategy_config || {};
  return firstAssetList([
    strategy.portfolio && strategy.portfolio.assets,
    strategy.assets,
    config.portfolio && config.portfolio.assets,
    config.assets,
  ]);
}

function harnessConfiguredPortfolioAssets(harness) {
  return firstAssetList([
    harness.portfolio && harness.portfolio.assets,
    harness.assets,
  ]);
}

function promptTexts(config) {
  const strategy = config.strategy_config || {};
  return [
    strategy.user_prompt,
    strategy.prompt,
    strategy.mandate,
    strategy.description,
    config.user_prompt,
    config.prompt,
    config.mandate,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
}

function assetsFromPrompt(config, pairs) {
  const text = promptTexts(config).join('\n');
  if (!text) return null;
  const matches = [];
  const pctBeforeSymbol = /(\d+(?:\.\d+)?)\s*%\s*(WETH|ETH|USDC|USD COIN|STABLECOINS?|STABLES?)/gi;
  const symbolBeforePct = /(WETH|ETH|USDC|USD COIN|STABLECOINS?|STABLES?)\s*(?:target|allocation|weight)?\s*(?:of|is|:)?\s*(\d+(?:\.\d+)?)\s*%/gi;

  for (const pattern of [pctBeforeSymbol, symbolBeforePct]) {
    let match = pattern.exec(text);
    while (match) {
      const number = pattern === pctBeforeSymbol ? match[1] : match[2];
      const symbol = normalizedSymbol(pattern === pctBeforeSymbol ? match[2] : match[1]);
      if (!matches.some((entry) => entry.symbol === symbol)) {
        matches.push({ symbol, target: targetNumber(`${number}%`) });
      }
      match = pattern.exec(text);
    }
  }

  const assets = matches
    .map((asset) => ({
      symbol: asset.symbol,
      address: addressForAsset(asset, pairs),
      target: asset.target,
      target_source: 'prompt',
    }))
    .filter((asset) => asset.address && Number.isFinite(asset.target) && asset.target > 0);
  return assets.length >= 2 ? assets : null;
}

function normalizeTargets(assets) {
  const valid = assets.filter((asset) => asset.address && Number.isFinite(asset.target) && asset.target > 0);
  const totalTarget = valid.reduce((sum, asset) => sum + asset.target, 0);
  if (totalTarget <= 0) return [];
  for (const asset of valid) asset.target /= totalTarget;
  return valid;
}

function hasExplicitPaperTargetCycle(settings) {
  if (Array.isArray(settings)) return settings.length >= 2;
  return Array.isArray(settings && settings.values) && settings.values.length >= 2;
}

function targetAssets(ctx) {
  const { config, harness } = ctx;
  const pairs = t.pairTokens(config);
  const { weth, usdc } = pairs;
  const configured = userConfiguredPortfolioAssets(config);
  const promptAssets = configured ? null : assetsFromPrompt(config, pairs);
  const harnessConfigured = configured || promptAssets || harnessConfiguredPortfolioAssets(harness);
  let assets;
  if (promptAssets) {
    assets = promptAssets;
  } else if (Array.isArray(harnessConfigured) && harnessConfigured.length >= 2) {
    const source = configured ? 'configured_portfolio' : 'harness_portfolio';
    assets = harnessConfigured
      .map((a) => ({
        symbol: normalizedSymbol(a.symbol || a.asset || a.token || a.name || a.address),
        address: addressForAsset(a, pairs),
        target: targetWeight(a),
        target_source: source,
      }));
  } else {
    assets = null;
  }
  if (!assets || assets.length < 2) {
    assets = [
      { symbol: 'USDC', address: usdc, target: 0.5, target_source: 'default_equal_weight' },
      { symbol: 'WETH', address: weth, target: 0.5, target_source: 'default_equal_weight' },
    ];
  }

  assets = normalizeTargets(assets);
  if (assets.length < 2) {
    assets = [
      { symbol: 'USDC', address: usdc, target: 0.5, target_source: 'default_equal_weight' },
      { symbol: 'WETH', address: weth, target: 0.5, target_source: 'default_equal_weight' },
    ];
  }

  const explicitCycle = (harness.portfolio || {}).paper_target_cycle || harness.paper_portfolio_target_cycle;
  if (assets.length === 2 && hasExplicitPaperTargetCycle(explicitCycle) && t.isPaperShowcaseMode(config, harness)) {
    const firstTarget = t.paperCycleWeight(
      ctx,
      explicitCycle,
      assets[0].target,
      [],
      'multi-first-asset-target',
    );
    assets[0].target = firstTarget;
    assets[1].target = 1 - firstTarget;
    assets[0].target_source = 'explicit_paper_target_cycle';
    assets[1].target_source = 'explicit_paper_target_cycle';
  }
  return assets;
}

function checkedAsset(asset) {
  return {
    symbol: asset.symbol,
    weight: asset.weight,
    target: asset.target,
    target_source: asset.target_source,
    value_usd: asset.valueUsd,
    price: asset.price ?? null,
  };
}

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const assets = targetAssets(ctx);
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
      ? await t.resolveUsdPrice(api, portfolio, a.address, prices, 1)
      : await t.resolveUsdPrice(api, portfolio, a.address, prices);
    a.price = price;
    a.held = t.vaultSpotAmount(portfolio, a.address);
    a.valueUsd = Number.isFinite(price) ? a.held * price : 0;
    total += a.valueUsd;
  }
  for (const a of assets) a.weight = total > 0 ? a.valueUsd / total : 0;

  const checkedState = {
    protocol,
    total_value_usd: total,
    assets: assets.map(checkedAsset),
    aggressive_paper_mode: t.isPaperShowcaseMode(config, harness),
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

if (require.main === module) {
  t.runTick('multi', decide);
}

module.exports = {
  assetsFromPrompt,
  targetAssets,
  targetNumber,
  targetWeight,
  decide,
};
