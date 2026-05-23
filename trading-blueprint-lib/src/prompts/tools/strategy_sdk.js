// Minimal strategy SDK for generated trading strategies.
//
// Strategy modules should export:
//   module.exports = { id: 'my-strategy', async tick(ctx) { ... } }
//
// Keep strategy code focused on signals. This SDK owns API wiring, validation,
// execution, risk prechecks, logs, and artifacts.

const fs = require('fs');
const path = require('path');
const api = require('./api-client');

const AGENT_ROOT = process.env.AGENT_HOME || process.env.AGENT_WORKSPACE || '/home/agent';
const LOG_FILE = path.join(AGENT_ROOT, 'logs', 'strategy-runs.jsonl');
const ARTIFACT_DIR = path.join(AGENT_ROOT, 'eval-artifacts', 'strategies');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, value) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function normalizeDecision(decision) {
  if (!decision) return { action: 'skip', reason: 'strategy returned no decision' };
  if (typeof decision === 'string') return { action: 'skip', reason: decision };
  return { ...decision };
}

function strategyMode(config = api.loadConfig()) {
  const configured = config.strategy_config || {};
  if (configured.paper_trade === true || config.paper_trade === true) return 'paper';
  if (configured.live_enabled === true || config.live_enabled === true) return 'live';
  return 'paper';
}

function defaultRisk() {
  return {
    maxDrawdownPct: 10,
    maxSlippageBps: 100,
  };
}

async function runPreflight(risk = {}) {
  const merged = { ...defaultRisk(), ...risk };
  const circuitBreaker = await api.checkCircuitBreaker(merged.maxDrawdownPct);
  if (circuitBreaker.status >= 400) {
    return {
      ok: false,
      reason: 'circuit breaker check failed',
      detail: circuitBreaker.data,
    };
  }
  if (circuitBreaker.data && circuitBreaker.data.should_break === true) {
    return {
      ok: false,
      reason: 'circuit breaker active',
      detail: circuitBreaker.data,
    };
  }
  return { ok: true, detail: circuitBreaker.data };
}

function makeContext(strategyId, options = {}) {
  const config = api.loadConfig();
  const mode = options.mode || strategyMode(config);
  const startedAt = nowIso();
  const risk = { ...defaultRisk(), ...(options.risk || {}) };

  async function submitTrade(intent, submitOptions = {}) {
    const normalized = api.normalizeIntent({
      ...intent,
      strategy_id: intent.strategy_id || intent.strategyId || strategyId,
    });
    const preflight = await runPreflight(submitOptions.risk || risk);
    if (!preflight.ok) {
      return logDecision({
        action: 'blocked',
        reason: preflight.reason,
        intent: normalized,
        detail: preflight.detail,
      });
    }

    const validation = await api.validate(normalized);
    const validationBody = validation.data || validation.body || validation;
    const approved = validation.status < 400 && validationBody && validationBody.approved !== false;
    if (!approved) {
      return logDecision({
        action: 'rejected',
        reason: 'validation rejected trade',
        intent: normalized,
        validation: validationBody,
      });
    }

    if (submitOptions.dryRun === true) {
      return logDecision({
        action: 'paper_validated',
        reason: 'trade validated but execution was explicitly disabled',
        intent: normalized,
        validation: validationBody,
        mode,
      });
    }

    if (mode !== 'live') {
      const execution = await api.execute(normalized, validationBody);
      return logDecision({
        action: execution.status < 400 ? 'paper_executed' : 'paper_execution_failed',
        reason: 'paper trade submitted to operator API for unified trade history',
        intent: normalized,
        validation: validationBody,
        execution: execution.data || execution.body || execution,
        mode,
      });
    }

    const execution = await api.execute(normalized, validationBody);
    return logDecision({
      action: execution.status < 400 ? 'executed' : 'execution_failed',
      intent: normalized,
      validation: validationBody,
      execution: execution.data || execution.body || execution,
      mode,
    });
  }

  function logDecision(entry) {
    const payload = {
      timestamp: nowIso(),
      strategy_id: strategyId,
      mode,
      ...entry,
    };
    appendJsonl(LOG_FILE, payload);
    return payload;
  }

  function writeArtifact(name, value) {
    const safeName = String(name || 'artifact')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'artifact';
    const filePath = path.join(ARTIFACT_DIR, `${strategyId}-${safeName}.json`);
    ensureDir(filePath);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    return filePath;
  }

  return {
    api,
    config,
    mode,
    strategyId,
    startedAt,
    risk,
    getPortfolio: api.getPortfolio,
    getPrices: api.getPrices,
    getSupportedAssets: api.getSupportedAssets,
    quoteUniswapSwap: api.quoteUniswapSwap,
    recommendSlippageBps: api.recommendSlippageBps,
    submitTrade,
    logDecision,
    writeArtifact,
    skip: (reason, extra = {}) => logDecision({ action: 'skip', reason, ...extra }),
  };
}

async function runStrategy(strategy, options = {}) {
  if (!strategy || typeof strategy.tick !== 'function') {
    throw new Error('strategy module must export async tick(ctx)');
  }
  const strategyId = String(strategy.id || options.strategyId || 'generated-strategy');
  const ctx = makeContext(strategyId, options);
  const startedAt = Date.now();
  let decision;
  try {
    decision = normalizeDecision(await strategy.tick(ctx));
  } catch (error) {
    const failure = ctx.logDecision({
      action: 'error',
      reason: error && error.message ? error.message : String(error),
    });
    return {
      ok: false,
      strategy_id: strategyId,
      mode: ctx.mode,
      duration_ms: Date.now() - startedAt,
      decision: failure,
    };
  }

  const result = decision.action
    ? ctx.logDecision(decision)
    : ctx.logDecision({ action: 'decision', decision });
  return {
    ok: result.action !== 'error',
    strategy_id: strategyId,
    mode: ctx.mode,
    duration_ms: Date.now() - startedAt,
    decision: result,
  };
}

module.exports = {
  makeContext,
  runStrategy,
};
