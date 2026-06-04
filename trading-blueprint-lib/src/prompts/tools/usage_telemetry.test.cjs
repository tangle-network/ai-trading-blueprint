const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalEnv = { ...process.env };

function withTelemetryModule(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-telemetry-'));
  const modulePath = require.resolve('./usage_telemetry.js');
  delete require.cache[modulePath];
  process.env = { ...originalEnv };
  process.env.AGENT_WORKSPACE = tmp;
  process.env.LLM_USAGE_TELEMETRY_PATH = path.join(tmp, 'telemetry', 'llm-usage.jsonl');
  try {
    return fn(require('./usage_telemetry.js'), tmp);
  } finally {
    delete require.cache[modulePath];
    process.env = { ...originalEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('uses built-in ZAI pricing when provider reports tokens but not cost', () => {
  withTelemetryModule(({ recordUsageEvent }) => {
    const event = recordUsageEvent({
      provider: 'zai-coding-plan',
      model: 'glm-4.7',
      surface: 'observatory',
      operation: 'read-only-reflection',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      },
    });

    assert.equal(event.token_count_status, 'reported');
    assert.equal(event.token_count_source, 'provider_reported');
    assert.equal(event.cost_source, 'pricing_map:zai-official-2026-06-04');
    assert.equal(event.input_price_per_million_usd, 0.6);
    assert.equal(event.output_price_per_million_usd, 2.2);
    assert.equal(event.cost_usd, 0.0017);
  });
});

test('estimates missing harness tokens from chars and then estimates cost', () => {
  withTelemetryModule(({ recordUsageEvent }) => {
    const event = recordUsageEvent({
      provider: 'zai-coding-plan',
      model: 'glm-4.7',
      input_chars: 401,
      output_chars: 80,
    });

    assert.equal(event.input_tokens, 101);
    assert.equal(event.output_tokens, 20);
    assert.equal(event.total_tokens, 121);
    assert.equal(event.token_count_status, 'estimated');
    assert.equal(event.token_count_source, 'char_estimate');
    assert.equal(event.input_tokens_source, 'estimated');
    assert.equal(event.output_tokens_source, 'estimated');
    assert.equal(event.cost_source, 'pricing_map:zai-official-2026-06-04');
    assert.equal(event.cost_usd, 0.0001046);
  });
});

test('env pricing overrides built-in pricing map', () => {
  withTelemetryModule(({ recordUsageEvent }) => {
    process.env.LLM_PRICE_ZAI_CODING_PLAN_GLM_4_7_INPUT_PER_MILLION_USD = '2';
    process.env.LLM_PRICE_ZAI_CODING_PLAN_GLM_4_7_OUTPUT_PER_MILLION_USD = '8';
    const event = recordUsageEvent({
      provider: 'zai-coding-plan',
      model: 'glm-4.7',
      usage: {
        input_tokens: 100,
        output_tokens: 25,
      },
    });

    assert.equal(event.cost_source, 'env:LLM_PRICE_ZAI_CODING_PLAN_GLM_4_7_INPUT_PER_MILLION_USD,LLM_PRICE_ZAI_CODING_PLAN_GLM_4_7_OUTPUT_PER_MILLION_USD');
    assert.equal(event.cost_usd, 0.0004);
  });
});
