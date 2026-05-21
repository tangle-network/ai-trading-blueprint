#!/usr/bin/env node
import { isoStamp, resolveRepo } from '../lib/repo.js'
import { runTradingLifecycleEval } from '../trading/lifecycle-runner.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputPath = resolveRepo(argValue('--out') ?? `.evolve/evals/trading-lifecycle-${isoStamp()}.json`)
const personaReportPath = resolveRepo(
  argValue('--persona-report') ?? `.evolve/evals/trading-lifecycle-personas-${isoStamp()}.json`,
)
const feedbackJsonlPath = resolveRepo(argValue('--feedback-jsonl') ?? '.evolve/agent-eval/trading-lifecycle-feedback.jsonl')

const summary = await runTradingLifecycleEval({ outputPath, personaReportPath, feedbackJsonlPath })
console.log(JSON.stringify({
  suite: summary.suite,
  output: summary.output,
  feedback_jsonl: summary.feedback_jsonl,
  total: summary.total,
  passed: summary.passed,
  failed: summary.failed,
}, null, 2))

if (summary.failed > 0) process.exit(1)
