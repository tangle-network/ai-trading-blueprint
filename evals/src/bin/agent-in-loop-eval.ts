#!/usr/bin/env node
/**
 * Agent-in-loop walk-forward eval bin.
 *
 * Runs the simulation across a small bench of user intents on cached
 * Hyperliquid HYPE 1h candles. For each intent:
 *   - Claude generates K candidate HarnessConfigs
 *   - Each candidate is walked forward D days under two arms (frozen vs
 *     agent-in-loop); the agent gets a weekly turn to revise
 *   - We score frozen-vs-agent delta per candidate and aggregate per intent
 *
 * Writes a markdown report + a JSON result blob to /tmp/agent-in-loop/.
 *
 * Defaults: 4 intents · K=3 candidates · D=24 simulated days (~720
 * hourly bars) · weekly turns. Adjust via flags.
 */

import { mkdirSync, writeFileSync } from 'node:fs'

import {
  loadCachedCandles,
  runIntent,
  writeReport,
  type IntentResult,
  type UserIntent,
} from '../sim/agent-in-loop.js'

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const CANDLES_PATH = argValue('--candles', '/tmp/per-bot-artifacts/holdout-cache/hyperliquid-HYPE-1h-720.json')
const NUM_CANDIDATES = Number.parseInt(argValue('--candidates', '3'), 10)
const TOTAL_DAYS = Number.parseInt(argValue('--days', '24'), 10)
const AGENT_TURN_EVERY = Number.parseInt(argValue('--turn-every', '7'), 10)
const OUT_DIR = argValue('--out-dir', '/tmp/agent-in-loop')

const INTENTS: UserIntent[] = [
  {
    id: 'conservative-momentum',
    text: 'Conservative momentum trader. Hold positions only when the signal is clear. Tight stop losses. 5-10 trades per week is plenty.',
    capital_usd: 10_000,
    dd_cap_pct: 5,
    bot_source: 'hyperliquid',
    bot_symbol: 'HYPE',
    fee_protocol: 'hyperliquid_perp',
  },
  {
    id: 'aggressive-momentum',
    text: 'Aggressive momentum chaser. Lever up on strong breakouts, accept volatility. 20+ trades per week. Drawdown up to 15% is OK if average return justifies it.',
    capital_usd: 10_000,
    dd_cap_pct: 15,
    bot_source: 'hyperliquid',
    bot_symbol: 'HYPE',
    fee_protocol: 'hyperliquid_perp',
  },
  {
    id: 'mean-reversion-only',
    text: 'Pure mean reversion. Fade extreme moves only. No momentum entries. Patient — willing to wait for setups. Small positions, hold for 12-48 hours.',
    capital_usd: 10_000,
    dd_cap_pct: 8,
    bot_source: 'hyperliquid',
    bot_symbol: 'HYPE',
    fee_protocol: 'hyperliquid_perp',
  },
  {
    id: 'risk-off-on-vol-spike',
    text: 'Adaptive: trade momentum when realised volatility is low, but go fully flat or reduce size sharply when ATR spikes. Capital preservation is more important than upside.',
    capital_usd: 10_000,
    dd_cap_pct: 6,
    bot_source: 'hyperliquid',
    bot_symbol: 'HYPE',
    fee_protocol: 'hyperliquid_perp',
  },
]

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const candles = loadCachedCandles(CANDLES_PATH)
  const requiredCandles = TOTAL_DAYS * 24
  if (candles.length < requiredCandles) {
    throw new Error(
      `not enough candles in ${CANDLES_PATH}: have ${candles.length}, need ${requiredCandles} for ${TOTAL_DAYS} simulated days`,
    )
  }

  process.stderr.write(`Loaded ${candles.length} candles. Running ${INTENTS.length} intents × ${NUM_CANDIDATES} candidates × ${TOTAL_DAYS} days (turns every ${AGENT_TURN_EVERY}d).\n\n`)

  const results: IntentResult[] = []
  for (const intent of INTENTS) {
    process.stderr.write(`\n── ${intent.id} ──────────────────────────────────────────────\n`)
    const r = runIntent({
      intent,
      candles,
      numCandidates: NUM_CANDIDATES,
      totalDays: TOTAL_DAYS,
      agentTurnEveryNDays: AGENT_TURN_EVERY,
    })
    results.push(r)
    process.stderr.write(
      `  → frozen mean ${r.frozen_mean_return.toFixed(2)}% | agent mean ${r.agent_mean_return.toFixed(2)}% | Δ ${r.delta_pct >= 0 ? '+' : ''}${r.delta_pct.toFixed(2)}%\n`,
    )
  }

  const reportPath = `${OUT_DIR}/REPORT.md`
  const jsonPath = `${OUT_DIR}/results.json`
  writeReport(results, reportPath)
  writeFileSync(jsonPath, JSON.stringify(results, null, 2))

  // Single-line summary on stdout for shell-piping.
  const overallDelta =
    results.reduce((s, r) => s + r.delta_pct, 0) / results.length
  console.log(
    JSON.stringify({
      intents: results.length,
      candidates_each: NUM_CANDIDATES,
      days: TOTAL_DAYS,
      overall_agent_minus_frozen_pct: overallDelta,
      report: reportPath,
      json: jsonPath,
    }),
  )
}

await main()
