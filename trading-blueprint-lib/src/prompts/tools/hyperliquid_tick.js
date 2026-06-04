#!/usr/bin/env node
// Deterministic Hyperliquid perpetuals trading tick.
//
// The fast cron prompt delegates here so each tick has machine-checkable
// behavior: inspect state, decide, optionally fund/execute, log once, write
// metrics once, and print one final JSON object.

const fs = require('fs');
const { spawnSync } = require('child_process');

const DECISION_LOG = '/home/agent/logs/decisions.jsonl';
const METRICS_FILE = '/home/agent/metrics/latest.json';
const CANONICAL_HARNESS_FILE = '/home/agent/config/canonical-harness.json';
const HARNESS_FILE = '/home/agent/config/harness.json';

function nowIso() {
  return new Date().toISOString();
}

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function lineCount(path) {
  try {
    const text = fs.readFileSync(path, 'utf8').trim();
    return text ? text.split('\n').length : 0;
  } catch {
    return 0;
  }
}

function fileMtimeMs(path) {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function body(response) {
  if (!response) return {};
  return response.data !== undefined ? response.data : response;
}

function snapshot(response) {
  const data = body(response);
  return data.snapshot || data.data?.snapshot || data;
}

function asNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') {
    for (const key of ['value', 'usd', 'amount', 'mid', 'mark', 'price']) {
      if (value[key] !== undefined) return asNumber(value[key], fallback);
    }
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function priceOf(prices, symbol) {
  const data = body(prices);
  const value = data[symbol] || data[symbol.toUpperCase()] || data[symbol.toLowerCase()];
  return asNumber(value, null);
}

const HYPERLIQUID_SIZE_DECIMALS = {
  BTC: 5,
  ETH: 4,
  SOL: 2,
};

function formatAssetSize(asset, rawSize) {
  const decimals = HYPERLIQUID_SIZE_DECIMALS[String(asset || '').toUpperCase()] ?? 4;
  const factor = 10 ** decimals;
  const floored = Math.floor(asNumber(rawSize, 0) * factor) / factor;
  if (!Number.isFinite(floored) || floored <= 0) return null;
  return floored.toFixed(decimals).replace(/\.?0+$/, '');
}

function normalizePositions(account) {
  const data = body(account);
  const positions = data.positions || data.assetPositions || [];
  return Array.isArray(positions) ? positions : [];
}

function positionAsset(position) {
  return position.asset || position.coin || position.position?.coin || position.position?.asset || '';
}

function positionSize(position) {
  return asNumber(
    position.size
      ?? position.szi
      ?? position.position?.szi
      ?? position.position?.size
      ?? position.qty,
    0,
  );
}

function positionNotional(position) {
  return Math.abs(asNumber(
    position.notional_usd
      ?? position.notional
      ?? position.position?.positionValue
      ?? position.position?.notional,
    0,
  ));
}

function positionPnl(position) {
  return asNumber(
    position.unrealized_pnl_usd
      ?? position.unrealizedPnl
      ?? position.position?.unrealizedPnl
      ?? position.pnl,
    0,
  );
}

function openOrdersCount(account) {
  const data = body(account);
  const orders = data.open_orders || data.openOrders || [];
  return Array.isArray(orders) ? orders.length : 0;
}

function logDecision(entry) {
  const result = spawnSync('node', [
    '/home/agent/tools/log-decision.js',
    JSON.stringify(entry),
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`log-decision.js failed: ${result.stderr || result.stdout}`);
  }
}

function writeMetrics(entry) {
  const result = spawnSync('node', [
    '/home/agent/tools/write-metrics.js',
    JSON.stringify(entry),
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`write-metrics.js failed: ${result.stderr || result.stdout}`);
  }
}

async function fetchCandles(api, asset) {
  try {
    await api.apiCall('POST', '/market-data/candles/fetch', {
      tokens: [asset],
      interval: '1h',
      limit: 80,
    });
    const response = await api.apiCall(
      'GET',
      `/market-data/candles?token=${encodeURIComponent(asset)}&limit=80`,
    );
    const data = body(response);
    const candles = Array.isArray(data)
      ? data
      : Array.isArray(data.candles)
        ? data.candles
        : Array.isArray(data.data)
          ? data.data
          : [];
    return candles.map((candle) => asNumber(
      candle.close ?? candle.c ?? candle.price ?? candle[4],
      null,
    )).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (const value of values.slice(period)) {
    current = value * alpha + current * (1 - alpha);
  }
  return current;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

async function detectSetup(api, prices, account, totalNav, usablePerpMargin) {
  const harness = readJson(CANONICAL_HARNESS_FILE, readJson(HARNESS_FILE, {}));
  const sizing = harness.position_sizing || {};
  const positionFraction = asNumber(sizing.fraction, 0.1);
  const minOrderUsd = asNumber(harness.min_order_usd, 10);
  const targetNotional = totalNav * positionFraction;

  const positions = normalizePositions(account);
  for (const position of positions) {
    const asset = positionAsset(position) || 'ETH';
    const size = positionSize(position);
    const notional = positionNotional(position);
    const pnl = positionPnl(position);
    const pnlPct = notional > 0 ? pnl / notional : 0;
    if (size !== 0 && (pnlPct >= 0.01 || pnlPct <= -0.005)) {
      const assetSize = formatAssetSize(asset, Math.abs(size));
      return {
        clear: true,
        action: size > 0 ? 'close_long' : 'close_short',
        asset,
        amount_in: String(notional || Math.abs(size)),
        asset_size: assetSize || String(Math.abs(size)),
        required_margin_usdc: 0,
        rationale: pnlPct >= 0.01 ? 'take-profit-trigger' : 'stop-loss-trigger',
        signals: { pnl_pct: pnlPct },
      };
    }
  }

  if (targetNotional < minOrderUsd) {
    return {
      clear: false,
      reason: 'target-notional-below-minimum',
      target_notional_usdc: targetNotional,
      min_order_usd: minOrderUsd,
      usable_perp_margin_usdc: usablePerpMargin,
    };
  }

  for (const asset of ['ETH', 'BTC', 'SOL']) {
    const currentPrice = priceOf(prices, asset);
    const closes = await fetchCandles(api, asset);
    if (!currentPrice || closes.length < 30) continue;

    const currentRsi = rsi(closes, 14);
    const shortEma = ema(closes, 12);
    const longEma = ema(closes, 26);
    if (currentRsi !== null && currentRsi <= 30) {
      const assetSize = formatAssetSize(asset, targetNotional / currentPrice);
      if (!assetSize) continue;
      return {
        clear: true,
        action: 'open_long',
        asset,
        amount_in: String(targetNotional),
        asset_size: assetSize,
        required_margin_usdc: targetNotional,
        rationale: 'rsi-oversold',
        signals: { rsi_14: currentRsi, price: currentPrice },
      };
    }
    if (shortEma !== null && longEma !== null && shortEma > longEma && currentRsi !== null && currentRsi < 70) {
      const assetSize = formatAssetSize(asset, targetNotional / currentPrice);
      if (!assetSize) continue;
      return {
        clear: true,
        action: 'open_long',
        asset,
        amount_in: String(targetNotional),
        asset_size: assetSize,
        required_margin_usdc: targetNotional,
        rationale: 'ema-trend-confirmed',
        signals: { rsi_14: currentRsi, ema_12: shortEma, ema_26: longEma, price: currentPrice },
      };
    }
  }

  return {
    clear: false,
    reason: 'no-clear-hyperliquid-setup',
    target_notional_usdc: targetNotional,
    min_order_usd: minOrderUsd,
    usable_perp_margin_usdc: usablePerpMargin,
  };
}

async function main() {
  const runStartedAt = nowIso();
  const decisionCountBefore = lineCount(DECISION_LOG);
  const metricsMtimeBefore = fileMtimeMs(METRICS_FILE);
  const api = require('/home/agent/tools/api-client');
  const config = api.loadConfig();
  const harness = readJson(CANONICAL_HARNESS_FILE, readJson(HARNESS_FILE, {}));

  const [navResponse, modeResponse, fundingResponse, accountResponse, pricesResponse] =
    await Promise.all([
      api.getHyperliquidNav(),
      api.getHyperliquidMode(),
      api.getHyperliquidFundingStatus(),
      api.apiCall('GET', '/hyperliquid/account'),
      api.apiCall('GET', '/hyperliquid/prices'),
    ]);

  const nav = snapshot(navResponse);
  const mode = snapshot(modeResponse);
  const funding = body(fundingResponse);
  const account = body(accountResponse);
  const prices = body(pricesResponse);

  const totalNav = asNumber(nav.total_nav ?? nav.nav_usd ?? nav.vault_nav_usd, 0);
  const idleUsdc = asNumber(nav.idle_usdc ?? funding.idle_evm_usdc, 0);
  const hyperliquidEquity = asNumber(nav.hyperliquid_equity ?? nav.hyperliquid_equity_usd, 0);
  const usablePerpMargin = asNumber(
    funding.perp_margin_usdc
      ?? funding.usable_perp_margin_usd
      ?? account.withdrawable
      ?? account.account_value,
    0,
  );
  const positions = normalizePositions(account);
  const openOrders = openOrdersCount(account);
  const modeValue = mode.mode || 'unknown';
  const state = {
    nav_status: nav.status || snapshot(navResponse).status || null,
    mode: modeValue,
    total_nav_usdc: totalNav,
    idle_usdc: idleUsdc,
    hyperliquid_equity_usdc: hyperliquidEquity,
    core_spot_usdc: asNumber(funding.core_spot_usdc, 0),
    perp_margin_usdc: usablePerpMargin,
    positions_count: positions.length,
    open_orders_count: openOrders,
    prices: {
      BTC: priceOf(prices, 'BTC'),
      ETH: priceOf(prices, 'ETH'),
      SOL: priceOf(prices, 'SOL'),
    },
  };

  let decision;
  let fundingAction = { attempted: false };
  let apiWalletApprovalAction = { attempted: false };
  let tradeAction = { attempted: false };

  if (modeValue === 'liquidity' || modeValue === 'emergency_wind_down') {
    decision = {
      action: 'skip',
      reason: 'mode-prevents-trading',
      mode: modeValue,
    };
  } else {
    const setup = await detectSetup(api, prices, account, totalNav, usablePerpMargin);
    if (!setup.clear) {
      decision = {
        action: 'skip',
        reason: setup.reason || 'no-clear-hyperliquid-setup',
        setup,
      };
    } else {
      const requiredMargin = asNumber(setup.required_margin_usdc, 0);
      let availableMargin = usablePerpMargin;
      if (setup.action.startsWith('open') && availableMargin < requiredMargin) {
        fundingAction = {
          attempted: true,
          requested_usdc: requiredMargin - availableMargin,
        };
        const fundingResult = await api.fundHyperliquidMargin({
          amount_usdc: fundingAction.requested_usdc,
        });
        fundingAction.status = fundingResult.status;
        fundingAction.response = body(fundingResult);
        const refreshedFunding = body(await api.getHyperliquidFundingStatus());
        availableMargin = asNumber(
          refreshedFunding.perp_margin_usdc ?? refreshedFunding.usable_perp_margin_usd,
          0,
        );
      }

      if (setup.action.startsWith('open') && availableMargin < requiredMargin) {
        decision = {
          action: 'skip',
          reason: 'insufficient-margin-after-funding',
          setup,
          required_margin_usdc: requiredMargin,
          available_margin_usdc: availableMargin,
        };
      } else {
        if (setup.action.startsWith('open')) {
          apiWalletApprovalAction = { attempted: true };
          const approval = await api.approveHyperliquidApiWallet();
          apiWalletApprovalAction.status = approval.status;
          apiWalletApprovalAction.response = body(approval);
          if (!(body(approval) || {}).verified_corewriter_approval) {
            decision = {
              action: 'skip',
              reason: 'api-wallet-approval-not-verified',
              setup,
              approval: body(approval),
            };
          }
        }
      }

      if (!decision) {
        const intent = {
          strategy_id: api.normalizeIntent({}).strategy_id,
          target_protocol: 'hyperliquid',
          token_in: 'USDC',
          token_out: 'USDC',
          min_amount_out: '0',
          action: setup.action,
          amount_in: setup.amount_in,
          metadata: {
            asset: setup.asset,
            asset_size: setup.asset_size,
            notional_usdc: setup.amount_in,
            hyperliquid_account_address:
              config.strategy_config?.hyperliquid_account_address
              || config.hyperliquid_account_address,
            reduce_only: setup.action.startsWith('close') || undefined,
            signal: setup.rationale,
            signals: setup.signals,
          },
        };

        tradeAction = { attempted: true, intent };
        const validation = await api.validate(intent);
        tradeAction.validation_status = validation.status;
        tradeAction.validation = body(validation);
        if ((body(validation) || {}).approved) {
          const execution = await api.execute(intent, validation);
          tradeAction.execution_status = execution.status;
          tradeAction.execution = body(execution);
          decision = {
            action: 'trade',
            reason: setup.rationale,
            setup,
          };
        } else {
          decision = {
            action: 'skip',
            reason: 'validation-rejected',
            setup,
            validation: body(validation),
          };
        }
      }
    }
  }

  const decisionEntry = {
    ...decision,
    state,
    funding_action: fundingAction,
    api_wallet_approval_action: apiWalletApprovalAction,
    trade_action: tradeAction,
    run_started_at: runStartedAt,
  };
  const { provenanceHash } = require('/home/agent/tools/log-decision');
  const recipe_hash = provenanceHash({ family: 'hyperliquid', harness, strategy_config: config.strategy_config ?? null });
  const input_hash = provenanceHash({ family: 'hyperliquid', checked_state: state, intent: decision.intent ?? decision.setup ?? null });
  decisionEntry.recipe_hash = recipe_hash;
  decisionEntry.input_hash = input_hash;
  logDecision(decisionEntry);
  const metrics = {
    action: decision.action,
    reason: decision.reason,
    portfolio_value_usd: totalNav,
    idle_usdc: idleUsdc,
    hyperliquid_equity: hyperliquidEquity,
    perp_margin_usdc: usablePerpMargin,
    positions_count: positions.length,
    open_orders_count: openOrders,
    recipe_hash,
    input_hash,
  };
  writeMetrics(metrics);

  const runCompletedAt = nowIso();
  const reflectionLoop = require('/home/agent/tools/reflection-loop');
  const decisionContext = reflectionLoop.recordDecisionContext({
    family: 'hyperliquid',
    run_started_at: runStartedAt,
    run_completed_at: runCompletedAt,
    config,
    harness,
    checked_state: state,
    decision,
    result: {
      funding_action: fundingAction,
      api_wallet_approval_action: apiWalletApprovalAction,
      trade_action: tradeAction,
    },
    metrics,
    recipe_hash,
    input_hash,
  });
  const reflection = reflectionLoop.reflectOnDecisionContext(decisionContext);

  const result = {
    result_schema_version: 1,
    family: 'hyperliquid',
    run_started_at: runStartedAt,
    run_completed_at: runCompletedAt,
    checked_state: state,
    decision,
    funding_action: fundingAction,
    api_wallet_approval_action: apiWalletApprovalAction,
    trade_action: tradeAction,
    decision_context: {
      context_id: decisionContext.context_id,
      evidence: decisionContext.evidence,
    },
    reflection: {
      reflection_id: reflection.reflection_id,
      decision_context_id: reflection.decision_context_id,
      mode: reflection.mode,
      verdict: reflection.verdict,
      summary: reflection.summary,
      emitted_improvement_intent_id: reflection.emitted_improvement_intent_id || null,
    },
    logs_written: lineCount(DECISION_LOG) > decisionCountBefore,
    metrics_written: fileMtimeMs(METRICS_FILE) >= metricsMtimeBefore,
    decision_context_written: Boolean(decisionContext.context_id),
    reflection_written: Boolean(reflection.reflection_id),
  };

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const result = {
    result_schema_version: 1,
    family: 'hyperliquid',
    run_started_at: nowIso(),
    run_completed_at: nowIso(),
    checked_state: null,
    decision: {
      action: 'error',
      reason: 'tick-runtime-error',
      error: error.message || String(error),
    },
    funding_action: { attempted: false },
    api_wallet_approval_action: { attempted: false },
    trade_action: { attempted: false },
    logs_written: false,
    metrics_written: false,
    decision_context_written: false,
    reflection_written: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(1);
});
