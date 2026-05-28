#!/usr/bin/env node
// Deterministic directional spot-DEX trading tick (strategy_type "dex").
//
// Mirrors hyperliquid_tick.js for vault-backed Uniswap/Aerodrome swaps: inspect
// portfolio + prices + candles, decide from RSI/EMA, size from the harness,
// submit one bounded swap (or skip with a reason), and emit the schema-v1 JSON
// the Rust workflow tick verifies. One trade per tick.

const t = require('/home/agent/tools/tick-common');

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const { weth, usdc } = t.pairTokens(config);
  const protocol = (harness.execution && harness.execution.protocol)
    || (config.strategy_config && config.strategy_config.protocol)
    || 'uniswap_v3';

  const [portfolioRes, pricesRes] = await Promise.all([
    api.apiCall('POST', '/portfolio/state', {}),
    api.apiCall('POST', '/market-data/prices', { tokens: [weth, usdc] }),
  ]);
  const portfolio = t.body(portfolioRes);
  const prices = t.priceMap(t.body(pricesRes));
  const wethPrice = prices.get(weth.toLowerCase());

  const totalNav = t.asNumber(portfolio.total_value_usd, 0);
  const wethHeld = t.vaultSpotAmount(portfolio, weth);
  const usdcHeld = t.vaultSpotAmount(portfolio, usdc);

  const sizing = harness.position_sizing || {};
  const fraction = t.asNumber(sizing.fraction, 0.1);
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  const maxDrawdownPct = t.asNumber((harness.risk || {}).max_drawdown_pct, 10);

  const closes = await t.fetchCandles(api, 'WETH');
  const currentRsi = t.rsi(closes, 14);
  const shortEma = t.ema(closes, 12);
  const longEma = t.ema(closes, 26);

  const checkedState = {
    protocol,
    total_nav_usd: totalNav,
    weth_held: wethHeld,
    usdc_held: usdcHeld,
    weth_price: wethPrice ?? null,
    rsi_14: currentRsi,
    ema_12: shortEma,
    ema_26: longEma,
    candles: closes.length,
  };
  const metrics = { portfolio_value_usd: totalNav, positions_count: t.positionsOf(portfolio).length };

  if (await t.circuitBreakerTripped(api, maxDrawdownPct)) {
    return { decision: { action: 'skip', reason: 'circuit-breaker-triggered' }, checkedState, metrics };
  }
  if (!Number.isFinite(wethPrice) || wethPrice <= 0) {
    return { decision: { action: 'skip', reason: 'pricing-unavailable' }, checkedState, metrics };
  }

  // Exit: trim a held WETH position on overbought RSI (take profit / de-risk).
  if (wethHeld > 0 && currentRsi !== null && currentRsi >= 70) {
    return submit(ctx, {
      tokenIn: weth,
      tokenOut: usdc,
      amountHuman: wethHeld,
      prices,
      protocol,
      rationale: 'rsi-overbought-exit',
      signals: { rsi_14: currentRsi, price: wethPrice },
      checkedState,
      metrics,
    });
  }

  // Entry: deploy idle USDC on oversold RSI or a confirmed up-trend.
  const targetNotional = totalNav * fraction;
  if (targetNotional < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'target-notional-below-minimum', checkedState }, checkedState, metrics };
  }
  if (closes.length < 30 || currentRsi === null) {
    return { decision: { action: 'skip', reason: 'insufficient-candles' }, checkedState, metrics };
  }

  const oversold = currentRsi <= 30;
  const trendUp = shortEma !== null && longEma !== null && shortEma > longEma && currentRsi < 70;
  if ((oversold || trendUp) && usdcHeld > 0) {
    const amountUsd = Math.min(targetNotional, usdcHeld);
    if (amountUsd < minOrderUsd) {
      return { decision: { action: 'skip', reason: 'idle-usdc-below-minimum', checkedState }, checkedState, metrics };
    }
    return submit(ctx, {
      tokenIn: usdc,
      tokenOut: weth,
      amountHuman: amountUsd,
      prices,
      protocol,
      rationale: oversold ? 'rsi-oversold-entry' : 'ema-trend-entry',
      signals: { rsi_14: currentRsi, ema_12: shortEma, ema_26: longEma, price: wethPrice },
      checkedState,
      metrics,
    });
  }

  return { decision: { action: 'skip', reason: 'no-clear-dex-setup', checkedState }, checkedState, metrics };
}

async function submit(ctx, { tokenIn, tokenOut, amountHuman, prices, protocol, rationale, signals, checkedState, metrics }) {
  const { api, config } = ctx;
  const slippageBps = await t.recommendSlippageBps(api, tokenIn, tokenOut, 100);
  const amountInUnits = t.decimalToBaseUnits(amountHuman, t.tokenDecimals(tokenIn));
  const intent = t.buildSwapIntent({
    config,
    strategyId: `dex-${config.bot_id || 'bot'}`,
    tokenIn,
    tokenOut,
    amountInUnits,
    prices,
    slippageBps,
    protocol,
    metadata: { signal: rationale, signals },
  });
  if (!intent) {
    return { decision: { action: 'skip', reason: 'intent-construction-failed', checkedState }, checkedState, metrics };
  }
  const submission = await t.submitIntent(api, config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: rationale, intent }
    : { action: 'skip', reason: 'submission-rejected', intent };
  return {
    decision,
    checkedState,
    metrics,
    resultExtra: { trade_action: { attempted: true, ...submission } },
  };
}

t.runTick('dex', decide);
