const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalEnv = { ...process.env };

function withTempEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-loop-'));
  const modulePath = require.resolve('./observatory_loop.js');
  delete require.cache[modulePath];
  process.env.AGENT_ROOT = tmp;
  process.env.AGENT_MEMORY_DIR = path.join(tmp, 'memory');
  process.env.AGENT_DECISION_CONTEXTS_FILE = path.join(tmp, 'memory', 'decision-contexts.jsonl');
  process.env.AGENT_DECISION_LOG = path.join(tmp, 'logs', 'decisions.jsonl');
  process.env.LLM_USAGE_TELEMETRY_PATH = path.join(tmp, 'telemetry', 'llm-usage.jsonl');
  process.env.BOT_ID = 'bot_test';
  process.env.BOT_NAME = 'ETH Perp Sentinel';
  process.env.OBSERVATORY_TRIGGER = 'manual';
  try {
    return fn(tmp);
  } finally {
    delete require.cache[modulePath];
    process.env = { ...originalEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

test('buildObservatoryRun writes immediate records from current sandbox evidence', () => {
  withTempEnv((tmp) => {
    appendJsonl(process.env.AGENT_DECISION_CONTEXTS_FILE, {
      context_id: 'ctx_1',
      timestamp: '2026-06-04T10:00:00.000Z',
      checked_state: {
        external_signal_evidence: {
          checked: false,
          required: true,
          unavailable: false,
          source_status: 'missing_provider',
        },
      },
      metrics: {},
    });
    appendJsonl(path.join(tmp, 'memory', 'reflections.jsonl'), {
      reflection_id: 'refl_1',
      decision_context_id: 'ctx_1',
      findings: [],
    });
    appendJsonl(process.env.AGENT_DECISION_LOG, { action: 'skip', reason: 'awaiting data' });
    appendJsonl(process.env.LLM_USAGE_TELEMETRY_PATH, {
      event_id: 'usage_1',
      provider: 'openai',
      model: 'gpt-5',
      input_tokens: 120,
      output_tokens: 40,
      token_count_status: 'reported',
    });

    const { buildObservatoryRun } = require('./observatory_loop.js');
    const result = buildObservatoryRun();

    assert.equal(result.schema_version, 1);
    assert.equal(result.bot_id, 'bot_test');
    assert.equal(result.records.reflection_runs.length, 1);
    assert.equal(result.records.world_signal_digests.length, 1);
    assert.equal(result.records.ideas.length, 1);
    assert.deepEqual(result.records.research_tasks, []);
    assert.equal(
      result.records.reflection_runs[0].findings[0].code,
      'external-signal-not-checked',
    );
    assert.equal(result.records.usage_summary.reporting_status, 'reported');
    assert.ok(fs.existsSync(path.join(tmp, 'memory', 'observatory', 'reflection-runs.jsonl')));
    assert.ok(fs.existsSync(path.join(tmp, 'memory', 'observatory', 'ideas.jsonl')));
  });
});

test('repeated instrumentation gaps reuse one stable Observatory idea', () => {
  withTempEnv((tmp) => {
    const { buildObservatoryRun } = require('./observatory_loop.js');
    const first = buildObservatoryRun();
    const second = buildObservatoryRun();
    const ideasFile = path.join(tmp, 'memory', 'observatory', 'ideas.jsonl');
    const persistedIdeas = fs.readFileSync(ideasFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(persistedIdeas.length, 1);
    assert.equal(first.records.ideas[0].idea_id, second.records.ideas[0].idea_id);
    assert.equal(first.records.ideas[0].finding_code, 'missing-decision-context');
    assert.equal(first.records.ideas[0].category, 'instrumentation');
    assert.equal(first.records.ideas[0].proposed_action, 'delegate_build');
    assert.match(first.records.ideas[0].title, /Restore ETH Perp Sentinel decision context capture/);
    assert.match(first.records.ideas[0].expected_value, /evidence trail/);
  });
});

test('usageSummary marks empty deterministic runs as not applicable', () => {
  const { usageSummary } = require('./observatory_loop.js');
  assert.deepEqual(usageSummary([]), {
    event_count: 0,
    reporting_status: 'not_applicable',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    providers: [],
    models: [],
  });
});

test('delegated work records are deduped and report active pressure', () => {
  withTempEnv((tmp) => {
    const taskDir = path.join(tmp, '.evolve', 'mcp-self-improvement', 'tasks');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task-1.json'), JSON.stringify({
      task_id: 'task-1',
      status: 'queued',
      created_at: '2026-06-04T10:00:00.000Z',
      spec: 'Build a paper-only volatility check.',
    }));

    const { buildObservatoryRun } = require('./observatory_loop.js');
    const first = buildObservatoryRun();
    const second = buildObservatoryRun();
    const delegatedFile = path.join(tmp, 'memory', 'observatory', 'delegated-work-sessions.jsonl');
    const persisted = fs.readFileSync(delegatedFile, 'utf8').trim().split('\n').filter(Boolean);

    assert.equal(first.records.delegated_work_sessions.length, 1);
    assert.equal(second.records.delegated_work_sessions.length, 1);
    assert.equal(persisted.length, 1);
    assert.equal(first.records.delegation_pressure.unique_sessions, 1);
    assert.equal(first.records.delegation_pressure.active_sessions, 1);
    assert.equal(first.records.delegation_pressure.pressure_level, 'low');
    assert.equal(first.records.delegation_pressure.allows_new_delegation, true);
    assert.deepEqual(first.records.delegation_pressure.deny_reasons, []);
    assert.equal(first.records.delegation_pressure.limits.max_active_delegations, 3);
  });
});
