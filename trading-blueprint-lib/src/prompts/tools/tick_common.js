// Shared deterministic-tick runtime for the non-Hyperliquid strategy families
// (dex, mm, yield, multi). Each family tool provides an async `decide(ctx)` and
// `runTick` guarantees the machine-checkable contract the Rust workflow tick
// verifies (workflow_tick.rs `verify_tick_side_effects`):
//   1. one schema-v1 JSON object on stdout with `decision.action` + the
//      `logs_written` / `metrics_written` flags,
//   2. a fresh `/home/agent/logs/decisions.jsonl` line whose timestamp is >= the
//      run start and whose `action`/`reason` match the printed decision,
//   3. a refreshed `/home/agent/metrics/latest.json`,
//   4. a fresh decision context + runtime reflection in `/home/agent/memory`.
// Hyperliquid keeps its own bespoke tool (hyperliquid_tick.js); this module is
// the canonical runtime for every other family so the four tools never diverge.

const fs = require('fs');
const { spawnSync } = require('child_process');

const DECISION_LOG = '/home/agent/logs/decisions.jsonl';
const METRICS_FILE = '/home/agent/metrics/latest.json';
const CANONICAL_HARNESS_FILE = '/home/agent/config/canonical-harness.json';
const HARNESS_FILE = '/home/agent/config/harness.json';

const DEFAULT_TOKENS_BY_CHAIN = {
  1: {
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  8453: {
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  84532: {
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  42161: {
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  31338: {
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  31339: {
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
};

const TOKEN_DECIMALS = (() => {
  const map = { weth: 18, usdc: 6, eth: 18, usdt: 6, dai: 18, wbtc: 8, cbbtc: 8 };
  for (const tokens of Object.values(DEFAULT_TOKENS_BY_CHAIN)) {
    map[tokens.weth.toLowerCase()] = 18;
    map[tokens.usdc.toLowerCase()] = 6;
  }
  return map;
})();

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
    for (const key of ['value', 'usd', 'amount', 'mid', 'mark', 'price', 'price_usd']) {
      if (value[key] !== undefined) return asNumber(value[key], fallback);
    }
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function stableHash(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isPaperShowcaseMode(config, harness) {
  return Boolean(
    config
      && config.strategy_config
      && config.strategy_config.paper_trade === true
      && harness
      && harness.aggressive_paper_mode === true,
  );
}

function normalizeCycleValues(settings, fallbackValues) {
  const raw = Array.isArray(settings)
    ? settings
    : Array.isArray(settings?.values)
      ? settings.values
      : fallbackValues;
  const values = (raw || [])
    .map((value) => clamp(asNumber(value, NaN), 0, 1))
    .filter((value) => Number.isFinite(value));
  return values.length >= 2 ? values : [];
}

function cycleIndexForRun(runStartedAt, periodSecs, length, salt) {
  if (length <= 0) return 0;
  const startedMs = Date.parse(runStartedAt || '');
  const ms = Number.isFinite(startedMs) ? startedMs : Date.now();
  const period = Math.max(60, asNumber(periodSecs, 300));
  const slot = Math.floor(ms / 1000 / period);
  const offset = stableHash(salt) % length;
  return (slot + offset) % length;
}

// Paper-only showcase mode makes live demos visibly active without bypassing the
// real paper validation/execution/logging path. It is intentionally gated on
// strategy_config.paper_trade=true so it cannot alter live-capital behavior.
function paperCycleWeight(ctx, settings, fallback, fallbackValues, salt) {
  if (!ctx || !isPaperShowcaseMode(ctx.config, ctx.harness)) return fallback;
  const values = normalizeCycleValues(settings, fallbackValues);
  if (values.length === 0) return fallback;
  const periodSecs = Array.isArray(settings)
    ? ctx.harness.paper_target_cycle_period_secs
    : settings?.period_secs ?? ctx.harness.paper_target_cycle_period_secs;
  const botSalt = `${ctx.config?.bot_id || ctx.config?.workflow_id || 'bot'}:${salt || ''}`;
  return values[cycleIndexForRun(ctx.runStartedAt, periodSecs, values.length, botSalt)];
}

function loadHarness() {
  return readJson(CANONICAL_HARNESS_FILE, readJson(HARNESS_FILE, {}));
}

function chainId(config) {
  return Number(
    (config.strategy_config && config.strategy_config.protocol_chain_id)
      || config.protocol_chain_id
      || config.chain_id
      || process.env.PROTOCOL_CHAIN_ID
      || process.env.FORK_BASE_CHAIN_ID
      || 1,
  );
}

// Quote (USDC) + primary base (WETH) token addresses for the bot's chain.
function pairTokens(config) {
  const id = chainId(config);
  return DEFAULT_TOKENS_BY_CHAIN[id] || DEFAULT_TOKENS_BY_CHAIN[1];
}

function tokenDecimals(token) {
  const key = String(token || '').trim().toLowerCase();
  return TOKEN_DECIMALS[key] ?? 18;
}

function decimalToBaseUnits(value, decimals) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0n;
  const fixed = numeric.toFixed(decimals);
  const [whole, fraction = ''] = fixed.split('.');
  const normalized = whole + fraction.padEnd(decimals, '0').slice(0, decimals);
  const sanitized = normalized.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(sanitized);
}

function baseUnitsToDecimal(units, decimals) {
  if (units <= 0n) return 0;
  const raw = units.toString();
  if (decimals === 0) return Number(raw);
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return Number(fraction ? `${whole}.${fraction}` : whole);
}

// Map { token -> price_usd } keyed by lowercased address from a /market-data/prices body.
function priceMap(pricesBody) {
  const map = new Map();
  const entries = (pricesBody && pricesBody.prices) || [];
  for (const entry of entries) {
    const key = String(entry?.token || '').toLowerCase();
    const price = Number(entry?.price_usd ?? entry?.price ?? 0);
    if (!key || !Number.isFinite(price) || price <= 0) continue;
    map.set(key, price);
  }
  return map;
}

function positionsOf(portfolio) {
  const data = body(portfolio);
  return Array.isArray(data.positions) ? data.positions : [];
}

// A spot inventory holding the strategy can trade. The bot manages spot
// inventory regardless of how the portfolio source labels it: live vault reads
// report protocol "vault"; the paper portfolio synthesizer labels seeded cash
// "paper" and swapped tokens by their DEX venue ("aerodrome"/"uniswap"). All of
// these are the same thing to the strategy — a positive spot balance — so we
// gate on position_type, not the bookkeeping protocol. (Non-spot exposure —
// perps, conditional tokens — carries a different position_type and is excluded.)
function isVaultSpot(position) {
  const positionType = String(position.position_type || '').trim().toLowerCase();
  return positionType === 'spot' && asNumber(position.amount, 0) > 0;
}

// Human-unit spot balance held in the vault for a token address (0 if none).
function vaultSpotAmount(portfolio, tokenAddress) {
  const addr = String(tokenAddress || '').toLowerCase();
  const match = positionsOf(portfolio).find(
    (p) => isVaultSpot(p) && String(p.token || '').toLowerCase() === addr,
  );
  return match ? asNumber(match.amount, 0) : 0;
}

// Synthetic paper portfolios sometimes carry value_usd but not price_usd. When
// the market-data endpoint misses a token, derive a conservative spot price
// from the portfolio's own amount/value pair before falling back to candles.
function spotPriceFromPortfolio(portfolio, tokenAddress) {
  const addr = String(tokenAddress || '').toLowerCase();
  const match = positionsOf(portfolio).find(
    (p) => isVaultSpot(p) && String(p.token || '').toLowerCase() === addr,
  );
  if (!match) return null;
  const explicit = asNumber(match.price_usd ?? match.price ?? null, null);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const amount = asNumber(match.amount, 0);
  const valueUsd = asNumber(match.value_usd ?? match.valueUsd ?? null, null);
  if (amount > 0 && Number.isFinite(valueUsd) && valueUsd > 0) {
    return valueUsd / amount;
  }
  return null;
}

async function resolveUsdPrice(api, portfolio, tokenAddress, prices, fallback = null) {
  const key = String(tokenAddress || '').toLowerCase();
  const quoted = prices && prices.get(key);
  if (Number.isFinite(quoted) && quoted > 0) return quoted;

  const portfolioPrice = spotPriceFromPortfolio(portfolio, tokenAddress);
  if (Number.isFinite(portfolioPrice) && portfolioPrice > 0) {
    if (prices) prices.set(key, portfolioPrice);
    return portfolioPrice;
  }

  try {
    const candles = await fetchCandles(api, tokenAddress);
    const candlePrice = candles[candles.length - 1];
    if (Number.isFinite(candlePrice) && candlePrice > 0) {
      if (prices) prices.set(key, candlePrice);
      return candlePrice;
    }
  } catch {
    // Preserve the original skip behavior on fetch/lookahead failures.
  }

  if (Number.isFinite(fallback) && fallback > 0) {
    if (prices) prices.set(key, fallback);
    return fallback;
  }
  return null;
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

// Thrown when a candle feed carries a bucket that opens at or after the decision
// time. Lookahead is a correctness violation (the tick is reading the future),
// not a transient fetch failure, so this error is NOT collapsed to an empty
// window by fetchCandles — it propagates so runTick records a hard `error`
// decision the Rust verifier and the walk-forward eval both fail on.
class LookaheadViolationError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'LookaheadViolationError';
    this.code = 'lookahead_violation';
    this.detail = detail || {};
  }
}

// Open timestamp of a candle in epoch-ms, or null when the feed carries no
// usable timestamp. Accepts seconds or ms (heuristic: < 1e12 is seconds) and the
// common positional/aliased shapes the candle endpoints emit.
function candleOpenMs(candle) {
  if (Array.isArray(candle)) return normalizeEpochMs(candle[0]);
  const raw = candle?.timestamp ?? candle?.open_time ?? candle?.openTime ?? candle?.time ?? candle?.t;
  return normalizeEpochMs(raw);
}

function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

// HARD lookahead guard (G2): a tick deciding at `decisionMs` may only see
// candles that have already opened. Any bucket opening at/after the decision
// time is the future leaking into the input window — throw so the tick cannot
// silently trade on it. `decisionMs` defaults to wall-clock now; the eval feeds
// a fixed walk-forward cursor so the assertion is deterministic.
function assertNoLookahead(candles, decisionMs) {
  const cutoff = Number.isFinite(decisionMs) ? decisionMs : Date.now();
  for (let i = 0; i < candles.length; i += 1) {
    const openMs = candleOpenMs(candles[i]);
    if (openMs !== null && openMs >= cutoff) {
      throw new LookaheadViolationError(
        `lookahead: candle opens at ${new Date(openMs).toISOString()} >= decision ${new Date(cutoff).toISOString()}`,
        { candle_index: i, candle_open_ms: openMs, decision_ms: cutoff },
      );
    }
  }
}

async function fetchCandles(api, asset, decisionMs) {
  let candles;
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
    candles = Array.isArray(data)
      ? data
      : Array.isArray(data.candles)
        ? data.candles
        : Array.isArray(data.data)
          ? data.data
          : [];
  } catch {
    return [];
  }
  // Run the lookahead assertion OUTSIDE the fetch try/catch so a genuine
  // violation surfaces instead of being masked as an empty window.
  assertNoLookahead(candles, decisionMs);
  return candles
    .map((candle) => asNumber(candle.close ?? candle.c ?? candle.price ?? candle[4], null))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function logDecision(entry) {
  const result = spawnSync('node', ['/home/agent/tools/log-decision.js', JSON.stringify(entry)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`log-decision.js failed: ${result.stderr || result.stdout}`);
  }
}

function writeMetrics(entry) {
  const result = spawnSync('node', ['/home/agent/tools/write-metrics.js', JSON.stringify(entry)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`write-metrics.js failed: ${result.stderr || result.stdout}`);
  }
}

// Slippage learner recommendation in bps, falling back to `fallbackBps` on any error.
async function recommendSlippageBps(api, tokenIn, tokenOut, fallbackBps) {
  try {
    const response = await api.recommendSlippageBps({
      token_in: tokenIn,
      token_out: tokenOut,
      fallback_bps: fallbackBps,
    });
    const recommended = asNumber(body(response).recommended_max_bps, fallbackBps);
    return recommended > 0 ? recommended : fallbackBps;
  } catch {
    return fallbackBps;
  }
}

async function circuitBreakerTripped(api, maxDrawdownPct) {
  try {
    const response = body(await api.checkCircuitBreaker(maxDrawdownPct));
    return Boolean(
      response.triggered
        ?? response.tripped
        ?? response.circuit_breaker_triggered
        ?? response.breached
        ?? false,
    );
  } catch {
    return false;
  }
}

// Build a vault-backed swap intent in base units, with `min_amount_out` derived
// from the supplied USD price map and slippage bps. Returns null when pricing or
// sizing is infeasible. Matches the proven qa_stochastic_dex.js intent shape.
function buildSwapIntent({
  config,
  strategyId,
  tokenIn,
  tokenOut,
  amountInUnits,
  prices,
  slippageBps,
  protocol,
  metadata,
}) {
  if (amountInUnits <= 0n) return null;
  const inKey = String(tokenIn).toLowerCase();
  const outKey = String(tokenOut).toLowerCase();
  const tokenInPrice = prices.get(inKey);
  const tokenOutPrice = prices.get(outKey);
  if (!Number.isFinite(tokenInPrice) || !Number.isFinite(tokenOutPrice) || tokenOutPrice <= 0) {
    return null;
  }
  const tokenInAmount = baseUnitsToDecimal(amountInUnits, tokenDecimals(tokenIn));
  const expectedOut = (tokenInAmount * tokenInPrice) / tokenOutPrice;
  const slippageFactor = (10000 - asNumber(slippageBps, 100)) / 10000;
  const minAmountOutUnits = decimalToBaseUnits(expectedOut * slippageFactor, tokenDecimals(tokenOut));
  if (minAmountOutUnits <= 0n) return null;
  return {
    strategy_id: strategyId || `tick-${config.bot_id || 'bot'}`,
    action: 'swap',
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountInUnits.toString(),
    min_amount_out: minAmountOutUnits.toString(),
    amount_format: 'base_units',
    target_protocol: protocol || 'uniswap_v3',
    deadline_secs: 300,
    metadata: metadata || {},
  };
}

function isEnvelopeMode(config) {
  const trust =
    (config.strategy_config && config.strategy_config.validation_trust)
    || config.validation_trust;
  return String(trust || '').toLowerCase() === 'envelope';
}

// Validate (per-trade) or execute-with-envelope, returning a normalized
// { submitted, approved, validation, execution } record. Never throws — a failed
// submission becomes a logged skip in the caller.
async function submitIntent(api, config, intent) {
  if (isEnvelopeMode(config)) {
    const execution = await api.executeWithEnvelope(intent);
    const approved = execution.status < 400;
    return { submitted: true, mode: 'envelope', approved, execution: body(execution), execution_status: execution.status };
  }
  const validation = await api.validate(intent);
  const approved = Boolean((body(validation) || {}).approved);
  if (!approved) {
    return { submitted: true, mode: 'per_trade', approved: false, validation: body(validation), validation_status: validation.status };
  }
  const execution = await api.execute(intent, validation);
  return {
    submitted: true,
    mode: 'per_trade',
    approved: execution.status < 400,
    validation: body(validation),
    validation_status: validation.status,
    execution: body(execution),
    execution_status: execution.status,
  };
}

// The deterministic-tick harness. `decide(ctx)` returns:
//   { decision: {action, reason, ...}, checkedState?, metrics?, entryExtra?, resultExtra? }
// and this guarantees the log/metrics side effects + final JSON contract.
async function runTick(family, decide) {
  const runStartedAt = nowIso();
  const decisionCountBefore = lineCount(DECISION_LOG);
  const metricsMtimeBefore = fileMtimeMs(METRICS_FILE);
  try {
    const api = require('/home/agent/tools/api-client');
    const config = api.loadConfig();
    const ctx = { api, config, family, runStartedAt, harness: loadHarness() };
    const out = (await decide(ctx)) || {};
    const decision = out.decision || { action: 'skip', reason: `${family}-no-decision` };

    const { provenanceHash } = require('/home/agent/tools/log-decision');
    const recipe_hash = provenanceHash({ family, harness: ctx.harness ?? {}, strategy_config: (config && config.strategy_config) ?? null });
    const input_hash = provenanceHash({ family, checked_state: out.checkedState ?? null, intent: decision.intent ?? null });
    const metrics = { ...(out.metrics || {}), recipe_hash, input_hash };
    logDecision({ ...decision, ...(out.entryExtra || {}), state: out.checkedState ?? null, run_started_at: runStartedAt, recipe_hash, input_hash });
    writeMetrics({ action: decision.action, reason: decision.reason, ...metrics });

    const runCompletedAt = nowIso();
    const reflectionLoop = require('/home/agent/tools/reflection-loop');
    const decisionContext = reflectionLoop.recordDecisionContext({
      family,
      run_started_at: runStartedAt,
      run_completed_at: runCompletedAt,
      config,
      harness: ctx.harness,
      checked_state: out.checkedState ?? null,
      decision,
      result: out.resultExtra || null,
      metrics,
      recipe_hash,
      input_hash,
    });
    const reflection = reflectionLoop.reflectOnDecisionContext(decisionContext);

    const result = {
      result_schema_version: 1,
      family,
      run_started_at: runStartedAt,
      run_completed_at: runCompletedAt,
      checked_state: out.checkedState ?? null,
      decision,
      ...(out.resultExtra || {}),
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
  } catch (error) {
    const result = {
      result_schema_version: 1,
      family,
      run_started_at: runStartedAt,
      run_completed_at: nowIso(),
      checked_state: null,
      decision: {
        action: 'error',
        reason: `${family}-tick-runtime-error`,
        error: error.message || String(error),
      },
      logs_written: false,
      metrics_written: false,
      decision_context_written: false,
      reflection_written: false,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(1);
  }
}

module.exports = {
  DECISION_LOG,
  METRICS_FILE,
  DEFAULT_TOKENS_BY_CHAIN,
  TOKEN_DECIMALS,
  nowIso,
  readJson,
  lineCount,
  fileMtimeMs,
  body,
  snapshot,
  asNumber,
  clamp,
  stableHash,
  isPaperShowcaseMode,
  normalizeCycleValues,
  cycleIndexForRun,
  paperCycleWeight,
  loadHarness,
  chainId,
  pairTokens,
  tokenDecimals,
  decimalToBaseUnits,
  baseUnitsToDecimal,
  priceMap,
  positionsOf,
  isVaultSpot,
  vaultSpotAmount,
  spotPriceFromPortfolio,
  resolveUsdPrice,
  ema,
  rsi,
  fetchCandles,
  assertNoLookahead,
  candleOpenMs,
  LookaheadViolationError,
  logDecision,
  writeMetrics,
  recommendSlippageBps,
  circuitBreakerTripped,
  buildSwapIntent,
  isEnvelopeMode,
  submitIntent,
  runTick,
};
