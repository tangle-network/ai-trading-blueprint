#!/usr/bin/env node
/**
 * `npm run eval:harness-self-improve` — drive the substrate's
 * current complete method over the HarnessConfig surface.
 *
 * Optimize the strategy over the TRAIN bot split, gate the winner on the
 * HELD-OUT bot split, print the substrate's verdict + the winning surface.
 *
 *   npm run eval:harness-self-improve -- --holdout hl-hype,drift-sol
 *   npm run eval:harness-self-improve -- --holdout aerodrome-eth --max-evaluations 96
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
const maxEvaluations = arg('max-evaluations') ? Number(arg('max-evaluations')) : undefined
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
    ...(maxEvaluations !== undefined ? { maxEvaluations } : {}),
    ...(reps !== undefined ? { reps } : {}),
    ...(seed !== undefined ? { seed } : {}),
  })
  const winnerSurface = result.winner.surface
  const winnerHash = result.raw.winnerSurfaceHash
  const gateDecision = result.gateDecision
  console.log(
    JSON.stringify(
      {
        kind: 'self-improvement',
        gate_decision: gateDecision,
        winner_surface_hash: winnerHash,
        winner_surface: typeof winnerSurface === 'string' ? JSON.parse(winnerSurface) : winnerSurface,
        baseline_holdout_aggregates: result.raw.baselineOnHoldout.aggregates,
        winner_holdout_aggregates: result.raw.winnerOnHoldout.aggregates,
      },
      null,
      2,
    ),
  )
  if (gateDecision !== 'ship') process.exit(1)
}
