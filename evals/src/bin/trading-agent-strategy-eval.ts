#!/usr/bin/env node
import { resolveRepo } from '../lib/repo.js'
import { runAgentStrategyArtifactEval } from '../trading/agent-strategy-runner.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputPath = argValue('--out')
const personaReportPath = argValue('--persona-report')
const runsJsonl = argValue('--runs-jsonl')
const summary = await runAgentStrategyArtifactEval({
  ...(outputPath ? { outputPath: resolveRepo(outputPath) } : {}),
  ...(personaReportPath ? { personaReportPath: resolveRepo(personaReportPath) } : {}),
  ...(runsJsonl ? { runsJsonl: resolveRepo(runsJsonl) } : {}),
  skipOpencode: process.argv.includes('--skip-opencode'),
})

console.log(JSON.stringify(summary, null, 2))
if (summary.failed > 0) process.exit(1)
