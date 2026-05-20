#!/usr/bin/env node
// Bridge trading-runtime persona evals into @tangle-network/agent-eval.
//
// Rust owns the deterministic market/backtest math. agent-eval owns the
// analysis-time run records and traces. This adapter keeps that boundary thin.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const traceIndex = process.argv.indexOf('--trace-dir');
const runsIndex = process.argv.indexOf('--runs-jsonl');
const reportPath = resolve(
  repoRoot,
  outIndex >= 0 ? process.argv[outIndex + 1] : `.evolve/evals/trading-agent-personas-${stamp()}.json`,
);
const traceDir = resolve(
  repoRoot,
  traceIndex >= 0 ? process.argv[traceIndex + 1] : '.evolve/agent-eval/traces/trading-personas',
);
const runsJsonl = resolve(
  repoRoot,
  runsIndex >= 0 ? process.argv[runsIndex + 1] : '.evolve/agent-eval/trading-persona-runs.jsonl',
);

const agentEval = await importAgentEval();
const started = Date.now();
run('cargo', ['run', '-p', 'trading-runtime', '--example', 'agent_persona_eval', '--', '--out', reportPath]);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const commitSha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
const { FileSystemTraceStore, TraceEmitter, validateRunRecord } = agentEval;
const store = new FileSystemTraceStore({ dir: traceDir });
mkdirSync(dirname(runsJsonl), { recursive: true });

const records = [];
for (const [index, result] of report.results.entries()) {
  const runId = randomUUID();
  const promptHash = sha256(`${result.persona_id}:${result.scenario_id}`);
  const configHash = sha256({
    suite: report.suite,
    schema_version: report.schema_version,
    score_breakdown: result.score_breakdown,
  });
  const wallMs = Math.max(1, Math.floor((Date.now() - started) / Math.max(1, report.results.length)));
  const record = validateRunRecord({
    runId,
    experimentId: report.suite,
    candidateId: 'trading-runtime-specialist-candidate',
    seed: index,
    model: 'deterministic-trading-runtime@2026-05-21',
    promptHash,
    configHash,
    commitSha,
    wallMs,
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    outcome: {
      searchScore: result.score / 100,
      raw: numericRaw(result),
    },
    failureMode: result.passed ? undefined : firstFindingSubject(result),
    splitTag: normalizeSplit(result.split),
    scenarioId: result.scenario_id,
  });
  records.push(record);
  appendFileSync(runsJsonl, `${JSON.stringify(record)}\n`, 'utf8');
  await writeTrace({ store, TraceEmitter, runId, result, report, commitSha, promptHash, configHash });
}

console.log(JSON.stringify({
  suite: report.suite,
  report: reportPath,
  runs_jsonl: runsJsonl,
  trace_dir: traceDir,
  records: records.length,
  passed: report.passed,
  failed: report.failed,
}, null, 2));

if (report.failed > 0) process.exit(1);

async function importAgentEval() {
  const explicit = process.env.AGENT_EVAL_IMPORT;
  const candidates = [
    explicit,
    '@tangle-network/agent-eval',
    '/Users/drew/webb/agent-eval/dist/index.js',
  ].filter(Boolean);
  const failures = [];
  for (const spec of candidates) {
    try {
      return await import(spec.startsWith('/') ? pathToFileURL(spec).href : spec);
    } catch (error) {
      failures.push(`${spec}: ${error.message}`);
    }
  }
  throw new Error(`Unable to import @tangle-network/agent-eval. Tried:\n${failures.join('\n')}`);
}

async function writeTrace({ store, TraceEmitter, runId, result, report, commitSha, promptHash, configHash }) {
  const emitter = new TraceEmitter(store, { runId });
  await emitter.startRun({
    scenarioId: result.scenario_id,
    variantId: 'trading-runtime-specialist-candidate',
    codeSha: commitSha,
    promptSha: promptHash,
    modelFingerprint: 'deterministic-trading-runtime@2026-05-21',
    layer: 'app-runtime',
    tags: {
      suite: report.suite,
      persona_id: result.persona_id,
      split: result.split,
      config_hash: configHash,
    },
  });
  const span = await emitter.tool({
    name: 'trading-runtime backtest walk-forward compare',
    toolName: 'trading_runtime.backtest.walk_forward_compare',
    args: {
      persona_id: result.persona_id,
      scenario_id: result.scenario_id,
    },
  });
  await span.end({
    result: {
      passed: result.passed,
      score: result.score,
      promotion_recommended: result.promotion_recommended,
      gates: result.deterministic_gates,
      findings: result.findings,
    },
    latencyMs: 0,
  });
  await emitter.recordArtifact({
    kind: 'json',
    uri: reportPath,
    sha256: sha256(readFileSync(reportPath, 'utf8')),
    metadata: { suite: report.suite },
  });
  await emitter.endRun({
    pass: result.passed,
    score: result.score / 100,
    failureClass: result.passed ? undefined : 'verification',
    notes: result.findings.map((f) => f.message).join('\n') || undefined,
  });
}

function numericRaw(result) {
  return {
    passed: result.passed ? 1 : 0,
    score: result.score / 100,
    promotion_recommended: result.promotion_recommended ? 1 : 0,
    train_candidate_return_pct: result.train_candidate_return_pct,
    test_candidate_return_pct: result.test_candidate_return_pct,
    train_candidate_sharpe: result.train_candidate_sharpe,
    test_candidate_sharpe: result.test_candidate_sharpe,
    train_candidate_drawdown_pct: result.train_candidate_drawdown_pct,
    test_candidate_drawdown_pct: result.test_candidate_drawdown_pct,
    test_trade_count: result.test_trade_count,
    sharpe_ratio_decay: result.sharpe_ratio_decay,
  };
}

function firstFindingSubject(result) {
  return result.findings?.[0]?.subject;
}

function normalizeSplit(split) {
  return split === 'holdout' || split === 'search' || split === 'dev' ? split : 'dev';
}

function sha256(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
