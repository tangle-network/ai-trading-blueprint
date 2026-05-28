#!/usr/bin/env node
/**
 * Multishot user-sim E2E — drives the REAL local product stack with K
 * user-sim sessions in parallel, one per freeform user intent.
 *
 *   - Boots local-stack via `runLocalProductE2E` (same path the other
 *     chat-* e2e bins use) unless `--no-start-stack` + `--base-url` /
 *     `--operator-url` is passed.
 *   - Provisions K fresh bots through the operator's `/api/bots`
 *     endpoint — same path the frontend uses.
 *   - Each shot is an LLM-driven user-sim ↔ bot multi-turn conversation
 *     against the real chat API. No frozen arm, no scripted prompts.
 *   - Scores each shot via an LLM rubric judge (intent_fulfilled,
 *     respected_constraints, actually_traded_or_committed,
 *     productive_conversation).
 *
 * Usage:
 *   npx tsx evals/src/bin/multishot-user-sim-e2e.ts
 *     [--base-url http://127.0.0.1:1337]
 *     [--operator-url http://127.0.0.1:1337/operator-api]
 *     [--no-start-stack]
 *     [--max-turns 8]
 *     [--per-turn-timeout-ms 240000]
 *     [--out report.json]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { runLocalProductE2E } from '../product/local-stack-runner.js'
import { runMultishotUserSim, runMultishotWithBaselines } from '../sim/multishot-user-sim.js'
import type { UserIntent } from '../sim/user-sim-driver.js'

const INTENTS: UserIntent[] = [
  {
    id: 'hl-hype-momentum-conservative',
    text: 'Trade HYPE perp on Hyperliquid. $10k capital. Momentum-driven entries only. Max 5% drawdown — pull back if you breach.',
    capital_usd: 10_000,
    dd_cap_pct: 5,
    venues: ['hyperliquid'],
  },
  {
    id: 'hl-btc-news-driven',
    text: 'I want a bot that trades BTC perp on Hyperliquid based on news catalysts. $5k. Be selective. Only trade when there is a clear narrative.',
    capital_usd: 5_000,
    dd_cap_pct: 8,
    venues: ['hyperliquid'],
  },
  {
    id: 'polymarket-mm-binary',
    text: 'Market-make on Polymarket binary markets — pick high-volume political markets, run tight quotes. $2k.',
    capital_usd: 2_000,
    dd_cap_pct: 10,
    venues: ['polymarket_clob'],
  },
  {
    id: 'aave-yield-stables',
    text: 'Just deposit stables into Aave on Base for yield. $20k. Keep it simple. No trades.',
    capital_usd: 20_000,
    dd_cap_pct: 1,
    venues: ['aave_v3'],
  },
]

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}
function numberArg(name: string): number | undefined {
  const v = argValue(name)
  return v === undefined ? undefined : Number.parseInt(v, 10)
}

async function main(): Promise<void> {
  const outArg = argValue('--out')
  const outputPath = outArg ? resolve(process.cwd(), outArg) : undefined
  const withBaselines = process.argv.includes('--with-baselines')
  const reps = numberArg('--reps') ?? 5

  // Boot (or reuse) the local product stack — same wiring the other e2e
  // bins use. The user-sim multishot runs inside `afterProvision` so it
  // sees the operator token; the default product flow's single-bot
  // provisioning is treated as a warm-up, not the eval body.
  let realCampaign: Awaited<ReturnType<typeof runMultishotUserSim>> | undefined
  let baselineResult: Awaited<ReturnType<typeof runMultishotWithBaselines>> | undefined
  const product = await runLocalProductE2E({
    startStack: !process.argv.includes('--no-start-stack'),
    keepStack: process.argv.includes('--keep-stack'),
    ...(argValue('--base-url') ? { baseUrl: argValue('--base-url')! } : {}),
    ...(argValue('--operator-url') ? { operatorUrl: argValue('--operator-url')! } : {}),
    afterProvision: async (context) => {
      const common = {
        intents: INTENTS,
        operatorUrl: context.operatorUrl,
        token: context.token,
        runDir: `${context.outputDir}/multishot-user-sim`,
        reps,
        ...(numberArg('--max-turns') !== undefined ? { maxTurnsPerShot: numberArg('--max-turns')! } : {}),
        ...(numberArg('--per-turn-timeout-ms') !== undefined ? { perTurnTimeoutMs: numberArg('--per-turn-timeout-ms')! } : {}),
      }
      if (withBaselines) {
        baselineResult = await runMultishotWithBaselines(common)
        realCampaign = baselineResult.real
      } else {
        realCampaign = await runMultishotUserSim(common)
      }
      return {
        intents: INTENTS.length,
        reps,
        with_baselines: withBaselines,
        cells_executed: realCampaign.aggregates.cellsExecuted,
        cells_failed: realCampaign.aggregates.cellsFailed,
      }
    },
    maxTurns: 0,
  })
  if (!realCampaign) throw new Error('multishot user-sim did not run (afterProvision was not invoked)')

  const summary = {
    suite: 'multishot-user-sim-e2e',
    operator_url: product.operator_url,
    base_url: product.base_url,
    output_dir: product.output_dir,
    intents: INTENTS.length,
    reps,
    with_baselines: withBaselines,
    cells_executed: realCampaign.aggregates.cellsExecuted,
    cells_failed: realCampaign.aggregates.cellsFailed,
    by_scenario: Object.fromEntries(
      Object.entries(realCampaign.aggregates.byScenario).map(([id, agg]) => [
        id,
        { mean_composite: agg.meanComposite, n: agg.n, ci95: agg.ci95 },
      ]),
    ),
    ...(baselineResult
      ? {
          baseline_comparison: {
            per_scenario: baselineResult.per_scenario_deltas,
            // Judge sanity: real should dominate null + stall by ≥0.4 on every intent.
            judge_validity_flags: Object.entries(baselineResult.per_scenario_deltas)
              .filter(([, d]) => d.delta_vs_null < 0.4 || d.delta_vs_stall < 0.4)
              .map(([id, d]) => ({ scenario: id, ...d })),
          },
        }
      : {}),
  }

  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(
      outputPath,
      `${JSON.stringify({ summary, real_campaign: realCampaign, baseline_comparison: baselineResult }, null, 2)}\n`,
      'utf8',
    )
  }
  console.log(JSON.stringify(summary, null, 2))
  if (realCampaign.aggregates.cellsFailed > 0) process.exit(1)
}

await main()
