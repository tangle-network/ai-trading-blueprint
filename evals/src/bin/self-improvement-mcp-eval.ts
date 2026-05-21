#!/usr/bin/env node
import { resolveRepo } from '../lib/repo.js'
import { hasBun, runSelfImprovementMcpEval } from '../self-improvement/mcp-eval.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (!hasBun()) {
  throw new Error('bun is required to launch trading-blueprint-lib self_improvement_mcp_server.ts')
}

const outputPath = argValue('--out')
const summary = await runSelfImprovementMcpEval({
  ...(outputPath ? { outputPath: resolveRepo(outputPath) } : {}),
  skipOpencode: process.argv.includes('--skip-opencode'),
})

console.log(JSON.stringify(summary, null, 2))
if (summary.failed > 0) process.exit(1)
