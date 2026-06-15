#!/usr/bin/env node
// 1-CELL operator-matrix smoke: proves the unified trading eval drives the REAL
// operator end-to-end (provision -> persona chat -> capture bot_artifacts ->
// judge on real artifacts + objective backtest) WITHOUT the full 55-cell sweep.
//
// Run:
//   OPERATOR_API_URL=https://<box> ZAI_API_KEY=<key> \
//   node dist/evals/bin/operator-matrix-smoke.js --private-key 0x...
import { runTradingPersonaEval } from '../trading/persona-agent-eval.js'
import { STANDARD_USER_PERSONAS } from '../sim/user-personas.js'
import { defaultScenarios } from '../trading/personas/scenarios.js'
import { STANDARD_USER_INTENTS } from '../sim/user-intents.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const operatorUrl = arg('--operator-url') ?? process.env.OPERATOR_API_URL ?? process.env.OPERATOR_URL
if (!operatorUrl) {
  console.error('operator-matrix-smoke: --operator-url or OPERATOR_API_URL required')
  process.exit(2)
}
const privateKey = arg('--private-key') ?? process.env.OPERATOR_PRIVATE_KEY
const token = arg('--token') ?? process.env.OPERATOR_API_TOKEN

// Exactly one cell: one model x one persona x one market, one rep.
const summary = await runTradingPersonaEval({
  operatorUrl,
  ...(privateKey ? { privateKey } : {}),
  ...(token ? { token } : {}),
  models: ['glm-4.7'],
  personas: [STANDARD_USER_PERSONAS[0]!],
  markets: [defaultScenarios()[0]!],
  intents: [STANDARD_USER_INTENTS[0]!],
  reps: 1,
  maxTurnsPerShot: Number(arg('--max-turns') ?? 4),
  maxConcurrency: 1,
  // A single live cell: warn (don't hard-throw) so the smoke reports the result
  // even if the inner operator LLM spend isn't visible to the integrity guard.
  integrity: 'warn',
})

console.log(JSON.stringify(summary, null, 2))
if (summary.mode !== 'operator-matrix') {
  console.error('SMOKE FAIL: expected operator-matrix mode (operatorUrl not honored?)')
  process.exit(1)
}
const profile = summary.byProfile?.[0]
console.log(
  `\nSMOKE: records=${summary.records} cell_model=${profile?.model} ` +
    `mean=${profile?.meanScore?.toFixed?.(3)} integrity=${summary.integrity?.verdict}`,
)
// The smoke proves the cell RAN against the real operator; a 0-record result
// means the operator never produced a turn (provision/auth/chat failed).
if (summary.records === 0) {
  console.error('SMOKE FAIL: 0 records — the real operator was not driven (provision/auth/chat failed)')
  process.exit(1)
}
console.log('SMOKE PASS: the eval drove the real operator and produced a scored cell.')
