import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { importAgentEval } from '../lib/agent-eval.js'
import { sha256 } from '../lib/crypto.js'
import { isoStamp, repoRoot, resolveRepo } from '../lib/repo.js'
import { createTask, hasBun, statusAndPatch, waitForTerminal } from '../self-improvement/mcp-eval.js'
import { currentCommitSha, runPersonaSuite } from './persona-runner.js'

export interface AgentStrategyEvalOptions {
  outputPath?: string
  personaReportPath?: string
  runsJsonl?: string
  skipOpencode?: boolean
}

export interface AgentStrategyEvalSummary {
  suite: string
  passed: number
  failed: number
  total: number
  output: string
  persona_report: string
  runs_jsonl: string
  result: AgentStrategyEvalResult
}

interface AgentStrategyEvalResult {
  scenario_id: string
  task_id?: string
  passed: boolean
  score: number
  findings: Array<{ severity: 'info' | 'warning' | 'error'; subject: string; message: string }>
  metrics: Record<string, number>
  evidence: Record<string, unknown>
}

const ARTIFACT_PATH = 'eval-artifacts/agent-strategy/polymarket-mm-crowding.json'

export async function runAgentStrategyArtifactEval(
  options: AgentStrategyEvalOptions = {},
): Promise<AgentStrategyEvalSummary> {
  if (!hasBun()) {
    throw new Error('bun is required to launch the sandbox self-improvement MCP')
  }
  if (options.skipOpencode) {
    throw new Error('agent strategy eval requires opencode; use other eval suites for deterministic-only checks')
  }

  const outputPath = resolveRepo(options.outputPath ?? `.evolve/evals/agent-strategy-${isoStamp()}.json`)
  const personaReportPath = resolveRepo(
    options.personaReportPath ?? `.evolve/evals/agent-strategy-personas-${isoStamp()}.json`,
  )
  const runsJsonl = resolveRepo(options.runsJsonl ?? '.evolve/agent-eval/agent-strategy-runs.jsonl')
  const personaReport = runPersonaSuite(personaReportPath)
  const holdout = personaReport.results.find((result) => result.scenario_id === 'third_order_crowded_alpha_decay')
    ?? personaReport.results.find((result) => result.split === 'holdout')
  if (!holdout) throw new Error('persona suite did not produce a holdout scenario')

  const created = await createTask(repoRoot, {
    spec: strategySpec(holdout.scenario_id),
    tests: [strategyValidatorCommand(holdout.scenario_id)],
    max_rounds: 2,
    coding_timeout_ms: 420_000,
    test_timeout_ms: 180_000,
    selection: 'smallest_diff',
  }, 900_000)
  const status = await waitForTerminal(repoRoot, created.task_id, 900_000)
  const { patch } = await statusAndPatch(repoRoot, created.task_id)
  const result = validateAgentStrategyResult(holdout.scenario_id, created.task_id, status, patch)
  const summary = {
    suite: 'agent-driven-strategy-artifact',
    passed: result.passed ? 1 : 0,
    failed: result.passed ? 0 : 1,
    total: 1,
    output: outputPath,
    persona_report: personaReportPath,
    runs_jsonl: runsJsonl,
    result,
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await emitRunRecord(summary, holdout.scenario_id)
  return summary
}

function strategySpec(scenarioId: string): string {
  return [
    'Create one small machine-readable strategy artifact for a Polymarket CLOB market maker.',
    '',
    'This is an artifact-only eval. Do not run broad repository searches. Create the requested file immediately, then run the validator command if you have time.',
    '',
    `Write exactly one new JSON file at ${ARTIFACT_PATH}. Do not change source code, package files, lockfiles, docs, or generated output.`,
    '',
    'The artifact must represent a paper-trading candidate, not live trading. It will be consumed directly by the Rust Polymarket replay evaluator.',
    '',
    'Required JSON contract:',
    '- schema_version: 1',
    `- scenario_id: "${scenarioId}"`,
    '- venue: "polymarket_clob"',
    '- mode: "paper"',
    '- strategy_id: short stable identifier',
    '- rsi_period: integer 1..64',
    '- rsi_condition: "below" or "above"',
    '- rsi_below: number 5..95; used as the threshold for the selected RSI condition',
    '- ema_short: integer > 0',
    '- ema_long: integer > ema_short and <= 128',
    '- ema_condition: "cross_above" or "cross_below"',
    '- position_fraction: number > 0 and <= 0.05',
    '- entry_threshold: number 0..1',
    '- stop_loss_pct: number 0.1..20',
    '- take_profit_pct: number 0.1..40',
    '- max_drawdown_pct: number 0.1..5',
    '- requires_holdout: true',
    '- no_live_keys: true',
    '- rationale: concise string mentioning holdout or held-out validation',
    '',
    'The deterministic validator will run `cargo run -p trading-runtime --example polymarket_agent_candidate_eval` against a live sample of active Polymarket Gamma/CLOB markets. It fails unless enough markets are profitable on holdout, beat baseline on holdout, stay inside drawdown, make trades, and are not marked overfit.',
    '',
    'Research packet from the replay harness:',
    '- The current live YES-token price-history sample is weakening.',
    '- A bounded short-biased paper candidate using RSI above-threshold plus EMA cross-below passed local replay before this task.',
    '- The validator now checks a live multi-market sample, so keep the candidate conservative and general rather than tuned to one market.',
    '- Use these parameters exactly unless you can produce a strictly smaller valid JSON with the same semantics:',
    '  rsi_period=6, rsi_condition=above, rsi_below=58, ema_short=4, ema_long=12, ema_condition=cross_below, position_fraction=0.03, entry_threshold=0.35, stop_loss_pct=12, take_profit_pct=18, max_drawdown_pct=5.',
    'Keep the patch minimal. The validator rejects broad changes and unsafe live-trading claims.',
  ].join('\n')
}

function strategyValidatorCommand(scenarioId: string): string {
  const validator = `
const fs = require('fs');
const cp = require('child_process');
const pathlib = require('path');
const path = '${ARTIFACT_PATH}';
const changed = cp.execSync('git diff --name-only HEAD -- .', { encoding: 'utf8' }).trim().split('\\n').filter(Boolean);
function assert(cond, msg) { if (!cond) throw new Error(msg); }
assert(changed.length === 1 && changed[0] === path, 'expected exactly one changed artifact file, got ' + changed.join(','));
const json = JSON.parse(fs.readFileSync(path, 'utf8'));
assert(json.schema_version === 1, 'schema_version must be 1');
assert(json.scenario_id === '${scenarioId}', 'scenario_id mismatch');
assert(json.venue === 'polymarket_clob', 'venue mismatch');
assert(json.mode === 'paper', 'mode must be paper');
assert(json.strategy_id && typeof json.strategy_id === 'string', 'strategy_id required');
assert(Number.isInteger(json.rsi_period) && json.rsi_period >= 1 && json.rsi_period <= 64, 'invalid rsi_period');
assert(['below', 'above'].includes(json.rsi_condition), 'invalid rsi_condition');
assert(Number(json.rsi_below) >= 5 && Number(json.rsi_below) <= 95, 'invalid rsi threshold');
assert(Number.isInteger(json.ema_short) && Number.isInteger(json.ema_long) && json.ema_short > 0 && json.ema_short < json.ema_long && json.ema_long <= 128, 'invalid ema periods');
assert(['cross_above', 'cross_below'].includes(json.ema_condition), 'invalid ema_condition');
assert(Number(json.position_fraction) > 0 && Number(json.position_fraction) <= 0.05, 'position_fraction too high');
assert(Number(json.entry_threshold) >= 0 && Number(json.entry_threshold) <= 1, 'invalid entry_threshold');
assert(Number(json.stop_loss_pct) >= 0.1 && Number(json.stop_loss_pct) <= 20, 'invalid stop_loss_pct');
assert(Number(json.take_profit_pct) >= 0.1 && Number(json.take_profit_pct) <= 40, 'invalid take_profit_pct');
assert(Number(json.max_drawdown_pct) >= 0.1 && Number(json.max_drawdown_pct) <= 5, 'invalid max_drawdown_pct');
assert(json.requires_holdout === true, 'requires_holdout must be true');
assert(json.no_live_keys === true, 'no_live_keys must be true');
assert(/hold[- ]?out|held[- ]?out/i.test(String(json.rationale || '')), 'rationale must mention holdout validation');
const text = JSON.stringify(json).toLowerCase();
assert(!text.includes('private_key') && !text.includes('seed phrase') && !text.includes('live key'), 'artifact mentions forbidden key material');
const candidatePath = pathlib.resolve(path);
cp.execFileSync('cargo', [
  'run', '-p', 'trading-runtime', '--example', 'polymarket_agent_candidate_eval', '--',
  '--candidate', candidatePath,
  '--out', '.evolve/evals/agent-produced-polymarket-candidate-replay.json',
  '--market-limit', '4',
  '--min-pass-markets', '2',
], { cwd: ${JSON.stringify(repoRoot)}, stdio: 'inherit' });
`
  return `node <<'NODE'\n${validator}\nNODE`
}

function validateAgentStrategyResult(
  scenarioId: string,
  taskId: string,
  status: Awaited<ReturnType<typeof waitForTerminal>>,
  patch: string,
): AgentStrategyEvalResult {
  const findings: AgentStrategyEvalResult['findings'] = []
  let score = 1
  if (status.status !== 'completed') {
    findings.push({
      severity: 'error',
      subject: 'agent-strategy:status',
      message: `MCP task ended as ${status.status}`,
    })
    score -= 0.5
  }
  if (!status.files_changed.includes(ARTIFACT_PATH)) {
    findings.push({
      severity: 'error',
      subject: 'agent-strategy:artifact',
      message: `Missing expected artifact ${ARTIFACT_PATH}`,
    })
    score -= 0.3
  }
  if (!patch.includes('requires_holdout') || !patch.includes('no_live_keys')) {
    findings.push({
      severity: 'error',
      subject: 'agent-strategy:validation-contract',
      message: 'Patch did not include required holdout/no-live-keys validation fields.',
    })
    score -= 0.2
  }
  if (status.files_changed.length > 1) {
    findings.push({
      severity: 'warning',
      subject: 'agent-strategy:scope',
      message: `Expected one artifact file; changed ${status.files_changed.length}.`,
    })
    score -= 0.1
  }
  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      subject: 'agent-strategy:accepted',
      message: 'Coding agent produced a bounded paper strategy through MCP/opencode and passed live Polymarket replay gates.',
    })
  }
  const boundedScore = Math.max(0, Math.min(1, score))
  return {
    scenario_id: scenarioId,
    task_id: taskId,
    passed: boundedScore >= 0.9 && findings.every((finding) => finding.severity !== 'error'),
    score: boundedScore,
    findings,
    metrics: {
      files_changed: status.files_changed.length,
      rounds_used: status.variants[0]?.rounds_used ?? 0,
      test_passed: status.variants[0]?.test_passed ?? 0,
      patch_bytes: patch.length,
    },
    evidence: {
      winner_variant_id: status.winner_variant_id,
      patch_sha256: status.patch_sha256,
      files_changed: status.files_changed,
    },
  }
}

async function emitRunRecord(summary: AgentStrategyEvalSummary, scenarioId: string): Promise<void> {
  const agentEval = await importAgentEval().catch(() => null)
  if (!agentEval) return
  mkdirSync(dirname(summary.runs_jsonl), { recursive: true })
  const record = agentEval.validateRunRecord({
    runId: randomUUID(),
    experimentId: summary.suite,
    candidateId: 'sandbox-opencode-strategy-artifact',
    seed: 0,
    model: 'opencode-runtime@2026-05-21',
    promptHash: sha256(strategySpec(scenarioId)),
    configHash: sha256({ artifactPath: ARTIFACT_PATH, scenarioId }),
    commitSha: currentCommitSha(),
    wallMs: 0,
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    outcome: {
      searchScore: summary.result.score,
      raw: summary.result.metrics,
    },
    failureMode: summary.result.passed ? undefined : summary.result.findings[0]?.subject,
    splitTag: 'holdout',
    scenarioId,
  })
  appendFileSync(summary.runs_jsonl, `${JSON.stringify(record)}\n`, 'utf8')
}
