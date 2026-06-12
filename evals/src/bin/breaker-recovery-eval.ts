#!/usr/bin/env node
/**
 * `npm run eval:breaker-recovery` — longitudinal drawdown-halt recovery
 * scenario against a live operator stack (devnet or box). Seeds an honest
 * NAV-drop breach, then asserts: the breaker trips, improvement intents
 * stay bounded while halted, and the bot resumes ticking after the owner
 * acknowledges the drawdown. See evals/src/sim/breaker-recovery.ts for
 * the assertion contract.
 *
 *   npm run eval:breaker-recovery
 *   npm run eval:breaker-recovery -- --operator-url http://127.0.0.1:9200
 *   npm run eval:breaker-recovery -- --observe-window-s 240 --post-ack-window-s 180
 *
 * Exit codes:
 *   0  verdict=pass — every assertion verified
 *   1  verdict=fail — >=1 assertion failed (a real regression)
 *   2  verdict=skipped|partial — infra was missing/unreachable for some or
 *      all assertions; the report says exactly which. NEVER treated as pass.
 */

import { runBreakerRecoveryScenario } from '../sim/breaker-recovery.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// Anvil dev key #0 — the same default every other operator-driven eval uses
// (full-bot-eval.ts). Local-test scaffolding only.
const DEFAULT_E2E_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const operatorUrl = arg('operator-url') ?? process.env.TRADING_OPERATOR_URL ?? 'http://127.0.0.1:9200'
const privateKey = process.env.ARENA_E2E_PRIVATE_KEY ?? DEFAULT_E2E_PRIVATE_KEY
const observeWindowS = arg('observe-window-s') ? Number(arg('observe-window-s')) : undefined
const postAckWindowS = arg('post-ack-window-s') ? Number(arg('post-ack-window-s')) : undefined
const maxDrawdownPct = arg('max-drawdown-pct') ? Number(arg('max-drawdown-pct')) : undefined

const report = await runBreakerRecoveryScenario({
  operatorUrl,
  privateKey,
  ...(observeWindowS !== undefined ? { observeWindowMs: observeWindowS * 1000 } : {}),
  ...(postAckWindowS !== undefined ? { postAckWindowMs: postAckWindowS * 1000 } : {}),
  ...(maxDrawdownPct !== undefined ? { maxDrawdownPct } : {}),
})

console.log(JSON.stringify({ kind: 'breaker-recovery', ...report }, null, 2))

if (report.verdict === 'fail') {
  console.error('breaker-recovery: FAIL — see assertions above')
  process.exit(1)
}
if (report.verdict !== 'pass') {
  console.error(
    `breaker-recovery: ${report.verdict.toUpperCase()} — ` +
      `${report.assertions.filter((a) => a.status === 'skipped').length} assertion(s) could not be verified (infra unavailable); not a pass`,
  )
  process.exit(2)
}
console.error('breaker-recovery: OK — breaker tripped, intents bounded, bot recovered after acknowledge')
