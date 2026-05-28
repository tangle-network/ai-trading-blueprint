/**
 * Trading-persona bridge — drives `runPersonaSuite` (Rust persona eval),
 * folds each result into a paper-grade `RunRecord`, captures spans via
 * `TraceEmitter` + `FileSystemTraceStore`, AND now feeds the scorecard
 * timeline so `diffScorecard` flags regressions across commits (the
 * pattern creative-agent uses).
 *
 * Migrated off the dynamic-import shim — direct imports against the
 * `@tangle-network/agent-eval` 0.45+ surface. The dispatch + scoring are
 * unchanged; the wiring is the modern shape.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  FileSystemTraceStore,
  TraceEmitter,
  type RunRecord,
  validateRunRecord,
} from '@tangle-network/agent-eval'

import { sha256 } from '../lib/crypto.js'
import { isoStamp, resolveRepo } from '../lib/repo.js'
import { currentCommitSha, runPersonaSuite } from './persona-runner.js'
import { normalizeSplit, numericRaw, type PersonaEvalResult } from './persona-types.js'
import {
  buildTradingScorecardAgentProfile,
  recordScorecardAndDiff,
  type ScorecardWiringResult,
} from './scorecard-integration.js'

const MODEL_FINGERPRINT = 'deterministic-trading-runtime@2026-05-21'
const VENUES = ['hyperliquid', 'binance', 'coinbase', 'drift', 'aerodrome', 'polymarket']
const FEE_SCHEDULE_VERSION = 'protocol-fees@2026-05'
const SURFACE_VERSION = 1
const RUNTIME_VERSION = '0.1.0'

export interface TradingPersonaBridgeOptions {
  reportPath?: string
  traceDir?: string
  runsJsonl?: string
  scorecardPath?: string
  failOnRegression?: boolean
}

export interface TradingPersonaBridgeSummary {
  suite: string
  report: string
  runs_jsonl: string
  trace_dir: string
  scorecard: {
    path: string
    appendedCells: number
    profileHash: string
    regressed: boolean
    formatted: string
  }
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
  const scorecardPath = resolveRepo(
    options.scorecardPath ?? '.evolve/agent-eval/scorecards/trading-personas.jsonl',
  )

  const started = Date.now()
  const report = runPersonaSuite(reportPath)
  const commitSha = currentCommitSha()
  const store = new FileSystemTraceStore({ dir: traceDir })
  mkdirSync(dirname(runsJsonl), { recursive: true })
  mkdirSync(dirname(scorecardPath), { recursive: true })

  const profile = buildTradingScorecardAgentProfile({
    surfaceVersion: SURFACE_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    venues: VENUES,
    feeScheduleVersion: FEE_SCHEDULE_VERSION,
    model: MODEL_FINGERPRINT,
  })

  const collectedRuns: RunRecord[] = []
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
    const record = validateRunRecord({
      runId,
      experimentId: report.suite,
      candidateId: 'trading-runtime-specialist-candidate',
      seed: index,
      model: MODEL_FINGERPRINT,
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
    }) as RunRecord
    collectedRuns.push(record)
    appendFileSync(runsJsonl, `${JSON.stringify(record)}\n`, 'utf8')
    await writeTrace({ store, runId, result, reportPath, suite: report.suite, commitSha, promptHash, configHash })
    records += 1
  }

  const scorecard: ScorecardWiringResult = recordScorecardAndDiff({
    scorecardPath,
    runs: collectedRuns,
    profile,
    commitSha,
  })

  const summary: TradingPersonaBridgeSummary = {
    suite: report.suite,
    report: reportPath,
    runs_jsonl: runsJsonl,
    trace_dir: traceDir,
    scorecard: {
      path: scorecardPath,
      appendedCells: scorecard.appendedCells,
      profileHash: scorecard.profileHash,
      regressed: scorecard.regressed,
      formatted: scorecard.formatted,
    },
    records,
    passed: report.passed,
    failed: report.failed,
  }

  if (options.failOnRegression && scorecard.regressed) {
    throw new Error(
      `trading-persona scorecard reports regression on at least one cell. Diff:\n${scorecard.formatted}`,
    )
  }
  return summary
}

async function writeTrace(input: {
  store: FileSystemTraceStore
  runId: string
  result: PersonaEvalResult
  reportPath: string
  suite: string
  commitSha: string
  promptHash: string
  configHash: string
}): Promise<void> {
  const { store, runId, result, reportPath, suite, commitSha, promptHash, configHash } = input
  const emitter = new TraceEmitter(store, { runId })
  await emitter.startRun({
    scenarioId: result.scenario_id,
    variantId: 'trading-runtime-specialist-candidate',
    codeSha: commitSha,
    promptSha: promptHash,
    modelFingerprint: MODEL_FINGERPRINT,
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
  const reportBytes = readFileSync(reportPath, 'utf8')
  await emitter.recordArtifact({
    contentType: 'application/json',
    sizeBytes: Buffer.byteLength(reportBytes, 'utf8'),
    hash: sha256(reportBytes).replace(/^sha256:/, ''),
    storageUrl: reportPath,
  })
  const failureClass = result.passed ? 'success' : 'instruction_following'
  const notes = result.findings.map((finding) => finding.message).join('\n')
  await emitter.endRun({
    pass: result.passed,
    score: result.score / 100,
    failureClass,
    ...(notes ? { notes } : {}),
  })
}
