#!/usr/bin/env node
// Runtime reflection loop for deterministic trading ticks.
//
// This file runs inside the sandbox as /home/agent/tools/reflection-loop.js.
// It makes every fast tick leave inspectable evidence of what the agent saw,
// why it acted or skipped, what it learned from recent outcomes, and which
// paper-only self-improvement task should run next.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AGENT_ROOT = process.env.AGENT_ROOT || '/home/agent';
const MEMORY_DIR = process.env.AGENT_MEMORY_DIR || path.join(AGENT_ROOT, 'memory');
const DECISION_CONTEXTS_FILE = process.env.AGENT_DECISION_CONTEXTS_FILE || path.join(MEMORY_DIR, 'decision-contexts.jsonl');
const REFLECTIONS_FILE = process.env.AGENT_REFLECTIONS_FILE || path.join(MEMORY_DIR, 'reflections.jsonl');
const IMPROVEMENT_INTENTS_FILE = process.env.AGENT_IMPROVEMENT_INTENTS_FILE || path.join(MEMORY_DIR, 'improvement-intents.jsonl');
const IMPROVEMENT_DISPATCHES_FILE = process.env.AGENT_IMPROVEMENT_DISPATCHES_FILE || path.join(MEMORY_DIR, 'improvement-dispatches.jsonl');
const DECISION_LOG = process.env.AGENT_DECISION_LOG || path.join(AGENT_ROOT, 'logs', 'decisions.jsonl');

const INTENT_COOLDOWN_MS = Number(process.env.AGENT_IMPROVEMENT_INTENT_COOLDOWN_MS || 60 * 60 * 1000);
const DISPATCH_COOLDOWN_MS = Number(process.env.AGENT_IMPROVEMENT_DISPATCH_COOLDOWN_MS || 2 * 60 * 60 * 1000);

function nowIso() {
  return new Date().toISOString();
}

function ensureParentDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function appendJsonl(file, entry) {
  ensureParentDir(file);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file, max = 50) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(Math.max(0, lines.length - max)).map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
      } catch {
        return { parse_error: line.slice(0, 200) };
      }
    });
  } catch {
    return [];
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item === undefined ? null : item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value ?? {})).digest('hex');
}

function primitive(value) {
  if (value === null || value === undefined) return null;
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') {
    for (const key of ['value', 'usd', 'amount', 'mid', 'mark', 'price', 'price_usd', 'nav_usd']) {
      if (value[key] !== undefined) return asNumber(value[key], fallback);
    }
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function lowerText(value) {
  return String(value || '').toLowerCase();
}

function compactObject(value, maxDepth = 4, maxKeys = 32, maxString = 500) {
  if (maxDepth <= 0) return summarizeValue(value);
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}...` : value;
  if (['number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactObject(item, maxDepth - 1, maxKeys, maxString));
  if (!isRecord(value)) return String(value);
  const out = {};
  for (const key of Object.keys(value).slice(0, maxKeys)) {
    if (/token|secret|private|authorization|api_key|apikey|password/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = compactObject(value[key], maxDepth - 1, maxKeys, maxString);
    }
  }
  const keys = Object.keys(value);
  if (keys.length > maxKeys) out._truncated_keys = keys.length - maxKeys;
  return out;
}

function summarizeValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  if (['number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (isRecord(value)) return { type: 'object', keys: Object.keys(value).slice(0, 12) };
  return String(value);
}

function pickFirst(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function extractConfig(input) {
  return isRecord(input.config) ? input.config : {};
}

function strategyConfig(config) {
  return isRecord(config.strategy_config) ? config.strategy_config : {};
}

function arrayStrings(value) {
  return asArray(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function extractMandate(config, family) {
  const strategy = strategyConfig(config);
  const userPrompt = pickFirst(strategy.user_prompt, config.user_prompt, config.prompt, strategy.prompt, null);
  const availableProtocols = arrayStrings(pickFirst(strategy.available_protocols, config.available_protocols, []));
  const symbols = arrayStrings(pickFirst(strategy.symbols, strategy.assets, strategy.tokens, strategy.markets, []));
  const strategyType = String(pickFirst(config.strategy_type, strategy.strategy_type, family, 'unknown'));
  return {
    bot_id: primitive(config.bot_id) ?? primitive(strategy.bot_id) ?? null,
    bot_name: primitive(config.bot_name) ?? primitive(strategy.bot_name) ?? null,
    strategy_type: strategyType,
    family: String(family || strategyType || 'unknown'),
    paper_trade: typeof strategy.paper_trade === 'boolean' ? strategy.paper_trade : typeof config.paper_trade === 'boolean' ? config.paper_trade : null,
    user_prompt: typeof userPrompt === 'string' ? userPrompt : null,
    available_protocols: availableProtocols,
    symbols,
    max_drawdown_pct: primitive(pickFirst(strategy.max_drawdown_pct, config.max_drawdown_pct, null)),
    risk_profile: primitive(pickFirst(strategy.risk_profile, config.risk_profile, null)),
  };
}

function summarizeHarness(harness) {
  if (!isRecord(harness)) return null;
  return compactObject({
    strategy_id: harness.strategy_id,
    version: harness.version,
    recipe_hash: harness.recipe_hash,
    aggressive_paper_mode: harness.aggressive_paper_mode,
    features: harness.features,
    risk: harness.risk,
    venues: harness.venues,
    params: harness.params,
  }, 3, 24, 300);
}

function decisionAction(entry) {
  if (!isRecord(entry)) return null;
  if (typeof entry.action === 'string') return entry.action;
  if (isRecord(entry.decision) && typeof entry.decision.action === 'string') return entry.decision.action;
  return null;
}

function decisionReason(entry) {
  if (!isRecord(entry)) return null;
  if (typeof entry.reason === 'string') return entry.reason;
  if (isRecord(entry.decision) && typeof entry.decision.reason === 'string') return entry.decision.reason;
  return null;
}

function summarizeDecision(entry) {
  if (!isRecord(entry)) return { value: summarizeValue(entry) };
  const tradeAction = isRecord(entry.trade_action) ? entry.trade_action : isRecord(entry.tradeAction) ? entry.tradeAction : {};
  return {
    timestamp: primitive(entry.timestamp) ?? primitive(entry.run_started_at) ?? null,
    action: decisionAction(entry),
    reason: decisionReason(entry),
    market: primitive(entry.market) ?? primitive(entry.symbol) ?? primitive(entry.asset) ?? primitive(entry.token) ?? null,
    trade_attempted: tradeAction.attempted === true,
    trade_approved: tradeAction.approved === true || asNumber(tradeAction.execution_status, 999) < 400,
    validation_status: primitive(tradeAction.validation_status) ?? null,
    execution_status: primitive(tradeAction.execution_status) ?? null,
    recipe_hash: primitive(entry.recipe_hash) ?? null,
    input_hash: primitive(entry.input_hash) ?? null,
  };
}

function summarizeReflection(entry) {
  if (!isRecord(entry)) return { value: summarizeValue(entry) };
  return {
    timestamp: primitive(entry.timestamp),
    reflection_id: primitive(entry.reflection_id),
    decision_context_id: primitive(entry.decision_context_id),
    verdict: primitive(entry.verdict),
    summary: primitive(entry.summary),
    finding_codes: asArray(entry.findings).map((finding) => isRecord(finding) ? finding.code : null).filter(Boolean).slice(0, 8),
    emitted_improvement_intent_id: primitive(entry.emitted_improvement_intent_id),
  };
}

function objectHasKeyLike(value, pattern, depth = 4) {
  if (depth < 0 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => objectHasKeyLike(item, pattern, depth - 1));
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (pattern.test(key)) return true;
    if (objectHasKeyLike(nested, pattern, depth - 1)) return true;
  }
  return false;
}

function objectText(value, depth = 4) {
  if (depth < 0 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (['number', 'boolean'].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => objectText(item, depth - 1)).join(' ');
  if (!isRecord(value)) return '';
  return Object.entries(value)
    .slice(0, 80)
    .map(([key, nested]) => `${key} ${objectText(nested, depth - 1)}`)
    .join(' ');
}

function classifyMandateAlignment(mandate, state, decision) {
  const prompt = lowerText(mandate.user_prompt);
  const family = lowerText(mandate.family);
  const protocols = mandate.available_protocols.map((item) => lowerText(item));
  const stateText = lowerText(objectText(state, 3));
  const decisionText = lowerText(objectText(decision, 3));
  const observedText = `${stateText} ${decisionText} ${protocols.join(' ')} ${family}`;
  const findings = [];

  const wantsHyperliquid = prompt.includes('hyperliquid') && !/(do not|don't|dont|no|without|not)\s+(use\s+|trade\s+|execute\s+|route\s+through\s+)?hyperliquid/.test(prompt);
  if (wantsHyperliquid && !observedText.includes('hyperliquid')) {
    findings.push({ code: 'mandate-hyperliquid-not-observed', severity: 'high', detail: 'Prompt asks for Hyperliquid but tick evidence does not show Hyperliquid venue/config.' });
  }

  if (prompt.includes('vertex') && !protocols.includes('vertex') && !observedText.includes('vertex')) {
    findings.push({ code: 'mandate-vertex-not-configured', severity: 'medium', detail: 'Prompt mentions Vertex but available protocols and tick evidence do not show Vertex.' });
  }

  if ((prompt.includes('polymarket') || prompt.includes('prediction market')) && !observedText.includes('polymarket') && !observedText.includes('prediction')) {
    findings.push({ code: 'mandate-prediction-market-not-observed', severity: 'high', detail: 'Prompt asks for prediction markets but tick evidence does not show prediction-market state.' });
  }

  if ((prompt.includes('diversified') || prompt.includes('cross-strategy') || prompt.includes('60% dex')) && !family.includes('multi')) {
    findings.push({ code: 'mandate-cross-strategy-family-mismatch', severity: 'high', detail: 'Prompt asks for a cross-strategy allocation but runtime family is not multi-strategy.' });
  }

  if (prompt.includes('eth') && prompt.includes('perp') && !observedText.includes('eth')) {
    findings.push({ code: 'mandate-eth-perp-not-observed', severity: 'medium', detail: 'Prompt asks for ETH perps but tick evidence does not show ETH market state.' });
  }

  return {
    status: findings.some((finding) => finding.severity === 'high') ? 'mismatch' : findings.length > 0 ? 'partial' : 'aligned',
    findings,
  };
}

function evidenceQuality({ state, metrics, decision, priorDecisions, mandate }) {
  const text = `${objectText(state, 4)} ${objectText(metrics, 3)} ${objectText(decision, 3)}`;
  const lower = lowerText(text);
  const signalsGenerated = asNumber(isRecord(metrics) ? metrics.signals_generated : null, null);
  const observedPortfolio = objectHasKeyLike(state, /portfolio|position|nav|equity|balance|margin|idle|value/i)
    || objectHasKeyLike(metrics, /portfolio|position|nav|equity|balance|margin|idle|value/i);
  const observedMarket = objectHasKeyLike(state, /price|funding|rsi|ema|candle|volatility|spread|liquidity|market|reserve|apy|yield/i)
    || objectHasKeyLike(metrics, /price|funding|rsi|ema|candle|volatility|spread|liquidity|market|reserve|apy|yield/i);
  const observedNews = /news|headline|sentiment|event|catalyst/i.test(lower);
  const observedExternalSignals = observedNews || (signalsGenerated ?? 0) > 0;
  const tradeAction = isRecord(decision && decision.trade_action) ? decision.trade_action : {};
  const observedExecution = decisionAction(decision) === 'trade'
    || tradeAction.attempted === true
    || objectHasKeyLike(decision, /validation|execution|submitted|approved|intent/i);
  const mandateAlignment = classifyMandateAlignment(mandate, state, decision);

  return {
    observed_portfolio: observedPortfolio,
    observed_market: observedMarket,
    observed_prior_actions: priorDecisions.length > 1,
    observed_news: observedNews,
    observed_external_signals: observedExternalSignals,
    observed_trade_execution: observedExecution,
    signals_generated: signalsGenerated,
    mandate_alignment: mandateAlignment.status,
    mandate_findings: mandateAlignment.findings,
  };
}

function recordDecisionContext(input) {
  const config = extractConfig(input);
  const family = String(input.family || config.strategy_type || strategyConfig(config).strategy_type || 'unknown');
  const mandate = extractMandate(config, family);
  const priorDecisions = readJsonl(DECISION_LOG, 12).map(summarizeDecision);
  const priorReflections = readJsonl(REFLECTIONS_FILE, 6).map(summarizeReflection);
  const checkedState = input.checked_state ?? input.checkedState ?? null;
  const metrics = input.metrics ?? null;
  const decision = input.decision ?? { action: 'skip', reason: `${family}-no-decision` };
  const runCompletedAt = input.run_completed_at || input.runCompletedAt || nowIso();
  const runStartedAt = input.run_started_at || input.runStartedAt || runCompletedAt;
  const provenance = {
    recipe_hash: typeof input.recipe_hash === 'string' ? input.recipe_hash : null,
    input_hash: typeof input.input_hash === 'string' ? input.input_hash : null,
  };
  const evidence = evidenceQuality({ state: checkedState, metrics, decision, priorDecisions, mandate });
  const baseId = {
    run_started_at: runStartedAt,
    family,
    bot_id: mandate.bot_id,
    decision,
    provenance,
  };
  const contextId = `ctx_${hash(baseId).slice(0, 18)}`;
  const context = {
    schema_version: 1,
    context_id: contextId,
    timestamp: nowIso(),
    run_started_at: runStartedAt,
    run_completed_at: runCompletedAt,
    mode: 'deterministic-fast-tick',
    family,
    bot: {
      id: mandate.bot_id,
      name: mandate.bot_name,
      strategy_type: mandate.strategy_type,
      paper_trade: mandate.paper_trade,
    },
    mandate,
    harness: summarizeHarness(input.harness),
    checked_state: compactObject(checkedState, 5, 48, 700),
    decision: compactObject(decision, 5, 48, 700),
    result: compactObject(input.result ?? input.resultExtra ?? null, 4, 32, 500),
    metrics: compactObject(metrics, 4, 48, 500),
    prior: {
      recent_decisions: priorDecisions.slice(-8),
      recent_reflections: priorReflections.slice(-4),
    },
    evidence,
    provenance,
  };
  return appendJsonl(DECISION_CONTEXTS_FILE, context);
}

function recentContexts(max = 12) {
  return readJsonl(DECISION_CONTEXTS_FILE, max);
}

function findRepeatedSkip(contexts) {
  const last = contexts.slice(-5);
  if (last.length < 3) return null;
  const skips = last.filter((ctx) => decisionAction(ctx.decision) === 'skip');
  if (skips.length < 3) return null;
  const reasons = [...new Set(skips.map((ctx) => decisionReason(ctx.decision)).filter(Boolean))].slice(0, 4);
  return {
    code: 'repeated-skip',
    severity: reasons.some((reason) => /config|incomplete|validation|margin|coverage|insufficient/i.test(reason)) ? 'high' : 'medium',
    detail: `Recent ticks repeatedly skipped${reasons.length ? ` (${reasons.join(', ')})` : ''}.`,
  };
}

function findRepeatedSkipFromDecisions(decisions) {
  const last = asArray(decisions).slice(-5);
  if (last.length < 3) return null;
  const skips = last.filter((decision) => decisionAction(decision) === 'skip');
  if (skips.length < 3) return null;
  const reasons = [...new Set(skips.map((decision) => decisionReason(decision)).filter(Boolean))].slice(0, 4);
  return {
    code: 'repeated-skip',
    severity: reasons.some((reason) => /config|incomplete|validation|margin|coverage|insufficient/i.test(reason)) ? 'high' : 'medium',
    detail: `Recent decision log repeatedly skipped${reasons.length ? ` (${reasons.join(', ')})` : ''}.`,
  };
}

function metricNumber(context, keys) {
  const metrics = isRecord(context.metrics) ? context.metrics : {};
  const state = isRecord(context.checked_state) ? context.checked_state : {};
  for (const key of keys) {
    const value = asNumber(metrics[key], null);
    if (value !== null) return value;
    const stateValue = asNumber(state[key], null);
    if (stateValue !== null) return stateValue;
  }
  return null;
}

function wantsExternalSignals(mandate) {
  const prompt = lowerText(mandate.user_prompt);
  return /news|headline|sentiment|event|catalyst|prediction|polymarket|volatility|macro|election|politic/.test(prompt);
}

function buildReflectionFindings(context, contexts) {
  const findings = [];
  const evidence = isRecord(context.evidence) ? context.evidence : {};
  const mandateFindings = asArray(evidence.mandate_findings);
  findings.push(...mandateFindings);

  if (!evidence.observed_portfolio) {
    findings.push({ code: 'missing-portfolio-observation', severity: 'high', detail: 'Tick did not capture portfolio, NAV, balance, margin, or position evidence before acting.' });
  }
  if (!evidence.observed_market) {
    findings.push({ code: 'missing-market-observation', severity: 'high', detail: 'Tick did not capture market, price, funding, candle, liquidity, or yield evidence before acting.' });
  }
  if (!evidence.observed_prior_actions) {
    findings.push({ code: 'missing-prior-action-observation', severity: 'medium', detail: 'Tick context does not show enough prior decision/outcome history for adaptive behavior.' });
  }
  if (wantsExternalSignals(context.mandate || {}) && !evidence.observed_external_signals) {
    findings.push({ code: 'missing-external-signal-observation', severity: 'high', detail: 'Mandate needs external/news/event/sentiment context but no signal evidence was observed.' });
  }
  if ((evidence.signals_generated ?? null) === 0 && wantsExternalSignals(context.mandate || {})) {
    findings.push({ code: 'signals-generated-zero', severity: 'high', detail: 'Strategy requires external signals but metrics report signals_generated=0.' });
  }

  const repeatedSkip = findRepeatedSkip(contexts)
    || findRepeatedSkipFromDecisions(context.prior && context.prior.recent_decisions);
  if (repeatedSkip) findings.push(repeatedSkip);

  const reason = lowerText(decisionReason(context.decision));
  if (/validation-rejected|approval-not-verified|insufficient|incomplete|coverage|no-clear/.test(reason)) {
    findings.push({ code: 'blocked-action-path', severity: 'high', detail: `Current decision is blocked by ${decisionReason(context.decision) || 'unknown reason'}.` });
  }

  const drawdown = metricNumber(context, ['drawdown_pct', 'max_drawdown_pct', 'current_drawdown_pct']);
  const pnlPct = metricNumber(context, ['pnl_pct', 'return_pct', 'unrealized_pnl_pct']);
  const pnlUsd = metricNumber(context, ['pnl_usd', 'unrealized_pnl', 'realized_pnl']);
  if ((drawdown !== null && drawdown > 2) || (pnlPct !== null && pnlPct < -1) || (pnlUsd !== null && pnlUsd < -25)) {
    findings.push({
      code: 'negative-performance-needs-review',
      severity: drawdown !== null && drawdown > 5 ? 'critical' : 'high',
      detail: `Performance/risk metric crossed review threshold (drawdown=${drawdown ?? 'n/a'}, pnl_pct=${pnlPct ?? 'n/a'}, pnl_usd=${pnlUsd ?? 'n/a'}).`,
    });
  }

  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreReflection(context, findings) {
  const evidence = isRecord(context.evidence) ? context.evidence : {};
  const score = {
    observation_quality: 0,
    mandate_alignment: evidence.mandate_alignment === 'aligned' ? 1 : evidence.mandate_alignment === 'partial' ? 0.5 : 0,
    action_validity: decisionAction(context.decision) === 'error' ? 0 : 1,
    improvement_need: 0,
  };
  score.observation_quality += evidence.observed_portfolio ? 0.25 : 0;
  score.observation_quality += evidence.observed_market ? 0.25 : 0;
  score.observation_quality += evidence.observed_prior_actions ? 0.25 : 0;
  score.observation_quality += evidence.observed_external_signals || !wantsExternalSignals(context.mandate || {}) ? 0.25 : 0;
  const severityWeight = { low: 0.15, medium: 0.35, high: 0.75, critical: 1 };
  score.improvement_need = Math.min(1, findings.reduce((sum, finding) => sum + (severityWeight[finding.severity] ?? 0.25), 0) / 2);
  return score;
}

function intentCooldownKey(findings) {
  const codes = findings
    .filter((finding) => ['critical', 'high'].includes(finding.severity))
    .map((finding) => finding.code)
    .sort()
    .slice(0, 5);
  return codes.length ? codes.join('+') : null;
}

function parseMs(timestamp) {
  const ms = Date.parse(timestamp || '');
  return Number.isFinite(ms) ? ms : 0;
}

function shouldEmitIntent(cooldownKey) {
  if (!cooldownKey) return false;
  const now = Date.now();
  return !readJsonl(IMPROVEMENT_INTENTS_FILE, 50).some((intent) =>
    intent.cooldown_key === cooldownKey && now - parseMs(intent.timestamp) < INTENT_COOLDOWN_MS
  );
}

function buildImprovementIntent(context, reflection, findings) {
  const highFindings = findings.filter((finding) => ['critical', 'high'].includes(finding.severity));
  const cooldownKey = intentCooldownKey(findings);
  if (!highFindings.length || !shouldEmitIntent(cooldownKey)) return null;
  const mandate = context.mandate || {};
  const findingText = highFindings.map((finding) => `${finding.code}: ${finding.detail}`).join(' ');
  const botLabel = mandate.bot_id || context.family || 'trading bot';
  const prompt = [
    `Improve paper-only trading behavior for ${botLabel}.`,
    `Use the latest DecisionContext ${context.context_id} and ReflectionRecord ${reflection.reflection_id}.`,
    `Findings: ${findingText}`,
    'Produce a candidate harness/strategy change only if it is justified by market/portfolio/prior-outcome evidence.',
    'Run backtest or paper replay evidence, record lineage, and leave live promotion blocked for the conductor.',
  ].join(' ');
  const intent = {
    schema_version: 1,
    intent_id: `intent_${hash({ context_id: context.context_id, findings: highFindings, timestamp: reflection.timestamp }).slice(0, 18)}`,
    timestamp: nowIso(),
    source: 'runtime-reflection-loop',
    status: 'pending',
    priority: highFindings.some((finding) => finding.severity === 'critical') ? 'critical' : 'high',
    cooldown_key: cooldownKey,
    bot_id: mandate.bot_id ?? null,
    family: context.family,
    decision_context_id: context.context_id,
    reflection_id: reflection.reflection_id,
    prompt,
    findings: highFindings,
    acceptance: [
      'candidate change is grounded in the latest decision context and prior outcomes',
      'backtest or forward-paper evidence is written to durable artifacts',
      'promotion remains paper-gated unless the existing promotion conductor approves',
    ],
    safety_constraints: [
      'paper-only self-improvement intent',
      'do not increase live risk limits',
      'do not overwrite canonical harness without backend approval',
    ],
  };
  return appendJsonl(IMPROVEMENT_INTENTS_FILE, intent);
}

function reflectOnDecisionContext(contextInput) {
  const context = isRecord(contextInput) ? contextInput : recordDecisionContext(contextInput || {});
  const contexts = recentContexts(12);
  if (!contexts.some((item) => item.context_id === context.context_id)) {
    contexts.push(context);
  }
  const findings = buildReflectionFindings(context, contexts);
  const scores = scoreReflection(context, findings);
  const verdict = findings.some((finding) => finding.severity === 'critical')
    ? 'halt-and-investigate'
    : findings.some((finding) => finding.severity === 'high')
      ? 'improve'
      : findings.some((finding) => finding.severity === 'medium')
        ? 'watch'
        : 'continue';
  const reflection = {
    schema_version: 1,
    reflection_id: `refl_${hash({ context_id: context.context_id, findings, scores }).slice(0, 18)}`,
    timestamp: nowIso(),
    mode: 'deterministic-runtime-reflection',
    decision_context_id: context.context_id,
    bot_id: context.bot?.id ?? context.mandate?.bot_id ?? null,
    family: context.family,
    verdict,
    summary: findings.length
      ? `Found ${findings.length} behavior gap${findings.length === 1 ? '' : 's'}; ${verdict}.`
      : 'Tick evidence is sufficient for current mandate; no strategy change proposed.',
    findings,
    scores,
    no_change_rationale: findings.length === 0 ? 'Observation, action, mandate, and risk evidence are adequate for this tick.' : null,
  };
  const intent = buildImprovementIntent(context, reflection, findings);
  if (intent) {
    reflection.emitted_improvement_intent_id = intent.intent_id;
  }
  appendJsonl(REFLECTIONS_FILE, reflection);
  return reflection;
}

function dispatchedIntentIds(windowMs = DISPATCH_COOLDOWN_MS) {
  const cutoff = Date.now() - windowMs;
  return new Set(
    readJsonl(IMPROVEMENT_DISPATCHES_FILE, 100)
      .filter((dispatch) => parseMs(dispatch.timestamp) >= cutoff)
      .map((dispatch) => dispatch.intent_id)
      .filter(Boolean),
  );
}

function nextImprovementIntent(defaultPrompt = 'Periodic paper-only harness self-improvement.') {
  const dispatched = dispatchedIntentIds();
  const intents = readJsonl(IMPROVEMENT_INTENTS_FILE, 100)
    .filter((intent) => intent.status !== 'resolved' && intent.status !== 'discarded')
    .filter((intent) => intent.intent_id && !dispatched.has(intent.intent_id));
  const priority = { critical: 3, high: 2, medium: 1, low: 0 };
  intents.sort((a, b) => (priority[b.priority] ?? 0) - (priority[a.priority] ?? 0) || parseMs(b.timestamp) - parseMs(a.timestamp));
  const intent = intents[0] || null;
  return {
    intent,
    prompt: intent?.prompt || defaultPrompt,
  };
}

function recordIntentDispatch(intent, extra = {}) {
  if (!intent || !intent.intent_id) return null;
  return appendJsonl(IMPROVEMENT_DISPATCHES_FILE, {
    schema_version: 1,
    timestamp: nowIso(),
    source: 'self-improvement-cadence',
    intent_id: intent.intent_id,
    decision_context_id: intent.decision_context_id ?? null,
    reflection_id: intent.reflection_id ?? null,
    ...compactObject(extra, 3, 24, 300),
  });
}

function status() {
  const contexts = readJsonl(DECISION_CONTEXTS_FILE, 100);
  const reflections = readJsonl(REFLECTIONS_FILE, 100);
  const intents = readJsonl(IMPROVEMENT_INTENTS_FILE, 100);
  const dispatches = readJsonl(IMPROVEMENT_DISPATCHES_FILE, 100);
  return {
    decision_contexts: contexts.length,
    reflections: reflections.length,
    improvement_intents: intents.length,
    improvement_dispatches: dispatches.length,
    latest_context: contexts.at(-1) ?? null,
    latest_reflection: reflections.at(-1) ?? null,
    latest_intent: intents.at(-1) ?? null,
  };
}

function main() {
  const command = process.argv[2] || 'status';
  if (command === 'record') {
    const payload = JSON.parse(process.argv[3] || '{}');
    process.stdout.write(`${JSON.stringify(recordDecisionContext(payload))}\n`);
    return;
  }
  if (command === 'reflect') {
    const payload = JSON.parse(process.argv[3] || '{}');
    process.stdout.write(`${JSON.stringify(reflectOnDecisionContext(payload))}\n`);
    return;
  }
  if (command === 'next-intent') {
    const selected = nextImprovementIntent(process.argv[3] || 'Periodic paper-only harness self-improvement.');
    process.stdout.write(`${JSON.stringify(selected)}\n`);
    return;
  }
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(status())}\n`);
    return;
  }
  console.error(JSON.stringify({ error: `unknown command: ${command}` }));
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ error: error.message || String(error) }));
    process.exit(1);
  }
}

module.exports = {
  AGENT_ROOT,
  MEMORY_DIR,
  DECISION_CONTEXTS_FILE,
  REFLECTIONS_FILE,
  IMPROVEMENT_INTENTS_FILE,
  IMPROVEMENT_DISPATCHES_FILE,
  appendJsonl,
  readJson,
  readJsonl,
  recordDecisionContext,
  reflectOnDecisionContext,
  nextImprovementIntent,
  recordIntentDispatch,
  status,
  classifyMandateAlignment,
  evidenceQuality,
};
