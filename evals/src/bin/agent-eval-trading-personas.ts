#!/usr/bin/env node
import {
  runTradingPersonaAgentEvalBridge,
  type TradingPersonaBridgeOptions,
} from '../trading/persona-agent-eval.js'
import {
  runTradingProfileMatrix,
  type TradingProfileMatrixOptions,
} from '../trading/persona-profile-matrix.js'
import type { LlmModel } from '../sim/llm-call.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

// MATRIX path: sweep the PROFILE axis (model variants) × persona scenarios via
// `runProfileMatrix`. Opt-in via `TRADING_PERSONA_MATRIX=1` or `--matrix`.
if (process.env.TRADING_PERSONA_MATRIX === '1' || hasFlag('--matrix')) {
  const options: TradingProfileMatrixOptions = {}
  const runDir = argValue('--run-dir')
  const scorecard = argValue('--scorecard')
  const reps = argValue('--reps')
  const models = argValue('--models')
  const costCeiling = argValue('--cost-ceiling')
  if (runDir) options.runDir = runDir
  if (scorecard) options.scorecardPath = scorecard
  if (reps) options.reps = Number(reps)
  if (models) options.models = models.split(',').map((m) => m.trim()) as LlmModel[]
  if (costCeiling) options.costCeiling = Number(costCeiling)
  // 'warn' lets a dry run proceed without LLM keys; default 'assert' fails loud
  // when a profile ran stub (the matrix would otherwise report a blind board).
  if (process.env.TRADING_PERSONA_MATRIX_INTEGRITY === 'warn') options.integrity = 'warn'

  const summary = await runTradingProfileMatrix(options)
  console.log(JSON.stringify(summary, null, 2))
  // Non-zero exit when any profile ran stub or no profile cleared the suite gate.
  const blind = summary.integrity.verdict === 'stub'
  const noWinner = summary.best === null
  if (blind || noWinner) process.exit(1)
} else {
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
