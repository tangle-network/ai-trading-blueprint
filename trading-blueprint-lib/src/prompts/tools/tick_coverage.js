// Structured coverage findings for deterministic ticks (G4).
//
// When a tick cannot decide because the input window is too thin (e.g. fewer
// candles than an indicator needs), the legacy behavior was a bare silent skip
// — `{ action: 'skip', reason: 'insufficient-candles' }` — which is
// indistinguishable from a deliberate "nothing to do" skip. The eval can't tell
// "the strategy held" from "the strategy was blind", so sparse-data coverage
// holes hide inside the pass rate.
//
// This module turns that silent skip into a STRUCTURED finding that rides along
// the decision (`decision.coverage`) AND is appended to a dedicated coverage
// log the eval reads via tick_artifacts.rs. The finding shape is stable:
//   { finding: 'insufficient_coverage', have: n, need: m, metric, asset?, ... }
//
// Tools call `insufficientCoverage(...)` to build the skip return value (the
// runTick harness then logs it through the normal decision path) and
// `recordCoverageFinding(...)` to persist the finding to the coverage JSONL.

const fs = require('fs');

const COVERAGE_LOG = '/home/agent/logs/tick_coverage.jsonl';

// Build the canonical coverage finding object. `have`/`need` are coerced to
// finite numbers (NaN/undefined => 0) so the shape is always machine-checkable.
function coverageFinding({ have, need, metric, asset, detail } = {}) {
  const finding = {
    finding: 'insufficient_coverage',
    have: toCount(have),
    need: toCount(need),
  };
  if (metric) finding.metric = String(metric);
  if (asset) finding.asset = String(asset);
  if (detail && typeof detail === 'object') finding.detail = detail;
  return finding;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

// Append a coverage finding to the coverage JSONL with a timestamp + tick
// context. Never throws — a coverage log write failure must not crash a tick
// (the finding still rides on the decision via `insufficientCoverage`). The
// directory is created best-effort.
function recordCoverageFinding({ family, asset, have, need, metric, detail, runStartedAt } = {}) {
  const finding = coverageFinding({ have, need, metric, asset, detail });
  const entry = {
    timestamp: new Date().toISOString(),
    family: family ? String(family) : null,
    run_started_at: runStartedAt || null,
    ...finding,
  };
  try {
    fs.mkdirSync('/home/agent/logs', { recursive: true });
    fs.appendFileSync(COVERAGE_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // best-effort: the structured finding still travels on the decision output
  }
  return finding;
}

// One-call replacement for a silent insufficient-data skip. Returns the runTick
// `decide` result shape with the structured finding attached at
// `decision.coverage` (so the decision log + result JSON both carry it) and
// persists the finding to the coverage log. Use this anywhere a tool previously
// returned `{ decision: { action: 'skip', reason: 'insufficient-candles' } }`.
//
//   return insufficientCoverage({
//     family: 'mm', asset, have: closes.length, need: 30, metric: 'candles',
//     reason: 'insufficient-candles', checkedState, metrics, runStartedAt: ctx.runStartedAt,
//   })
function insufficientCoverage({
  family,
  asset,
  have,
  need,
  metric = 'candles',
  reason = 'insufficient-coverage',
  detail,
  checkedState = null,
  metrics,
  entryExtra,
  runStartedAt,
} = {}) {
  const finding = recordCoverageFinding({ family, asset, have, need, metric, detail, runStartedAt });
  return {
    decision: { action: 'skip', reason, coverage: finding, checkedState },
    checkedState,
    ...(metrics !== undefined ? { metrics } : {}),
    entryExtra: { ...(entryExtra || {}), coverage: finding },
  };
}

module.exports = {
  COVERAGE_LOG,
  coverageFinding,
  recordCoverageFinding,
  insufficientCoverage,
};
