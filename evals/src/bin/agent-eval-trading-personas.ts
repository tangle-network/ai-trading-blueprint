#!/usr/bin/env node
import {
  runTradingPersonaAgentEvalBridge,
  type TradingPersonaBridgeOptions,
} from '../trading/persona-agent-eval.js'
import {
  runUnifiedTradingMatrix,
  type UnifiedMatrixOptions,
} from '../trading/unified-trading-matrix.js'
import type { LlmModel } from '../sim/llm-call.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

// UNIFIED MATRIX path — the ONE trading eval. Sweeps the PROFILE axis (operator
// model variants) × (persona × market) scenarios via `runProfileMatrix`, where
// each cell runs the REAL operator simulation and is scored on real artifacts
// COMBINED with the objective backtest ground truth. Opt-in via
// `TRADING_UNIFIED_MATRIX=1` or `--matrix`. Needs live operator infra + keys.
if (process.env.TRADING_UNIFIED_MATRIX === '1' || hasFlag('--matrix')) {
  const options: UnifiedMatrixOptions = {}
  const runDir = argValue('--run-dir')
  const scorecard = argValue('--scorecard')
  const reps = argValue('--reps')
  const models = argValue('--models')
  const costCeiling = argValue('--cost-ceiling')
  const maxTurns = argValue('--max-turns')
  const operatorUrl = argValue('--operator-url')
  if (runDir) options.runDir = runDir
  if (scorecard) options.scorecardPath = scorecard
  if (reps) options.reps = Number(reps)
  if (models) options.models = models.split(',').map((m) => m.trim()) as LlmModel[]
  if (costCeiling) options.costCeiling = Number(costCeiling)
  if (maxTurns) options.maxTurnsPerShot = Number(maxTurns)
  if (operatorUrl) options.operatorUrl = operatorUrl
  // 'warn' lets a dry run proceed without LLM keys; default 'assert' fails loud
  // when a profile ran stub (the matrix would otherwise report a blind board).
  if (process.env.TRADING_UNIFIED_MATRIX_INTEGRITY === 'warn') options.integrity = 'warn'

  const summary = await runUnifiedTradingMatrix(options)
  console.log(JSON.stringify(summary, null, 2))
  // Non-zero exit when any profile ran stub or no profile cleared the gate.
  const blind = summary.integrity.verdict === 'stub'
  const noWinner = summary.best === null
  if (blind || noWinner) process.exit(1)
} else {
  // BACK-COMPAT: the original single-profile deterministic bridge. Kept so
  // existing callers / `eval:trading-personas` keep working unchanged.
  const options: TradingPersonaBridgeOptions = {}
  const reportPath = argValue('--out')
  const traceDir = argValue('--trace-dir')
  const runsJsonl = argValue('--runs-jsonl') ?? argValue('--runs')
  if (reportPath) options.reportPath = reportPath
  if (traceDir) options.traceDir = traceDir
  if (runsJsonl) options.runsJsonl = runsJsonl

  const summary = await runTradingPersonaAgentEvalBridge(options)
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failed > 0) process.exit(1)
}
