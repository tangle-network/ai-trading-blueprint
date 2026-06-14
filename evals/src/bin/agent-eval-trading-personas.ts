#!/usr/bin/env node
import { runTradingPersonaEval, type TradingPersonaEvalOptions } from '../trading/persona-agent-eval.js'
import type { LlmModel } from '../sim/llm-call.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

// One entry point. With --operator-url (or OPERATOR_API_URL/OPERATOR_URL set) it
// runs the real operator profile × persona matrix (real bot artifacts + tick
// side-effects, scored against the objective backtest); without it, the
// deterministic walk-forward backtest. Same surface, degrades by infra.
const options: TradingPersonaEvalOptions = {}
const reportPath = argValue('--out')
const traceDir = argValue('--trace-dir')
const runsJsonl = argValue('--runs-jsonl') ?? argValue('--runs')
const scorecard = argValue('--scorecard')
const operatorUrl = argValue('--operator-url')
const models = argValue('--models')
const reps = argValue('--reps')
const maxTurns = argValue('--max-turns')
const costCeiling = argValue('--cost-ceiling')
if (reportPath) options.reportPath = reportPath
if (traceDir) options.traceDir = traceDir
if (runsJsonl) options.runsJsonl = runsJsonl
if (scorecard) options.scorecardPath = scorecard
if (operatorUrl) options.operatorUrl = operatorUrl
if (models) options.models = models.split(',').map((m) => m.trim()) as LlmModel[]
if (reps) options.reps = Number(reps)
if (maxTurns) options.maxTurnsPerShot = Number(maxTurns)
if (costCeiling) options.costCeiling = Number(costCeiling)
if (process.env.TRADING_PERSONA_MATRIX_INTEGRITY === 'warn') options.integrity = 'warn'

const summary = await runTradingPersonaEval(options)
console.log(JSON.stringify(summary, null, 2))

if (summary.mode === 'operator-matrix') {
  if (summary.integrity?.verdict === 'stub' || summary.best === null) process.exit(1)
} else if ((summary.failed ?? 0) > 0) {
  process.exit(1)
}
