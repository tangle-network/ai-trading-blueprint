import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { importAgentEval } from '../lib/agent-eval.js'
import { sha256 } from '../lib/crypto.js'
import { isoStamp, resolveRepo } from '../lib/repo.js'
import { currentCommitSha, runPersonaSuite } from './persona-runner.js'
import { normalizeSplit, numericRaw, type PersonaEvalResult } from './persona-types.js'

export interface TradingPersonaBridgeOptions {
  reportPath?: string
  traceDir?: string
  runsJsonl?: string
}

export interface TradingPersonaBridgeSummary {
  suite: string
  report: string
  runs_jsonl: string
  trace_dir: string
  records: number
  passed: number
  failed: number
}

export async function runTradingPersonaAgentEvalBridge(
  options: TradingPersonaBridgeOptions = {},
): Promise<TradingPersonaBridgeSummary> {
  const reportPath = resolveRepo(
    options.reportPath ?? `.evolve/evals/trading-agent-personas-${isoStamp()}.json`,
  )
  const traceDir = resolveRepo(options.traceDir ?? '.evolve/agent-eval/traces/trading-personas')
  const runsJsonl = resolveRepo(options.runsJsonl ?? '.evolve/agent-eval/trading-persona-runs.jsonl')

  const agentEval = await importAgentEval()
  const started = Date.now()
  const report = runPersonaSuite(reportPath)
  const commitSha = currentCommitSha()
  const store = new agentEval.FileSystemTraceStore({ dir: traceDir })
  mkdirSync(dirname(runsJsonl), { recursive: true })

  let records = 0
  for (const [index, result] of report.results.entries()) {
    const runId = randomUUID()
    const promptHash = sha256(`${result.persona_id}:${result.scenario_id}`)
    const configHash = sha256({
      suite: report.suite,
      schema_version: report.schema_version,
      score_breakdown: result.score_breakdown,
    })
    const wallMs = Math.max(1, Math.floor((Date.now() - started) / Math.max(1, report.results.length)))
    const record = agentEval.validateRunRecord({
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
      failureMode: result.passed ? undefined : result.findings[0]?.subject,
      splitTag: normalizeSplit(result.split),
      scenarioId: result.scenario_id,
    })
    appendFileSync(runsJsonl, `${JSON.stringify(record)}\n`, 'utf8')
    await writeTrace({ agentEval, store, runId, result, reportPath, suite: report.suite, commitSha, promptHash, configHash })
    records += 1
  }

  return {
    suite: report.suite,
    report: reportPath,
    runs_jsonl: runsJsonl,
    trace_dir: traceDir,
    records,
    passed: report.passed,
    failed: report.failed,
  }
}

async function writeTrace(input: {
  agentEval: Awaited<ReturnType<typeof importAgentEval>>
  store: unknown
  runId: string
  result: PersonaEvalResult
  reportPath: string
  suite: string
  commitSha: string
  promptHash: string
  configHash: string
}): Promise<void> {
  const { agentEval, store, runId, result, reportPath, suite, commitSha, promptHash, configHash } = input
  const emitter = new agentEval.TraceEmitter(store, { runId })
  await emitter.startRun({
    scenarioId: result.scenario_id,
    variantId: 'trading-runtime-specialist-candidate',
    codeSha: commitSha,
    promptSha: promptHash,
    modelFingerprint: 'deterministic-trading-runtime@2026-05-21',
    layer: 'app-runtime',
    tags: {
      suite,
      persona_id: result.persona_id,
      split: result.split,
      config_hash: configHash,
    },
  })
  const span = await emitter.tool({
    name: 'trading-runtime backtest walk-forward compare',
    toolName: 'trading_runtime.backtest.walk_forward_compare',
    args: {
      persona_id: result.persona_id,
      scenario_id: result.scenario_id,
    },
  })
  await span.end({
    result: {
      passed: result.passed,
      score: result.score,
      promotion_recommended: result.promotion_recommended,
      gates: result.deterministic_gates,
      findings: result.findings,
    },
    latencyMs: 0,
  })
  await emitter.recordArtifact({
    kind: 'json',
    uri: reportPath,
    sha256: sha256(readFileSync(reportPath, 'utf8')),
    metadata: { suite },
  })
  await emitter.endRun({
    pass: result.passed,
    score: result.score / 100,
    failureClass: result.passed ? undefined : 'verification',
    notes: result.findings.map((finding) => finding.message).join('\n') || undefined,
  })
}
