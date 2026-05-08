// Trading API client module — shared by all tools
// Reads config from /home/agent/config/api.json (written during activation)
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

let _config = null;

const TOKEN_DEFAULTS_BY_CHAIN = {
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
};

function loadConfig() {
  if (_config) return _config;
  try {
    _config = JSON.parse(fs.readFileSync('/home/agent/config/api.json', 'utf8'));
  } catch {
    _config = {
      api_url: process.env.TRADING_API_URL || 'http://localhost:9100',
      token: process.env.TRADING_API_TOKEN || '',
    };
  }
  return _config;
}

function tokenDefaults(config = loadConfig()) {
  const supported = supportedAssetDefaults(config);
  if (Object.keys(supported).length > 0) return supported;

  const chainId = Number(
    (config.strategy_config && config.strategy_config.protocol_chain_id)
      || config.protocol_chain_id
      || process.env.PROTOCOL_CHAIN_ID
      || process.env.FORK_BASE_CHAIN_ID
      || config.chain_id
      || 0,
  );
  return TOKEN_DEFAULTS_BY_CHAIN[chainId] || {};
}

function supportedAssetDefaults(config = loadConfig()) {
  const universeAssets =
    config.strategy_config
    && config.strategy_config.asset_universe
    && Array.isArray(config.strategy_config.asset_universe.allowed_assets)
      ? config.strategy_config.asset_universe.allowed_assets
      : null;
  const assets =
    universeAssets
    || (config.strategy_config && Array.isArray(config.strategy_config.supported_assets)
      && config.strategy_config.supported_assets)
    || [];
  return assets.reduce((acc, asset) => {
    if (!asset || !asset.symbol || !asset.address) return acc;
    acc[String(asset.symbol).toLowerCase()] = asset.address;
    return acc;
  }, {});
}

function resolveTokenAddress(token) {
  if (!token || typeof token !== 'string') return token;
  const trimmed = token.trim();
  if (trimmed.startsWith('0x')) return trimmed;

  const defaults = tokenDefaults();
  const key = trimmed.toLowerCase();
  if (defaults[key]) return defaults[key];
  if (key === 'eth' || key === 'weth') return defaults.weth || trimmed;
  if (key === 'usdc') return defaults.usdc || trimmed;
  return trimmed;
}

function knownTokenSymbol(token) {
  if (!token || typeof token !== 'string') return null;
  const normalized = token.trim().toLowerCase();
  const defaults = tokenDefaults();
  for (const [symbol, address] of Object.entries(defaults)) {
    if (normalized === symbol || normalized === String(address).toLowerCase()) {
      return symbol.toUpperCase();
    }
  }
  if (defaults.weth && normalized === defaults.weth.toLowerCase()) return 'WETH';
  if (defaults.usdc && normalized === defaults.usdc.toLowerCase()) return 'USDC';
  if (normalized === 'weth' || normalized === 'eth') return 'WETH';
  if (normalized === 'usdc') return 'USDC';
  return null;
}

function defaultStrategyId(config = loadConfig()) {
  const strategyType = config.strategy_config && config.strategy_config.strategy_type;
  const prefix = strategyType || 'trading';
  return `${prefix}-${config.bot_id || 'bot'}`;
}

function normalizeIntent(intent = {}) {
  const config = loadConfig();
  const action = intent.action || intent.intent || intent.intent_type || intent.intentType || 'swap';
  const amountIn = intent.amount_in || intent.amountIn || intent.amount || '0';
  const minAmountOut =
    intent.min_amount_out || intent.minAmountOut || intent.min_amount || intent.minAmount || '0';
  return {
    ...intent,
    strategy_id: intent.strategy_id || defaultStrategyId(config),
    action,
    token_in: resolveTokenAddress(intent.token_in || intent.tokenIn),
    token_out: resolveTokenAddress(intent.token_out || intent.tokenOut),
    amount_in: String(amountIn),
    min_amount_out: String(minAmountOut),
    amount_format: intent.amount_format || intent.amountFormat,
    target_protocol:
      intent.target_protocol || intent.targetProtocol || intent.protocol || 'uniswap_v3',
    deadline_secs: intent.deadline_secs || intent.deadlineSecs || 300,
  };
}

function unwrapValidation(validation) {
  if (!validation) return validation;
  if (validation.approved !== undefined) return validation;
  if (validation.data && validation.data.approved !== undefined) return validation.data;
  if (validation.body && validation.body.approved !== undefined) return validation.body;
  return validation;
}

function apiCall(method, path, body) {
  const config = loadConfig();
  const url = new URL(path, config.api_url);
  const proto = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Bearer ' + config.token,
        'Content-Type': 'application/json',
      },
    };
    const req = proto.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function validate(intent) {
  return apiCall('POST', '/validate', normalizeIntent(intent));
}

async function execute(intent, validation) {
  return apiCall('POST', '/execute', {
    intent: normalizeIntent(intent),
    validation: unwrapValidation(validation),
  });
}

// Envelope-mode execute: server uses the on-file SignedEnvelope to authorize.
// Do NOT call api.validate(intent) when running in envelope mode.
async function executeWithEnvelope(intent) {
  return apiCall('POST', '/execute', {
    intent: normalizeIntent(intent),
  });
}

// Envelope endpoints — only meaningful for envelope-mode bots.
async function getEnvelope() {
  return apiCall('GET', '/envelope');
}

// Returns:
// {
//   is_active, consumed_amount, max_total_amount, consumed_pct,
//   expires_at, expires_in_seconds, signature_count, min_signatures
// }
async function envelopeStatus() {
  return apiCall('GET', '/envelope/status');
}

// Operator-side log + webhook trigger that asks the depositor for a fresh envelope.
// The agent does NOT mint a new envelope — it just signals "I need one".
async function requestEnvelopeRenewal(reason) {
  return apiCall('POST', '/envelope/renewal-request', {
    reason: reason || 'envelope-renewal-needed',
  });
}

async function checkCircuitBreaker(maxDrawdownPct) {
  return apiCall('POST', '/circuit-breaker/check', {
    max_drawdown_pct: maxDrawdownPct || 10.0,
  });
}

async function getPortfolio() {
  return apiCall('POST', '/portfolio/state', {});
}

async function getPrices(tokens) {
  return apiCall('POST', '/market-data/prices', { tokens });
}

async function quoteUniswapSwap({ token_in, tokenIn, token_out, tokenOut, amount_in, amountIn, fee_tier, feeTier, chain_id, chainId, slippage_bps, slippageBps }) {
  const body = {
    token_in: resolveTokenAddress(token_in || tokenIn),
    token_out: resolveTokenAddress(token_out || tokenOut),
    amount_in: String(amount_in || amountIn || '0'),
    fee_tier: fee_tier || feeTier || 3000,
    chain_id: chain_id || chainId,
  };
  const slip = slippage_bps !== undefined ? slippage_bps : slippageBps;
  if (slip !== undefined && slip !== null) {
    body.slippage_bps = Number(slip);
  }
  return apiCall('POST', '/envelope/quote/uniswap_v3', body);
}

// ── Learning loop endpoints ──────────────────────────────────────────────────
//
// The slippage learner (EWMA) tracks observed slippage per (token_in, token_out)
// pair. It ratchets the recommended `max_slippage_bps` tighter when fills are
// clean and looser after failures — trust its recommendation over a static
// value when constructing `min_amount_out`.
//
// The strategy bandit (UCB1) tracks reward per `variant_id`. Record outcomes
// after every iteration (positive reward = profit, negative = loss).

// GET /learning/slippage?token_in=&token_out=&fallback=
// Returns { recommended_max_bps, observation_count, failure_count, ... }.
async function recommendSlippageBps({
  token_in,
  tokenIn,
  token_out,
  tokenOut,
  fallback_bps,
  fallbackBps,
}) {
  const fallback = fallback_bps !== undefined ? fallback_bps : fallbackBps;
  const params = new URLSearchParams({
    token_in: resolveTokenAddress(token_in || tokenIn),
    token_out: resolveTokenAddress(token_out || tokenOut),
  });
  if (fallback !== undefined && fallback !== null) {
    params.set('fallback', String(fallback));
  }
  return apiCall('GET', `/learning/slippage?${params.toString()}`);
}

// POST /learning/strategy-outcome  { variant_id, reward, iteration_id? }
// `variant_id` matches the strategy's `id` field on `StrategyDefinition`.
// `reward` is realized P&L over the iteration window in USD (positive = profit).
// `iteration_id` (optional) is the agent's per-phase counter from `phase.json`;
// when present, the route deduplicates by (bot_id, variant_id, iteration_id)
// so a retried POST after a network glitch doesn't double-count the arm pull.
async function recordStrategyOutcome({
  variant_id,
  variantId,
  reward,
  iteration_id,
  iterationId,
}) {
  const body = {
    variant_id: variant_id || variantId,
    reward: Number(reward),
  };
  const itId = iteration_id || iterationId;
  if (itId !== undefined && itId !== null && String(itId).length > 0) {
    body.iteration_id = String(itId);
  }
  return apiCall('POST', '/learning/strategy-outcome', body);
}

// GET /learning/bandit-status — arms + best-arm summary. Informational.
async function getBanditStatus() {
  return apiCall('GET', '/learning/bandit-status');
}

async function getAdapters() {
  return apiCall('GET', '/adapters');
}

async function getSupportedAssets() {
  return apiCall('GET', '/supported-assets');
}

async function getMetrics() {
  return apiCall('GET', '/metrics');
}

module.exports = {
  loadConfig,
  apiCall,
  supportedAssetDefaults,
  resolveTokenAddress,
  knownTokenSymbol,
  normalizeIntent,
  validate,
  execute,
  executeWithEnvelope,
  getEnvelope,
  envelopeStatus,
  requestEnvelopeRenewal,
  checkCircuitBreaker,
  getPortfolio,
  getPrices,
  quoteUniswapSwap,
  recommendSlippageBps,
  recordStrategyOutcome,
  getBanditStatus,
  getAdapters,
  getSupportedAssets,
  getMetrics,
};
