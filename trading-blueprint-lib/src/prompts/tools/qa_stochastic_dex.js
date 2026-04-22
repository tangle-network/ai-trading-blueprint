#!/usr/bin/env node
// QA stochastic DEX tool — samples no-trade / small-trade / big-trade outcomes
// and, when a trade is selected, runs the live validate -> execute pipeline.
// Usage: node qa-stochastic-dex.js

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_FILE = '/home/agent/config/api.json';
const LOG_FILE = '/home/agent/logs/decisions.jsonl';
const METRICS_FILE = '/home/agent/metrics/latest.json';

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
};
const DEFAULT_WETH = DEFAULT_TOKENS_BY_CHAIN[1].weth;
const DEFAULT_USDC = DEFAULT_TOKENS_BY_CHAIN[1].usdc;
const TOKEN_DECIMALS = {
  [DEFAULT_WETH.toLowerCase()]: 18,
  [DEFAULT_USDC.toLowerCase()]: 6,
  [DEFAULT_TOKENS_BY_CHAIN[8453].weth.toLowerCase()]: 18,
  [DEFAULT_TOKENS_BY_CHAIN[8453].usdc.toLowerCase()]: 6,
  [DEFAULT_TOKENS_BY_CHAIN[84532].weth.toLowerCase()]: 18,
  [DEFAULT_TOKENS_BY_CHAIN[84532].usdc.toLowerCase()]: 6,
  weth: 18,
  usdc: 6,
};
const MIN_BASE_UNITS = {
  buy: BigInt('5000000'),
  sell: BigInt('5000000000000000'),
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {
      bot_id: 'unknown-bot',
      api_url: process.env.TRADING_API_URL || 'http://localhost:9100',
      token: process.env.TRADING_API_TOKEN || '',
      strategy_config: {},
    };
  }
}

function apiCall(config, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.api_url);
    const proto = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: 'Bearer ' + config.token,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    };

    const req = proto.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('API timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function appendDecision(entry) {
  fs.mkdirSync('/home/agent/logs', { recursive: true });
  const payload = { timestamp: new Date().toISOString(), ...entry };
  fs.appendFileSync(LOG_FILE, JSON.stringify(payload) + '\n');
  return payload;
}

function writeMetrics(entry) {
  fs.mkdirSync('/home/agent/metrics', { recursive: true });
  fs.writeFileSync(
    METRICS_FILE,
    JSON.stringify({ timestamp: new Date().toISOString(), ...entry }, null, 2),
  );
}

function normalizeTradeEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.trades)) return payload.trades;
  return [];
}

function getSnapshotAccountValue(portfolio) {
  const rawValue = Number(portfolio?.total_value_usd || 0);
  if (!Number.isFinite(rawValue) || rawValue <= 0) return null;
  if (portfolio?.has_unpriced_positions === true) return null;
  return rawValue;
}

async function recordMetricsSnapshot(config, portfolio) {
  try {
    const tradesResult = await apiCall(config, 'GET', '/trades?limit=500');
    const trades = tradesResult.status < 400 ? normalizeTradeEntries(tradesResult.body) : [];
    const accountValueUsd = getSnapshotAccountValue(portfolio);
    if (accountValueUsd == null) {
      return;
    }
    const positionsCount = Array.isArray(portfolio?.positions) ? portfolio.positions.length : 0;
    await apiCall(config, 'POST', '/metrics/snapshot', {
      account_value_usd: String(accountValueUsd),
      unrealized_pnl: '0',
      realized_pnl: '0',
      high_water_mark: String(accountValueUsd),
      drawdown_pct: '0',
      positions_count: positionsCount,
      trade_count: trades.length,
    });
  } catch (error) {
    appendDecision({
      mode: 'qa_stochastic',
      action: 'warning',
      reason: 'Failed to record metrics snapshot',
      details: String(error && error.message ? error.message : error),
    });
  }
}

function parseNumeric(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeWeights(rawWeights) {
  const weights = {
    no_trade: parseNumeric(rawWeights?.no_trade, 0.4, 0, 1),
    small_trade: parseNumeric(rawWeights?.small_trade, 0.4, 0, 1),
    big_trade: parseNumeric(rawWeights?.big_trade, 0.2, 0, 1),
  };
  const total = weights.no_trade + weights.small_trade + weights.big_trade;
  if (total <= 0) return { no_trade: 0.4, small_trade: 0.4, big_trade: 0.2 };
  return {
    no_trade: weights.no_trade / total,
    small_trade: weights.small_trade / total,
    big_trade: weights.big_trade / total,
  };
}

function normalizeQaConfig(config) {
  const strategyConfig = config?.strategy_config || {};
  const chainId = Number(config?.chain_id || strategyConfig?.chain_id || 0);
  const chainDefaults = DEFAULT_TOKENS_BY_CHAIN[chainId] || DEFAULT_TOKENS_BY_CHAIN[1];
  const allowedDirections = Array.isArray(strategyConfig?.qa_allowed_directions)
    ? strategyConfig.qa_allowed_directions
        .map((value) => String(value).trim().toLowerCase())
        .filter((value) => value === 'buy' || value === 'sell')
    : ['buy', 'sell'];

  return {
    mode: strategyConfig?.qa_mode || 'off',
    weights: normalizeWeights(strategyConfig?.qa_trade_weights || {}),
    sizes: {
      smallPct: parseNumeric(strategyConfig?.qa_trade_sizes?.small_pct, 0.05, 0.001, 1),
      bigPct: parseNumeric(strategyConfig?.qa_trade_sizes?.big_pct, 0.25, 0.001, 1),
    },
    allowedDirections: allowedDirections.length > 0 ? allowedDirections : ['buy', 'sell'],
    pair: strategyConfig?.qa_pair || 'WETH/USDC',
    pairTokens: {
      weth:
        strategyConfig?.qa_pair_tokens?.weth ||
        strategyConfig?.qa_pair_tokens?.base ||
        chainDefaults.weth,
      usdc:
        strategyConfig?.qa_pair_tokens?.usdc ||
        strategyConfig?.qa_pair_tokens?.quote ||
        chainDefaults.usdc,
    },
  };
}

function sampleBucket(weights) {
  const roll = Math.random();
  if (roll < weights.no_trade) return 'no_trade';
  if (roll < weights.no_trade + weights.small_trade) return 'small_trade';
  return 'big_trade';
}

function sampleOne(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function decimalToBaseUnits(value, decimals) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return BigInt(0);
  const fixed = numeric.toFixed(decimals);
  const [whole, fraction = ''] = fixed.split('.');
  const normalized = whole + fraction.padEnd(decimals, '0').slice(0, decimals);
  const sanitized = normalized.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(sanitized);
}

function findPosition(portfolio, symbol, address) {
  const addressLower = address.toLowerCase();
  const symbolLower = symbol.toLowerCase();
  return (portfolio?.positions || []).find((position) => {
    const token = String(position.token || '').toLowerCase();
    const posSymbol = String(position.symbol || '').toLowerCase();
    return token === addressLower || token === symbolLower || posSymbol === symbolLower;
  });
}

function buildFeasibleDirections(portfolio, qaConfig) {
  const weth = findPosition(portfolio, 'WETH', qaConfig.pairTokens.weth);
  const usdc = findPosition(portfolio, 'USDC', qaConfig.pairTokens.usdc);
  const wethUnits = decimalToBaseUnits(weth?.amount || 0, TOKEN_DECIMALS.weth);
  const usdcUnits = decimalToBaseUnits(usdc?.amount || 0, TOKEN_DECIMALS.usdc);

  const feasible = [];
  if (qaConfig.allowedDirections.includes('buy') && usdcUnits >= MIN_BASE_UNITS.buy) {
    feasible.push({ direction: 'buy', availableUnits: usdcUnits });
  }
  if (qaConfig.allowedDirections.includes('sell') && wethUnits >= MIN_BASE_UNITS.sell) {
    feasible.push({ direction: 'sell', availableUnits: wethUnits });
  }
  return feasible;
}

function buildIntent(config, qaConfig, direction, sizeBucket, availableUnits) {
  const pct = sizeBucket === 'big_trade' ? qaConfig.sizes.bigPct : qaConfig.sizes.smallPct;
  const basisPoints = BigInt(Math.max(1, Math.round(pct * 10000)));
  const proposedUnits = (availableUnits * basisPoints) / BigInt(10000);
  const minimumUnits = direction === 'buy' ? MIN_BASE_UNITS.buy : MIN_BASE_UNITS.sell;
  const amountInUnits = proposedUnits > minimumUnits ? proposedUnits : minimumUnits;
  if (amountInUnits > availableUnits || amountInUnits <= BigInt(0)) return null;

  const tokenIn = direction === 'buy' ? qaConfig.pairTokens.usdc : qaConfig.pairTokens.weth;
  const tokenOut = direction === 'buy' ? qaConfig.pairTokens.weth : qaConfig.pairTokens.usdc;

  return {
    strategy_id: `qa-stochastic-${config.bot_id || 'bot'}`,
    action: 'swap',
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountInUnits.toString(),
    min_amount_out: '1',
    target_protocol: 'uniswap_v3',
    deadline_secs: 300,
  };
}

async function main() {
  const config = loadConfig();
  const qaConfig = normalizeQaConfig(config);

  if (qaConfig.mode !== 'stochastic') {
    const result = { status: 'disabled', reason: 'qa_mode is not stochastic' };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const portfolioResult = await apiCall(config, 'POST', '/portfolio/state', {});
  if (portfolioResult.status >= 400) {
    throw new Error(`portfolio fetch failed with status ${portfolioResult.status}`);
  }
  const portfolio = portfolioResult.body || {};
  const sampledBucket = sampleBucket(qaConfig.weights);

  if (sampledBucket === 'no_trade') {
    const decision = appendDecision({
      mode: 'qa_stochastic',
      action: 'skip',
      sampled_bucket: sampledBucket,
      reason: 'QA stochastic mode selected a no-trade iteration',
    });
    writeMetrics({
      mode: 'qa_stochastic',
      sampled_bucket: sampledBucket,
      portfolio_value_usd: Number(portfolio.total_value_usd || 0),
      trades_executed: 0,
    });
    await recordMetricsSnapshot(config, portfolio);
    console.log(JSON.stringify({ status: 'no_trade', decision }, null, 2));
    return;
  }

  const feasible = buildFeasibleDirections(portfolio, qaConfig);
  if (feasible.length === 0) {
    const decision = appendDecision({
      mode: 'qa_stochastic',
      action: 'skip',
      sampled_bucket: sampledBucket,
      reason: 'QA stochastic mode sampled a trade, but no feasible buy or sell inventory was available',
    });
    writeMetrics({
      mode: 'qa_stochastic',
      sampled_bucket: sampledBucket,
      portfolio_value_usd: Number(portfolio.total_value_usd || 0),
      trades_executed: 0,
      errors: ['no_feasible_inventory'],
    });
    await recordMetricsSnapshot(config, portfolio);
    console.log(JSON.stringify({ status: 'no_trade', decision }, null, 2));
    return;
  }

  const selected = sampleOne(feasible);
  const intent = buildIntent(
    config,
    qaConfig,
    selected.direction,
    sampledBucket,
    selected.availableUnits,
  );
  if (!intent) {
    const decision = appendDecision({
      mode: 'qa_stochastic',
      action: 'skip',
      sampled_bucket: sampledBucket,
      sampled_direction: selected.direction,
      reason: 'Sampled QA trade size was not feasible for current inventory',
    });
    writeMetrics({
      mode: 'qa_stochastic',
      sampled_bucket: sampledBucket,
      portfolio_value_usd: Number(portfolio.total_value_usd || 0),
      trades_executed: 0,
      errors: ['trade_size_infeasible'],
    });
    await recordMetricsSnapshot(config, portfolio);
    console.log(JSON.stringify({ status: 'no_trade', decision }, null, 2));
    return;
  }

  const cb = await apiCall(config, 'POST', '/circuit-breaker/check', {
    max_drawdown_pct: 10,
  });
  if (cb.status >= 400) {
    throw new Error(`circuit breaker check failed with status ${cb.status}`);
  }
  if (cb.body && cb.body.triggered) {
    const decision = appendDecision({
      mode: 'qa_stochastic',
      action: 'blocked',
      sampled_bucket: sampledBucket,
      sampled_direction: selected.direction,
      reason: 'Circuit breaker triggered during QA stochastic trade',
      details: cb.body,
    });
    writeMetrics({
      mode: 'qa_stochastic',
      sampled_bucket: sampledBucket,
      portfolio_value_usd: Number(portfolio.total_value_usd || 0),
      trades_executed: 0,
      errors: ['circuit_breaker'],
    });
    await recordMetricsSnapshot(config, portfolio);
    console.log(JSON.stringify({ status: 'blocked', decision }, null, 2));
    return;
  }

  const validation = await apiCall(config, 'POST', '/validate', intent);
  if (validation.status >= 400) {
    const decision = appendDecision({
      mode: 'qa_stochastic',
      action: 'rejected',
      sampled_bucket: sampledBucket,
      sampled_direction: selected.direction,
      intent,
      reason: 'Validation failed for QA stochastic trade',
      details: validation.body,
    });
    writeMetrics({
      mode: 'qa_stochastic',
      sampled_bucket: sampledBucket,
      portfolio_value_usd: Number(portfolio.total_value_usd || 0),
      trades_executed: 0,
      errors: ['validation_http_error'],
    });
    await recordMetricsSnapshot(config, portfolio);
    console.log(JSON.stringify({ status: 'rejected', decision }, null, 2));
    return;
  }
  if (!validation.body || validation.body.approved !== true) {
    const decision = appendDecision({
      mode: 'qa_stochastic',
      action: 'rejected',
      sampled_bucket: sampledBucket,
      sampled_direction: selected.direction,
      intent,
      reason: 'Validators did not approve the QA stochastic trade',
      details: validation.body,
    });
    writeMetrics({
      mode: 'qa_stochastic',
      sampled_bucket: sampledBucket,
      portfolio_value_usd: Number(portfolio.total_value_usd || 0),
      trades_executed: 0,
      errors: ['validation_rejected'],
    });
    await recordMetricsSnapshot(config, portfolio);
    console.log(JSON.stringify({ status: 'rejected', decision }, null, 2));
    return;
  }

  const execution = await apiCall(config, 'POST', '/execute', {
    intent,
    validation: validation.body,
  });
  if (execution.status >= 400) {
    const decision = appendDecision({
      mode: 'qa_stochastic',
      action: 'error',
      sampled_bucket: sampledBucket,
      sampled_direction: selected.direction,
      intent,
      reason: 'Execution failed after successful validation',
      details: execution.body,
    });
    writeMetrics({
      mode: 'qa_stochastic',
      sampled_bucket: sampledBucket,
      portfolio_value_usd: Number(portfolio.total_value_usd || 0),
      trades_executed: 0,
      errors: ['execute_http_error'],
    });
    await recordMetricsSnapshot(config, portfolio);
    console.log(JSON.stringify({ status: 'error', decision }, null, 2));
    return;
  }

  const refreshedPortfolio = await apiCall(config, 'POST', '/portfolio/state', {});
  const nextPortfolio = refreshedPortfolio.status < 400 ? refreshedPortfolio.body : portfolio;
  const decision = appendDecision({
    mode: 'qa_stochastic',
    action: 'traded',
    sampled_bucket: sampledBucket,
    sampled_direction: selected.direction,
    size_bucket: sampledBucket === 'big_trade' ? 'big' : 'small',
    intent,
    tx_hash: execution.body?.tx_hash || null,
    validator_score: validation.body?.aggregate_score || null,
    reason: `QA stochastic mode executed a ${sampledBucket === 'big_trade' ? 'big' : 'small'} ${selected.direction} trade`,
  });
  writeMetrics({
    mode: 'qa_stochastic',
    sampled_bucket: sampledBucket,
    sampled_direction: selected.direction,
    portfolio_value_usd: Number(nextPortfolio?.total_value_usd || 0),
    trades_executed: 1,
  });
  await recordMetricsSnapshot(config, nextPortfolio);

  console.log(
    JSON.stringify(
      {
        status: 'traded',
        decision,
        validation: {
          approved: validation.body?.approved,
          aggregate_score: validation.body?.aggregate_score,
          validator_count: Array.isArray(validation.body?.validator_responses)
            ? validation.body.validator_responses.length
            : 0,
        },
        execution: execution.body,
        portfolio: nextPortfolio,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  try {
    appendDecision({
      mode: 'qa_stochastic',
      action: 'error',
      reason: error.message,
    });
    writeMetrics({
      mode: 'qa_stochastic',
      trades_executed: 0,
      errors: [error.message],
    });
  } catch {}

  console.error(JSON.stringify({ status: 'error', error: error.message }, null, 2));
  process.exit(1);
});
