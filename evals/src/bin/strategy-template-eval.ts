#!/usr/bin/env node
import { resolveRepo } from '../lib/repo.js'
import { runStrategyTemplateEval } from '../trading/strategy-template-runner.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputPath = argValue('--out')
const summary = await runStrategyTemplateEval({
  ...(outputPath ? { outputPath: resolveRepo(outputPath) } : {}),
})

console.log(JSON.stringify({
  suite: summary.suite,
  output: summary.output,
  total: summary.total,
  passed: summary.passed,
  failed: summary.failed,
}, null, 2))

if (summary.failed > 0) process.exit(1)
