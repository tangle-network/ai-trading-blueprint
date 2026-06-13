// Model-authored strategy programs (the FunSearch rung of the self-improvement
// loop). Instead of randomly perturbing one harness parameter, the MODEL designs
// a COMPLETE strategy — which signals, conditions, thresholds, weights, exits,
// and sizing — reasoned from the parent program and its realized performance.
//
// The harness IS the program: a weighted set of signal->condition entry rules +
// exit rules + position sizing, expressed in a fixed grammar the deterministic
// backtester understands. So a model-authored harness is automatically
// backtestable, walk-forward-scorable, and promotable through the EXISTING gate
// (backtest -> paper trial -> promotion). The model proposes; the deterministic
// gate selects. No alpha is taken on trust — every authored program must beat
// the parent out-of-sample before any capital (paper or real) follows it.
//
// FAIL CLOSED: any malformed / out-of-grammar / unconfigured output returns null,
// and the caller falls back to a deterministic mutation for that population slot.
// A model failure never shrinks the search or ships an unvalidated strategy.

const crypto = require('crypto');
const { resolveModelEndpoint, agenticDecisionsEnabled, stripJsonFence } = require('/home/agent/tools/agentic-decision');

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_TOKENS = 1200;

// The grammar the deterministic backtester accepts (trading-runtime SignalType /
// EntryCondition / ExitRule / PositionSizing). The model must stay inside it; the
// backtest is the final semantic gate, but we reject obviously out-of-grammar
// programs here so a junk candidate never even costs a backtest.
const SIGNAL_TYPES = new Set(['rsi', 'ema_cross', 'price_momentum', 'sma_cross', 'macd', 'bollinger_band', 'atr_breakout', 'obv', 'volume_surge']);
const CONDITION_TYPES = new Set(['below', 'above', 'cross_above', 'cross_below']);
const EXIT_TYPES = new Set(['stop_loss', 'take_profit', 'trailing_stop', 'time_limit']);
const SIZING_METHODS = new Set(['fixed_fraction', 'kelly_fraction']);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function systemPrompt() {
  return [
    'You are a quantitative strategy author for an autonomous on-chain trading vault.',
    'You DESIGN a complete trading strategy as a "harness" program and output it as JSON.',
    'A harness is a weighted set of entry rules, a set of exit rules, and a sizing rule.',
    'Your goal: a strategy with better RISK-ADJUSTED return than the parent — higher',
    'return per unit of drawdown, not just more trades. Reason about the regime the',
    'evidence implies and choose signals that exploit it; avoid overfitting (a few',
    'robust rules beat many fragile ones).',
    '',
    'GRAMMAR (use ONLY these — anything else is rejected):',
    'signal.type: rsi{period}, ema_cross{short_period,long_period}, sma_cross{short_period,long_period},',
    '  price_momentum{lookback_candles}, macd{fast_period,slow_period,signal_period},',
    '  bollinger_band{period,std_dev}, atr_breakout{period,multiplier}',
    'condition.type: below{threshold}, above{threshold}, cross_above, cross_below',
    'exit.type: stop_loss{pct}, take_profit{pct}, trailing_stop{activation_pct,trail_pct}, time_limit{max_candles}',
    'position_sizing.method: fixed_fraction{fraction 0..1}, kelly_fraction{kelly_multiplier}',
    '',
    'Output ONLY this JSON object (no prose):',
    '{"rationale": <one sentence: the thesis>,',
    ' "entry_rules": [{"signal": {"type": ..., <params>}, "condition": {"type": ..., <params>}, "weight": <0..1>}],',
    ' "exit_rules": [{"type": ..., <params>}],',
    ' "position_sizing": {"method": ..., <params>},',
    ' "entry_threshold": <0.05..0.95 — weighted signal score needed to enter>,',
    ' "max_positions": <1..10>}',
  ].join('\n');
}

function userPrompt({ family, parentHarness, performance, intent }) {
  return JSON.stringify(
    {
      family,
      mandate_intent: intent || null,
      parent_harness: parentHarness || null,
      parent_performance: performance || null,
      instruction: 'Design an improved harness program. Bare JSON only, inside the grammar.',
    },
    null,
    0,
  );
}

// Structural validation against the grammar. Returns a normalized harness or null.
function validateHarness(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const entry = Array.isArray(parsed.entry_rules) ? parsed.entry_rules : null;
  if (!entry || entry.length === 0 || entry.length > 8) return null;

  const entry_rules = [];
  for (const rule of entry) {
    const sig = rule && rule.signal;
    const cond = rule && rule.condition;
    if (!sig || !SIGNAL_TYPES.has(String(sig.type))) return null;
    if (!cond || !CONDITION_TYPES.has(String(cond.type))) return null;
    // Numeric params must be finite where present.
    for (const k of Object.keys(sig)) {
      if (k === 'type') continue;
      if (num(sig[k]) === null) return null;
    }
    if ((cond.type === 'below' || cond.type === 'above') && num(cond.threshold) === null) return null;
    const weight = num(rule.weight);
    entry_rules.push({ signal: { ...sig, type: String(sig.type) }, condition: { ...cond, type: String(cond.type) }, weight: weight === null ? 0.5 : Math.min(1, Math.max(0.05, weight)) });
  }

  const exitsIn = Array.isArray(parsed.exit_rules) ? parsed.exit_rules : [];
  const exit_rules = [];
  for (const ex of exitsIn) {
    if (!ex || !EXIT_TYPES.has(String(ex.type))) return null;
    exit_rules.push({ ...ex, type: String(ex.type) });
  }
  // A program with no exit plan is how bots rode big drawdowns — require at least one.
  if (exit_rules.length === 0) exit_rules.push({ type: 'stop_loss', pct: 5 });

  const sizing = parsed.position_sizing;
  if (!sizing || !SIZING_METHODS.has(String(sizing.method))) return null;
  const position_sizing = { ...sizing, method: String(sizing.method) };
  if (position_sizing.method === 'fixed_fraction') {
    const f = num(position_sizing.fraction);
    if (f === null) return null;
    position_sizing.fraction = Math.min(0.5, Math.max(0.02, f));
  }

  const entry_threshold = Math.min(0.95, Math.max(0.05, num(parsed.entry_threshold) ?? 0.5));
  const max_positions = Math.round(Math.min(10, Math.max(1, num(parsed.max_positions) ?? 3)));

  return { entry_rules, exit_rules, position_sizing, entry_threshold, max_positions };
}

// Author one strategy program with the model. Returns { harness, rationale,
// model, prompt_hash } or null (fail-closed). `parentHarness` seeds version.
async function authorStrategy(spec, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!agenticDecisionsEnabled(env)) return null;
  if (typeof fetchImpl !== 'function') return null;
  const { apiKey, baseUrl, model } = resolveModelEndpoint(env);

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(spec) },
  ];
  const promptHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.4, max_tokens: Number(opts.maxTokens) || DEFAULT_MAX_TOKENS, messages }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);
  if (!response || typeof response.json !== 'function' || !response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  const jsonText = stripJsonFence(content);
  if (!jsonText) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const validated = validateHarness(parsed);
  if (!validated) return null;

  const harness = {
    ...validated,
    version: Number((spec.parentHarness && spec.parentHarness.version) || 1) + 1,
    authored_by: 'model',
  };
  return {
    harness,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 280) : '',
    model,
    prompt_hash: promptHash,
    usage: (payload && payload.usage) || null,
  };
}

module.exports = { authorStrategy, validateHarness, SIGNAL_TYPES, CONDITION_TYPES, EXIT_TYPES, SIZING_METHODS };
