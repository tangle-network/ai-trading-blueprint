#!/usr/bin/env node
import { resolveRepo } from '../lib/repo.js'
import { runFullEval } from '../full/full-eval-runner.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputPath = argValue('--out')
const summary = await runFullEval({
  ...(outputPath ? { outputPath: resolveRepo(outputPath) } : {}),
  livePolymarket: process.argv.includes('--live-polymarket'),
})

console.log(JSON.stringify({
  suite: summary.suite,
  output: summary.output,
  total: summary.total,
  passed: summary.passed,
  failed: summary.failed,
  duration_ms: summary.duration_ms,
}, null, 2))

if (summary.failed > 0) process.exit(1)
