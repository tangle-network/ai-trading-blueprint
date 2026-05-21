#!/usr/bin/env node
import {
  runTradingPersonaAgentEvalBridge,
  type TradingPersonaBridgeOptions,
} from '../trading/persona-agent-eval.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

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
