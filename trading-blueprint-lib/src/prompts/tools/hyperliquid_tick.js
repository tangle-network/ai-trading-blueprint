#!/usr/bin/env node
// Hyperliquid perpetuals trading tick (strategy_type "hyperliquid_perp").
//
// The fast cron prompt delegates here so each tick has machine-checkable
// behavior: inspect state, decide, optionally fund/execute, log once, write
// metrics once, and print one final JSON object.
//
// Decision architecture (mirrors dex_tick.js — the line that killed the
// decorative-AI bug):
//   1. Fail-closed RISK GUARDS run first and stay deterministic — mode gating,
//      pricing sanity, the PnL-based stop-loss/take-profit that flattens an open
//      position, the leverage and position-size caps (max_leverage,
//      max_position_pct), usable-margin / funding / liquidation safety. Risk
//      never asks the model and the model can never widen any of these caps.
//   2. Inside whatever the guards still permit, the MODEL is the alpha source:
//      it picks the DIRECTION (long/short/skip when flat; hold/close when in a
//      position) and a size_fraction of the already-capped notional envelope.
//      RSI/EMA/funding are now *inputs to the model*, no longer the decision.
//   3. The deterministic RSI/EMA strategy survives ONLY as the eval/replay
//      baseline (TRADING_AGENTIC_DECISIONS=0) so walk-forward stays
//      reproducible. In live mode a model failure HOLDS/closes-safe — it never
//      silently trades the rule behind the operator's back.

const fs = require('fs');
const { spawnSync } = require('child_process');
const { agenticDecision, agenticDecisionsEnabled } = require('/home/agent/tools/agentic-decision');

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

// Compact, model-legible momentum view of the candle history beyond the single
// RSI/EMA scalars: recent returns so the model can reason about trend without
// being handed an 80-element array (mirrors dex_tick.js priceFeatures).
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

// Surface whatever funding-rate / funding-pressure fields the venue actually
// returns so the model can weigh carry — fail-soft to null, never throw.
function fundingSignal(funding) {
  const data = funding || {};
  return {
    funding_rate: asNumber(
      data.funding_rate ?? data.fundingRate ?? data.predicted_funding ?? data.hourly_funding_rate,
      null,
    ),
    funding_apr: asNumber(data.funding_apr ?? data.funding_apr_pct, null),
  };
}

// The leverage + position-size envelope. These are RISK caps — read once,
// deterministic, and the model can never widen them. Returns the max notional
// the strategy may open this tick.
//   * max_position_pct: % of NAV the position notional may reach (default 5%).
//   * max_leverage: notional / margin ceiling (default 2x).
//   * usable perp margin further bounds notional so we never request more than
//     the account can collateralize.
function sizingEnvelope(harness, totalNav, usablePerpMargin) {
  const perps = harness.perps || {};
  const sizing = harness.position_sizing || {};
  const positionFraction = asNumber(sizing.fraction, 0.1);
  const minOrderUsd = asNumber(harness.min_order_usd, 10);
  const maxLeverage = Math.max(1, asNumber(perps.max_leverage, 2));
  const maxPositionPct = Math.max(0, asNumber(perps.max_position_pct, 5));

  const capitalBase = Math.max(totalNav, usablePerpMargin);
  // The legacy fraction-of-capital target, hard-capped by the mandate's
  // max_position_pct of NAV so the model can never size past the risk ceiling.
  const fractionNotional = capitalBase * positionFraction;
  const positionPctNotional = totalNav > 0 ? totalNav * (maxPositionPct / 100) : fractionNotional;
  const cappedByPct = Math.min(fractionNotional, positionPctNotional);
  // Margin/leverage ceiling: a position is collateralized by usable margin and
  // may not exceed margin * maxLeverage.
  const marginLeverageCeiling = usablePerpMargin > 0 ? usablePerpMargin * maxLeverage : cappedByPct;
  const maxNotional = Math.max(0, Math.min(cappedByPct, marginLeverageCeiling));

  return {
    maxLeverage,
    maxPositionPct,
    minOrderUsd,
    positionFraction,
    capitalBase,
    maxNotional,
  };
}

// Build the close/exit setup for an open position. Used by both the
// deterministic baseline (PnL-trigger exits) and the agentic path (model
// "close"). Returns a setup the main() execution machinery already understands.
function buildCloseSetup(position, rationale, signals) {
  const asset = positionAsset(position) || 'ETH';
  const size = positionSize(position);
  const notional = positionNotional(position);
  const assetSize = formatAssetSize(asset, Math.abs(size));
  return {
    clear: true,
    action: size > 0 ? 'close_long' : 'close_short',
    asset,
    amount_in: String(notional || Math.abs(size)),
    asset_size: assetSize || String(Math.abs(size)),
    required_margin_usdc: 0,
    rationale,
    signals: signals || {},
  };
}

// Build the open setup for a chosen direction + notional. Shared by the
// deterministic baseline and the agentic path so both route through the same
// execution intent in main(). Returns null when the asset size rounds to zero.
function buildOpenSetup({ action, asset, notional, currentPrice, rationale, signals }) {
  const assetSize = formatAssetSize(asset, notional / currentPrice);
  if (!assetSize) return null;
  return {
    clear: true,
    action,
    asset,
    amount_in: String(notional),
    asset_size: assetSize,
    required_margin_usdc: notional,
    rationale,
    signals: signals || {},
  };
}

// ---- ALPHA: model decides DIRECTION + SIZE inside the guard envelope ----
// Flat: long / short / skip. In a position: hold / close. The model never sees
// the leverage or position-size caps as negotiable — it returns a size_fraction
// of the already-capped notional envelope. Fails closed (null → hold/skip).
async function decideAgentic({ env, openPosition, asset, currentPrice, closes, currentRsi, shortEma, longEma, funding, totalNav, usablePerpMargin, envelope, maxDrawdownPct }) {
  const holding = Boolean(openPosition);
  const candidates = holding ? ['hold', 'close'] : ['long', 'short', 'skip'];

  const evidence = {
    asset,
    price: currentPrice,
    rsi_14: currentRsi,
    ema_12: shortEma,
    ema_26: longEma,
    ema_gap_pct: shortEma && longEma ? ((shortEma - longEma) / longEma) * 100 : null,
    ...priceFeatures(closes),
    ...fundingSignal(funding),
    total_nav_usd: totalNav,
    usable_perp_margin_usd: usablePerpMargin,
    position: holding
      ? {
          side: positionSize(openPosition) > 0 ? 'long' : 'short',
          notional_usd: positionNotional(openPosition),
          unrealized_pnl_usd: positionPnl(openPosition),
          unrealized_pct: positionNotional(openPosition) > 0
            ? (positionPnl(openPosition) / positionNotional(openPosition)) * 100
            : null,
          leverage: usablePerpMargin > 0 ? positionNotional(openPosition) / usablePerpMargin : null,
        }
      : null,
  };

  const decisionOut = await agenticDecision(
    {
      family: 'hyperliquid',
      candidates,
      sizing: { max_fraction: 1, max_notional_usd: envelope.maxNotional, min_notional_usd: envelope.minOrderUsd },
      mandate: { max_drawdown_pct: maxDrawdownPct, max_leverage: envelope.maxLeverage, max_position_pct: envelope.maxPositionPct, asset, venue: 'hyperliquid' },
      position: holding ? { side: evidence.position.side, notional_usd: evidence.position.notional_usd } : { side: 'flat' },
      evidence,
    },
    { env },
  );

  const meta = decisionOut
    ? {
        decided_by: 'model',
        model: decisionOut.model,
        confidence: decisionOut.confidence,
        model_rationale: decisionOut.rationale,
        key_signals: decisionOut.key_signals,
        prompt_hash: decisionOut.prompt_hash,
      }
    : null;

  // Fail closed: a model failure HOLDS an open position / skips when flat. It
  // never falls back to a hidden directional rule (the decorative-AI bug).
  if (!decisionOut) {
    if (holding) {
      return { clear: false, reason: 'model-unavailable-hold', decided_by: 'model', model_unavailable: true };
    }
    return { clear: false, reason: 'model-unavailable-skip', decided_by: 'model', model_unavailable: true };
  }

  if (holding) {
    if (decisionOut.action === 'close') {
      return { ...buildCloseSetup(openPosition, 'model-exit', { price: currentPrice }), ...meta };
    }
    return { clear: false, reason: 'model-hold', ...meta };
  }

  if (decisionOut.action === 'skip') {
    return { clear: false, reason: 'model-no-trade', ...meta };
  }

  // long / short: size is the model's fraction of the already-capped envelope.
  const notional = Math.min(
    envelope.maxNotional,
    Math.max(0, decisionOut.size_fraction) * envelope.maxNotional,
  );
  if (notional < envelope.minOrderUsd) {
    return { clear: false, reason: 'model-size-below-minimum', target_notional_usdc: notional, min_order_usd: envelope.minOrderUsd, ...meta };
  }
  const open = buildOpenSetup({
    action: decisionOut.action === 'long' ? 'open_long' : 'open_short',
    asset,
    notional,
    currentPrice,
    rationale: 'model-entry',
    signals: { rsi_14: currentRsi, ema_12: shortEma, ema_26: longEma, price: currentPrice, confidence: decisionOut.confidence },
  });
  if (!open) {
    return { clear: false, reason: 'model-asset-size-rounds-to-zero', ...meta };
  }
  return { ...open, ...meta };
}

// Deterministic RSI/EMA baseline — eval/replay reproducibility + model-disabled
// runs only (TRADING_AGENTIC_DECISIONS=0). NOT the live decision path when the
// model is configured. Only ever opens LONG, exactly as before.
function decideDeterministic({ asset, currentPrice, closes, currentRsi, shortEma, longEma, envelope }) {
  if (currentRsi !== null && currentRsi <= 30) {
    const open = buildOpenSetup({
      action: 'open_long',
      asset,
      notional: envelope.maxNotional,
      currentPrice,
      rationale: 'rsi-oversold',
      signals: { rsi_14: currentRsi, price: currentPrice },
    });
    if (open) return open;
  }
  if (shortEma !== null && longEma !== null && shortEma > longEma && currentRsi !== null && currentRsi < 70) {
    const open = buildOpenSetup({
      action: 'open_long',
      asset,
      notional: envelope.maxNotional,
      currentPrice,
      rationale: 'ema-trend-confirmed',
      signals: { rsi_14: currentRsi, ema_12: shortEma, ema_26: longEma, price: currentPrice },
    });
    if (open) return open;
  }
  return null;
}

async function detectSetup(api, prices, account, funding, totalNav, usablePerpMargin, maxDrawdownPct, env) {
  const harness = readJson(CANONICAL_HARNESS_FILE, readJson(HARNESS_FILE, {}));
  const envelope = sizingEnvelope(harness, totalNav, usablePerpMargin);
  const { minOrderUsd, maxNotional } = envelope;
  const agentic = agenticDecisionsEnabled(env);

  // ---- RISK GUARD: PnL-based stop-loss / take-profit on open positions ----
  // This flattens rather than freezes — it is risk, not alpha, so it runs
  // deterministically and the model never gets to override it. When a position
  // exists but has NOT hit a PnL trigger, the model decides hold vs close.
  const positions = normalizePositions(account);
  const openPosition = positions.find((p) => positionSize(p) !== 0) || null;
  if (openPosition) {
    const notional = positionNotional(openPosition);
    const pnl = positionPnl(openPosition);
    const pnlPct = notional > 0 ? pnl / notional : 0;
    if (pnlPct >= 0.01 || pnlPct <= -0.005) {
      return buildCloseSetup(
        openPosition,
        pnlPct >= 0.01 ? 'take-profit-trigger' : 'stop-loss-trigger',
        { pnl_pct: pnlPct },
      );
    }
  }

  // ---- RISK GUARD: size envelope must clear the minimum order ----
  if (!openPosition && maxNotional < minOrderUsd) {
    return {
      clear: false,
      reason: 'target-notional-below-minimum',
      target_notional_usdc: maxNotional,
      sizing_capital_base_usdc: envelope.capitalBase,
      min_order_usd: minOrderUsd,
      usable_perp_margin_usdc: usablePerpMargin,
    };
  }

  // ---- ALPHA: model decides direction/size inside the envelope ----
  // Candle context for the chosen / held asset. When holding, evaluate the held
  // asset; when flat, scan the universe for the first asset with enough history
  // and let the model decide long/short/skip on it.
  if (openPosition) {
    const asset = positionAsset(openPosition) || 'ETH';
    const currentPrice = priceOf(prices, asset);
    const closes = await fetchCandles(api, asset);
    const currentRsi = rsi(closes, 14);
    const shortEma = ema(closes, 12);
    const longEma = ema(closes, 26);
    if (!agentic) {
      // Deterministic baseline never managed an open position beyond the PnL
      // guard above — it holds.
      return { clear: false, reason: 'holding-position-no-exit-signal', asset };
    }
    return decideAgentic({
      env, openPosition, asset, currentPrice, closes, currentRsi, shortEma, longEma,
      funding, totalNav, usablePerpMargin, envelope, maxDrawdownPct,
    });
  }

  for (const asset of ['ETH', 'BTC', 'SOL']) {
    const currentPrice = priceOf(prices, asset);
    const closes = await fetchCandles(api, asset);
    if (!currentPrice || closes.length < 30) continue;

    const currentRsi = rsi(closes, 14);
    const shortEma = ema(closes, 12);
    const longEma = ema(closes, 26);

    if (agentic) {
      // The model decides on the first asset with enough history. It already
      // weighs long/short/skip with full context, so we honor its call rather
      // than scanning to the next asset and effectively re-rolling — a "skip"
      // here is a real no-trade decision, not a reason to keep shopping assets.
      return decideAgentic({
        env, openPosition: null, asset, currentPrice, closes, currentRsi, shortEma, longEma,
        funding, totalNav, usablePerpMargin, envelope, maxDrawdownPct,
      });
    }

    const det = decideDeterministic({ asset, currentPrice, closes, currentRsi, shortEma, longEma, envelope });
    if (det) return det;
  }

  return {
    clear: false,
    reason: 'no-clear-hyperliquid-setup',
    target_notional_usdc: maxNotional,
    sizing_capital_base_usdc: envelope.capitalBase,
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
    const maxDrawdownPct = asNumber(
      (harness.perps && harness.perps.max_drawdown_pct)
        ?? harness.max_drawdown_pct
        ?? config.strategy_config?.max_drawdown_pct,
      10,
    );
    const setup = await detectSetup(
      api, prices, account, funding, totalNav, usablePerpMargin, maxDrawdownPct, process.env,
    );
    // Thread model provenance (decided_by/model/confidence/rationale/key_signals/
    // prompt_hash) onto the decision so the live call is auditable, whether the
    // model said trade, hold, or skip.
    const provenance = setup.decided_by === 'model'
      ? {
          decided_by: 'model',
          model: setup.model,
          confidence: setup.confidence,
          model_rationale: setup.model_rationale,
          key_signals: setup.key_signals,
          prompt_hash: setup.prompt_hash,
        }
      : {};
    if (!setup.clear) {
      decision = {
        action: setup.reason === 'model-hold' ? 'hold' : 'skip',
        reason: setup.reason || 'no-clear-hyperliquid-setup',
        setup,
        ...provenance,
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
          ...provenance,
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
              ...provenance,
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
            ...provenance,
          };
        } else {
          decision = {
            action: 'skip',
            reason: 'validation-rejected',
            setup,
            validation: body(validation),
            ...provenance,
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
