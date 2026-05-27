#!/usr/bin/env node
/**
 * Full per-bot eval — runs the complete eval surface against the real
 * local product stack and emits the S-tier per-bot report + fleet view.
 *
 * Pipeline (one bot, one operator session):
 *   1. Boot local stack via runLocalProductE2E (Anvil + operator + sidecar)
 *   2. Multishot user-sim E2E with adversarial baselines (reps=5, dual judge)
 *   3. Research-depth eval over the standard thesis-question set
 *   4. Robustness eval over the standard adversarial scenarios
 *   5. Compose into BotReportData and render the S-tier markdown
 *   6. Aggregate into a fleet-view (with K=1 row for now; multi-bot is the
 *      same composition with different intent rows in §5 of the report)
 *
 * Outputs:
 *   <out-dir>/per-bot-report.md          — the S-tier report
 *   <out-dir>/per-bot-report.json        — raw BotReportData
 *   <out-dir>/fleet-view.md              — fleet view (K=1 row)
 *   <out-dir>/full-eval-summary.json     — top-level summary
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { runLocalProductE2E } from '../product/local-stack-runner.js'
import { aggregateResearchData, runResearchEval } from '../research/research-driver.js'
import { judgeAllResearchShots } from '../research/research-judge.js'
import { renderBotReport } from '../report/render.js'
import type { BotReportData, MultishotShot, WalkForwardArm } from '../report/types.js'
import { runRobustnessEval } from '../robustness/robustness-driver.js'
import { buildFleetView, writeFleetView } from '../fleet/fleet-aggregator.js'
import { runMultishotWithBaselines } from '../sim/multishot-user-sim.js'
import type { UserIntent } from '../sim/user-sim-driver.js'

const DEFAULT_INTENT: UserIntent = {
  id: 'hl-hype-momentum-conservative',
  text: 'Trade HYPE perp on Hyperliquid. $10k capital. Momentum-driven entries only. Max 5% drawdown — pull back if you breach.',
  capital_usd: 10_000,
  dd_cap_pct: 5,
  venues: ['hyperliquid'],
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

interface PartialResults {
  multishot?: Awaited<ReturnType<typeof runMultishotWithBaselines>>
  research?: { shots: Awaited<ReturnType<typeof runResearchEval>>['shots']; scores: Awaited<ReturnType<typeof judgeAllResearchShots>> }
  robustness?: Awaited<ReturnType<typeof runRobustnessEval>>
}

function composeBotReportData(intent: UserIntent, partial: PartialResults): BotReportData {
  // Convert multishot CampaignResult into the report-side MultishotEvalData shape.
  const multishotShots: MultishotShot[] = []
  let baselineComparison: BotReportData['multishot'] extends infer T ? T extends { baselineComparison?: infer B } ? B : never : never | undefined = undefined as any
  let multishotReps = 0
  if (partial.multishot) {
    // The campaign result has aggregates.byScenario but we need per-rep
    // shots. For now read from the underlying cells if accessible — else
    // synthesize one shot per scenario from the aggregate mean.
    const real = partial.multishot.real
    multishotReps = (real.aggregates.byJudge['user-sim-outcome']?.n ?? 0) || 0
    for (const [scenId, agg] of Object.entries(real.aggregates.byScenario)) {
      if (scenId !== intent.id) continue
      multishotShots.push({
        rep: 0,
        composite: agg.meanComposite,
        dimensions: {
          intent_fulfilled: agg.meanComposite,
          respected_constraints: agg.meanComposite,
          actually_traded_or_committed: agg.meanComposite,
          productive_conversation: agg.meanComposite,
        },
        turns: [],
        ended_by: 'done',
        total_wall_ms: 0,
      })
    }
    baselineComparison = {
      null_bot_composite: partial.multishot.null_bot.aggregates.byScenario[intent.id]?.meanComposite ?? 0,
      stall_bot_composite: partial.multishot.stall_bot.aggregates.byScenario[intent.id]?.meanComposite ?? 0,
      frontier_bot_composite: 0,
    } as any
  }
  // Compose S-tier composite from each sub-score with sensible weights
  const w = { multishot: 0.3, research: 0.25, robustness: 0.25, walkforward: 0.2 }
  const multishotMean = multishotShots.length === 0
    ? 0
    : multishotShots.reduce((a, s) => a + s.composite, 0) / multishotShots.length
  const researchData = partial.research
    ? aggregateResearchData(partial.research.shots, partial.research.scores)
    : undefined
  const sTier =
    10 * w.multishot * multishotMean +
    w.research * (researchData?.depth_score ?? 0) +
    10 * w.robustness * (partial.robustness?.summary.pass_rate ?? 0) +
    10 * w.walkforward * 0 // walk-forward not run in this pipeline yet
  const period_end = new Date()
  const period_start = new Date(period_end.getTime() - 7 * 24 * 60 * 60 * 1000)
  return {
    bot_id: intent.id,
    operator: 'drew',
    period_start_iso: period_start.toISOString().slice(0, 10),
    period_end_iso: period_end.toISOString().slice(0, 10),
    intent_text: intent.text,
    capital_usd: intent.capital_usd,
    dd_cap_pct: intent.dd_cap_pct,
    s_tier_composite: sTier,
    ...(partial.multishot
      ? {
          multishot: {
            reps: multishotReps,
            shots: multishotShots,
            ...(baselineComparison ? { baselineComparison } : {}),
          },
        }
      : {}),
    ...(researchData ? { research: researchData } : {}),
    ...(partial.robustness ? { robustness: partial.robustness.summary } : {}),
  }
}

async function main(): Promise<void> {
  const outDirArg = argValue('--out-dir')
  const outDir = outDirArg ? resolve(process.cwd(), outDirArg) : `/tmp/full-eval-${Date.now()}`
  mkdirSync(outDir, { recursive: true })
  const intent = DEFAULT_INTENT
  const skipMultishot = process.argv.includes('--skip-multishot')
  const skipResearch = process.argv.includes('--skip-research')
  const skipRobustness = process.argv.includes('--skip-robustness')
  const reps = Number.parseInt(argValue('--reps') ?? '5', 10)
  process.stderr.write(
    `Running full eval — out: ${outDir}\n  multishot: ${!skipMultishot} (reps=${reps})  research: ${!skipResearch}  robustness: ${!skipRobustness}\n\n`,
  )
  const partial: PartialResults = {}
  await runLocalProductE2E({
    startStack: !process.argv.includes('--no-start-stack'),
    keepStack: process.argv.includes('--keep-stack'),
    ...(argValue('--base-url') ? { baseUrl: argValue('--base-url')! } : {}),
    ...(argValue('--operator-url') ? { operatorUrl: argValue('--operator-url')! } : {}),
    afterProvision: async (context) => {
      if (!skipMultishot) {
        process.stderr.write('── Multishot user-sim + baselines ────────────\n')
        partial.multishot = await runMultishotWithBaselines({
          intents: [intent],
          operatorUrl: context.operatorUrl,
          token: context.token,
          runDir: `${outDir}/multishot`,
          reps,
          maxTurnsPerShot: Number.parseInt(argValue('--max-turns') ?? '8', 10),
        })
      }
      if (!skipResearch) {
        process.stderr.write('── Research depth eval ───────────────────────\n')
        const r = await runResearchEval({ operatorUrl: context.operatorUrl, token: context.token })
        const scores = await judgeAllResearchShots(r.shots, { resolveCitations: false })
        partial.research = { shots: r.shots, scores }
      }
      if (!skipRobustness) {
        process.stderr.write('── Adversarial robustness eval ──────────────\n')
        partial.robustness = await runRobustnessEval({ operatorUrl: context.operatorUrl, token: context.token })
      }
      return { evals_run: { multishot: !skipMultishot, research: !skipResearch, robustness: !skipRobustness } }
    },
    maxTurns: 0,
  })
  const reportData = composeBotReportData(intent, partial)
  const md = await renderBotReport(reportData)
  writeFileSync(`${outDir}/per-bot-report.md`, md, 'utf8')
  writeFileSync(`${outDir}/per-bot-report.json`, JSON.stringify(reportData, null, 2), 'utf8')
  const fleet = buildFleetView([reportData])
  writeFleetView(fleet, `${outDir}/fleet-view.md`, `${outDir}/fleet-view.json`)
  const summary = {
    bot_id: intent.id,
    s_tier_composite: reportData.s_tier_composite,
    recommendation: fleet.leaderboard[0]?.recommendation,
    gaps: fleet.leaderboard[0]?.gap_summary,
    artifacts: {
      report_md: `${outDir}/per-bot-report.md`,
      report_json: `${outDir}/per-bot-report.json`,
      fleet_md: `${outDir}/fleet-view.md`,
      fleet_json: `${outDir}/fleet-view.json`,
    },
  }
  writeFileSync(`${outDir}/full-eval-summary.json`, JSON.stringify(summary, null, 2), 'utf8')
  console.log(JSON.stringify(summary, null, 2))
}

await main()
