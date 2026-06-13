#!/usr/bin/env node
// Directional spot-DEX trading tick (strategy_type "dex").
//
// Decision architecture (this is the line that killed the decorative-AI bug):
//   1. Fail-closed RISK GUARDS run first and are always deterministic — pricing
//      sanity, the drawdown breaker (flatten while exposed), and the harness
//      exit_rules the backtester scores. Risk never asks the model.
//   2. Inside whatever the guards still permit, the MODEL is the alpha source:
//      it picks one action and a size from the full evidence (features, market
//      sentiment, position, mandate). RSI/EMA are now *inputs to the model*, no
//      longer the decision.
//   3. The deterministic RSI/EMA strategy survives ONLY as the eval/replay
//      baseline (TRADING_AGENTIC_DECISIONS=0) so walk-forward stays reproducible.
//      In live mode a model failure HOLDS — it never silently trades the rule.

const t = require('/home/agent/tools/tick-common');
const { agenticDecision, agenticDecisionsEnabled } = require('/home/agent/tools/agentic-decision');

// Compact, model-legible view of the candle history beyond the single RSI/EMA
// scalars: recent return and short/long trend so the model can reason about
// momentum without being handed a 80-element array.
function priceFeatures(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return {};
  const last = closes[closes.length - 1];
  const ago = (n) => (closes.length > n ? closes[closes.length - 1 - n] : null);
  const pct = (from) => (Number.isFinite(from) && from > 0 ? ((last - from) / from) * 100 : null);
  return {
    return_1h_pct: pct(ago(1)),
    return_6h_pct: pct(ago(6)),
    return_24h_pct: pct(ago(24)),
  };
}

function compactSignals(ctx, checkedState, metrics) {
  try {
    const evidence = t.buildExternalSignalEvidence({
      config: ctx.config,
      family: 'dex',
      checkedState,
      metrics,
    });
    const signals = Array.isArray(evidence.external_signals) ? evidence.external_signals : [];
    return signals.slice(0, 5).map((s) => ({ kind: s.kind, value: s.value, label: s.label }));
  } catch {
    return [];
  }
}

async function gather(ctx) {
  const { api, config, harness } = ctx;
  const { weth, usdc } = t.pairTokens(config);
  const protocol =
    (harness.execution && harness.execution.protocol) ||
    (config.strategy_config && config.strategy_config.protocol) ||
    'uniswap_v3';

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
  return { weth, usdc, protocol, portfolio, prices, wethPrice, totalNav, wethHeld, usdcHeld, closes, currentRsi, shortEma, longEma, checkedState, metrics };
}

async function decide(ctx) {
  const { harness, config } = ctx;
  const g = await gather(ctx);
  const { weth, usdc, protocol, prices, wethPrice, totalNav, wethHeld, usdcHeld, closes, currentRsi, shortEma, longEma, checkedState, metrics } = g;

  const sizing = harness.position_sizing || {};
  const fraction = t.asNumber(sizing.fraction, 0.1);
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  const maxDrawdownPct = t.mandateMaxDrawdownPct(config, harness, 10);

  if (!Number.isFinite(wethPrice) || wethPrice <= 0) {
    return { decision: { action: 'skip', reason: 'pricing-unavailable' }, checkedState, metrics };
  }

  const positionUsd = wethHeld * wethPrice;
  const holding = positionUsd >= minOrderUsd;
  const exitAll = (rationale, signals) =>
    submit(ctx, { tokenIn: weth, tokenOut: usdc, amountHuman: wethHeld, prices, protocol, rationale, signals, checkedState, metrics });

  // ---- RISK GUARDS (deterministic, fail-closed, always run) ----
  // A tripped drawdown breaker flattens rather than freezes: skipping while
  // fully exposed leaves the vault riding the drawdown that tripped it.
  if (await t.circuitBreakerTripped(ctx.api, maxDrawdownPct)) {
    if (holding) return exitAll('drawdown-derisk-exit', { max_drawdown_pct: maxDrawdownPct, price: wethPrice });
    return { decision: { action: 'skip', reason: 'circuit-breaker-triggered' }, checkedState, metrics };
  }

  // Harness exit_rules are the same schema the backtester scores; honoring them
  // live keeps promotion evidence reproducible. They are RISK, not alpha, so the
  // model never gets to override them.
  let entry = null;
  if (holding) {
    entry = await t.latestEntryFill(ctx.api, weth);
    checkedState.entry_price_usd = entry ? entry.price : null;
    checkedState.entry_signal = entry ? entry.signal : null;
    const exitRules = Array.isArray(harness.exit_rules) && harness.exit_rules.length ? harness.exit_rules : t.DEFAULT_EXIT_RULES;
    const ruled = t.evaluateExitRules({
      rules: exitRules,
      entryPrice: entry ? entry.price : null,
      currentPrice: wethPrice,
      closes,
      entryTimestampMs: entry ? entry.timestamp_ms : null,
    });
    if (ruled.exit) {
      return exitAll(ruled.reason, { entry_price: entry ? entry.price : null, price: wethPrice, rsi_14: currentRsi });
    }
  }

  if (closes.length < 30 || currentRsi === null) {
    return { decision: { action: 'skip', reason: 'insufficient-candles', checkedState }, checkedState, metrics };
  }

  // ---- ALPHA: model decides inside the guard envelope ----
  if (agenticDecisionsEnabled()) {
    return decideAgentic(ctx, { ...g, fraction, minOrderUsd, maxDrawdownPct, holding, positionUsd, entry, exitAll });
  }
  return decideDeterministic(ctx, { ...g, fraction, minOrderUsd, holding, entry, exitAll });
}

async function decideAgentic(ctx, g) {
  const { weth, usdc, protocol, prices, wethPrice, totalNav, wethHeld, usdcHeld, closes, currentRsi, shortEma, longEma, checkedState, metrics, fraction, minOrderUsd, maxDrawdownPct, holding, positionUsd, entry, exitAll } = g;

  const maxDeployUsd = holding ? 0 : Math.min(totalNav * fraction, usdcHeld);
  const candidates = holding ? ['hold', 'flatten'] : maxDeployUsd >= minOrderUsd ? ['buy', 'skip'] : ['skip'];

  const evidence = {
    weth_price: wethPrice,
    rsi_14: currentRsi,
    ema_12: shortEma,
    ema_26: longEma,
    ema_gap_pct: shortEma && longEma ? ((shortEma - longEma) / longEma) * 100 : null,
    ...priceFeatures(closes),
    total_nav_usd: totalNav,
    weth_held: wethHeld,
    usdc_held: usdcHeld,
    position_value_usd: positionUsd,
    entry_price_usd: entry ? entry.price : null,
    unrealized_pct: entry && entry.price ? ((wethPrice - entry.price) / entry.price) * 100 : null,
    market_signals: compactSignals(ctx, checkedState, metrics),
  };

  const decisionOut = await agenticDecision({
    family: 'dex',
    candidates,
    sizing: { max_fraction: 1, max_notional_usd: maxDeployUsd, min_notional_usd: minOrderUsd },
    mandate: { max_drawdown_pct: maxDrawdownPct, asset: 'WETH', venue: protocol },
    position: { held_usd: positionUsd, side: holding ? 'long_weth' : 'flat' },
    evidence,
  });

  // Fail closed: in live mode a model failure HOLDS/skips — it never trades the
  // deterministic rule behind the operator's back.
  if (!decisionOut) {
    const reason = holding ? 'hold' : 'skip';
    return { decision: { action: reason, reason: 'model-unavailable', checkedState }, checkedState, metrics };
  }

  const meta = { decided_by: 'model', model: decisionOut.model, confidence: decisionOut.confidence, model_rationale: decisionOut.rationale, key_signals: decisionOut.key_signals, prompt_hash: decisionOut.prompt_hash };

  if (decisionOut.action === 'flatten') {
    if (!holding) return { decision: { action: 'skip', reason: 'model-flatten-no-position', checkedState, ...meta }, checkedState, metrics };
    return exitAll('model-exit', { price: wethPrice, ...meta });
  }
  if (decisionOut.action === 'buy') {
    const amountUsd = Math.min(maxDeployUsd, Math.max(0, decisionOut.size_fraction) * maxDeployUsd);
    if (amountUsd < minOrderUsd) {
      return { decision: { action: 'skip', reason: 'model-size-below-minimum', checkedState, ...meta }, checkedState, metrics };
    }
    return submit(ctx, { tokenIn: usdc, tokenOut: weth, amountHuman: amountUsd, prices, protocol, rationale: 'model-entry', signals: { confidence: decisionOut.confidence, ...meta }, checkedState, metrics, extraDecision: meta });
  }
  // hold / skip
  return { decision: { action: decisionOut.action === 'hold' ? 'hold' : 'skip', reason: 'model-no-trade', checkedState, ...meta }, checkedState, metrics };
}

// Deterministic RSI/EMA baseline — eval/replay reproducibility + model-disabled
// runs only. NOT the live decision path when the model is configured.
function decideDeterministic(ctx, g) {
  const { weth, usdc, protocol, prices, wethPrice, totalNav, wethHeld, usdcHeld, closes, currentRsi, shortEma, longEma, checkedState, metrics, fraction, minOrderUsd, holding, entry, exitAll } = g;

  if (holding) {
    if (currentRsi !== null && currentRsi >= 70) return exitAll('rsi-overbought-exit', { rsi_14: currentRsi, price: wethPrice });
    const entryAgeMs = entry && Number.isFinite(entry.timestamp_ms) ? Date.now() - entry.timestamp_ms : null;
    const pastMinHold = entryAgeMs === null || entryAgeMs >= t.CANDLE_INTERVAL_MS;
    const entrySignal = entry && entry.signal ? entry.signal : null;
    const trendDown = shortEma !== null && longEma !== null && shortEma < longEma * 0.999;
    if (entrySignal === 'ema-trend-entry' && trendDown && pastMinHold) return exitAll('trend-breakdown-exit', { ema_12: shortEma, ema_26: longEma, price: wethPrice });
    if (entrySignal === 'rsi-oversold-entry' && currentRsi !== null && currentRsi >= 55 && pastMinHold) return exitAll('mean-reversion-target-exit', { rsi_14: currentRsi, price: wethPrice });
    if (!entrySignal && trendDown && currentRsi !== null && currentRsi >= 35 && currentRsi < 45) return exitAll('trend-breakdown-exit', { ema_12: shortEma, ema_26: longEma, rsi_14: currentRsi, price: wethPrice });
    return { decision: { action: 'hold', reason: 'holding-position-no-exit-signal', checkedState }, checkedState, metrics };
  }

  const targetNotional = totalNav * fraction;
  if (targetNotional < minOrderUsd) return { decision: { action: 'skip', reason: 'target-notional-below-minimum', checkedState }, checkedState, metrics };
  const oversold = currentRsi <= 30;
  const trendUp = shortEma !== null && longEma !== null && shortEma > longEma && currentRsi < 70;
  if ((oversold || trendUp) && usdcHeld > 0) {
    const amountUsd = Math.min(targetNotional, usdcHeld);
    if (amountUsd < minOrderUsd) return { decision: { action: 'skip', reason: 'idle-usdc-below-minimum', checkedState }, checkedState, metrics };
    return submit(ctx, { tokenIn: usdc, tokenOut: weth, amountHuman: amountUsd, prices, protocol, rationale: oversold ? 'rsi-oversold-entry' : 'ema-trend-entry', signals: { rsi_14: currentRsi, ema_12: shortEma, ema_26: longEma, price: wethPrice }, checkedState, metrics });
  }
  return { decision: { action: 'skip', reason: 'no-clear-dex-setup', checkedState }, checkedState, metrics };
}

async function submit(ctx, { tokenIn, tokenOut, amountHuman, prices, protocol, rationale, signals, checkedState, metrics, extraDecision }) {
  const { config } = ctx;
  const slippageBps = await t.recommendSlippageBps(ctx.api, tokenIn, tokenOut, 100);
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
  const submission = await t.submitIntent(ctx.api, config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: rationale, intent, ...(extraDecision || {}) }
    : { action: 'skip', reason: 'submission-rejected', intent, ...(extraDecision || {}) };
  return { decision, checkedState, metrics, resultExtra: { trade_action: { attempted: true, ...submission } } };
}

t.runTick('dex', decide);
