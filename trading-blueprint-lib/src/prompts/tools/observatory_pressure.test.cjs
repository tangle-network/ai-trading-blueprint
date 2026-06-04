const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadFresh() {
  const modulePath = require.resolve('./observatory_pressure.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('observatory pressure dedupes sessions and blocks at active cap', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-pressure-'));
  const observatoryDir = path.join(tmp, 'memory', 'observatory');
  fs.mkdirSync(observatoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(observatoryDir, 'delegated-work-sessions.jsonl'),
    [
      JSON.stringify({
        session_id: 'active_1',
        status: 'dispatched',
        source: 'improvement-dispatch',
        created_at: '2026-06-04T00:00:00Z',
      }),
      JSON.stringify({
        session_id: 'active_1',
        status: 'dispatched',
        source: 'improvement-dispatch',
        created_at: '2026-06-04T00:01:00Z',
      }),
      JSON.stringify({
        session_id: 'done_1',
        status: 'backtest_pass',
        source: 'runtime-self-improvement',
        created_at: '2026-06-04T00:02:00Z',
      }),
    ].join('\n'),
  );

  const previousWorkspace = process.env.AGENT_WORKSPACE;
  const previousObservatoryDir = process.env.AGENT_OBSERVATORY_DIR;
  const previousMaxActive = process.env.OBSERVATORY_MAX_ACTIVE_DELEGATIONS;
  const previousMaxCpu = process.env.OBSERVATORY_MAX_CPU_PRESSURE;
  process.env.AGENT_WORKSPACE = tmp;
  process.env.AGENT_OBSERVATORY_DIR = observatoryDir;
  process.env.OBSERVATORY_MAX_ACTIVE_DELEGATIONS = '1';
  process.env.OBSERVATORY_MAX_CPU_PRESSURE = '999';
  try {
    const { readObservatoryPressure } = loadFresh();
    const pressure = readObservatoryPressure();
    assert.equal(pressure.unique_sessions, 2);
    assert.equal(pressure.active_sessions, 1);
    assert.equal(pressure.terminal_sessions, 1);
    assert.equal(pressure.duplicate_rows_removed, 1);
    assert.equal(pressure.allows_new_delegation, false);
    assert.deepEqual(pressure.deny_reasons, ['active_delegation_cap']);

    const relaxed = readObservatoryPressure({ maxActiveDelegations: 3, maxCpuPressure: 999 });
    assert.equal(relaxed.allows_new_delegation, true);
    assert.deepEqual(relaxed.deny_reasons, []);
  } finally {
    if (previousWorkspace === undefined) delete process.env.AGENT_WORKSPACE;
    else process.env.AGENT_WORKSPACE = previousWorkspace;
    if (previousObservatoryDir === undefined) delete process.env.AGENT_OBSERVATORY_DIR;
    else process.env.AGENT_OBSERVATORY_DIR = previousObservatoryDir;
    if (previousMaxActive === undefined) delete process.env.OBSERVATORY_MAX_ACTIVE_DELEGATIONS;
    else process.env.OBSERVATORY_MAX_ACTIVE_DELEGATIONS = previousMaxActive;
    if (previousMaxCpu === undefined) delete process.env.OBSERVATORY_MAX_CPU_PRESSURE;
    else process.env.OBSERVATORY_MAX_CPU_PRESSURE = previousMaxCpu;
  }
});
