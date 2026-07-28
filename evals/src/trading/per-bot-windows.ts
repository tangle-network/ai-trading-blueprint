import type { Scenario } from '@tangle-network/agent-eval/campaign'

import type { CandleTimeWindow } from './harness-dispatch.js'
import type { BotContext } from './harness-types.js'

/** A time-window scenario over a single bot's candle stream. */
export interface BotWindowScenario extends Scenario {
  bot: BotContext
  /** Hourly bars to fetch from the venue. */
  candlesLimit: number
  /** Half-open candle range. Search ranges end where the final range starts. */
  candleWindow: CandleTimeWindow
  window: 'train' | 'holdout'
}

export interface PerBotWindowPlan {
  searchScenarios: BotWindowScenario[]
  holdoutScenario: BotWindowScenario
}

const HOUR_SECONDS = 60 * 60

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer, got ${value}`)
  }
  return value
}

/**
 * Build reproducible search and final ranges over one candle stream.
 * Every range is [start, end), and every search end equals the final start.
 * The two search ranges intentionally overlap: they test the same candidate
 * across long and medium history. Only the later final range is held out.
 */
export function buildPerBotWindowPlan(
  bot: BotContext,
  options: {
    trainCandlesLimit?: number
    holdoutCandlesLimit?: number
    windowEndTimeSec?: number
    nowMs?: number
  } = {},
): PerBotWindowPlan {
  const trainLimit = positiveInteger(options.trainCandlesLimit ?? 4320, 'trainCandlesLimit')
  const holdoutLimit = positiveInteger(options.holdoutCandlesLimit ?? 720, 'holdoutCandlesLimit')
  if (trainLimit <= holdoutLimit) {
    throw new Error(
      `trainCandlesLimit (${trainLimit}) must be greater than holdoutCandlesLimit (${holdoutLimit})`,
    )
  }
  const defaultEnd = Math.floor((options.nowMs ?? Date.now()) / 1000 / HOUR_SECONDS) * HOUR_SECONDS
  const finalEnd = positiveInteger(options.windowEndTimeSec ?? defaultEnd, 'windowEndTimeSec')
  if (finalEnd % HOUR_SECONDS !== 0) {
    throw new Error(`windowEndTimeSec must align to an hourly candle boundary, got ${finalEnd}`)
  }
  const finalStart = finalEnd - holdoutLimit * HOUR_SECONDS
  const mediumLimit = Math.max(holdoutLimit + 1, Math.floor(trainLimit * 0.67))
  const searchEnd = finalStart
  const longStart = searchEnd - trainLimit * HOUR_SECONDS
  if (longStart < 0) {
    throw new Error('requested candle history starts before the Unix epoch')
  }

  const searchScenarios: BotWindowScenario[] = [
    {
      id: `${bot.id}-train-long`,
      kind: 'per-bot-train-window',
      tags: [bot.venue_label, bot.symbol, 'train-long'],
      bot,
      candlesLimit: trainLimit,
      candleWindow: { startTimeSec: longStart, endTimeSec: searchEnd },
      window: 'train',
    },
    {
      id: `${bot.id}-train-medium`,
      kind: 'per-bot-train-window',
      tags: [bot.venue_label, bot.symbol, 'train-medium'],
      bot,
      candlesLimit: mediumLimit,
      candleWindow: {
        startTimeSec: searchEnd - mediumLimit * HOUR_SECONDS,
        endTimeSec: searchEnd,
      },
      window: 'train',
    },
  ]
  const holdoutScenario: BotWindowScenario = {
    id: `${bot.id}-final`,
    kind: 'per-bot-holdout-window',
    tags: [bot.venue_label, bot.symbol, 'final'],
    bot,
    candlesLimit: holdoutLimit,
    candleWindow: { startTimeSec: finalStart, endTimeSec: finalEnd },
    window: 'holdout',
  }
  return { searchScenarios, holdoutScenario }
}
