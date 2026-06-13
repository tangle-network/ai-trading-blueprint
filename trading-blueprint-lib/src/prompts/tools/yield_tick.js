#!/usr/bin/env node
// Conservative-yield tick (strategy_type "yield") for Aave V3.
//
// Decision architecture (mirrors dex_tick.js — this is the line that killed the
// decorative-AI bug):
//   1. Fail-closed RISK GUARDS run first and are always deterministic — pricing
//      sanity, no-stable-balance, the drawdown breaker (withdraw to de-risk while
//      supplied), and config completeness. Risk never asks the model.
//   2. Inside whatever the guards still permit, the MODEL is the alpha source:
//      it picks one action {supply, withdraw, hold} and a size from the full
//      evidence (idle vs supplied balance, supplied fraction vs target, APY,
//      NAV, market signals, mandate). The target-fraction rule is now an *input
//      to the model*, no longer the decision.
//   3. The deterministic target-fraction strategy survives ONLY as the eval/
//      replay baseline (TRADING_AGENTIC_DECISIONS=0) so walk-forward stays
//      reproducible. In live mode a model failure HOLDS — it never silently
//      supplies on the rule.

const t = require('/home/agent/tools/tick-common');
const { agenticDecision, agenticDecisionsEnabled } = require('/home/agent/tools/agentic-decision');

const PROTOCOL = 'aave_v3';

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// USDC token aliases the portfolio may use to label the same stable balance.
// The strict `vaultSpotAmount` read gates on `position_type === 'spot'` AND an
// exact lowercased-address match. The operator's paper portfolio synthesizer
// (operator_api.rs `seed_initial_paper_cash_position` → `credit_fallback_position`)
// emits the seeded cash with `token: "USDC"` (the SYMBOL, not the chain address)
// and `position_type: null` — so the strict read returns 0 even though $10k of
// deployable stable is sitting idle. That mismatch is what silently dropped
// 'supply' from the candidate set; the model then (correctly) answered 'supply',
// agenticDecision rejected the out-of-contract action → null → "model-unavailable".
const USDC_ALIASES = new Set(['usdc', 'usd-coin', 'usdc.e']);

// Resolve idle stable balance robustly across portfolio labelings. Prefers the
// strict vault-spot read; if that is 0, falls back to any positive USDC-by-symbol
// or USDC-by-address holding that is NOT already booked as a supplied yield
// position. Returns the human-unit USD amount (USDC ~ $1). This is alpha-neutral:
// it only changes whether the model is *asked* about idle cash it can actually
// deploy — every risk guard still runs deterministically.
function resolveIdleStable(t, portfolio, usdcAddress) {
  const strict = t.vaultSpotAmount(portfolio, usdcAddress);
  if (strict > 0) return { amount: strict, source: 'vault_spot' };

  const addr = String(usdcAddress || '').toLowerCase();
  const positions = t.positionsOf(portfolio);
  let amount = 0;
  for (const p of positions) {
    const protocol = String(p.protocol || '').toLowerCase();
    // A position already counted as supplied to the yield venue is NOT idle.
    if (protocol === PROTOCOL) continue;
    const token = String(p.token || '').trim().toLowerCase();
    const isUsdc = token === addr || USDC_ALIASES.has(token);
    if (!isUsdc) continue;
    // Prefer explicit USD value; fall back to amount (USDC is ~$1). A non-spot
    // perp/conditional leg never reaches here because it carries a non-USDC
    // token and/or a venue protocol, so this stays scoped to stable inventory.
    const usd = t.asNumber(p.value_usd ?? p.amount, 0);
    if (usd > 0) amount += usd;
  }
  if (amount > 0) return { amount, source: 'token_match_fallback' };
  return { amount: 0, source: 'none' };
}

function compactSignals(ctx, checkedState, metrics) {
  try {
    const evidence = t.buildExternalSignalEvidence({
      config: ctx.config,
      family: 'yield',
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
  const { usdc } = t.pairTokens(config);
  const y = harness.yield || harness.aave || {};
  const targetFraction = clamp(t.asNumber(y.target_supplied_fraction, 0.8), 0, 1);
  const bandPct = Math.max(0.02, t.asNumber(y.rebalance_band_pct, 0.05));
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  // Optional reserve/APY context the operator can supply via harness; surfaced to
  // the model as evidence (not a guard).
  const supplyApyPct = Number.isFinite(Number(y.supply_apy_pct)) ? Number(y.supply_apy_pct) : null;
  const utilizationPct = Number.isFinite(Number(y.utilization_pct)) ? Number(y.utilization_pct) : null;

  const [portfolioBody, pricesBody] = await Promise.all([
    api.apiCall('POST', '/portfolio/state', {}),
    api.apiCall('POST', '/market-data/prices', { tokens: [usdc] }).catch(() => null),
  ]);
  const portfolio = t.body(portfolioBody);
  const prices = t.priceMap(t.body(pricesBody));
  const usdcPrice = prices.get(String(usdc).toLowerCase()) ?? 1;
  const positions = t.positionsOf(portfolio);
  const idle = resolveIdleStable(t, portfolio, usdc);
  const idleUsdc = idle.amount;
  const idleSource = idle.source;
  const suppliedUsd = positions
    .filter((p) => String(p.protocol || '').toLowerCase() === PROTOCOL)
    .reduce((sum, p) => sum + Math.abs(t.asNumber(p.value_usd ?? p.amount, 0)), 0);
  const totalStable = idleUsdc + suppliedUsd;
  const suppliedFraction = totalStable > 0 ? suppliedUsd / totalStable : 0;
  const totalNav = t.asNumber(portfolio.total_value_usd, totalStable);

  const checkedState = {
    protocol: PROTOCOL,
    target_supplied_fraction: targetFraction,
    rebalance_band_pct: bandPct,
    idle_usdc: idleUsdc,
    idle_source: idleSource,
    supplied_usd: suppliedUsd,
    total_stable_usd: totalStable,
    supplied_fraction: suppliedFraction,
    market: {
      asset: 'USDC',
      usdc_price_usd: usdcPrice,
      yield_venue: PROTOCOL,
      supply_apy_pct: supplyApyPct,
      utilization_pct: utilizationPct,
    },
  };
  const metrics = {
    portfolio_value_usd: totalNav,
    positions_count: positions.length,
    usdc_price_usd: usdcPrice,
    yield_venue_count: 1,
  };

  return {
    usdc,
    targetFraction,
    bandPct,
    minOrderUsd,
    supplyApyPct,
    utilizationPct,
    prices,
    usdcPrice,
    idleUsdc,
    suppliedUsd,
    totalStable,
    suppliedFraction,
    totalNav,
    checkedState,
    metrics,
  };
}

async function decide(ctx) {
  const { config, harness } = ctx;
  const g = await gather(ctx);
  const { usdcPrice, totalStable, suppliedUsd, idleUsdc, minOrderUsd, checkedState, metrics, prices } = g;
  const maxDrawdownPct = t.mandateMaxDrawdownPct(config, harness, 10);

  // ---- RISK GUARDS (deterministic, fail-closed, always run) ----
  if (!Number.isFinite(usdcPrice) || usdcPrice <= 0) {
    return { decision: { action: 'skip', reason: 'pricing-unavailable', checkedState }, checkedState, metrics };
  }
  if (totalStable < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'no-stable-balance', checkedState }, checkedState, metrics };
  }

  const supplied = suppliedUsd >= minOrderUsd;
  const withdrawAll = (rationale, signals, extraDecision) =>
    submit(ctx, { action: 'withdraw', amountHuman: suppliedUsd, rationale, signals, prices, checkedState, metrics, extraDecision });

  // A tripped drawdown breaker withdraws rather than freezes: skipping while
  // supplied leaves the position riding the drawdown that tripped it.
  if (await t.circuitBreakerTripped(ctx.api, maxDrawdownPct)) {
    if (supplied) return withdrawAll('drawdown-derisk-withdraw', { max_drawdown_pct: maxDrawdownPct });
    return { decision: { action: 'skip', reason: 'circuit-breaker-triggered', checkedState }, checkedState, metrics };
  }

  // ---- ALPHA: model decides inside the guard envelope ----
  if (agenticDecisionsEnabled()) {
    return decideAgentic(ctx, { ...g, maxDrawdownPct, supplied, withdrawAll });
  }
  return decideDeterministic(ctx, g);
}

async function decideAgentic(ctx, g) {
  const {
    usdc,
    targetFraction,
    minOrderUsd,
    supplyApyPct,
    utilizationPct,
    prices,
    idleUsdc,
    suppliedUsd,
    totalStable,
    suppliedFraction,
    totalNav,
    checkedState,
    metrics,
    maxDrawdownPct,
    supplied,
    withdrawAll,
  } = g;

  // Deployable envelope per direction: supply is bounded by idle cash, withdraw
  // by what is currently supplied. The model picks the action; size_fraction
  // scales the matching envelope.
  const canSupply = idleUsdc >= minOrderUsd;
  const candidates = [];
  if (canSupply) candidates.push('supply');
  if (supplied) candidates.push('withdraw');
  candidates.push('hold');

  const evidence = {
    idle_usdc: idleUsdc,
    supplied_usd: suppliedUsd,
    total_stable_usd: totalStable,
    supplied_fraction: suppliedFraction,
    target_supplied_fraction: targetFraction,
    supplied_fraction_gap: targetFraction - suppliedFraction,
    total_nav_usd: totalNav,
    supply_apy_pct: supplyApyPct,
    utilization_pct: utilizationPct,
    market_signals: compactSignals(ctx, checkedState, metrics),
  };

  const decisionOut = await agenticDecision({
    family: 'yield',
    candidates,
    sizing: { max_fraction: 1, min_notional_usd: minOrderUsd },
    mandate: { max_drawdown_pct: maxDrawdownPct, asset: 'USDC', venue: PROTOCOL, target_supplied_fraction: targetFraction },
    position: { supplied_usd: suppliedUsd, idle_usd: idleUsdc, side: supplied ? 'supplied' : 'idle' },
    evidence,
  });

  // Fail closed: in live mode a model failure HOLDS — it never supplies on the
  // deterministic rule behind the operator's back.
  if (!decisionOut) {
    return { decision: { action: 'hold', reason: 'model-unavailable', checkedState }, checkedState, metrics };
  }

  const meta = {
    decided_by: 'model',
    model: decisionOut.model,
    confidence: decisionOut.confidence,
    model_rationale: decisionOut.rationale,
    key_signals: decisionOut.key_signals,
    prompt_hash: decisionOut.prompt_hash,
  };
  const sizeFraction = clamp(Number(decisionOut.size_fraction) || 0, 0, 1);

  if (decisionOut.action === 'withdraw') {
    if (!supplied) return { decision: { action: 'hold', reason: 'model-withdraw-no-position', checkedState, ...meta }, checkedState, metrics };
    const amountUsd = Math.min(suppliedUsd, sizeFraction * suppliedUsd);
    if (amountUsd < minOrderUsd) {
      return { decision: { action: 'hold', reason: 'model-size-below-minimum', checkedState, ...meta }, checkedState, metrics };
    }
    return submit(ctx, { action: 'withdraw', amountHuman: amountUsd, rationale: 'model-withdraw', signals: { confidence: decisionOut.confidence, ...meta }, prices, checkedState, metrics, extraDecision: meta });
  }
  if (decisionOut.action === 'supply') {
    const amountUsd = Math.min(idleUsdc, sizeFraction * idleUsdc);
    if (amountUsd < minOrderUsd) {
      return { decision: { action: 'hold', reason: 'model-size-below-minimum', checkedState, ...meta }, checkedState, metrics };
    }
    return submit(ctx, { action: 'supply', amountHuman: amountUsd, rationale: 'model-supply', signals: { confidence: decisionOut.confidence, ...meta }, prices, checkedState, metrics, extraDecision: meta });
  }
  // hold
  return { decision: { action: 'hold', reason: 'model-no-trade', checkedState, ...meta }, checkedState, metrics };
}

// Deterministic target-fraction baseline — eval/replay reproducibility +
// model-disabled runs only. Supply-only by design: maintain a target supplied
// fraction of the stable balance, holding otherwise. NOT the live decision path
// when the model is configured.
function decideDeterministic(ctx, g) {
  const { targetFraction, bandPct, minOrderUsd, idleUsdc, suppliedUsd, totalStable, prices, checkedState, metrics } = g;

  const targetSuppliedUsd = totalStable * targetFraction;
  const shortfallUsd = targetSuppliedUsd - suppliedUsd;
  if (shortfallUsd <= totalStable * bandPct) {
    return { decision: { action: 'skip', reason: 'supplied-within-target', checkedState }, checkedState, metrics };
  }
  const supplyUsd = Math.min(shortfallUsd, idleUsdc);
  if (supplyUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'idle-stable-below-minimum', checkedState }, checkedState, metrics };
  }
  return submit(ctx, { action: 'supply', amountHuman: supplyUsd, rationale: 'aave-supply-to-target', signals: { target_supplied_fraction: targetFraction }, prices, checkedState, metrics });
}

async function submit(ctx, { action, amountHuman, rationale, signals, prices, checkedState, metrics, extraDecision }) {
  const { config } = ctx;
  const { usdc } = t.pairTokens(config);
  const amountInUnits = t.decimalToBaseUnits(amountHuman, t.tokenDecimals(usdc));
  const intent = {
    strategy_id: `yield-${config.bot_id || 'bot'}`,
    action,
    token_in: usdc,
    token_out: usdc,
    amount_in: amountInUnits.toString(),
    min_amount_out: '0',
    amount_format: 'base_units',
    target_protocol: PROTOCOL,
    deadline_secs: 300,
    metadata: { signal: rationale, signals },
  };
  const submission = await t.submitIntent(ctx.api, config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: rationale, intent, ...(extraDecision || {}) }
    : { action: 'skip', reason: 'submission-rejected', intent, ...(extraDecision || {}) };
  return { decision, checkedState, metrics, resultExtra: { trade_action: { attempted: true, ...submission } } };
}

t.runTick('yield', decide);
