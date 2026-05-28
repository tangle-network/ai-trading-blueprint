#!/usr/bin/env node
/**
 * `npm run eval:per-bot-self-improve` — drive `runPerBotSelfImprovement`
 * for a single bot, time-window split (train+holdout) on its own venue
 * data, optimize the HarnessConfig, gate the winner, optionally write
 * it back to a local file.
 *
 *   npm run eval:per-bot-self-improve -- --bot hl-hype
 *   npm run eval:per-bot-self-improve -- --bot drift-sol --train-bars 4320 --holdout-bars 720 --generations 4 --population 8
 *   npm run eval:per-bot-self-improve -- --bot hl-btc --promote-to /home/agent/config/harness.json
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_BOTS } from '../trading/harness-self-improve.js'
import {
  runPerBotSelfImprovement,
  writeHarnessToLocalFile,
} from '../trading/per-bot-self-improve.js'
import type { HarnessConfig } from '../trading/harness-types.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const botId = arg('bot')
if (!botId) {
  console.error('per-bot-self-improve-eval: --bot <id> is required.')
  console.error(`Available bots: ${DEFAULT_BOTS.map((b) => b.id).join(', ')}`)
  process.exit(2)
}
const bot = DEFAULT_BOTS.find((b) => b.id === botId)
if (!bot) {
  console.error(`per-bot-self-improve-eval: unknown bot '${botId}'.`)
  console.error(`Available: ${DEFAULT_BOTS.map((b) => b.id).join(', ')}`)
  process.exit(2)
}

const promoteTo = arg('promote-to')
const baselineFile = arg('baseline-harness-file')
const trainBars = arg('train-bars') ? Number(arg('train-bars')) : undefined
const holdoutBars = arg('holdout-bars') ? Number(arg('holdout-bars')) : undefined
const generations = arg('generations') ? Number(arg('generations')) : undefined
const populationSize = arg('population') ? Number(arg('population')) : undefined
const seed = arg('seed') ? Number(arg('seed')) : undefined

const currentHarness: HarnessConfig | undefined = baselineFile
  ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as HarnessConfig)
  : undefined

const result = await runPerBotSelfImprovement({
  bot,
  ...(currentHarness ? { currentHarness } : {}),
  ...(trainBars !== undefined ? { trainCandlesLimit: trainBars } : {}),
  ...(holdoutBars !== undefined ? { holdoutCandlesLimit: holdoutBars } : {}),
  ...(generations !== undefined ? { maxGenerations: generations } : {}),
  ...(populationSize !== undefined ? { populationSize } : {}),
  ...(seed !== undefined ? { seed } : {}),
  ...(promoteTo ? { promoteToLocalState: writeHarnessToLocalFile(promoteTo) } : {}),
})

const gateDecision =
  typeof result.loop.gateResult === 'object' && result.loop.gateResult && 'decision' in result.loop.gateResult
    ? (result.loop.gateResult as { decision: string }).decision
    : 'unknown'

console.log(
  JSON.stringify(
    {
      kind: 'per-bot-self-improvement',
      bot: result.bot.id,
      gate_decision: gateDecision,
      promoted: result.promoted,
      winning_harness: result.winningHarness,
      winner_surface_hash: result.loop.winnerSurfaceHash,
      baseline_holdout_aggregates: result.loop.baselineOnHoldout.aggregates,
      winner_holdout_aggregates: result.loop.winnerOnHoldout.aggregates,
      promoted_to_local_state: result.promoted && Boolean(promoteTo) ? promoteTo : null,
    },
    null,
    2,
  ),
)
if (!result.promoted) process.exit(1)
