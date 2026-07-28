#!/usr/bin/env node
/**
 * `npm run eval:per-bot-self-improve` — drive `runPerBotSelfImprovement`
 * for a single bot across multiple history lengths, optimize the HarnessConfig,
 * check the winner on the final horizon, optionally write
 * it back to a local file.
 *
 *   npm run eval:per-bot-self-improve -- --bot hl-hype
 *   npm run eval:per-bot-self-improve -- --bot drift-sol --train-bars 4320 --holdout-bars 720 --max-evaluations 96
 *   npm run eval:per-bot-self-improve -- --bot hl-btc --window-end-time-sec 1767225600
 *   npm run eval:per-bot-self-improve -- --bot hl-btc --promote-to /home/agent/config/harness.json
 */

import { readFileSync } from 'node:fs'
import { argValue } from './trading-persona-cli.js'
import { DEFAULT_BOTS } from '../trading/harness-self-improve.js'
import {
  runPerBotSelfImprovement,
  writeHarnessToLocalFile,
} from '../trading/per-bot-self-improve.js'
import type { HarnessConfig } from '../trading/harness-types.js'

function arg(name: string): string | undefined {
  return argValue(process.argv, `--${name}`)
}

function safeIntegerArg(name: string, minimum: number): number | undefined {
  const raw = arg(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be a safe integer >= ${minimum}, got "${raw}"`)
  }
  return value
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
const trainBars = safeIntegerArg('train-bars', 1)
const holdoutBars = safeIntegerArg('holdout-bars', 1)
const maxEvaluations = safeIntegerArg('max-evaluations', 1)
const windowEndTimeSec = safeIntegerArg('window-end-time-sec', 1)
const seed = safeIntegerArg('seed', 0)

const currentHarness: HarnessConfig | undefined = baselineFile
  ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as HarnessConfig)
  : undefined

const result = await runPerBotSelfImprovement({
  bot,
  ...(currentHarness ? { currentHarness } : {}),
  ...(trainBars !== undefined ? { trainCandlesLimit: trainBars } : {}),
  ...(holdoutBars !== undefined ? { holdoutCandlesLimit: holdoutBars } : {}),
  ...(maxEvaluations !== undefined ? { maxEvaluations } : {}),
  ...(windowEndTimeSec !== undefined ? { windowEndTimeSec } : {}),
  ...(seed !== undefined ? { seed } : {}),
  ...(promoteTo ? { promoteToLocalState: writeHarnessToLocalFile(promoteTo) } : {}),
})

const gateDecision = result.improvement.gateDecision

console.log(
  JSON.stringify(
    {
      kind: 'per-bot-self-improvement',
      bot: result.bot.id,
      gate_decision: gateDecision,
      promoted: result.promoted,
      winning_harness: result.winningHarness,
      winner_surface_hash: result.improvement.raw.winnerSurfaceHash,
      baseline_holdout_aggregates: result.improvement.raw.baselineOnHoldout.aggregates,
      winner_holdout_aggregates: result.improvement.raw.winnerOnHoldout.aggregates,
      promoted_to_local_state: result.promoted && Boolean(promoteTo) ? promoteTo : null,
    },
    null,
    2,
  ),
)
if (!result.promoted) process.exit(1)
