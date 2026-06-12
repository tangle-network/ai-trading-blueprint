#!/usr/bin/env node
/**
 * `npm run eval:planted-improvement` — recovery direction of the
 * self-improvement gate. Plants a synthetic mean-reverting regime + a
 * mis-parameterized baseline whose known-better config sits inside the
 * mutator's search space, runs the production `runHarnessSelfImprovement`
 * machinery R times, and asserts the loop actually finds and promotes
 * the improvement (the production failure mode this guards against:
 * 385 candidates → 384 blocked / 0 promotions).
 *
 *   npm run eval:planted-improvement
 *   npm run eval:planted-improvement -- --runs 5 --generations 6 --population 16
 *   npm run eval:planted-improvement -- --min-recovery-rate 0.6
 *
 * Exit codes:
 *   0  promotion_count >= 1 AND recovery_rate >= --min-recovery-rate
 *   1  the loop never promoted (the audit failure mode), recovery rate
 *      below threshold, or the planted optimum failed pre-flight
 *      verification (eval construction is broken — fail loudly).
 */

import { runPlantedImprovementRecovery } from '../trading/planted-improvement.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const runs = arg('runs') ? Number(arg('runs')) : undefined
const populationSize = arg('population') ? Number(arg('population')) : undefined
const maxGenerations = arg('generations') ? Number(arg('generations')) : undefined
const deltaThreshold = arg('delta-threshold') ? Number(arg('delta-threshold')) : undefined
const seed = arg('seed') ? Number(arg('seed')) : undefined
// Default 0: the hard assertion is promotion_count >= 1; the rate is always
// REPORTED so flakiness is visible run-over-run before tightening the bar.
const minRecoveryRate = arg('min-recovery-rate') ? Number(arg('min-recovery-rate')) : 0

const report = await runPlantedImprovementRecovery({
  ...(runs !== undefined ? { runs } : {}),
  ...(populationSize !== undefined ? { populationSize } : {}),
  ...(maxGenerations !== undefined ? { maxGenerations } : {}),
  ...(deltaThreshold !== undefined ? { deltaThreshold } : {}),
  ...(seed !== undefined ? { seed } : {}),
})

console.log(JSON.stringify({ kind: 'planted-improvement-recovery', ...report }, null, 2))

if (report.promotion_count < 1) {
  console.error(
    `planted-improvement: FAIL — 0/${report.total_runs} runs promoted the planted improvement ` +
      '(gate never said "ship" despite a verified-better config in the search space).',
  )
  process.exit(1)
}
if (report.recovery_rate < minRecoveryRate) {
  console.error(
    `planted-improvement: FAIL — recovery_rate ${report.recovery_rate.toFixed(2)} < required ${minRecoveryRate}`,
  )
  process.exit(1)
}
console.error(
  `planted-improvement: OK — ${report.recovered_count}/${report.total_runs} runs recovered ` +
    `(recovery_rate ${report.recovery_rate.toFixed(2)}, promotions ${report.promotion_count})`,
)
