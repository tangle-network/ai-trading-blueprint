// Model-driven trade decision for the live tick.
//
// This module is the alpha engine: given the evidence a family tick already
// gathers (portfolio, prices, candle-derived features, external market signals,
// open position, mandate), the MODEL picks ONE action and a size. It replaces
// the hardcoded RSI/EMA directional rules that used to *be* the strategy.
//
// Hard contract — this module is alpha only, never risk:
//   * It only ever proposes among the `candidates` the caller allows. The caller
//     computes those AFTER its fail-closed risk guards (drawdown breaker, size
//     caps, mandate, min-order, balance). The model can never widen them.
//   * It FAILS CLOSED. Any missing key, network error, timeout, malformed JSON,
//     or out-of-contract action returns null. A null decision means the caller
//     holds/skips — it must NOT fall back to a hidden directional rule, because
//     that is the decorative-AI bug this replaces.
//   * Every call returns its full provenance (model, usage, raw text, prompt
//     hash) so the live decision is auditable even though it is not replayable.

const crypto = require('crypto');

// Reasoning models (glm-4.7) routinely spend 20-40s on a non-trivial prompt
// (hundreds of reasoning tokens). 25s clipped the larger prediction/multi
// prompts mid-thought -> AbortController -> null -> a real model decision lost.
// The fast tick runs every ~5 min, so a longer ceiling costs nothing.
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_TOKENS = 700;
const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

// Resolve the model endpoint from the same env the sidecar already injects
// (activate.rs writes OPENCODE_MODEL_* and ZAI_API_KEY into the sandbox). A
// dedicated TRADING_DECISION_* override wins so the decision model can differ
// from the chat/reflection model without disturbing either.
function resolveModelEndpoint(env = process.env) {
  const apiKey =
    env.TRADING_DECISION_API_KEY ||
    env.OPENCODE_MODEL_API_KEY ||
    env.ZAI_API_KEY ||
    null;
  const baseUrl =
    env.TRADING_DECISION_BASE_URL ||
    env.OPENCODE_MODEL_BASE_URL ||
    (env.ZAI_API_KEY ? ZAI_BASE_URL : null);
  const model =
    env.TRADING_DECISION_MODEL ||
    env.OPENCODE_MODEL_ID ||
    'glm-4.7';
  return { apiKey, baseUrl, model };
}

// The model layer is on unless explicitly disabled OR unconfigured. Evals,
// backtests, and offline replay set TRADING_AGENTIC_DECISIONS=0 so the family
// tick uses its deterministic baseline and stays reproducible.
function agenticDecisionsEnabled(env = process.env) {
  if (env.TRADING_AGENTIC_DECISIONS === '0' || env.TRADING_AGENTIC_DECISIONS === 'false') {
    return false;
  }
  const { apiKey, baseUrl } = resolveModelEndpoint(env);
  return Boolean(apiKey && baseUrl);
}

function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  // Tolerate a leading prose sentence before the object by slicing to the first
  // brace; the model is instructed to return bare JSON but we never trust it.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return body.slice(start, end + 1);
}

function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function systemPrompt(family) {
  return [
    `You are the trading decision engine for an autonomous on-chain ${family} vault.`,
    'Each tick you receive the full market + portfolio evidence and must choose',
    'EXACTLY ONE action from the allowed set, plus a size. You are the alpha',
    'source: reason from the evidence (trend, momentum, mean-reversion, market',
    'sentiment, position context, the mandate). Risk limits are already enforced',
    'by the caller — your job is to make money inside them, not to police them.',
    '',
    'Respond with ONLY a JSON object, no prose, with this exact shape:',
    '{"action": <one of the allowed actions>,',
    ' "size_fraction": <0..1 fraction of the sizing envelope to deploy; 0 means do nothing>,',
    ' "confidence": <0..1>,',
    ' "rationale": <one sentence, the actual reason>,',
    ' "key_signals": [<the 1-4 evidence fields that drove this>]}',
    '',
    'Rules: choose "hold"/"skip" when the evidence is not decisive — churning the',
    'book on noise loses to fees and impact. Prefer fewer, higher-conviction',
    'trades. size_fraction scales with conviction. Never invent fields.',
  ].join('\n');
}

function userPrompt({ family, evidence, candidates, sizing, mandate, position }) {
  return JSON.stringify(
    {
      family,
      allowed_actions: candidates,
      sizing_envelope: sizing,
      mandate,
      open_position: position,
      evidence,
      instruction:
        'Pick one allowed action and a size_fraction in [0,1] of the sizing envelope. Bare JSON only.',
    },
    null,
    0,
  );
}

// Core call. Returns a validated decision or null (fail-closed). Never throws.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST a chat/completions request with: a per-attempt abort timeout, a small
// pre-call jitter (so a fleet of bots ticking on the same cron second doesn't
// burst a shared key simultaneously), and backoff+retry on 429 (rate limit) /
// 5xx (transient). A single ZAI key shared across the fleet hits per-minute 429s
// under concurrency — those cleared on retry, so a bot was fail-closing to
// `hold` on a transient throttle. Returns the parsed JSON payload or null
// (fail-closed; the caller still never trades on a missing decision).
async function postChatCompletion(opts) {
  const { baseUrl, apiKey, model, messages, fetchImpl, timeoutMs } = opts;
  const maxTokens = Number(opts.maxTokens) || DEFAULT_MAX_TOKENS;
  const retries = Number.isFinite(Number(opts.retries)) ? Number(opts.retries) : 4;
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = JSON.stringify({ model, temperature: 0.2, max_tokens: maxTokens, messages });
  // De-synchronize concurrent fleet calls: 0–600ms jitter (skipped for tests via
  // opts.noJitter so they stay fast/deterministic).
  if (!opts.noJitter) await sleep(Math.floor((globalThis.Math?.random?.() ?? 0) * 600));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let threw = false;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: controller.signal,
      });
    } catch {
      // Connection reset / DNS / TLS error, OR our own abort-timeout firing.
      threw = true;
    }
    clearTimeout(timer);
    if (!threw && response && typeof response.json === 'function' && response.ok) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
    // A fast-failing connection error ("error sending request for url" — the
    // dominant live failure for bots that call the model every tick) is transient
    // and MUST be retried like a 429. But our OWN abort-timeout already consumed a
    // full timeoutMs window, so retrying it `retries` times could span most of the
    // ~5min tick interval — treat a timeout as non-retryable and fail closed.
    const timedOut = threw && controller.signal.aborted;
    const status = threw ? 0 : (response && Number(response.status));
    const retryable = (threw && !timedOut) || status === 429 || (status >= 500 && status < 600);
    if (attempt < retries && retryable) {
      // Escalating backoff spanning a sustained-throttle window (the shared key
      // can stay 429 across a full per-minute bucket under fleet concurrency),
      // plus up to 1s jitter to break lockstep retries.
      const schedule = Array.isArray(opts.backoffMs) ? opts.backoffMs : [1500, 4000, 9000, 20000];
      const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 20000;
      // Honor a server-sent Retry-After (seconds) when present — the provider
      // knows its own bucket reset better than our fixed schedule. Capped at 30s.
      let retryAfterMs = 0;
      const retryAfter = response?.headers?.get?.('retry-after');
      if (retryAfter != null) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs) && secs > 0) retryAfterMs = Math.min(secs * 1000, 30000);
      }
      const wait = Math.max(base, retryAfterMs);
      await sleep(wait + (opts.noJitter ? 0 : Math.floor((globalThis.Math?.random?.() ?? 0) * 1000)));
      continue;
    }
    return null;
  }
  return null;
}

async function agenticDecision(spec, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const candidates = Array.isArray(spec.candidates) ? spec.candidates : [];
  if (!candidates.length) return null;
  if (!agenticDecisionsEnabled(env)) return null;
  if (typeof fetchImpl !== 'function') return null;

  const { apiKey, baseUrl, model } = resolveModelEndpoint(env);
  const messages = [
    { role: 'system', content: systemPrompt(spec.family) },
    { role: 'user', content: userPrompt(spec) },
  ];
  const promptHash = `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(messages))
    .digest('hex')}`;

  const payload = await postChatCompletion({
    baseUrl,
    apiKey,
    model,
    messages,
    fetchImpl,
    timeoutMs,
    maxTokens: Number(opts.maxTokens) || DEFAULT_MAX_TOKENS,
    noJitter: opts.noJitter ?? Boolean(opts.fetch),
    retries: opts.retries,
    backoffMs: opts.backoffMs,
  });
  if (!payload) return null;
  const choice = payload && payload.choices && payload.choices[0];
  const content = choice && choice.message && choice.message.content;
  const jsonText = stripJsonFence(content);
  if (!jsonText) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const action = String(parsed.action || '').trim();
  if (!candidates.includes(action)) return null;

  const maxFraction = Number.isFinite(Number(spec.sizing && spec.sizing.max_fraction))
    ? Number(spec.sizing.max_fraction)
    : 1;
  const sizeFraction = clamp(parsed.size_fraction, 0, Math.min(1, Math.max(0, maxFraction)));
  const confidence = clamp(parsed.confidence, 0, 1);
  const keySignals = Array.isArray(parsed.key_signals)
    ? parsed.key_signals.slice(0, 4).map((s) => String(s))
    : [];

  return {
    action,
    size_fraction: sizeFraction,
    confidence,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 280) : '',
    key_signals: keySignals,
    decided_by: 'model',
    model,
    prompt_hash: promptHash,
    usage: (payload && payload.usage) || null,
  };
}

// Tactical asset allocation for portfolio ("multi") families. Instead of a
// discrete action the model returns target WEIGHTS over the asset set; the
// caller's mechanical rebalancer then trades toward them inside its band/min
// guards. This is the alpha injection for allocation strategies: the static
// 50/50 config weights are what made the multi bots buy a falling asset every
// tick. Fails closed (null) exactly like agenticDecision.
async function agenticAllocation(spec, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const symbols = Array.isArray(spec.assets) ? spec.assets.map((a) => String(a.symbol)) : [];
  if (symbols.length < 2) return null;
  if (!agenticDecisionsEnabled(env)) return null;
  if (typeof fetchImpl !== 'function') return null;

  const { apiKey, baseUrl, model } = resolveModelEndpoint(env);
  const messages = [
    {
      role: 'system',
      content: [
        `You are the tactical asset allocator for an autonomous on-chain ${spec.family || 'multi'} vault.`,
        'Each tick you set target portfolio weights from the evidence (trend,',
        'momentum, sentiment, current weights, mandate). You are the alpha source:',
        'a falling risk asset should usually get a LOWER target, not a mechanical',
        'rebalance back to a fixed weight. Respond with ONLY JSON:',
        '{"weights": {<SYMBOL>: <0..1>, ...for every asset>},',
        ' "confidence": <0..1>, "rationale": <one sentence>, "key_signals": [<1-4 fields>]}',
        'Weights should sum to about 1. Include every asset symbol exactly.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify(
        { family: spec.family, assets: spec.assets, mandate: spec.mandate, evidence: spec.evidence, instruction: 'Bare JSON only. One weight per asset symbol.' },
        null,
        0,
      ),
    },
  ];
  const promptHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex')}`;

  const payload = await postChatCompletion({
    baseUrl,
    apiKey,
    model,
    messages,
    fetchImpl,
    timeoutMs,
    maxTokens: Number(opts.maxTokens) || DEFAULT_MAX_TOKENS,
    noJitter: opts.noJitter ?? Boolean(opts.fetch),
    retries: opts.retries,
    backoffMs: opts.backoffMs,
  });
  if (!payload) return null;
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  const jsonText = stripJsonFence(content);
  if (!jsonText) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const rawWeights = parsed && parsed.weights;
  if (!rawWeights || typeof rawWeights !== 'object') return null;

  // Every asset must be present and non-negative; renormalize to sum 1.
  const weights = {};
  let sum = 0;
  for (const sym of symbols) {
    const w = Number(rawWeights[sym]);
    if (!Number.isFinite(w) || w < 0) return null;
    weights[sym] = w;
    sum += w;
  }
  if (sum <= 0) return null;
  for (const sym of symbols) weights[sym] = weights[sym] / sum;

  return {
    weights,
    confidence: clamp(parsed.confidence, 0, 1),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 280) : '',
    key_signals: Array.isArray(parsed.key_signals) ? parsed.key_signals.slice(0, 4).map((s) => String(s)) : [],
    decided_by: 'model',
    model,
    prompt_hash: promptHash,
    usage: (payload && payload.usage) || null,
  };
}

module.exports = {
  agenticDecision,
  agenticAllocation,
  agenticDecisionsEnabled,
  resolveModelEndpoint,
  stripJsonFence,
  ZAI_BASE_URL,
};
