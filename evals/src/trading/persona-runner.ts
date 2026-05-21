import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { run } from '../lib/process.js'
import type { PersonaEvalSuiteReport } from './persona-types.js'

export function runPersonaSuite(reportPath: string): PersonaEvalSuiteReport {
  mkdirSync(dirname(reportPath), { recursive: true })
  run('cargo', ['run', '-p', 'trading-runtime', '--example', 'agent_persona_eval', '--', '--out', reportPath])
  return JSON.parse(readFileSync(reportPath, 'utf8')) as PersonaEvalSuiteReport
}

export function currentCommitSha(): string {
  return run('git', ['rev-parse', 'HEAD']).stdout.trim()
}
