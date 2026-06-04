const { createHash, randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const ROOT = process.env.AGENT_WORKSPACE || '/home/agent';
const TELEMETRY_PATH = process.env.LLM_USAGE_TELEMETRY_PATH || join(ROOT, 'telemetry', 'llm-usage.jsonl');
const MAX_TELEMETRY_BYTES = Math.max(
  256 * 1024,
  Number(process.env.LLM_USAGE_TELEMETRY_MAX_BYTES || 5 * 1024 * 1024),
);
const DEFAULT_CHARS_PER_TOKEN = 4;
const BUILT_IN_PRICING = [
  {
    providerMatchers: ['zai-coding-plan', 'zai', 'z.ai', 'z-ai', 'zhipu'],
    modelMatchers: ['glm-5.1'],
    input_per_million_usd: 1.4,
    cached_input_per_million_usd: 0.26,
    output_per_million_usd: 4.4,
    source: 'pricing_map:zai-official-2026-06-04',
  },
  {
    providerMatchers: ['zai-coding-plan', 'zai', 'z.ai', 'z-ai', 'zhipu'],
    modelMatchers: ['glm-5'],
    input_per_million_usd: 1.0,
    cached_input_per_million_usd: 0.2,
    output_per_million_usd: 3.2,
    source: 'pricing_map:zai-official-2026-06-04',
  },
  {
    providerMatchers: ['zai-coding-plan', 'zai', 'z.ai', 'z-ai', 'zhipu'],
    modelMatchers: ['glm-5-turbo'],
    input_per_million_usd: 1.2,
    cached_input_per_million_usd: 0.24,
    output_per_million_usd: 4.0,
    source: 'pricing_map:zai-official-2026-06-04',
  },
  {
    providerMatchers: ['zai-coding-plan', 'zai', 'z.ai', 'z-ai', 'zhipu'],
    modelMatchers: ['glm-4.7', 'glm-4.6', 'glm-4.5'],
    input_per_million_usd: 0.6,
    cached_input_per_million_usd: 0.11,
    output_per_million_usd: 2.2,
    source: 'pricing_map:zai-official-2026-06-04',
  },
  {
    providerMatchers: ['zai-coding-plan', 'zai', 'z.ai', 'z-ai', 'zhipu'],
    modelMatchers: ['glm-4.7-flashx'],
    input_per_million_usd: 0.07,
    cached_input_per_million_usd: 0.01,
    output_per_million_usd: 0.4,
    source: 'pricing_map:zai-official-2026-06-04',
  },
  {
    providerMatchers: ['zai-coding-plan', 'zai', 'z.ai', 'z-ai', 'zhipu'],
    modelMatchers: ['glm-4.7-flash', 'glm-4.5-flash'],
    input_per_million_usd: 0,
    cached_input_per_million_usd: 0,
    output_per_million_usd: 0,
    source: 'pricing_map:zai-official-2026-06-04',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function workspaceConfig() {
  return readJson(join(ROOT, 'config', 'api.json'), {}) || {};
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function intOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.max(0, Math.round(parsed));
}

function positiveNumberOrDefault(value, fallback) {
  const parsed = numberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : fallback;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function slug(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function commandModel(command) {
  const text = String(command || '');
  const match = text.match(/\s-m\s+["']?([^"'\s]+)["']?/);
  if (!match) return null;
  return match[1];
}

function splitProviderModel(value) {
  const modelRef = stringOrNull(value);
  if (!modelRef) return { provider: null, model: null };
  const slash = modelRef.indexOf('/');
  if (slash > 0 && slash < modelRef.length - 1) {
    return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
  }
  return { provider: null, model: modelRef };
}

function canonical(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function inferProviderModel(input = {}) {
  const commandRef = commandModel(input.command);
  const commandParts = splitProviderModel(commandRef);
  const envProvider = stringOrNull(process.env.OPENCODE_MODEL_PROVIDER);
  const envModel = stringOrNull(process.env.OPENCODE_MODEL_NAME);
  let provider = stringOrNull(input.provider) || commandParts.provider || envProvider;
  let model = stringOrNull(input.model) || commandParts.model || envModel;

  const command = String(input.command || '');
  if (!provider && /(^|\s)gemini(\s|$)/.test(command)) provider = 'gemini-cli';
  if (!model && provider === 'gemini-cli') model = stringOrNull(process.env.GEMINI_MODEL);
  if (!provider && model && model.includes('/')) {
    const parts = splitProviderModel(model);
    provider = parts.provider;
    model = parts.model;
  }
  if (!provider && model) provider = stringOrNull(process.env.LLM_PROVIDER) || null;
  return { provider, model };
}

function estimateTokenCount(chars) {
  const charCount = intOrNull(chars);
  if (charCount == null || charCount <= 0) return null;
  const charsPerToken = positiveNumberOrDefault(
    process.env.LLM_TOKEN_ESTIMATE_CHARS_PER_TOKEN,
    DEFAULT_CHARS_PER_TOKEN,
  );
  return Math.max(1, Math.ceil(charCount / charsPerToken));
}

function normalizeUsage(raw, estimates = {}) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  const reportedInputTokens = intOrNull(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? usage.tokensIn,
  );
  const reportedOutputTokens = intOrNull(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? usage.tokensOut,
  );
  const estimatedInputTokens = reportedInputTokens == null ? estimateTokenCount(estimates.input_chars) : null;
  const estimatedOutputTokens = reportedOutputTokens == null ? estimateTokenCount(estimates.output_chars) : null;
  const inputTokens = reportedInputTokens ?? estimatedInputTokens;
  const outputTokens = reportedOutputTokens ?? estimatedOutputTokens;
  const totalTokens = intOrNull(
    usage.total_tokens ?? usage.totalTokens ?? usage.tokensTotal,
  ) ?? (
    inputTokens != null || outputTokens != null
      ? (inputTokens || 0) + (outputTokens || 0)
      : null
  );
  const cachedInputTokens = intOrNull(
    usage.cached_input_tokens
      ?? usage.cachedInputTokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_token_details?.cache_read,
  );
  const reasoningTokens = intOrNull(
    usage.reasoning_tokens
      ?? usage.reasoningTokens
      ?? usage.completion_tokens_details?.reasoning_tokens,
  );

  let tokenCountStatus = 'unreported';
  if (reportedInputTokens != null && reportedOutputTokens != null) tokenCountStatus = 'reported';
  else if (reportedInputTokens != null || reportedOutputTokens != null) tokenCountStatus = inputTokens != null && outputTokens != null ? 'partial_estimated' : 'partial';
  else if (estimatedInputTokens != null || estimatedOutputTokens != null) tokenCountStatus = inputTokens != null && outputTokens != null ? 'estimated' : 'partial_estimated';
  else if (totalTokens != null) tokenCountStatus = 'partial';

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedInputTokens,
    reasoning_tokens: reasoningTokens,
    token_count_status: tokenCountStatus,
    token_count_source: tokenCountStatus === 'reported'
      ? 'provider_reported'
      : tokenCountStatus.includes('estimated')
        ? 'char_estimate'
        : tokenCountStatus === 'partial'
          ? 'provider_partial'
          : 'missing',
    input_tokens_source: reportedInputTokens != null ? 'reported' : estimatedInputTokens != null ? 'estimated' : 'missing',
    output_tokens_source: reportedOutputTokens != null ? 'reported' : estimatedOutputTokens != null ? 'estimated' : 'missing',
    token_estimate_chars_per_token: tokenCountStatus.includes('estimated')
      ? positiveNumberOrDefault(process.env.LLM_TOKEN_ESTIMATE_CHARS_PER_TOKEN, DEFAULT_CHARS_PER_TOKEN)
      : null,
  };
}

function priceFromEnv(provider, model, side) {
  const keys = [];
  const providerSlug = slug(provider);
  const modelSlug = slug(model);
  if (providerSlug && modelSlug) keys.push(`LLM_PRICE_${providerSlug}_${modelSlug}_${side}_PER_MILLION_USD`);
  if (modelSlug) keys.push(`LLM_PRICE_${modelSlug}_${side}_PER_MILLION_USD`);
  if (providerSlug) keys.push(`LLM_PRICE_${providerSlug}_${side}_PER_MILLION_USD`);
  keys.push(`LLM_PRICE_${side}_PER_MILLION_USD`);
  for (const key of keys) {
    const value = numberOrNull(process.env[key]);
    if (value != null) return { value, key };
  }
  return null;
}

function builtInPricing(provider, model) {
  const providerKey = canonical(provider);
  const modelKey = canonical(model);
  if (!modelKey) return null;
  return BUILT_IN_PRICING.find((entry) => {
    const providerMatches = !providerKey || entry.providerMatchers.some((candidate) => canonical(candidate) === providerKey);
    const modelMatches = entry.modelMatchers.some((candidate) => canonical(candidate) === modelKey);
    return providerMatches && modelMatches;
  }) || null;
}

function pricingFor(provider, model) {
  const inputPrice = priceFromEnv(provider, model, 'INPUT');
  const outputPrice = priceFromEnv(provider, model, 'OUTPUT');
  const cachedInputPrice = priceFromEnv(provider, model, 'CACHED_INPUT');
  if (inputPrice && outputPrice) {
    return {
      input_per_million_usd: inputPrice.value,
      cached_input_per_million_usd: cachedInputPrice?.value ?? inputPrice.value,
      output_per_million_usd: outputPrice.value,
      source: `env:${inputPrice.key},${outputPrice.key}`,
    };
  }
  return builtInPricing(provider, model);
}

function reportedCost(input, rawUsage) {
  return numberOrNull(
    input.cost_usd
      ?? input.costUsd
      ?? rawUsage?.cost_usd
      ?? rawUsage?.costUsd
      ?? rawUsage?.cost,
  );
}

function estimateCost(input, normalizedUsage, provider, model, rawUsage) {
  const explicit = reportedCost(input, rawUsage);
  if (explicit != null) return { cost_usd: explicit, cost_source: 'reported' };

  const pricing = pricingFor(provider, model);
  if (
    pricing
    && normalizedUsage.input_tokens != null
    && normalizedUsage.output_tokens != null
  ) {
    const cachedInputTokens = Math.min(
      normalizedUsage.cached_input_tokens || 0,
      normalizedUsage.input_tokens,
    );
    const uncachedInputTokens = Math.max(0, normalizedUsage.input_tokens - cachedInputTokens);
    const cost = (
      uncachedInputTokens * pricing.input_per_million_usd
      + cachedInputTokens * pricing.cached_input_per_million_usd
      + normalizedUsage.output_tokens * pricing.output_per_million_usd
    ) / 1_000_000;
    return {
      cost_usd: Number(cost.toFixed(8)),
      cost_source: pricing.source,
      input_price_per_million_usd: pricing.input_per_million_usd,
      cached_input_price_per_million_usd: pricing.cached_input_per_million_usd,
      output_price_per_million_usd: pricing.output_per_million_usd,
      cost_estimated: true,
    };
  }

  return { cost_usd: null, cost_source: 'unknown', cost_estimated: false };
}

function stableMetadata(value) {
  if (!value || typeof value !== 'object') return {};
  return JSON.parse(JSON.stringify(value));
}

function appendJsonl(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: 'a' });
  trimTelemetry(path);
}

function trimTelemetry(path) {
  try {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.size <= MAX_TELEMETRY_BYTES) return;
    const raw = readFileSync(path, 'utf8');
    const tail = raw.slice(-MAX_TELEMETRY_BYTES);
    const firstNewline = tail.indexOf('\n');
    writeFileSync(path, firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail, 'utf8');
  } catch {}
}

function recordUsageEvent(input = {}) {
  const config = workspaceConfig();
  const rawUsage = input.usage && typeof input.usage === 'object' ? input.usage : {};
  const inputChars = intOrNull(input.input_chars)
    ?? stringOrNull(input.input_text)?.length
    ?? stringOrNull(input.prompt)?.length
    ?? stringOrNull(input.message)?.length
    ?? null;
  const outputChars = intOrNull(input.output_chars)
    ?? stringOrNull(input.output_text)?.length
    ?? stringOrNull(input.response)?.length
    ?? null;
  const normalizedUsage = normalizeUsage(rawUsage, { input_chars: inputChars, output_chars: outputChars });
  const { provider, model } = inferProviderModel(input);
  const cost = estimateCost(input, normalizedUsage, provider, model, rawUsage);
  const event = {
    schema_version: '1.0.0',
    event_id: input.event_id || randomUUID(),
    event_hash: null,
    timestamp: input.timestamp || nowIso(),
    workspace: ROOT,
    bot_id: input.bot_id || config.bot_id || null,
    chain_id: input.chain_id || config.chain_id || null,
    surface: stringOrNull(input.surface) || 'unknown',
    operation: stringOrNull(input.operation) || 'unknown',
    run_id: stringOrNull(input.run_id),
    task_id: stringOrNull(input.task_id),
    variant_id: stringOrNull(input.variant_id),
    shot_index: intOrNull(input.shot_index),
    round: intOrNull(input.round),
    session_id: stringOrNull(input.session_id),
    trace_id: stringOrNull(input.trace_id),
    decision_context_id: stringOrNull(input.decision_context_id),
    provider,
    model,
    model_source: stringOrNull(input.model_source) || (input.command ? 'command_or_env' : provider || model ? 'env' : null),
    command: stringOrNull(input.command),
    status: stringOrNull(input.status) || (input.success === false ? 'failed' : 'completed'),
    success: typeof input.success === 'boolean' ? input.success : null,
    duration_ms: intOrNull(input.duration_ms),
    input_chars: inputChars,
    output_chars: outputChars,
    ...normalizedUsage,
    ...cost,
    raw_usage: stableMetadata(rawUsage),
    metadata: stableMetadata(input.metadata),
  };
  event.event_hash = `sha256:${createHash('sha256').update(JSON.stringify({ ...event, event_hash: null })).digest('hex')}`;
  appendJsonl(TELEMETRY_PATH, event);
  return event;
}

function readUsageEvents(path = TELEMETRY_PATH) {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event && typeof event === 'object');
  } catch {
    return [];
  }
}

function summarizeUsageEvents(events, filter = {}) {
  const filtered = events.filter((event) => {
    if (filter.run_id && event.run_id !== filter.run_id) return false;
    if (filter.task_id && event.task_id !== filter.task_id) return false;
    if (filter.session_id && event.session_id !== filter.session_id) return false;
    return true;
  });
  const inputTokens = filtered.reduce((sum, event) => sum + (numberOrNull(event.input_tokens) || 0), 0);
  const outputTokens = filtered.reduce((sum, event) => sum + (numberOrNull(event.output_tokens) || 0), 0);
  const totalTokens = filtered.reduce((sum, event) => sum + (numberOrNull(event.total_tokens) || 0), 0);
  const totalCost = filtered.reduce((sum, event) => sum + (numberOrNull(event.cost_usd) || 0), 0);
  return {
    event_count: filtered.length,
    events_with_reported_tokens: filtered.filter((event) => event.token_count_status === 'reported').length,
    events_with_reported_or_estimated_cost: filtered.filter((event) => numberOrNull(event.cost_usd) != null).length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens || inputTokens + outputTokens,
    cost_usd: Number(totalCost.toFixed(8)),
    providers: Array.from(new Set(filtered.map((event) => event.provider).filter(Boolean))).sort(),
    models: Array.from(new Set(filtered.map((event) => event.model).filter(Boolean))).sort(),
    surfaces: Array.from(new Set(filtered.map((event) => event.surface).filter(Boolean))).sort(),
    latest: filtered.slice(-5),
  };
}

module.exports = {
  TELEMETRY_PATH,
  estimateCost,
  estimateTokenCount,
  normalizeUsage,
  pricingFor,
  recordUsageEvent,
  readUsageEvents,
  summarizeUsageEvents,
};
