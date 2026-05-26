#!/usr/bin/env node
/**
 * `npm run eval:harness-self-improve` — drive the substrate's
 * `runImprovementLoop` over the HarnessConfig surface.
 *
 * Optimize the strategy over the TRAIN bot split, gate the winner on the
 * HELD-OUT bot split, print the substrate's verdict + the winning surface.
 *
 *   npm run eval:harness-self-improve -- --holdout hl-hype,drift-sol
 *   npm run eval:harness-self-improve -- --holdout aerodrome-eth --generations 6 --population 12
 *   npm run eval:harness-self-improve -- --eval-only         # measure without optimizing
 */

import { runHarnessEval, runHarnessSelfImprovement } from '../trading/harness-self-improve.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const holdoutArg = (arg('holdout') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const candlesLimit = arg('candles-limit') ? Number(arg('candles-limit')) : undefined
const generations = arg('generations') ? Number(arg('generations')) : undefined
const populationSize = arg('population') ? Number(arg('population')) : undefined
const reps = arg('reps') ? Number(arg('reps')) : undefined
const seed = arg('seed') ? Number(arg('seed')) : undefined
const evalOnly = flag('eval-only')

if (evalOnly) {
  const result = await runHarnessEval({
    ...(candlesLimit !== undefined ? { candlesLimit } : {}),
    ...(reps !== undefined ? { reps } : {}),
    ...(seed !== undefined ? { seed } : {}),
  })
  console.log(JSON.stringify({ kind: 'campaign', aggregates: result.aggregates }, null, 2))
} else {
  if (holdoutArg.length === 0) {
    console.error(
      'harness-self-improve-eval: --holdout <botId>[,...] is required (the held-out bots gate the optimizer).',
    )
    process.exit(2)
  }
  const result = await runHarnessSelfImprovement({
    holdoutBotIds: holdoutArg,
    ...(candlesLimit !== undefined ? { candlesLimit } : {}),
    ...(generations !== undefined ? { maxGenerations: generations } : {}),
    ...(populationSize !== undefined ? { populationSize } : {}),
    ...(reps !== undefined ? { reps } : {}),
    ...(seed !== undefined ? { seed } : {}),
  })
  const winnerSurface = result.winnerSurface
  const winnerHash = result.winnerSurfaceHash
  const gateResult = result.gateResult
  const gateDecision =
    typeof gateResult === 'object' && gateResult !== null && 'decision' in gateResult
      ? (gateResult as { decision: string }).decision
      : 'unknown'
  console.log(
    JSON.stringify(
      {
        kind: 'self-improvement',
        gate_decision: gateDecision,
        winner_surface_hash: winnerHash,
        winner_surface: typeof winnerSurface === 'string' ? JSON.parse(winnerSurface) : winnerSurface,
        baseline_holdout_aggregates: result.baselineOnHoldout.aggregates,
        winner_holdout_aggregates: result.winnerOnHoldout.aggregates,
      },
      null,
      2,
    ),
  )
  if (gateDecision === 'reject' || gateDecision === 'rejected') process.exit(1)
}
