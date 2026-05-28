#!/usr/bin/env node
// Deterministic conservative-yield tick (strategy_type "yield") for Aave V3.
//
// Maintains a target supplied fraction of the bot's stable balance: supply idle
// USDC above the buffer into Aave, hold otherwise. Supply-only by design —
// withdraw/borrow require live health-factor metadata and are handled by the
// wind-down path, not the routine tick. One supply per tick.

const t = require('/home/agent/tools/tick-common');

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const { usdc } = t.pairTokens(config);
  const y = harness.yield || harness.aave || {};
  const targetFraction = clamp(t.asNumber(y.target_supplied_fraction, 0.8), 0, 1);
  const bandPct = Math.max(0.02, t.asNumber(y.rebalance_band_pct, 0.05));
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  const protocol = 'aave_v3';

  const portfolio = t.body(await api.apiCall('POST', '/portfolio/state', {}));
  const positions = t.positionsOf(portfolio);
  const idleUsdc = t.vaultSpotAmount(portfolio, usdc);
  const suppliedUsd = positions
    .filter((p) => String(p.protocol || '').toLowerCase() === protocol)
    .reduce((sum, p) => sum + Math.abs(t.asNumber(p.value_usd ?? p.amount, 0)), 0);
  const totalStable = idleUsdc + suppliedUsd;

  const checkedState = {
    protocol,
    target_supplied_fraction: targetFraction,
    idle_usdc: idleUsdc,
    supplied_usd: suppliedUsd,
    total_stable_usd: totalStable,
    supplied_fraction: totalStable > 0 ? suppliedUsd / totalStable : 0,
  };
  const metrics = { portfolio_value_usd: t.asNumber(portfolio.total_value_usd, totalStable), positions_count: positions.length };

  if (totalStable < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'no-stable-balance', checkedState }, checkedState, metrics };
  }
  const targetSuppliedUsd = totalStable * targetFraction;
  const shortfallUsd = targetSuppliedUsd - suppliedUsd;
  if (shortfallUsd <= totalStable * bandPct) {
    return { decision: { action: 'skip', reason: 'supplied-within-target', checkedState }, checkedState, metrics };
  }
  const supplyUsd = Math.min(shortfallUsd, idleUsdc);
  if (supplyUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'idle-stable-below-minimum', checkedState }, checkedState, metrics };
  }

  const amountInUnits = t.decimalToBaseUnits(supplyUsd, t.tokenDecimals(usdc));
  const intent = {
    strategy_id: `yield-${config.bot_id || 'bot'}`,
    action: 'supply',
    token_in: usdc,
    token_out: usdc,
    amount_in: amountInUnits.toString(),
    min_amount_out: '0',
    amount_format: 'base_units',
    target_protocol: protocol,
    deadline_secs: 300,
    metadata: { signal: 'aave-supply-to-target' },
  };
  const submission = await t.submitIntent(api, config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: 'aave-supply-to-target', intent }
    : { action: 'skip', reason: 'submission-rejected', intent };
  return { decision, checkedState, metrics, resultExtra: { trade_action: { attempted: true, ...submission } } };
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

t.runTick('yield', decide);
