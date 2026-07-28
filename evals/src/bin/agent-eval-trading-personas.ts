#!/usr/bin/env node
import { runTradingPersonaEval, type TradingPersonaEvalOptions } from '../trading/persona-agent-eval.js'
import type { LlmModel } from '../sim/llm-call.js'
import { argValue, dollarArg } from './trading-persona-cli.js'

// One entry point. With --operator-url (or OPERATOR_API_URL/OPERATOR_URL set) it
// runs the real operator profile × persona matrix (real bot artifacts + tick
// side-effects, scored against the objective backtest); without it, the
// deterministic walk-forward backtest. Same surface, degrades by infra.
const options: TradingPersonaEvalOptions = {}
const reportPath = argValue(process.argv, '--out')
const traceDir = argValue(process.argv, '--trace-dir')
const runsJsonl =
  argValue(process.argv, '--runs-jsonl') ?? argValue(process.argv, '--runs')
const scorecard = argValue(process.argv, '--scorecard')
const operatorUrl = argValue(process.argv, '--operator-url')
const models = argValue(process.argv, '--models')
const reps = argValue(process.argv, '--reps')
const maxTurns = argValue(process.argv, '--max-turns')
const costCeiling = dollarArg(process.argv, '--cost-ceiling')
const providerCellCostLimit = dollarArg(process.argv, '--provider-cell-cost-limit')
if (reportPath) options.reportPath = reportPath
if (traceDir) options.traceDir = traceDir
if (runsJsonl) options.runsJsonl = runsJsonl
if (scorecard) options.scorecardPath = scorecard
if (operatorUrl) options.operatorUrl = operatorUrl
if (models) options.models = models.split(',').map((m) => m.trim()) as LlmModel[]
if (reps) options.reps = Number(reps)
if (maxTurns) options.maxTurnsPerShot = Number(maxTurns)
if (costCeiling !== undefined) options.costCeiling = costCeiling
if (providerCellCostLimit !== undefined) {
  options.providerCellCostLimit = providerCellCostLimit
}
if (process.env.TRADING_PERSONA_MATRIX_INTEGRITY === 'warn') options.integrity = 'warn'

const summary = await runTradingPersonaEval(options)
console.log(JSON.stringify(summary, null, 2))

if (summary.mode === 'operator-matrix') {
  if (summary.integrity?.verdict === 'stub' || summary.best === null) process.exit(1)
} else if ((summary.failed ?? 0) > 0) {
  process.exit(1)
}
