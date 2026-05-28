/**
 * Persona-eval suite entry point — pure TypeScript path, no `cargo run`.
 *
 * The 11 hardcoded scenarios used to live in `trading-runtime/src/evals/
 * agent_personas.rs`; they were ported into `evals/src/trading/personas/`
 * and the Rust eval module was deleted. This runner now drives them in
 * process, shelling out only to the Rust `walk_forward_backtest` cell-level
 * CLI — the same `BacktestEngine::walk_forward_compare` the live promotion
 * path uses. Single source of truth for fitness numbers, no parallel
 * scoring impl.
 *
 * Drop-in for every prior consumer (`agent-strategy-runner.ts`,
 * `lifecycle-runner.ts`, `persona-agent-eval.ts`): same exported
 * `runPersonaSuite(reportPath)`, same `PersonaEvalSuiteReport` shape on
 * disk + return.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { run } from '../lib/process.js'
import { runPersonaEvalSuite } from './personas/walk-forward.js'
import type { PersonaEvalSuiteReport } from './persona-types.js'

export function runPersonaSuite(reportPath: string): PersonaEvalSuiteReport {
  mkdirSync(dirname(reportPath), { recursive: true })
  const report = runPersonaEvalSuite()
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

export function currentCommitSha(): string {
  return run('git', ['rev-parse', 'HEAD']).stdout.trim()
}
